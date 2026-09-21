/**
 * Definición del agente en la plataforma de voz.
 *
 * La plataforma aporta voz, transcripción, telefonía y gestión de turnos. Todo
 * lo que decide qué se dice vive en este servicio. Este módulo escribe esa
 * división de responsabilidades en la configuración del agente, de modo que un
 * cambio hecho a mano en el panel (otro modelo, otra voz, grabación activada,
 * un prompt con instrucciones) se detecte y se revierta con una sincronización.
 *
 * Nombres de campo según la especificación de la API de ElevenLabs que acompaña
 * al SDK oficial `@elevenlabs/elevenlabs-js` 2.68. La especificación distingue
 * entrada y salida; aquí se escribe solo lo que este servicio necesita fijar.
 */
import type { ReglaTransferencia } from './elevenlabs.js';

/** Modelos de síntesis que la plataforma acepta para agentes conversacionales. */
export const MODELOS_TTS = [
  'eleven_flash_v2_5',
  'eleven_turbo_v2_5',
  'eleven_multilingual_v2',
  'eleven_v3_conversational',
] as const;
export type ModeloTts = (typeof MODELOS_TTS)[number];

/** Identificador con que este servicio se presenta como «modelo». Sin efecto funcional. */
export const MODELO_PROPIO = 'falp-checklist-v1';

/** Duración máxima de una llamada. Un checklist completo dura minutos, no decenas. */
export const DURACION_MAX_SEG = 15 * 60;

/**
 * Marcador con el que el prompt de sistema transporta el identificador de
 * conversación hasta el endpoint de LLM. La plataforma sustituye la variable de
 * sistema al iniciar la conversación y envía el prompt como primer mensaje.
 */
export const MARCADOR_CONVERSACION = 'conversation_id=';
const VARIABLE_CONVERSACION = '{{system__conversation_id}}';

export interface DefinicionAgente {
  nombre: string;
  /** URL pública de este servicio, sin barra final. */
  urlPublica: string;
  /** Secreto del workspace que guarda LLM_TOKEN. La plataforma lo presenta como Bearer. */
  secretIdLlm: string;
  voiceId: string;
  ttsModelo: ModeloTts;
  /** Código ISO 639-1. */
  idioma: string;
  retencionCero: boolean;
  retencionDias: number;
  /** Webhook post-llamada del workspace. Sin él la plataforma no notifica cierres. */
  webhookPostLlamadaId: string | null;
  reglas: readonly ReglaTransferencia[];
}

/** Ruta que la plataforma compone con la URL base: `<url>/chat/completions`. */
export function urlLlmPropio(urlPublica: string): string {
  return `${urlPublica.replace(/\/+$/, '')}/v1`;
}

/**
 * El prompt no instruye a ningún modelo: este servicio no usa uno para redactar.
 * Existe para que quien abra el panel entienda qué es este agente y para
 * transportar el identificador de conversación.
 */
export function promptSistema(): string {
  return (
    'Este agente no usa un modelo de lenguaje de la plataforma. Cada turno lo resuelve el ' +
    'servicio de preparación pre-procedimiento de Fundación Arturo López Pérez, que devuelve ' +
    'líneas de un guion cerrado y validado por el equipo clínico. Cualquier instrucción escrita ' +
    'aquí no tiene efecto. No modificar este agente desde el panel: se sincroniza desde el servicio.\n' +
    `${MARCADOR_CONVERSACION}${VARIABLE_CONVERSACION}`
  );
}

/** Recupera el identificador que `promptSistema` dejó en el mensaje de sistema. */
export function extraerIdConversacionDelPrompt(texto: string): string | null {
  const m = texto.match(/conversation_id=([A-Za-z0-9_-]+)/);
  const id = m?.[1];
  if (!id || id.startsWith('{{')) return null;
  return id;
}

