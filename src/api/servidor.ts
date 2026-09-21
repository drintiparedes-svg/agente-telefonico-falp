import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config/index.js';
import { MOTIVOS_ENRUTAMIENTO } from '../dominio/tipos.js';
import { abrirDB, type DB } from '../persistencia/db.js';
import {
  crearRepoAuditoria,
  crearRepoCola,
  crearRepoDestinos,
  crearRepoNumeros,
  crearRepoResultados,
  crearRepoSesiones,
  crearRepoTrabajos,
} from '../persistencia/repositorios.js';
import { crearClasificador, type Clasificador } from '../llm/clasificador.js';
import { registrarEndpointLLM } from '../llm/servidor.js';
import { crearTrabajadorCola, registrarWebhooks } from '../webhooks/receptor.js';
import { ClienteElevenLabs, ClienteVozSimulado, type ClienteVoz } from '../telefonia/elevenlabs.js';
import { crearDespachador, dentroDeVentana, MARGEN_EN_CURSO_MIN } from '../telefonia/despachador.js';
import { reglasParaAgente, resolverDestino } from '../telefonia/transferencias.js';
import { compararAgente, cuerpoAgente, type DefinicionAgente } from '../telefonia/agente.js';
import { conciliar } from '../conciliacion/conciliar.js';
import { resumirLlamada } from './estado-llamada.js';

/**
 * Rutas que tratan datos de pacientes y que usan los sistemas clientes. Con
 * INTEGRACION_TOKEN definido exigen `Authorization: Bearer <token>`. Las demás
 * rutas tienen su propia autenticación (/v1, /webhooks, /admin, /tareas) o son
 * públicas por diseño (/salud).
 */
export const RUTAS_DE_INTEGRACION = ['/llamadas', '/auditoria', '/revision', '/conciliacion'] as const;

export function esRutaDeIntegracion(url: string): boolean {
  const ruta = url.split('?')[0] ?? '';
  return RUTAS_DE_INTEGRACION.some((r) => ruta === r || ruta.startsWith(`${r}/`));
}

/** Variables sin las cuales no se puede escribir la definición del agente. */
export function faltantesParaAgente(cfg: Config): string[] {
  const faltan: string[] = [];
  if (!cfg.SERVICIO_URL_PUBLICA) faltan.push('SERVICIO_URL_PUBLICA');
  if (!cfg.ELEVENLABS_VOICE_ID && !cfg.ELEVENLABS_VOICE_NOMBRE) faltan.push('ELEVENLABS_VOICE_ID');
  return faltan;
}

/**
 * Identificador de la voz. Manda ELEVENLABS_VOICE_ID; si no está, se busca en
 * el workspace por ELEVENLABS_VOICE_NOMBRE. Una coincidencia ambigua o ausente
 * es un error: la voz con que se habla a un paciente no se adivina.
 */
export async function resolverVoz(
  cfg: Config,
  cliente: ClienteVoz,
): Promise<{ ok: true; voiceId: string; origen: 'id' | 'nombre' } | { ok: false; error: string }> {
  if (cfg.ELEVENLABS_VOICE_ID) return { ok: true, voiceId: cfg.ELEVENLABS_VOICE_ID, origen: 'id' };
  const r = await cliente.buscarVoz(cfg.ELEVENLABS_VOICE_NOMBRE);
  if (!r.ok) return { ok: false, error: `No se pudo buscar la voz «${cfg.ELEVENLABS_VOICE_NOMBRE}»: ${r.error}` };
  if (r.voz) return { ok: true, voiceId: r.voz.voiceId, origen: 'nombre' };
  if (r.candidatas.length === 0) {
    return { ok: false, error: `No hay ninguna voz llamada «${cfg.ELEVENLABS_VOICE_NOMBRE}» en el workspace. Agréguela a la biblioteca o defina ELEVENLABS_VOICE_ID.` };
  }
  const lista = r.candidatas.map((v) => `${v.voiceId} (${JSON.stringify(v.etiquetas)})`).join('; ');
  return { ok: false, error: `Hay ${r.candidatas.length} voces llamadas «${cfg.ELEVENLABS_VOICE_NOMBRE}»: ${lista}. Defina ELEVENLABS_VOICE_ID con la correcta.` };
}

