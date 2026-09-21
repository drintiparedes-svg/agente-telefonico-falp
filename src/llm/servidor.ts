/**
 * Endpoint de LLM propio, compatible con la API de chat completions.
 *
 * Esto es lo que ElevenLabs invoca en cada turno de la conversación. Desde su
 * punto de vista es un modelo de lenguaje; en realidad es la máquina de estados
 * de FALP. La plataforma aporta voz, telefonía y gestión de turnos; ninguna
 * decisión clínica ocurre fuera de este proceso.
 *
 * Contrato que la plataforma exige:
 *   - Content-Type: text/event-stream
 *   - chunks `data: {json}\n\n`
 *   - cierre con `data: [DONE]\n\n`
 *   - function calling en formato OpenAI para las herramientas de sistema
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { abrir, avanzar, validarSalida } from '../dominio/checklist/maquina.js';
import { evaluar } from '../dominio/criterios/index.js';
import { detectarBanderaRoja } from '../dominio/guardrails/index.js';
import { ContextoLlamada, type MotivoEnrutamiento } from '../dominio/tipos.js';
import { extraerIdConversacionDelPrompt } from '../telefonia/agente.js';
import { argumentosTransferencia, motivoDesdeEstado } from '../telefonia/transferencias.js';
import type { Clasificador } from './clasificador.js';
import type { crearRepoAuditoria, crearRepoResultados, crearRepoSesiones } from '../persistencia/repositorios.js';

const Mensaje = z.object({
  role: z.string(),
  content: z.union([z.string(), z.null()]).optional(),
});

const Peticion = z.object({
  model: z.string().optional(),
  messages: z.array(Mensaje),
  stream: z.boolean().optional(),
  /** Variables dinámicas que la plataforma reenvía. Ahí viaja el id de conversación. */
  elevenlabs_extra_body: z.record(z.unknown()).optional(),
  user: z.string().optional(),
});