/** Herramientas de sistema del agente. Este servicio es dueño de las dos. */
export function herramientasSistema(reglas: readonly ReglaTransferencia[]): Record<string, unknown> {
  return {
    end_call: { type: 'system', name: 'end_call', params: { system_tool_type: 'end_call' } },
    transfer_to_number: {
      type: 'system',
      name: 'transfer_to_number',
      params: { system_tool_type: 'transfer_to_number', transfers: reglas, enable_client_message: true },
    },
  };
}

/**
 * Cuerpo completo del agente. Sirve tanto para crearlo como para reescribirlo.
 * Cada valor tiene una razón clínica u operativa; las no obvias van comentadas.
 */
export function cuerpoAgente(d: DefinicionAgente): Record<string, unknown> {
  return {
    name: d.nombre,
    tags: ['falp', 'preparacion-pre-procedimiento'],
    conversation_config: {
      agent: {
        // Vacío: la plataforma espera a que el interlocutor hable y recién entonces
        // consulta al endpoint, que abre con la línea del guion. Un mensaje fijo
        // aquí saldría de la plataforma sin pasar por la lista blanca ni la auditoría.
        first_message: '',
        language: d.idioma,
        // La apertura incluye la divulgación de sistema automatizado y el aviso de
        // grabación. No debe poder cortarse.
        disable_first_message_interruptions: true,
        prompt: {
          prompt: promptSistema(),
          llm: 'custom-llm',
          custom_llm: {
            url: urlLlmPropio(d.urlPublica),
            model_id: MODELO_PROPIO,
            api_key: { secret_id: d.secretIdLlm },
            api_type: 'chat_completions',
          },
          // Sin personalidad por defecto: la plataforma no antepone su propio prompt.
          ignore_default_personality: true,
          temperature: 0,
          built_in_tools: herramientasSistema(d.reglas),
          tool_ids: [],
          knowledge_base: [],
          mcp_server_ids: [],
          native_mcp_server_ids: [],
        },
      },
      tts: {
        voice_id: d.voiceId,
        model_id: d.ttsModelo,
        // El guion entrega horas como «22:00» y confía en que la voz las lea como
        // hora. Esa normalización la hace la plataforma, no un modelo.
        text_normalisation_type: 'elevenlabs',
        stability: 0.6,
        similarity_boost: 0.8,
        // Paciente oncológico, a menudo mayor: algo más lento que el valor por defecto.
        speed: 0.95,
        optimize_streaming_latency: 3,
      },
      asr: {
        quality: 'high',
        provider: 'elevenlabs',
        // Términos que el reconocedor debe favorecer. Sin datos de pacientes.
        keywords: ['RUT', 'ayuno', 'acompañante', 'Fundación Arturo López Pérez'],
      },
      turn: {
        // Más tiempo de silencio antes de asumir que el paciente terminó de hablar.
        turn_timeout: 10,
        turn_eagerness: 'patient',
        // Un silencio largo cierra la llamada; el resultado queda como incompleto.
        silence_end_call_timeout: 30,
      },
      conversation: {
        max_duration_seconds: DURACION_MAX_SEG,
        text_only: false,
      },
    },
    platform_settings: {
      // La plataforma reenvía al endpoint de LLM lo que se pase en la originación.
      overrides: { custom_llm_extra_body: true },
      privacy: {
        record_voice: false,
        retention_days: d.retencionDias,
        delete_audio: true,
        delete_transcript_and_pii: true,
        zero_retention_mode: d.retencionCero,
      },
      // Ninguna evaluación ni extracción por modelo en la plataforma: la evaluación
      // es determinista y ocurre en este servicio.
      evaluation: { criteria: [] },
      data_collection: {},
      ...(d.webhookPostLlamadaId
        ? {
            workspace_overrides: {
              webhooks: {
                post_call_webhook_id: d.webhookPostLlamadaId,
                events: ['transcript', 'call_initiation_failure'],
                send_audio: false,
              },
            },
          }
        : {}),
    },
  };
}

export interface Discrepancia {
  campo: string;
  esperado: unknown;
  actual: unknown;
}

/**
 * Compara la definición con lo que la plataforma tiene guardado. Solo mira los
 * campos que importan para la seguridad de la llamada; el resto es preferencia.
 * `actual` es la respuesta cruda de `GET /v1/convai/agents/{id}`.
 */