/** Definición del agente a partir de la configuración y de los destinos vigentes. */
export function definicionAgente(
  cfg: Config,
  p: { secretIdLlm: string; voiceId: string; reglas: DefinicionAgente['reglas']; webhookPostLlamadaId?: string | null },
): DefinicionAgente {
  return {
    nombre: cfg.ELEVENLABS_AGENTE_NOMBRE,
    urlPublica: cfg.SERVICIO_URL_PUBLICA ?? '',
    secretIdLlm: p.secretIdLlm,
    voiceId: p.voiceId,
    ttsModelo: cfg.ELEVENLABS_TTS_MODELO,
    idioma: cfg.ELEVENLABS_IDIOMA,
    retencionCero: cfg.ELEVENLABS_RETENCION_CERO,
    retencionDias: cfg.RETENCION_AUDIO_DIAS,
    webhookPostLlamadaId: p.webhookPostLlamadaId ?? cfg.ELEVENLABS_POSTCALL_WEBHOOK_ID ?? null,
    reglas: p.reglas,
    voz: { estabilidad: cfg.VOZ_ESTABILIDAD, similitud: cfg.VOZ_SIMILITUD, velocidad: cfg.VOZ_VELOCIDAD },
    fondo: { tipo: cfg.FONDO_SONIDO, volumen: cfg.FONDO_VOLUMEN },
  };
}

/**
 * Agente sobre el que se opera. Manda ELEVENLABS_AGENT_ID; sin él se busca por
 * ELEVENLABS_AGENTE_NOMBRE en el workspace y se exige una coincidencia única.
 * Si no existe, hay que aprovisionarlo (`npm run aprovisionar`).
 */
export async function resolverAgente(
  cfg: Config,
  cliente: ClienteVoz,
): Promise<{ ok: true; agentId: string; origen: 'id' | 'nombre' } | { ok: false; error: string }> {
  if (cfg.ELEVENLABS_AGENT_ID) {
    cliente.usarAgente(cfg.ELEVENLABS_AGENT_ID);
    return { ok: true, agentId: cfg.ELEVENLABS_AGENT_ID, origen: 'id' };
  }
  const b = await cliente.buscarAgente(cfg.ELEVENLABS_AGENTE_NOMBRE);
  if (!b.ok) return { ok: false, error: `No se pudo buscar el agente «${cfg.ELEVENLABS_AGENTE_NOMBRE}»: ${b.error}` };
  if (b.agente) {
    cliente.usarAgente(b.agente.agentId);
    return { ok: true, agentId: b.agente.agentId, origen: 'nombre' };
  }
  if (b.candidatos.length > 1) {
    return { ok: false, error: `Hay ${b.candidatos.length} agentes llamados «${cfg.ELEVENLABS_AGENTE_NOMBRE}»: ${b.candidatos.map((a) => a.agentId).join(', ')}. Defina ELEVENLABS_AGENT_ID.` };
  }
  return { ok: false, error: `No existe ningún agente llamado «${cfg.ELEVENLABS_AGENTE_NOMBRE}». Ejecute npm run aprovisionar o defina ELEVENLABS_AGENT_ID.` };
}

/**
 * Escribe la definición completa del agente en la plataforma: secreto del token,
 * LLM propio, voz, idioma, privacidad, herramientas y reglas de transferencia.
 * Es la única vía sancionada para cambiar el agente; el panel es solo lectura.
 */
export async function sincronizarAgente(
  cfg: Config,
  cliente: ClienteVoz,
  reglas: DefinicionAgente['reglas'],
): Promise<
  | { ok: true; agentId: string; reglas: number; voiceId: string; secretoCreado: boolean; discrepanciasPrevias: ReturnType<typeof compararAgente> }
  | { ok: false; error: string; faltan?: string[] }
