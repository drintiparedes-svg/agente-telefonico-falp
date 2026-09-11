/**
 * Receptor de webhooks post-llamada.
 *
 * Regla de oro bajo retención cero: PERSISTIR ANTES DE PROCESAR. La plataforma
 * no reintenta webhooks fallidos ni conserva copia del evento, así que cualquier
 * excepción entre la recepción y el guardado destruye el resultado de esa llamada
 * de forma irrecuperable. Por eso el handler solo hace tres cosas: verificar la
 * firma, escribir en la cola y devolver 200. El procesamiento ocurre después, en
 * un trabajador que sí puede reintentar.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verificarFirma } from './hmac.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Cuerpo tal como llegó. La firma HMAC se calcula sobre estos bytes exactos. */
    cuerpoCrudo?: string;
  }
}
import type { crearRepoCola, crearRepoResultados, crearRepoTrabajos } from '../persistencia/repositorios.js';

export interface DepsWebhook {
  cola: ReturnType<typeof crearRepoCola>;
  trabajos: ReturnType<typeof crearRepoTrabajos>;
  resultados: ReturnType<typeof crearRepoResultados>;
  secreto: string;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export function registrarWebhooks(app: FastifyInstance, deps: DepsWebhook): void {
  // Parser global de JSON que además guarda el cuerpo crudo en la petición.
  // Reserializar el JSON cambiaría los bytes y la firma dejaría de coincidir, así
  // que hay que capturarlo aquí; el resto de las rutas sigue recibiendo el objeto
  // parseado de siempre.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, cuerpo, done) => {
    const texto = cuerpo as string;
    req.cuerpoCrudo = texto;
    if (texto.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(texto));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.post('/webhooks/postcall', async (req: FastifyRequest, reply: FastifyReply) => {
    const crudo = req.cuerpoCrudo;
    const json = req.body as Record<string, unknown> | undefined;
    if (crudo === undefined || !json) return reply.code(400).send({ error: 'Cuerpo ilegible' });

    const cabecera =
      (req.headers['elevenlabs-signature'] as string | undefined) ??
      (req.headers['x-elevenlabs-signature'] as string | undefined);

    const v = verificarFirma(crudo, cabecera, deps.secreto);
    if (!v.valida) {
      deps.log.warn({ motivo: v.motivo }, 'Webhook rechazado por firma');
      return reply.code(401).send({ error: 'Firma inválida' });
    }

    const tipo = String(json['type'] ?? 'desconocido');
    const data = (json['data'] ?? {}) as Record<string, unknown>;
    const idConversacion =
      typeof data['conversation_id'] === 'string' ? (data['conversation_id'] as string) : null;

    // Persistir primero. Todo lo demás puede fallar y ser reintentado.
    const idEvento = deps.cola.encolar(tipo, idConversacion, json);
    deps.log.info({ idEvento, tipo, idConversacion }, 'Evento encolado');

    return reply.code(200).send({ recibido: true, idEvento });
  });

  /** Salud del servicio, incluida la profundidad de la cola: si crece, algo falla. */
  app.get('/salud', async () => ({
    ok: true,
    eventosPendientes: deps.cola.pendientes(),
    ts: new Date().toISOString(),
  }));

  /** Cola de revisión humana. Es la bandeja de entrada del equipo clínico. */
  app.get('/revision', async () => ({
    pendientes: deps.resultados.colaDeRevision(),
  }));
}

/**
 * Trabajador de la cola. Procesa eventos ya persistidos.
 * Se ejecuta en intervalo; cada evento fallido queda pendiente y se reintenta.
 */
export function crearTrabajadorCola(deps: DepsWebhook) {
  return {
    procesarLote(limite = 25): { procesados: number; errores: number } {
      let procesados = 0;
      let errores = 0;
      for (const ev of deps.cola.tomarPendientes(limite)) {
        try {
          manejarEvento(deps, ev.tipo, ev.idConversacion, ev.payload);
          deps.cola.marcarProcesado(ev.id);
          procesados++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          deps.cola.marcarError(ev.id, msg);
          deps.log.error({ idEvento: ev.id, error: msg }, 'Error procesando evento');
          errores++;
        }
      }
      return { procesados, errores };
    },
  };
}

function manejarEvento(deps: DepsWebhook, tipo: string, idConversacion: string | null, payload: unknown): void {
  switch (tipo) {
    case 'post_call_transcription': {
      if (!idConversacion) throw new Error('Evento de transcripción sin id de conversación');
      const t = deps.trabajos.porConversacion(idConversacion);
      if (t) deps.trabajos.marcar(t.id, 'completado');
      // El resultado clínico ya fue calculado y guardado por el endpoint de LLM al
      // cerrar la llamada. Este evento solo cierra el trabajo y aporta metadatos.
      deps.log.info({ idConversacion }, 'Llamada cerrada');
      break;
    }
    case 'call_initiation_failure': {
      if (idConversacion) {
        const t = deps.trabajos.porConversacion(idConversacion);
        if (t) deps.trabajos.marcar(t.id, 'fallido');
      }
      deps.log.warn({ idConversacion, payload }, 'La llamada no se estableció');
      break;
    }
    case 'post_call_audio':
      // No se almacena audio en este servicio. La política de conservación se
      // define y publica según el art. 14 ter i) y se aplica en la plataforma.
      deps.log.info({ idConversacion }, 'Evento de audio descartado por política de retención');
      break;
    default:
      deps.log.info({ tipo, idConversacion }, 'Evento no manejado');
  }
}
