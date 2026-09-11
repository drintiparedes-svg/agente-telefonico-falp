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
import { crearClasificador } from '../llm/clasificador.js';
import { registrarEndpointLLM } from '../llm/servidor.js';
import { crearTrabajadorCola, registrarWebhooks } from '../webhooks/receptor.js';
import { ClienteElevenLabs, ClienteVozSimulado, type ClienteVoz } from '../telefonia/elevenlabs.js';
import { crearDespachador, MARGEN_EN_CURSO_MIN } from '../telefonia/despachador.js';
import { reglasParaAgente, resolverDestino } from '../telefonia/transferencias.js';
import { conciliar } from '../conciliacion/conciliar.js';

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

  const cliente: ClienteVoz =
    clienteVoz ??
    (cfg.ELEVENLABS_API_KEY && cfg.ELEVENLABS_AGENT_ID
      ? new ClienteElevenLabs({
          baseUrl: cfg.ELEVENLABS_BASE_URL,
          apiKey: cfg.ELEVENLABS_API_KEY,
          agentId: cfg.ELEVENLABS_AGENT_ID,
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

  registrarWebhooks(app, { cola, trabajos, resultados, secreto: cfg.WEBHOOK_SECRETO, log });
  registrarEndpointLLM(app, {
    clasificador: crearClasificador(cfg),
    sesiones,
    auditoria,
    resultados,
    resolverTransferencia: (p) =>
      resolverDestino(destinos.activos(), { ...p, ahora: new Date() }, cfg.NUMERO_TRANSFERENCIA).e164,
    token: cfg.LLM_TOKEN,
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

        admin.post('/agente/sincronizar', async (_req, reply) => {
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
