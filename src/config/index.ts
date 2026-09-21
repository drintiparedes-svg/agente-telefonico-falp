import { z } from 'zod';
import { MODELOS_TTS } from '../telefonia/agente.js';

const Esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUERTO: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),

  /** Ruta del archivo SQLite. En producción, un volumen persistente. */
  DB_RUTA: z.string().default('./datos/agente.db'),

  /**
   * Clave con la que ElevenLabs firma los webhooks (HMAC). Sin ella no se
   * acepta ningún resultado de llamada.
   */
  WEBHOOK_SECRETO: z.string().min(16).default('cambiar-en-produccion-secreto-hmac'),

  /** Token que ElevenLabs presenta al llamar al endpoint de LLM propio. */
  LLM_TOKEN: z.string().min(8).default('cambiar-en-produccion-token-llm'),

  /** Proveedor del clasificador. `simulado` no hace red: sirve para pruebas y CI. */
  CLASIFICADOR: z.enum(['simulado', 'anthropic']).default('simulado'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODELO: z.string().default('claude-haiku-4-5'),

  /**
   * Credenciales de la plataforma de voz. Con clave y agente se usa la plataforma
   * real. ELEVENLABS_PHONE_NUMBER_ID es opcional: siembra un número activo al
   * arrancar; en producción el grupo de números se administra en /admin/numeros.
   */
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_PHONE_NUMBER_ID: z.string().optional(),
  ELEVENLABS_BASE_URL: z.string().default('https://api.elevenlabs.io'),

  /**
   * Definición del agente en la plataforma. Con estos valores el servicio
   * escribe la configuración completa del agente (LLM propio, voz, idioma,
   * privacidad, herramientas) y detecta cambios hechos a mano en el panel.
   */
  /** URL pública de este servicio, sin barra final. La plataforma llama a `<URL>/v1/chat/completions`. */
  SERVICIO_URL_PUBLICA: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().refine((u) => u.startsWith('https://'), 'Debe ser https').optional(),
  ),
  /** Nombre del agente en el workspace. Se busca por este nombre cuando no hay ELEVENLABS_AGENT_ID. */
  ELEVENLABS_AGENTE_NOMBRE: z.string().min(1).default('Catalina AI'),
  /**
   * Voz seleccionada y validada con el equipo. Se puede dar por identificador o
   * por nombre; el identificador manda. Con el nombre, el servicio la busca en
   * el workspace y exige una coincidencia exacta y única.
   */
  ELEVENLABS_VOICE_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  ELEVENLABS_VOICE_NOMBRE: z.string().min(1).default('Catalina'),
  ELEVENLABS_TTS_MODELO: z.enum(MODELOS_TTS).default('eleven_flash_v2_5'),
  ELEVENLABS_IDIOMA: z.string().regex(/^[a-z]{2}$/).default('es'),
  /** Nombre del secreto del workspace que guarda LLM_TOKEN. */
  ELEVENLABS_SECRETO_LLM_NOMBRE: z.string().min(1).default('agente-falp-llm-token'),
  /** Webhook post-llamada creado en la plataforma. Lo crea `npm run aprovisionar`. */
  ELEVENLABS_POSTCALL_WEBHOOK_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  /**
   * Retención cero en la plataforma. Es condición para tratar datos de pacientes
   * reales y requiere plan Enterprise; en un workspace sin ese plan la
   * sincronización falla. `false` solo para desarrollo y demostraciones.
   */
  ELEVENLABS_RETENCION_CERO: z
    .preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['true', 'false', '1', '0']))
    .transform((v) => v === 'true' || v === '1')
    .default('true'),

  /**
   * Proveedor con que se importó ELEVENLABS_PHONE_NUMBER_ID. `twilio` es la
   * integración nativa, la única con aviso al operador al transferir.
   */
  TELEFONIA_PROVEEDOR: z.enum(['twilio', 'sip_trunk']).default('twilio'),

  /**
   * Llamadas por segundo que admite la cuenta de Twilio. Twilio parte en 1 y,
   * con perfil de negocio aprobado, permite subirlo a 5 desde su consola.
   */
  TWILIO_CPS: z.coerce.number().positive().max(100).default(1),

  /** Techo de llamadas simultáneas con que entra un número recién sincronizado. */
  CONCURRENCIA_POR_NUMERO: z.coerce.number().int().positive().default(5),

  /** `conference` permite avisar al operador; `blind` conserva el caller ID y no avisa. */
  TRANSFERENCIA_TIPO: z.enum(['conference', 'blind']).default('conference'),

  /**
   * Token que presentan los sistemas que programan llamadas y leen resultados
   * (la agenda, la ficha, un asistente). Protege /llamadas, /auditoria,
   * /revision y /conciliacion. Vacío: esos endpoints quedan abiertos, lo que
   * solo es admisible en desarrollo; en producción es obligatorio.
   */
  INTEGRACION_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),

  /** Token de los endpoints /admin/*. Sin él, esos endpoints no existen. */
  ADMIN_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),

  /**
   * Número de respaldo para transferir a una persona cuando ningún destino de
   * /admin/destinos aplica. En producción es obligatorio.
   */
  NUMERO_TRANSFERENCIA: z.string().default(''),

  /**
   * Concurrencia máxima de llamadas salientes. Debe quedar por debajo del límite
   * del plan contratado, reservando capacidad para entrantes.
   */
  CONCURRENCIA_MAX: z.coerce.number().int().positive().default(10),

  /** Días de retención del audio. La transcripción no se almacena en este servicio. */
  RETENCION_AUDIO_DIAS: z.coerce.number().int().nonnegative().default(0),

  NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Secreto para los endpoints de tareas (`/tareas/*`). Solo hace falta cuando el
   * servicio corre en una plataforma sin procesos persistentes (Vercel) y las
   * tareas de fondo se disparan por cron HTTP. Vacío: los endpoints no existen.
   */
  CRON_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof Esquema>;

let cache: Config | null = null;

export function cargarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cache) return cache;
  const r = Esquema.safeParse(env);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración inválida:\n${detalle}`);
  }
  if (r.data.NODE_ENV === 'production') {
    const problemas: string[] = [];
    if (r.data.WEBHOOK_SECRETO.startsWith('cambiar-en-produccion')) problemas.push('WEBHOOK_SECRETO');
    if (r.data.LLM_TOKEN.startsWith('cambiar-en-produccion')) problemas.push('LLM_TOKEN');
    if (r.data.NUMERO_TRANSFERENCIA === '') problemas.push('NUMERO_TRANSFERENCIA');
    if (!r.data.INTEGRACION_TOKEN) problemas.push('INTEGRACION_TOKEN');
    if (problemas.length > 0) {
      throw new Error(
        `No se puede arrancar en producción con estos valores sin definir: ${problemas.join(', ')}. ` +
          'Un agente clínico sin ruta de transferencia a persona, o con sus resultados abiertos a cualquiera, no debe operar.',
      );
    }
    // Con plataforma real, la retención cero no es opcional: es la condición bajo
    // la cual el análisis de factibilidad admite tratar datos de pacientes.
    if (r.data.ELEVENLABS_API_KEY && !r.data.ELEVENLABS_RETENCION_CERO) {
      throw new Error(
        'ELEVENLABS_RETENCION_CERO=false no es admisible en producción con una plataforma real. ' +
          'Sin retención cero no se pueden tratar datos de pacientes.',
      );
    }
  }
  cache = r.data;
  return cache;
}

/** Solo para pruebas. */
export function _limpiarCacheConfig(): void {
  cache = null;
}
