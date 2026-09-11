import { z } from 'zod';

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

  /** Credenciales de la plataforma de voz. Solo para despacho de llamadas salientes. */
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_PHONE_NUMBER_ID: z.string().optional(),
  ELEVENLABS_BASE_URL: z.string().default('https://api.elevenlabs.io'),

  /** Número al que se transfieren las llamadas que requieren una persona. */
  NUMERO_TRANSFERENCIA: z.string().default(''),

  /**
   * Concurrencia máxima de llamadas salientes. Debe quedar por debajo del límite
   * del plan contratado, reservando capacidad para entrantes.
   */
  CONCURRENCIA_MAX: z.coerce.number().int().positive().default(10),

  /** Días de retención del audio. La transcripción no se almacena en este servicio. */
  RETENCION_AUDIO_DIAS: z.coerce.number().int().nonnegative().default(0),

  NIVEL_LOG: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
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
    if (problemas.length > 0) {
      throw new Error(
        `No se puede arrancar en producción con estos valores sin definir: ${problemas.join(', ')}. ` +
          'Un agente clínico sin ruta de transferencia a persona no debe operar.',
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
