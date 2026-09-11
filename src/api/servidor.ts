import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/index.js';
import { abrirDB, type DB } from '../persistencia/db.js';
import {
  crearRepoAuditoria,
  crearRepoCola,
  crearRepoResultados,
  crearRepoSesiones,
  crearRepoTrabajos,
} from '../persistencia/repositorios.js';
import { crearClasificador } from '../llm/clasificador.js';
import { registrarEndpointLLM } from '../llm/servidor.js';
import { crearTrabajadorCola, registrarWebhooks } from '../webhooks/receptor.js';
import { ClienteElevenLabs, ClienteVozSimulado, type ClienteVoz } from '../telefonia/elevenlabs.js';
import { crearDespachador } from '../telefonia/despachador.js';
import { conciliar } from '../conciliacion/conciliar.js';

export interface Servicio {
  app: FastifyInstance;
  db: DB;
  despachador: ReturnType<typeof crearDespachador>;
  trabajador: ReturnType<typeof crearTrabajadorCola>;
  conciliar: () => ReturnType<typeof conciliar>;
  cerrar: () => Promise<void>;
}

export function construirServicio(cfg: Config, clienteVoz?: ClienteVoz): Servicio {
  const db = abrirDB(cfg.DB_RUTA);
  const trabajos = crearRepoTrabajos(db);
  const cola = crearRepoCola(db);
  const resultados = crearRepoResultados(db);
  const auditoria = crearRepoAuditoria(db);
  const sesiones = crearRepoSesiones(db);

  const cliente: ClienteVoz =
    clienteVoz ??
    (cfg.ELEVENLABS_API_KEY && cfg.ELEVENLABS_AGENT_ID && cfg.ELEVENLABS_PHONE_NUMBER_ID
      ? new ClienteElevenLabs({
          baseUrl: cfg.ELEVENLABS_BASE_URL,
          apiKey: cfg.ELEVENLABS_API_KEY,
          agentId: cfg.ELEVENLABS_AGENT_ID,
          phoneNumberId: cfg.ELEVENLABS_PHONE_NUMBER_ID,
        })
      : new ClienteVozSimulado());

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

  registrarWebhooks(app, { cola, trabajos, resultados, secreto: cfg.WEBHOOK_SECRETO, log });
  registrarEndpointLLM(app, {
    clasificador: crearClasificador(cfg),
    sesiones,
    auditoria,
    resultados,
    numeroTransferencia: cfg.NUMERO_TRANSFERENCIA,
    token: cfg.LLM_TOKEN,
    log,
  });

  const despachador = crearDespachador({ trabajos, sesiones, cliente, concurrenciaMax: cfg.CONCURRENCIA_MAX, log });
  const trabajador = crearTrabajadorCola({ cola, trabajos, resultados, secreto: cfg.WEBHOOK_SECRETO, log });

  // Programación de llamadas. Endpoint interno: el sistema clínico de FALP empuja
  // aquí las indicaciones ya emitidas por el equipo tratante.
  app.post('/llamadas', async (req, reply) => {
    const b = req.body as { idPaciente?: string; telefono?: string; contexto?: unknown; programadoPara?: string };
    if (!b?.idPaciente || !b?.telefono || !b?.contexto) {
      return reply.code(400).send({ error: 'Faltan idPaciente, telefono o contexto' });
    }
    const r = despachador.programar({
      idPaciente: b.idPaciente,
      telefono: b.telefono,
      contexto: b.contexto,
      ...(b.programadoPara ? { programadoPara: b.programadoPara } : {}),
    });
    return r.ok ? reply.code(201).send(r) : reply.code(422).send(r);
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

  return {
    app,
    db,
    despachador,
    trabajador,
    conciliar: () => conciliar({ trabajos, resultados, log }),
    async cerrar() {
      await app.close();
      db.close();
    },
  };
}