> {
  const faltan = faltantesParaAgente(cfg);
  if (faltan.length > 0) return { ok: false, error: `Faltan variables para definir el agente: ${faltan.join(', ')}`, faltan };

  const agente = await resolverAgente(cfg, cliente);
  if (!agente.ok) return { ok: false, error: agente.error };

  const voz = await resolverVoz(cfg, cliente);
  if (!voz.ok) return { ok: false, error: voz.error };

  const secreto = await cliente.asegurarSecreto(cfg.ELEVENLABS_SECRETO_LLM_NOMBRE, cfg.LLM_TOKEN);
  if (!secreto.ok) return { ok: false, error: `No se pudo escribir el secreto del token: ${secreto.error}` };

  const definicion = definicionAgente(cfg, { secretIdLlm: secreto.secretId, voiceId: voz.voiceId, reglas });
  const previo = await cliente.leerAgente();
  const discrepanciasPrevias = previo.ok ? compararAgente(definicion, previo.datos) : [];

  const r = await cliente.escribirAgente(cuerpoAgente(definicion));
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, agentId: agente.agentId, reglas: reglas.length, voiceId: voz.voiceId, secretoCreado: secreto.creado, discrepanciasPrevias };
}

export interface Servicio {
  app: FastifyInstance;
  db: DB;
  despachador: ReturnType<typeof crearDespachador>;
  trabajador: ReturnType<typeof crearTrabajadorCola>;
  numeros: ReturnType<typeof crearRepoNumeros>;
  destinos: ReturnType<typeof crearRepoDestinos>;
  conciliar: () => ReturnType<typeof conciliar>;
  cerrar: () => Promise<void>;
}

export interface OpcionesServicio {
  /** Sustituye la pausa entre originaciones. Solo para pruebas. */
  esperar?: (ms: number) => Promise<void>;
  /** Reloj del despacho inmediato. Solo para pruebas. */
  reloj?: () => Date;
  /** Sustituye el clasificador que define la configuración. Solo para pruebas. */
  clasificador?: Clasificador;
}

const CambioNumero = z
  .object({
    activo: z.boolean().optional(),
    concurrenciaMax: z.number().int().min(1).max(500).optional(),
    prioridad: z.number().int().min(0).optional(),
    etiqueta: z.string().max(100).optional(),
  })
  .strict();

const Destino = z
  .object({
    e164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Debe estar en formato E.164, por ejemplo +56221234567'),
    etiqueta: z.string().max(100).default(''),
    motivo: z.enum([...MOTIVOS_ENRUTAMIENTO, 'general'] as const),
    servicio: z.string().max(100).default(''),
    horaDesde: z.number().int().min(0).max(23).default(0),
    horaHasta: z.number().int().min(1).max(24).default(24),
    dias: z.string().regex(/^[1-7]{1,7}$/).default('1234567'),
    prioridad: z.number().int().min(0).default(100),
    activo: z.boolean().default(true),
  })
  .strict()
  .refine((d) => d.horaDesde < d.horaHasta, { message: 'horaDesde debe ser menor que horaHasta' });