export interface DepsLLM {
  clasificador: Clasificador;
  sesiones: ReturnType<typeof crearRepoSesiones>;
  auditoria: ReturnType<typeof crearRepoAuditoria>;
  resultados: ReturnType<typeof crearRepoResultados>;
  /** Número al que transferir según motivo y servicio. En producción nunca es vacío. */
  resolverTransferencia: (p: { motivo: MotivoEnrutamiento; servicio?: string | undefined }) => string;
  token: string;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

export function registrarEndpointLLM(app: FastifyInstance, deps: DepsLLM): void {
  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${deps.token}`) {
      return reply.code(401).send({ error: { message: 'No autorizado', type: 'invalid_request_error' } });
    }

    const parsed = Peticion.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: 'Petición inválida', type: 'invalid_request_error' } });
    }
    const p = parsed.data;

    const candidatos = candidatosIdConversacion(req, p);
    if (candidatos.length === 0) {
      return reply.code(400).send({
        error: { message: 'Falta el identificador de conversación', type: 'invalid_request_error' },
      });
    }

    // El identificador puede llegar por varias vías y la plataforma puede haber
    // reemplazado el propuesto por el suyo: vale el primero que tenga sesión.
    const encontrado = candidatos
      .map((id) => ({ id, sesion: deps.sesiones.cargar(id) }))
      .find((c) => c.sesion !== null);
    if (!encontrado?.sesion) {
      // Sin sesión precargada no hay indicación clínica verificada y por lo tanto
      // no hay nada lícito que decir. Se corta en vez de improvisar.
      deps.log.error({ candidatos }, 'Turno recibido sin sesión precargada');
      return responder(reply, {
        texto: 'Disculpe, no puedo continuar en este momento. Le llamaremos nuevamente.',
        herramienta: 'end_call',
        argumentos: { reason: 'sesion_no_encontrada' },
      });
    }

    const idConversacion = encontrado.id;
    const { ctx } = encontrado.sesion;
    let st = encontrado.sesion.st;
    const ultimoUsuario = [...p.messages].reverse().find((m) => m.role === 'user');
    const textoPaciente = typeof ultimoUsuario?.content === 'string' ? ultimoUsuario.content : '';

    // Primer turno: el agente abre. En una llamada saliente la plataforma espera
    // a que el interlocutor hable, así que lo primero que llega suele ser un
    // «aló». Eso no es una respuesta al guion y no se clasifica. La única
    // excepción es una bandera roja dicha antes de que el agente hable: un
    // paciente que sangra sigue siendo un paciente que sangra.
    if (st.auditoria.length === 0) {
      const r = abrir(ctx, st);
      deps.sesiones.guardar(idConversacion, ctx, r.estado);
      deps.auditoria.registrar(r.estado.auditoria.slice(st.auditoria.length));
      if (!detectarBanderaRoja(textoPaciente).detectada) {
        return responder(reply, { texto: r.salida });
      }
      st = r.estado;
    }

    const ultimoAgente = [...p.messages].reverse().find((m) => m.role === 'assistant');
    const preguntaDelAgente = typeof ultimoAgente?.content === 'string' ? ultimoAgente.content : '';

    const cls = await deps.clasificador.clasificar({
      textoPaciente,
      estado: st.estado,
      preguntaDelAgente,
    });

    const r = avanzar(ctx, st, textoPaciente, cls);

    // Última compuerta antes de la voz: la línea debe pertenecer al guion.
    const v = validarSalida(ctx, r.salida);
    if (!v.valida) {
      deps.log.error({ idConversacion, salida: r.salida, motivo: v.motivo }, 'Salida fuera del guion');
      return responder(reply, {
        texto: 'Le voy a comunicar con una persona del equipo. No corte, por favor.',
        herramienta: 'transfer_to_number',
        argumentos: transferir(deps, ctx, 'fuera_de_guion'),
      });
    }

    deps.sesiones.guardar(idConversacion, ctx, r.estado);
    deps.auditoria.registrar(r.estado.auditoria.slice(st.auditoria.length));

    if (r.transferir) {
      const res = evaluar(ctx, r.estado);
      deps.resultados.guardar(ctx.idPaciente, res);
      return responder(reply, {
        texto: r.salida,
        herramienta: 'transfer_to_number',
        argumentos: transferir(deps, ctx, motivoDesdeEstado(r.estado.estado)),
      });
    }

    if (r.terminar) {
      const res = evaluar(ctx, r.estado);
      deps.resultados.guardar(ctx.idPaciente, res);
      deps.sesiones.borrar(idConversacion);
      return responder(reply, {
        texto: r.salida,
        herramienta: 'end_call',
        argumentos: { reason: r.estado.estado },
      });
    }

    return responder(reply, { texto: r.salida });
  });
}

/** Resuelve el destino y arma los argumentos que la plataforma exige para transferir. */
function transferir(deps: DepsLLM, ctx: ContextoLlamada, motivo: MotivoEnrutamiento): Record<string, string> {
  const e164 = deps.resolverTransferencia({ motivo, servicio: ctx.servicio });
  return argumentosTransferencia({ e164, motivo, idLlamada: ctx.idLlamada });
}

/**
 * Identificadores de conversación que trae la petición, en orden de confianza:
 * cabecera propia, el marcador que este servicio dejó en el prompt de sistema
 * del agente (la plataforma sustituye ahí su propio id de conversación), el
 * cuerpo extra que la plataforma reenvía desde la originación, y el campo
 * `user`. Se devuelven todos porque la plataforma puede haber reemplazado el
 * id propuesto por el suyo y la sesión estar indexada por cualquiera de los dos.
 */
export function candidatosIdConversacion(req: FastifyRequest, p: z.infer<typeof Peticion>): string[] {
  const ids: string[] = [];
  const agregar = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0 && !ids.includes(v)) ids.push(v);
  };
  agregar(req.headers['x-conversation-id']);
  for (const m of p.messages) {
    if (m.role === 'system' && typeof m.content === 'string') agregar(extraerIdConversacionDelPrompt(m.content));
  }
  const extra = p.elevenlabs_extra_body;
  if (extra) for (const clave of ['conversation_id', 'system__conversation_id', 'idConversacion']) agregar(extra[clave]);
  agregar(p.user);
  return ids;
}

interface Salida {
  texto: string;
  herramienta?: 'end_call' | 'transfer_to_number';
  argumentos?: Record<string, unknown>;
}

/** Emite la respuesta en el formato de streaming que la plataforma espera. */
function responder(reply: FastifyReply, s: Salida): FastifyReply {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const creado = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created: creado, model: 'falp-checklist-v1' };

  const escribir = (delta: Record<string, unknown>, finish: string | null) => {
    reply.raw.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  };

  escribir({ role: 'assistant' }, null);

  // El texto se envía en fragmentos por frase: la capa de voz empieza a hablar
  // antes de recibir el turno completo y eso recorta la latencia percibida.
  for (const trozo of trocear(s.texto)) escribir({ content: trozo }, null);

  if (s.herramienta) {
    escribir(
      {
        tool_calls: [
          {
            index: 0,
            id: `call_${Date.now().toString(36)}`,
            type: 'function',
            function: { name: s.herramienta, arguments: JSON.stringify(s.argumentos ?? {}) },
          },
        ],
      },
      null,
    );
    escribir({}, 'tool_calls');
  } else {
    escribir({}, 'stop');
  }

  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
  return reply;
}

/**
 * Trocea por frase conservando toda la puntuación, incluidos los signos de
 * apertura del español. La concatenación de los trozos reproduce el texto exacto.
 */
export function trocear(texto: string): string[] {
  if (texto === '') return [];
  const partes = texto.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g);
  return partes && partes.length > 0 ? partes : [texto];
}
