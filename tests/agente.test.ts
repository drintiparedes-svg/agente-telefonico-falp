/**
 * Definición del agente en la plataforma de voz y su sincronización.
 *
 * Lo que se protege aquí: que la plataforma quede configurada como capa de voz
 * y nada más (LLM propio, sin personalidad, sin herramientas ajenas, sin
 * grabación), que un cambio manual en el panel se detecte, y que el endpoint de
 * LLM resuelva la conversación aunque la plataforma use su propio identificador.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cargarConfig, _limpiarCacheConfig } from '../src/config/index.js';
import { construirServicio, type Servicio } from '../src/api/servidor.js';
import { ClienteElevenLabs, ClienteVozSimulado } from '../src/telefonia/elevenlabs.js';
import {
  compararAgente,
  cuerpoAgente,
  extraerIdConversacionDelPrompt,
  promptSistema,
  urlLlmPropio,
  type DefinicionAgente,
} from '../src/telefonia/agente.js';
import { reglasParaAgente } from '../src/telefonia/transferencias.js';
import { contexto } from './fixtures.js';

const TOKEN = 'token-de-pruebas';
const ADMIN = 'admin-de-pruebas-123456';
const RESPALDO = '+56000000000';
const URL_PUBLICA = 'https://agente.falp.example';
const LUNES_11 = new Date('2026-04-13T15:00:00Z');

const definicion: DefinicionAgente = {
  nombre: 'Prueba',
  urlPublica: URL_PUBLICA,
  secretIdLlm: 'sec_1',
  voiceId: 'voz_1',
  ttsModelo: 'eleven_flash_v2_5',
  idioma: 'es',
  retencionCero: true,
  retencionDias: 0,
  webhookPostLlamadaId: 'wh_1',
  reglas: reglasParaAgente([], RESPALDO, 'conference'),
};

let actual: Servicio | null = null;

afterEach(async () => {
  if (actual) await actual.cerrar();
  actual = null;
  _limpiarCacheConfig();
});

function levantar(extra: Record<string, string> = {}) {
  _limpiarCacheConfig();
  const cfg = cargarConfig({
    NODE_ENV: 'test',
    DB_RUTA: ':memory:',
    WEBHOOK_SECRETO: 'secreto-de-pruebas-1234567890',
    LLM_TOKEN: TOKEN,
    NUMERO_TRANSFERENCIA: RESPALDO,
    NIVEL_LOG: 'fatal',
    ...extra,
  } as NodeJS.ProcessEnv);
  const cliente = new ClienteVozSimulado();
  const svc = construirServicio(cfg, cliente, { esperar: async () => undefined });
  actual = svc;
  return { svc, cliente };
}

type Cuerpo = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Definición del agente', () => {
  const c = cuerpoAgente(definicion) as Cuerpo;
  const prompt = c.conversation_config.agent.prompt;

  it('la plataforma no usa ningún modelo propio: el LLM es este servicio', () => {
    expect(prompt.llm).toBe('custom-llm');
    expect(prompt.custom_llm).toEqual({
      url: `${URL_PUBLICA}/v1`,
      model_id: 'falp-checklist-v1',
      api_key: { secret_id: 'sec_1' },
      api_type: 'chat_completions',
    });
    expect(prompt.ignore_default_personality).toBe(true);
    expect(prompt.temperature).toBe(0);
    expect(urlLlmPropio('https://x.example/')).toBe('https://x.example/v1');
  });

  it('no tiene herramientas, bases de conocimiento ni servidores externos: solo colgar y transferir', () => {
    expect(prompt.tool_ids).toEqual([]);
    expect(prompt.knowledge_base).toEqual([]);
    expect(prompt.mcp_server_ids).toEqual([]);
    expect(Object.keys(prompt.built_in_tools).sort()).toEqual(['end_call', 'transfer_to_number']);
    expect(prompt.built_in_tools.transfer_to_number.params.transfers.map((t: Cuerpo) => t.transfer_destination.phone_number)).toEqual([RESPALDO]);
  });

  it('el primer mensaje es vacío y el prompt transporta el id de conversación de la plataforma', () => {
    expect(c.conversation_config.agent.first_message).toBe('');
    expect(c.conversation_config.agent.disable_first_message_interruptions).toBe(true);
    expect(prompt.prompt).toContain('conversation_id={{system__conversation_id}}');
    expect(prompt.prompt).toBe(promptSistema());
  });

  it('voz, idioma y normalización de texto van fijados por el servicio', () => {
    expect(c.conversation_config.agent.language).toBe('es');
    expect(c.conversation_config.tts).toMatchObject({ voice_id: 'voz_1', model_id: 'eleven_flash_v2_5', text_normalisation_type: 'elevenlabs' });
    expect(c.conversation_config.conversation.max_duration_seconds).toBe(900);
  });

  it('privacidad: sin grabación, sin audio, retención cero, y evaluación por modelo apagada', () => {
    expect(c.platform_settings.privacy).toEqual({
      record_voice: false,
      retention_days: 0,
      delete_audio: true,
      delete_transcript_and_pii: true,
      zero_retention_mode: true,
    });
    expect(c.platform_settings.evaluation).toEqual({ criteria: [] });
    expect(c.platform_settings.overrides).toEqual({ custom_llm_extra_body: true });
    expect(c.platform_settings.workspace_overrides.webhooks).toEqual({
      post_call_webhook_id: 'wh_1',
      events: ['transcript', 'call_initiation_failure'],
      send_audio: false,
    });
  });

  it('sin webhook no se escribe la sección de webhooks', () => {
    const sin = cuerpoAgente({ ...definicion, webhookPostLlamadaId: null }) as Cuerpo;
    expect(sin.platform_settings.workspace_overrides).toBeUndefined();
  });
});

describe('Detección de cambios manuales en el panel', () => {
  it('la propia definición no tiene discrepancias', () => {
    expect(compararAgente(definicion, cuerpoAgente(definicion))).toEqual([]);
  });

  it('detecta un modelo de la plataforma, grabación activada, otra voz o un destino de transferencia ajeno', () => {
    const alterado = JSON.parse(JSON.stringify(cuerpoAgente(definicion))) as Cuerpo;
    alterado.conversation_config.agent.prompt.llm = 'gpt-4o-mini';
    alterado.conversation_config.agent.prompt.prompt = 'Eres un asistente amable.';
    alterado.platform_settings.privacy.record_voice = true;
    alterado.conversation_config.tts.voice_id = 'otra';
    alterado.conversation_config.agent.prompt.built_in_tools.transfer_to_number.params.transfers.push({
      transfer_destination: { type: 'phone', phone_number: '+56999999999' },
      condition: 'siempre',
      transfer_type: 'blind',
    });
    const campos = compararAgente(definicion, alterado).map((d) => d.campo);
    expect(campos).toContain('conversation_config.agent.prompt.llm');
    expect(campos).toContain('conversation_config.agent.prompt.prompt (marcador de conversación)');
    expect(campos).toContain('platform_settings.privacy.record_voice');
    expect(campos).toContain('conversation_config.tts.voice_id');
    expect(campos).toContain('transfer_to_number.transfers');
  });

  it('un agente vacío difiere en todo lo esencial', () => {
    const campos = compararAgente(definicion, {}).map((d) => d.campo);
    expect(campos).toContain('conversation_config.agent.prompt.llm');
    expect(campos).toContain('platform_settings.privacy.zero_retention_mode');
    expect(campos).toContain('end_call');
  });
});

describe('Id de conversación desde el prompt de sistema', () => {
  it('lee el id sustituido por la plataforma e ignora la variable sin sustituir', () => {
    expect(extraerIdConversacionDelPrompt('bla\nconversation_id=conv_abc-123')).toBe('conv_abc-123');
    expect(extraerIdConversacionDelPrompt(promptSistema())).toBeNull();
    expect(extraerIdConversacionDelPrompt('sin marcador')).toBeNull();
  });
});

describe('Sincronización del agente por la API de administración', () => {
  const headers = { authorization: `Bearer ${ADMIN}` };
  const env = { ADMIN_TOKEN: ADMIN, SERVICIO_URL_PUBLICA: URL_PUBLICA, ELEVENLABS_VOICE_ID: 'voz_1' };

  it('escribe el secreto del token y la definición completa, y después no hay discrepancias', async () => {
    const { svc, cliente } = levantar(env);

    const antes = await svc.app.inject({ method: 'GET', url: '/admin/agente', headers });
    expect(antes.json()).toMatchObject({ existe: false });

    const sync = await svc.app.inject({ method: 'POST', url: '/admin/agente/sincronizar', headers });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ ok: true, reglas: 1, secretoCreado: true });
    expect(cliente.secretos.get('agente-falp-llm-token')).toEqual({ secretId: 'sec_1', valor: TOKEN });

    const escrito = cliente.agente as Cuerpo;
    expect(escrito.conversation_config.agent.prompt.custom_llm.url).toBe(`${URL_PUBLICA}/v1`);
    expect(escrito.conversation_config.agent.prompt.custom_llm.api_key).toEqual({ secret_id: 'sec_1' });
    expect(escrito.platform_settings.privacy.zero_retention_mode).toBe(true);
    expect(cliente.reglas?.map((r) => r.transfer_destination.phone_number)).toEqual([RESPALDO]);

    const despues = await svc.app.inject({ method: 'GET', url: '/admin/agente', headers });
    expect(despues.json()).toMatchObject({ existe: true, sincronizado: true, discrepancias: [] });
  });

  it('una segunda sincronización actualiza el secreto en vez de duplicarlo e informa lo que corrigió', async () => {
    const { svc, cliente } = levantar(env);
    await svc.app.inject({ method: 'POST', url: '/admin/agente/sincronizar', headers });
    (cliente.agente as Cuerpo).platform_settings.privacy.record_voice = true;

    const antes = await svc.app.inject({ method: 'GET', url: '/admin/agente', headers });
    expect(antes.json().sincronizado).toBe(false);
    expect(antes.json().discrepancias).toEqual([{ campo: 'platform_settings.privacy.record_voice', esperado: false, actual: true }]);

    const sync = await svc.app.inject({ method: 'POST', url: '/admin/agente/sincronizar', headers });
    expect(sync.json()).toMatchObject({ secretoCreado: false });
    expect(sync.json().discrepanciasPrevias.map((d: Cuerpo) => d.campo)).toEqual(['platform_settings.privacy.record_voice']);
    expect(cliente.secretos.size).toBe(1);
    expect((cliente.agente as Cuerpo).platform_settings.privacy.record_voice).toBe(false);
  });

  it('en desarrollo puede sincronizarse sin retención cero, y el cuerpo lo refleja', async () => {
    const { svc, cliente } = levantar({ ...env, ELEVENLABS_RETENCION_CERO: 'false' });
    await svc.app.inject({ method: 'POST', url: '/admin/agente/sincronizar', headers });
    expect((cliente.agente as Cuerpo).platform_settings.privacy.zero_retention_mode).toBe(false);
  });

  it('en producción, con plataforma real, la retención cero no se puede apagar', () => {
    _limpiarCacheConfig();
    expect(() =>
      cargarConfig({
        NODE_ENV: 'production',
        WEBHOOK_SECRETO: 'secreto-de-produccion-1234567890',
        LLM_TOKEN: 'token-de-produccion',
        NUMERO_TRANSFERENCIA: RESPALDO,
        ELEVENLABS_API_KEY: 'clave',
        ELEVENLABS_RETENCION_CERO: 'false',
      } as NodeJS.ProcessEnv),
    ).toThrow(/RETENCION_CERO/);
  });
});

describe('Cliente ElevenLabs: agente, secretos y webhook', () => {
  function falso(respuestas: Array<{ status?: number; cuerpo: unknown }>) {
    const pedidos: Array<{ url: string; metodo: string; cuerpo: Record<string, unknown> | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      pedidos.push({
        url: String(url),
        metodo: init?.method ?? 'GET',
        cuerpo: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
      const r = respuestas.shift() ?? { cuerpo: {} };
      return new Response(JSON.stringify(r.cuerpo), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const cliente = new ClienteElevenLabs({ baseUrl: 'https://api.prueba', apiKey: 'k', agentId: 'agent_1', fetchImpl });
    return { cliente, pedidos };
  }

  it('crea el secreto si no existe y lo actualiza si existe', async () => {
    const nuevo = falso([{ cuerpo: { secrets: [] } }, { cuerpo: { type: 'stored', secret_id: 'sec_9', name: 'n' } }]);
    expect(await nuevo.cliente.asegurarSecreto('n', 'v')).toEqual({ ok: true, error: null, secretId: 'sec_9', creado: true });
    expect(nuevo.pedidos.map((p) => `${p.metodo} ${p.url}`)).toEqual(['GET https://api.prueba/v1/convai/secrets', 'POST https://api.prueba/v1/convai/secrets']);
    expect(nuevo.pedidos[1]?.cuerpo).toEqual({ name: 'n', value: 'v' });

    const existente = falso([{ cuerpo: { secrets: [{ type: 'stored', secret_id: 'sec_3', name: 'n' }] } }, { cuerpo: {} }]);
    expect(await existente.cliente.asegurarSecreto('n', 'v2')).toEqual({ ok: true, error: null, secretId: 'sec_3', creado: false });
    expect(existente.pedidos[1]).toMatchObject({ metodo: 'PATCH', url: 'https://api.prueba/v1/convai/secrets/sec_3', cuerpo: { name: 'n', value: 'v2' } });
  });

  it('lee, escribe y crea el agente por las rutas de la plataforma', async () => {
    const { cliente, pedidos } = falso([
      { cuerpo: { agent_id: 'agent_1', conversation_config: {} } },
      { cuerpo: {} },
      { cuerpo: { agent_id: 'agent_nuevo' } },
    ]);
    const cuerpo = cuerpoAgente(definicion);
    expect(await cliente.leerAgente()).toMatchObject({ ok: true, datos: { agent_id: 'agent_1' } });
    expect(await cliente.escribirAgente(cuerpo)).toEqual({ ok: true, error: null });
    expect(await cliente.crearAgente(cuerpo)).toEqual({ ok: true, error: null, agentId: 'agent_nuevo' });
    expect(pedidos.map((p) => `${p.metodo} ${p.url}`)).toEqual([
      'GET https://api.prueba/v1/convai/agents/agent_1',
      'PATCH https://api.prueba/v1/convai/agents/agent_1',
      'POST https://api.prueba/v1/convai/agents/create',
    ]);
    expect(pedidos[1]?.cuerpo).toEqual(cuerpo);
  });

  it('un error HTTP es un valor con el detalle, nunca una excepción', async () => {
    const { cliente } = falso([{ status: 422, cuerpo: { detail: 'zero retention requires enterprise' } }]);
    const r = await cliente.escribirAgente({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('422');
    expect(r.error).toContain('enterprise');
  });

  it('crea el webhook post-llamada firmado y devuelve el secreto una sola vez', async () => {
    const { cliente, pedidos } = falso([{ cuerpo: { webhook_id: 'wh_7', webhook_secret: 'wsec_abc' } }]);
    expect(await cliente.crearWebhookPostLlamada('n', 'https://x/webhooks/postcall')).toEqual({ ok: true, error: null, webhookId: 'wh_7', secreto: 'wsec_abc' });
    expect(pedidos[0]).toMatchObject({
      metodo: 'POST',
      url: 'https://api.prueba/v1/workspace/webhooks',
      cuerpo: { settings: { auth_type: 'hmac', name: 'n', webhook_url: 'https://x/webhooks/postcall' } },
    });
  });

  it('la originación reenvía el id propuesto en el cuerpo extra del LLM propio', async () => {
    const { cliente, pedidos } = falso([{ cuerpo: { success: true, message: 'ok', conversation_id: 'conv_plat', callSid: 'CA1' } }]);
    await cliente.llamarSaliente({ telefono: '+56911111111', idConversacionPropuesto: 'conv_x', variables: {}, numero: { idPlataforma: 'p', proveedor: 'twilio' } });
    expect((pedidos[0]?.cuerpo as Cuerpo).conversation_initiation_client_data.custom_llm_extra_body).toEqual({ idConversacion: 'conv_x' });
  });
});

describe('Primer turno de una llamada saliente', () => {
  async function iniciar(svc: Servicio, cliente: ClienteVozSimulado) {
    await svc.app.inject({
      method: 'POST',
      url: '/llamadas',
      payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto: { ...contexto, idLlamada: 'llam-p1' } },
    });
    await svc.despachador.despacharLote(LUNES_11);
    const idConv = cliente.llamadas[0]!.idConversacion;
    const turno = (messages: Array<{ role: string; content: string }>, cabeceras: Record<string, string> = {}) =>
      svc.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, ...cabeceras },
        payload: { messages },
      });
    return { idConv, turno };
  }

  it('la plataforma espera a que el interlocutor hable: un «aló» no se clasifica, el agente abre', async () => {
    const { svc, cliente } = levantar();
    const { idConv, turno } = await iniciar(svc, cliente);
    const r = await turno([{ role: 'user', content: '¿Aló? ¿Quién habla?' }], { 'x-conversation-id': idConv });
    expect(r.body).toMatch(/asistente telefónico automatizado/);
    expect(r.body).not.toContain('tool_calls');

    // El siguiente turno ya es una respuesta al guion.
    const r2 = await turno([{ role: 'assistant', content: 'apertura' }, { role: 'user', content: 'sí, soy yo' }], { 'x-conversation-id': idConv });
    expect(r2.body).toMatch(/RUT/);

    const traza = (await svc.app.inject({ method: 'GET', url: '/auditoria/llam-p1' })).json().eventos;
    expect(traza.map((e: Cuerpo) => e.estadoNuevo)).toEqual(['apertura', 'verificacion_identidad']);
  });

  it('una bandera roja dicha antes de que el agente hable transfiere igual', async () => {
    const { svc, cliente } = levantar();
    const { idConv, turno } = await iniciar(svc, cliente);
    const r = await turno([{ role: 'user', content: 'aló... estoy sangrando mucho' }], { 'x-conversation-id': idConv });
    expect(r.body).toContain('transfer_to_number');
    expect(r.body).toMatch(/comunicarlo de inmediato/);
    const traza = (await svc.app.inject({ method: 'GET', url: '/auditoria/llam-p1' })).json().eventos;
    expect(traza.at(-1)).toMatchObject({ estadoNuevo: 'transferida_alarma', guardrail: 'bandera_roja_lexica' });
  });

  it('resuelve la sesión por el marcador del prompt de sistema aunque la plataforma use su propio id', async () => {
    const { svc, cliente } = levantar();
    const { idConv, turno } = await iniciar(svc, cliente);
    const sistema = promptSistema().replace('{{system__conversation_id}}', idConv);
    const r = await turno([{ role: 'system', content: sistema }, { role: 'user', content: 'aló' }]);
    expect(r.body).toMatch(/asistente telefónico automatizado/);
    expect(r.body).not.toContain('end_call');

    // Con un id que no corresponde a ninguna sesión se corta sin contenido clínico.
    const ajeno = await turno([{ role: 'system', content: promptSistema().replace('{{system__conversation_id}}', 'conv_ajena') }, { role: 'user', content: 'aló' }]);
    expect(ajeno.body).toContain('end_call');
    expect(ajeno.body).not.toMatch(/ayuno|acenocumarol/i);
  });

  it('el primer turno sin texto del interlocutor también abre', async () => {
    const { svc, cliente } = levantar();
    const { idConv, turno } = await iniciar(svc, cliente);
    const r = await turno([], { 'x-conversation-id': idConv });
    expect(r.body).toMatch(/asistente telefónico automatizado/);
  });
});