export function construirServicio(cfg: Config, clienteVoz?: ClienteVoz, opciones: OpcionesServicio = {}): Servicio {
  const db = abrirDB(cfg.DB_RUTA);
  const trabajos = crearRepoTrabajos(db);
  const cola = crearRepoCola(db);
  const resultados = crearRepoResultados(db);
  const auditoria = crearRepoAuditoria(db);
  const sesiones = crearRepoSesiones(db);
  const numeros = crearRepoNumeros(db);
  const destinos = crearRepoDestinos(db);

  // Con clave se usa la plataforma real. El agente puede venir por id o
  // resolverse por nombre en /admin/agente; para originar llamadas hace falta
  // el id, y en producción la configuración lo exige.
  const cliente: ClienteVoz =
    clienteVoz ??
    (cfg.ELEVENLABS_API_KEY
      ? new ClienteElevenLabs({
          baseUrl: cfg.ELEVENLABS_BASE_URL,
          apiKey: cfg.ELEVENLABS_API_KEY,
          agentId: cfg.ELEVENLABS_AGENT_ID ?? '',
        })
      : new ClienteVozSimulado());

  // Arranque mínimo del grupo de números. En producción se administra por
  // /admin/numeros; estas dos vías solo evitan arrancar sin ninguno.
  if (cfg.ELEVENLABS_PHONE_NUMBER_ID) {
    numeros.sembrar({
      idPlataforma: cfg.ELEVENLABS_PHONE_NUMBER_ID,
      e164: '',
      etiqueta: 'Configurado por entorno',
      proveedor: cfg.TELEFONIA_PROVEEDOR,
      activo: true,
      concurrenciaMax: cfg.CONCURRENCIA_MAX,
      prioridad: 100,
    });
  } else if (cliente instanceof ClienteVozSimulado && numeros.listar().length === 0) {
    // Sin plataforma real, un número simulado permite ensayar el despacho completo.
    numeros.sembrar({
      idPlataforma: 'simulado-1',
      e164: '+56200000000',
      etiqueta: 'Número simulado',
      proveedor: 'twilio',
      activo: true,
      concurrenciaMax: cfg.CONCURRENCIA_MAX,
      prioridad: 100,
    });
  }

  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logger: {
      level: cfg.NIVEL_LOG,
      // El contenido de las conversaciones no se escribe en el log de aplicación:
      // la trazabilidad clínica vive en la tabla de auditoría, con control de acceso.
      redact: { paths: ['req.headers.authorization', 'req.headers["xi-api-key"]'], censor: '***' },
      ...(cfg.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  const log = app.log;

  if (cfg.INTEGRACION_TOKEN) {
    const token = cfg.INTEGRACION_TOKEN;
    app.addHook('onRequest', async (req, reply) => {
      if (!esRutaDeIntegracion(req.url)) return undefined;
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply.code(401).send({ error: 'No autorizado' });
        return reply;
      }
      return undefined;
    });
  }

  registrarWebhooks(app, { cola, trabajos, resultados, secreto: cfg.WEBHOOK_SECRETO, log });
  registrarEndpointLLM(app, {
    clasificador: opciones.clasificador ?? crearClasificador(cfg),
    sesiones,
    auditoria,
    resultados,
    resolverTransferencia: (p) =>
      resolverDestino(destinos.activos(), { ...p, ahora: new Date() }, cfg.NUMERO_TRANSFERENCIA).e164,
    token: cfg.LLM_TOKEN,
    expresionesPausa: cfg.EXPRESIONES_PAUSA === 'si',
    log,
  });

  const despachador = crearDespachador({
    trabajos,
    sesiones,
    numeros,
    cliente,
    concurrenciaMax: cfg.CONCURRENCIA_MAX,
    llamadasPorSegundo: cfg.TWILIO_CPS,
    ...(opciones.esperar ? { esperar: opciones.esperar } : {}),
    log,
  });
  const trabajador = crearTrabajadorCola({ cola, trabajos, resultados, secreto: cfg.WEBHOOK_SECRETO, log });

  // Programación de llamadas. Endpoint interno: el sistema clínico de FALP empuja
  // aquí las indicaciones ya emitidas por el equipo tratante.
  app.post('/llamadas', async (req, reply) => {
    const b = req.body as {
      idPaciente?: string;
      telefono?: string;
      contexto?: unknown;
      programadoPara?: string;
      /**
       * Intentar originar en esta misma petición, sin esperar al ciclo del
       * despachador. Para quien programa una llamada y espera que suene ahora.
       * Se respetan igual la ventana horaria y la capacidad: si no se puede,
       * la llamada queda en cola y la respuesta lo dice.
       */
      inmediata?: boolean;
    };
    if (!b?.idPaciente || !b?.telefono || !b?.contexto) {
      return reply.code(400).send({ error: 'Faltan idPaciente, telefono o contexto' });
    }
    const r = despachador.programar({
      idPaciente: b.idPaciente,
      telefono: b.telefono,
      contexto: b.contexto,
      ...(b.programadoPara ? { programadoPara: b.programadoPara } : {}),
    });
    if (!r.ok) return reply.code(r.duplicado ? 409 : 422).send(r);

    if (b.inmediata === true && r.idTrabajo) {
      const ahora = (opciones.reloj ?? (() => new Date()))();
      await despachador.despacharLote(ahora);
      const t = trabajos.porId(r.idTrabajo);
      const originada = t?.estado === 'despachado';
      // El motivo se decide con lo que se sabe, no adivinando desde el lote.
      const motivo = originada
        ? 'La llamada se originó.'
        : t?.estado === 'fallido'
          ? 'La plataforma no aceptó la llamada.'
          // «Vencida» la decide el repositorio con el reloj real; aquí igual.
          : t && new Date(t.programadoPara).getTime() > Date.now() + 1000
            ? `Programada para ${t.programadoPara}: saldrá a su hora.`
            : !dentroDeVentana(ahora)
              ? 'Fuera de ventana horaria: la llamada queda en cola y sale a partir de las 9 de la mañana, de lunes a sábado.'
              : numeros.activos().length === 0
                ? 'Sin números de salida activos: la llamada queda en cola.'
                : 'Sin capacidad libre en este momento: la llamada queda en cola.';
      return reply.code(201).send({ ...r, despacho: { intentado: true, originada, motivo } });
    }
    return reply.code(201).send({ ...r, despacho: { intentado: false, originada: false, motivo: 'La llamada queda en cola.' } });
  });

  // Resumen de una llamada para el sistema que la programó: en qué está y, si
  // terminó, el desenlace. No incluye lo que dijo el paciente.
  app.get('/llamadas/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = trabajos.porId(id);
    if (!t) return reply.code(404).send({ error: 'No hay ninguna llamada con ese identificador.' });
    return resumirLlamada(t, resultados.porLlamada(id));
  });

  app.get('/auditoria/:idLlamada', async (req) => {
    const { idLlamada } = req.params as { idLlamada: string };
    return { eventos: auditoria.porLlamada(idLlamada) };
  });

  app.get('/conciliacion', async () => conciliar({ trabajos, resultados, log }));

  // Tareas de fondo como endpoints. En un proceso persistente las dispara
  // `src/index.ts` con temporizadores; en una plataforma serverless las dispara
  // un cron HTTP. Solo existen si hay CRON_SECRET, y exigen ese secreto.
  if (cfg.CRON_SECRET) {
    const secreto = cfg.CRON_SECRET;
    app.get('/tareas/:tarea', async (req, reply) => {
      if (req.headers.authorization !== `Bearer ${secreto}`) {
        return reply.code(401).send({ error: 'No autorizado' });
      }
      const { tarea } = req.params as { tarea: string };
      switch (tarea) {
        case 'cola':
          return trabajador.procesarLote();
        case 'despacho':
          return despachador.despacharLote();
        case 'conciliacion':
          return conciliar({ trabajos, resultados, log });
        default:
          return reply.code(404).send({ error: 'Tarea desconocida' });
      }
    });
  }

  // Administración de telefonía: números de salida, destinos de transferencia y
  // reglas del agente. Solo existe si hay ADMIN_TOKEN, y exige ese token.
  if (cfg.ADMIN_TOKEN) {
    const token = cfg.ADMIN_TOKEN;
    void app.register(
      async (admin) => {
        admin.addHook('onRequest', async (req, reply) => {
          if (req.headers.authorization !== `Bearer ${token}`) {
            reply.code(401).send({ error: 'No autorizado' });
            return reply;
          }
          return undefined;
        });

        admin.get('/numeros', async () => {
          const desde = new Date(Date.now() - MARGEN_EN_CURSO_MIN * 60_000).toISOString();
          const { total, porNumero } = trabajos.enCurso(desde);
          return {
            concurrenciaGlobal: { maxima: cfg.CONCURRENCIA_MAX, enCurso: total },
            llamadasPorSegundo: cfg.TWILIO_CPS,
            numeros: numeros.listar().map((n) => ({ ...n, enCurso: porNumero.get(n.idPlataforma) ?? 0 })),
          };
        });

        admin.post('/numeros/sincronizar', async (_req, reply) => {
          try {
            const lista = await cliente.listarNumeros();
            let nuevos = 0;
            for (const n of lista) {
              if (numeros.registrarDesdePlataforma(n, cfg.CONCURRENCIA_POR_NUMERO) === 'nuevo') nuevos++;
            }
            return {
              total: lista.length,
              nuevos,
              actualizados: lista.length - nuevos,
              nota: nuevos > 0 ? 'Los números nuevos quedan inactivos hasta activarlos.' : '',
            };
          } catch (e) {
            return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
          }
        });

        admin.patch('/numeros/:id', async (req, reply) => {
          const p = CambioNumero.safeParse(req.body);
          if (!p.success) {
            return reply.code(400).send({ error: 'Cambio inválido', detalle: p.error.issues.map((i) => i.path.join('.')) });
          }
          const { id } = req.params as { id: string };
          const n = numeros.actualizar(id, p.data);
          return n ?? reply.code(404).send({ error: 'Número desconocido' });
        });

        admin.get('/destinos', async () => ({ destinos: destinos.listar(), respaldo: cfg.NUMERO_TRANSFERENCIA }));

        admin.put('/destinos/:id', async (req, reply) => {
          const p = Destino.safeParse(req.body);
          if (!p.success) {
            return reply.code(400).send({ error: 'Destino inválido', detalle: p.error.issues.map((i) => i.message) });
          }
          const { id } = req.params as { id: string };
          destinos.guardar({ id, ...p.data });
          return { ok: true, id, aviso: 'Sincronice el agente para que la plataforma acepte este destino.' };
        });

        // Estado del agente en la plataforma frente a la definición de este
        // servicio. Una discrepancia es un cambio hecho a mano en el panel.
        admin.get('/agente', async (_req, reply) => {
          const faltan = faltantesParaAgente(cfg);
          if (faltan.length > 0) return reply.code(422).send({ error: 'Definición incompleta', faltan });
          const reglas = reglasParaAgente(destinos.activos(), cfg.NUMERO_TRANSFERENCIA, cfg.TRANSFERENCIA_TIPO);
          const agente = await resolverAgente(cfg, cliente);
          if (!agente.ok) return reply.code(502).send({ error: agente.error });
          const voz = await resolverVoz(cfg, cliente);
          if (!voz.ok) return reply.code(502).send({ error: voz.error });
          const actual = await cliente.leerAgente();
          if (!actual.ok) return reply.code(502).send({ error: actual.error });
          if (actual.datos === null) return { agentId: agente.agentId, existe: false, voiceId: voz.voiceId, discrepancias: [] };
          // El secreto no se compara: la plataforma no devuelve su valor.
          const discrepancias = compararAgente(definicionAgente(cfg, { secretIdLlm: '', voiceId: voz.voiceId, reglas }), actual.datos);
          return {
            agentId: agente.agentId,
            nombre: cfg.ELEVENLABS_AGENTE_NOMBRE,
            existe: true,
            voiceId: voz.voiceId,
            sincronizado: discrepancias.length === 0,
            discrepancias,
          };
        });

        // Reescribe la definición completa. Reemplaza cualquier cambio manual.
        admin.post('/agente/sincronizar', async (_req, reply) => {
          const reglas = reglasParaAgente(destinos.activos(), cfg.NUMERO_TRANSFERENCIA, cfg.TRANSFERENCIA_TIPO);
          const r = await sincronizarAgente(cfg, cliente, reglas);
          if (r.ok) return r;
          return reply.code(r.faltan ? 422 : 502).send(r);
        });

        // Solo las reglas de transferencia. Más barato tras cambiar un destino.
        admin.post('/agente/sincronizar-destinos', async (_req, reply) => {
          const reglas = reglasParaAgente(destinos.activos(), cfg.NUMERO_TRANSFERENCIA, cfg.TRANSFERENCIA_TIPO);
          const r = await cliente.actualizarReglasTransferencia(reglas);
          return r.ok ? { ok: true, reglas: reglas.length } : reply.code(502).send({ ok: false, error: r.error });
        });
      },
      { prefix: '/admin' },
    );
  }

  return {
    app,
    db,
    despachador,
    trabajador,
    numeros,
    destinos,
    conciliar: () => conciliar({ trabajos, resultados, log }),
    async cerrar() {
      await app.close();
      db.close();
    },
  };
}