export function compararAgente(d: DefinicionAgente, actual: unknown): Discrepancia[] {
  const a = (actual ?? {}) as Record<string, unknown>;
  const leer = (ruta: string): unknown =>
    ruta.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), a);

  const esperadoTransfers = [...d.reglas.map((r) => r.transfer_destination.phone_number)].sort();
  const transfersActuales = (() => {
    const t = leer('conversation_config.agent.prompt.built_in_tools.transfer_to_number.params.transfers');
    if (!Array.isArray(t)) return null;
    return (t as Array<Record<string, unknown>>)
      .map((x) => String(((x['transfer_destination'] ?? {}) as Record<string, unknown>)['phone_number'] ?? ''))
      .sort();
  })();

  const promptActual = leer('conversation_config.agent.prompt.prompt');
  const comparaciones: Array<[string, unknown, unknown]> = [
    ['conversation_config.agent.prompt.llm', 'custom-llm', leer('conversation_config.agent.prompt.llm')],
    ['conversation_config.agent.prompt.custom_llm.url', urlLlmPropio(d.urlPublica), leer('conversation_config.agent.prompt.custom_llm.url')],
    ['conversation_config.agent.prompt.custom_llm.api_type', 'chat_completions', leer('conversation_config.agent.prompt.custom_llm.api_type') ?? 'chat_completions'],
    ['conversation_config.agent.prompt.ignore_default_personality', true, leer('conversation_config.agent.prompt.ignore_default_personality') ?? false],
    [
      'conversation_config.agent.prompt.prompt (marcador de conversación)',
      true,
      typeof promptActual === 'string' && promptActual.includes(`${MARCADOR_CONVERSACION}${VARIABLE_CONVERSACION}`),
    ],
    ['conversation_config.agent.prompt.tool_ids', [], leer('conversation_config.agent.prompt.tool_ids') ?? []],
    ['conversation_config.agent.prompt.knowledge_base', [], leer('conversation_config.agent.prompt.knowledge_base') ?? []],
    ['conversation_config.agent.prompt.mcp_server_ids', [], leer('conversation_config.agent.prompt.mcp_server_ids') ?? []],
    ['conversation_config.agent.first_message', '', leer('conversation_config.agent.first_message') ?? ''],
    ['conversation_config.agent.language', d.idioma, leer('conversation_config.agent.language')],
    ['conversation_config.tts.voice_id', d.voiceId, leer('conversation_config.tts.voice_id')],
    ['conversation_config.tts.model_id', d.ttsModelo, leer('conversation_config.tts.model_id')],
    ['conversation_config.conversation.max_duration_seconds', DURACION_MAX_SEG, leer('conversation_config.conversation.max_duration_seconds')],
    ['platform_settings.privacy.record_voice', false, leer('platform_settings.privacy.record_voice') ?? true],
    ['platform_settings.privacy.retention_days', d.retencionDias, leer('platform_settings.privacy.retention_days')],
    ['platform_settings.privacy.zero_retention_mode', d.retencionCero, leer('platform_settings.privacy.zero_retention_mode') ?? false],
    ['platform_settings.overrides.custom_llm_extra_body', true, leer('platform_settings.overrides.custom_llm_extra_body') ?? false],
    ['transfer_to_number.transfers', esperadoTransfers, transfersActuales],
    ['end_call', true, leer('conversation_config.agent.prompt.built_in_tools.end_call') != null],
  ];
  if (d.webhookPostLlamadaId) {
    comparaciones.push([
      'platform_settings.workspace_overrides.webhooks.post_call_webhook_id',
      d.webhookPostLlamadaId,
      leer('platform_settings.workspace_overrides.webhooks.post_call_webhook_id'),
    ]);
  }

  return comparaciones
    .filter(([, esperado, real]) => JSON.stringify(esperado) !== JSON.stringify(real))
    .map(([campo, esperado, real]) => ({ campo, esperado, actual: real ?? null }));
}
