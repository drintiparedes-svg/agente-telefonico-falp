/**
 * Cliente de la plataforma de voz. Origina llamadas salientes, lee los números
 * importados y mantiene la definición del agente. No toma ninguna decisión
 * clínica.
 *
 * Proveedor por defecto: la integración nativa de Twilio. Es la única que admite
 * transferencia con aviso al operador (`agent_message`), transferencia ciega y
 * marcación de extensiones. SIP queda disponible como alternativa por número.
 */
import type { ProveedorTelefonia } from '../persistencia/repositorios.js';

export interface NumeroPlataforma {
  idPlataforma: string;
  e164: string;
  etiqueta: string;
  proveedor: ProveedorTelefonia;
}

/** Una regla de `transfer_to_number` en la configuración del agente. */
export interface ReglaTransferencia {
  transfer_destination: { type: 'phone'; phone_number: string };
  condition: string;
  transfer_type: 'conference' | 'blind';
}

export interface ResultadoOriginacion {
  ok: boolean;
  idConversacion: string | null;
  /** `callSid` de Twilio o `sip_call_id` de SIP. Para cruzar con el proveedor. */
  idLlamadaProveedor: string | null;
  error: string | null;
}

/** Resultado de una operación contra la plataforma. Un fallo es un valor, nunca una excepción. */
export type Resultado<T = object> = ({ ok: true; error: null } & T) | { ok: false; error: string };

export interface ClienteVoz {
  llamarSaliente(p: {
    telefono: string;
    idConversacionPropuesto: string;
    variables: Record<string, string>;
    numero: { idPlataforma: string; proveedor: ProveedorTelefonia };
  }): Promise<ResultadoOriginacion>;
  listarNumeros(): Promise<NumeroPlataforma[]>;
  /** Cambio parcial: solo las herramientas de sistema. Para cuando cambian los destinos. */
  actualizarReglasTransferencia(reglas: readonly ReglaTransferencia[]): Promise<{ ok: boolean; error: string | null }>;

  /** Definición completa del agente tal como la tiene la plataforma. */
  leerAgente(): Promise<Resultado<{ datos: unknown }>>;
  /** Reescribe la definición completa. El cuerpo lo produce `cuerpoAgente`. */
  escribirAgente(cuerpo: Record<string, unknown>): Promise<Resultado>;
  /** Crea el agente. Solo lo usa el aprovisionamiento inicial. */
  crearAgente(cuerpo: Record<string, unknown>): Promise<Resultado<{ agentId: string }>>;
  /**
   * Garantiza que exista un secreto del workspace con ese nombre y ese valor.
   * Si existe se actualiza el valor; así el token que la plataforma presenta al
   * endpoint de LLM es siempre el vigente. Idempotente.
   */
  asegurarSecreto(nombre: string, valor: string): Promise<Resultado<{ secretId: string; creado: boolean }>>;
  /**
   * Crea un webhook post-llamada firmado con HMAC. La plataforma devuelve el
   * secreto de firma UNA sola vez; quien llama debe guardarlo como WEBHOOK_SECRETO.
   */
  crearWebhookPostLlamada(nombre: string, url: string): Promise<Resultado<{ webhookId: string; secreto: string | null }>>;

  /**
   * Busca una voz del workspace por nombre exacto (sin distinguir mayúsculas ni
   * acentos). Si hay varias con el mismo nombre no elige: devuelve las candidatas
   * para que una persona decida.
   */
  buscarVoz(nombre: string): Promise<Resultado<{ voz: VozPlataforma | null; candidatas: VozPlataforma[] }>>;
  /** Busca un agente del workspace por nombre exacto. Misma regla de unicidad. */
  buscarAgente(nombre: string): Promise<Resultado<{ agente: AgentePlataforma | null; candidatos: AgentePlataforma[] }>>;
  /** Fija el agente sobre el que operan `leerAgente` y `escribirAgente`. */
  usarAgente(agentId: string): void;
}

export interface VozPlataforma {
  voiceId: string;
  nombre: string;
  /** Etiquetas de la plataforma: idioma, acento, género, etc. */
  etiquetas: Record<string, string>;
  idiomas: string[];
}

export interface AgentePlataforma {
  agentId: string;
  nombre: string;
  voiceId: string;
}

/** Comparación de nombres tolerante a mayúsculas, acentos y espacios repetidos. */
export function mismoNombre(a: string, b: string): boolean {
  const n = (s: string) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}

export interface OpcionesCliente {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  fetchImpl?: typeof fetch;
}

const RUTA_SALIENTE: Record<ProveedorTelefonia, string> = {
  twilio: '/v1/convai/twilio/outbound-call',
  sip_trunk: '/v1/convai/sip-trunk/outbound-call',
};

/**
 * Cuerpo que escribe las herramientas de sistema del agente. Este servicio es
 * dueño de `end_call` y `transfer_to_number`: los envía ambos para que una
 * actualización parcial no deje al agente sin forma de colgar.
 */
export function cuerpoReglasAgente(reglas: readonly ReglaTransferencia[]): Record<string, unknown> {
  return {
    conversation_config: {
      agent: {
        prompt: {
          built_in_tools: {
            end_call: { type: 'system', name: 'end_call', params: { system_tool_type: 'end_call' } },
            transfer_to_number: {
              type: 'system',
              name: 'transfer_to_number',
              params: { system_tool_type: 'transfer_to_number', transfers: reglas, enable_client_message: true },
            },
          },
        },
      },
    },
  };
}

export class ClienteElevenLabs implements ClienteVoz {
  private readonly fetchImpl: typeof fetch;
  private readonly o: OpcionesCliente;

  constructor(o: OpcionesCliente) {
    this.o = { ...o };
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  usarAgente(agentId: string): void {
    this.o.agentId = agentId;
  }

  private async pedir(
    ruta: string,
    metodo: 'GET' | 'POST' | 'PATCH',
    cuerpo?: unknown,
  ): Promise<{ ok: boolean; status: number; datos: unknown }> {
    const r = await this.fetchImpl(`${this.o.baseUrl}${ruta}`, {
      method: metodo,
      headers: { 'content-type': 'application/json', 'xi-api-key': this.o.apiKey },
      ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
    });
    const datos: unknown = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, datos };
  }

  /** Envuelve una petición para que un fallo de red o de la API sea un valor, no una excepción. */
  private async intentar<T>(f: () => Promise<Resultado<T>>): Promise<Resultado<T>> {
    try {
      return await f();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private fallo(r: { status: number; datos: unknown }): string {
    return `HTTP ${r.status}: ${JSON.stringify(r.datos)}`;
  }

  private get rutaAgente(): string {
    return `/v1/convai/agents/${encodeURIComponent(this.o.agentId)}`;
  }

  async llamarSaliente(p: Parameters<ClienteVoz['llamarSaliente']>[0]): Promise<ResultadoOriginacion> {
    const cuerpo: Record<string, unknown> = {
      agent_id: this.o.agentId,
      agent_phone_number_id: p.numero.idPlataforma,
      to_number: p.telefono,
      conversation_initiation_client_data: {
        // Las variables dinámicas viajan aquí. El id de conversación permite al
        // endpoint de LLM recuperar la sesión con la indicación ya verificada.
        dynamic_variables: { ...p.variables, idConversacion: p.idConversacionPropuesto },
        // Con `custom_llm_extra_body` activo en el agente, esto llega al endpoint
        // de LLM como `elevenlabs_extra_body` en cada turno.
        custom_llm_extra_body: { idConversacion: p.idConversacionPropuesto },
      },
    };
    // Este servicio no conserva audio, y tampoco se le pide a Twilio que lo haga.
    if (p.numero.proveedor === 'twilio') cuerpo['call_recording_enabled'] = false;

    try {
      const r = await this.pedir(RUTA_SALIENTE[p.numero.proveedor], 'POST', cuerpo);
      const c = (r.datos ?? {}) as Record<string, unknown>;
      if (!r.ok || c['success'] === false) {
        return { ok: false, idConversacion: null, idLlamadaProveedor: null, error: this.fallo(r) };
      }
      const texto = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : null);
      return {
        ok: true,
        idConversacion: texto('conversation_id') ?? p.idConversacionPropuesto,
        idLlamadaProveedor: texto('callSid') ?? texto('sip_call_id'),
        error: null,
      };
    } catch (e) {
      return { ok: false, idConversacion: null, idLlamadaProveedor: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Números importados en la plataforma. Solo Twilio y SIP: son los que este servicio sabe usar. */
  async listarNumeros(): Promise<NumeroPlataforma[]> {
    const r = await this.pedir('/v1/convai/phone-numbers', 'GET');
    if (!r.ok) throw new Error(this.fallo(r));
    const lista = Array.isArray(r.datos) ? (r.datos as Record<string, unknown>[]) : [];
    return lista.flatMap((o): NumeroPlataforma[] => {
      const proveedor = o['provider'];
      if (proveedor !== 'twilio' && proveedor !== 'sip_trunk') return [];
      return [
        {
          idPlataforma: String(o['phone_number_id']),
          e164: String(o['phone_number'] ?? ''),
          etiqueta: String(o['label'] ?? ''),
          proveedor,
        },
      ];
    });
  }

  async actualizarReglasTransferencia(reglas: readonly ReglaTransferencia[]): Promise<{ ok: boolean; error: string | null }> {
    try {
      const r = await this.pedir(this.rutaAgente, 'PATCH', cuerpoReglasAgente(reglas));
      return r.ok ? { ok: true, error: null } : { ok: false, error: this.fallo(r) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  leerAgente(): Promise<Resultado<{ datos: unknown }>> {
    return this.intentar<{ datos: unknown }>(async () => {
      const r = await this.pedir(this.rutaAgente, 'GET');
      return r.ok ? { ok: true, error: null, datos: r.datos } : { ok: false, error: this.fallo(r) };
    });
  }

  escribirAgente(cuerpo: Record<string, unknown>): Promise<Resultado> {
    return this.intentar(async () => {
      const r = await this.pedir(this.rutaAgente, 'PATCH', cuerpo);
      return r.ok ? { ok: true, error: null } : { ok: false, error: this.fallo(r) };
    });
  }

  crearAgente(cuerpo: Record<string, unknown>): Promise<Resultado<{ agentId: string }>> {
    return this.intentar<{ agentId: string }>(async () => {
      const r = await this.pedir('/v1/convai/agents/create', 'POST', cuerpo);
      const id = ((r.datos ?? {}) as Record<string, unknown>)['agent_id'];
      if (!r.ok || typeof id !== 'string') return { ok: false, error: this.fallo(r) };
      return { ok: true, error: null, agentId: id };
    });
  }

  asegurarSecreto(nombre: string, valor: string): Promise<Resultado<{ secretId: string; creado: boolean }>> {
    return this.intentar<{ secretId: string; creado: boolean }>(async () => {
      // Búsqueda por nombre: la lista está paginada y el secreto podría no caer
      // en la primera página.
      const lista = await this.pedir(`/v1/convai/secrets?search=${encodeURIComponent(nombre)}&page_size=100`, 'GET');
      if (!lista.ok) return { ok: false, error: this.fallo(lista) };
      const secretos = ((lista.datos ?? {}) as { secrets?: Array<Record<string, unknown>> }).secrets ?? [];
      const existente = secretos.find((s) => s['name'] === nombre);
      if (existente && typeof existente['secret_id'] === 'string') {
        const id = existente['secret_id'];
        // `type` es el discriminador que exige la API ("new" al crear, "update" al cambiar).
        const r = await this.pedir(`/v1/convai/secrets/${encodeURIComponent(id)}`, 'PATCH', { type: 'update', name: nombre, value: valor });
        return r.ok ? { ok: true, error: null, secretId: id, creado: false } : { ok: false, error: this.fallo(r) };
      }
      const r = await this.pedir('/v1/convai/secrets', 'POST', { type: 'new', name: nombre, value: valor });
      const id = ((r.datos ?? {}) as Record<string, unknown>)['secret_id'];
      if (!r.ok || typeof id !== 'string') return { ok: false, error: this.fallo(r) };
      return { ok: true, error: null, secretId: id, creado: true };
    });
  }

  crearWebhookPostLlamada(nombre: string, url: string): Promise<Resultado<{ webhookId: string; secreto: string | null }>> {
    return this.intentar<{ webhookId: string; secreto: string | null }>(async () => {
      const r = await this.pedir('/v1/workspace/webhooks', 'POST', {
        settings: { auth_type: 'hmac', name: nombre, webhook_url: url },
      });
      const c = (r.datos ?? {}) as Record<string, unknown>;
      const id = c['webhook_id'];
      if (!r.ok || typeof id !== 'string') return { ok: false, error: this.fallo(r) };
      return { ok: true, error: null, webhookId: id, secreto: typeof c['webhook_secret'] === 'string' ? c['webhook_secret'] : null };
    });
  }

  buscarVoz(nombre: string): Promise<Resultado<{ voz: VozPlataforma | null; candidatas: VozPlataforma[] }>> {
    return this.intentar<{ voz: VozPlataforma | null; candidatas: VozPlataforma[] }>(async () => {
      const r = await this.pedir(`/v2/voices?search=${encodeURIComponent(nombre)}&page_size=100`, 'GET');
      if (!r.ok) return { ok: false, error: this.fallo(r) };
      const lista = ((r.datos ?? {}) as { voices?: Array<Record<string, unknown>> }).voices ?? [];
      const candidatas = lista
        .map((v): VozPlataforma => ({
          voiceId: String(v['voice_id'] ?? ''),
          nombre: String(v['name'] ?? ''),
          etiquetas: (v['labels'] ?? {}) as Record<string, string>,
          idiomas: Array.isArray(v['verified_languages'])
            ? (v['verified_languages'] as Array<Record<string, unknown>>).map((l) => String(l['language'] ?? '')).filter(Boolean)
            : [],
        }))
        .filter((v) => v.voiceId !== '' && mismoNombre(v.nombre, nombre));
      return { ok: true, error: null, voz: candidatas.length === 1 ? candidatas[0]! : null, candidatas };
    });
  }

  buscarAgente(nombre: string): Promise<Resultado<{ agente: AgentePlataforma | null; candidatos: AgentePlataforma[] }>> {
    return this.intentar<{ agente: AgentePlataforma | null; candidatos: AgentePlataforma[] }>(async () => {
      const r = await this.pedir(`/v1/convai/agents?search=${encodeURIComponent(nombre)}&page_size=100`, 'GET');
      if (!r.ok) return { ok: false, error: this.fallo(r) };
      const lista = ((r.datos ?? {}) as { agents?: Array<Record<string, unknown>> }).agents ?? [];
      const candidatos = lista
        .filter((a) => a['archived'] !== true)
        .map((a): AgentePlataforma => ({
          agentId: String(a['agent_id'] ?? ''),
          nombre: String(a['name'] ?? ''),
          voiceId: String(a['voice_id'] ?? ''),
        }))
        .filter((a) => a.agentId !== '' && mismoNombre(a.nombre, nombre));
      return { ok: true, error: null, agente: candidatos.length === 1 ? candidatos[0]! : null, candidatos };
    });
  }
}

/** Cliente que no hace red. Para pruebas, CI y ensayos en seco del despachador. */
export class ClienteVozSimulado implements ClienteVoz {
  public readonly llamadas: Array<{ telefono: string; idConversacion: string; idNumero: string }> = [];
  /** Números que devolverá `listarNumeros`. */
  public numeros: NumeroPlataforma[] = [];
  /** Últimas reglas recibidas, por cualquiera de las dos vías. */
  public reglas: ReglaTransferencia[] | null = null;
  /** Última definición completa escrita o creada. */
  public agente: Record<string, unknown> | null = null;
  public readonly secretos = new Map<string, { secretId: string; valor: string }>();
  public webhooks: Array<{ webhookId: string; nombre: string; url: string }> = [];
  /** Voces y agentes que devolverán las búsquedas. */
  public voces: VozPlataforma[] = [];
  public agentes: AgentePlataforma[] = [];
  public agenteEnUso = '';

  usarAgente(agentId: string): void {
    this.agenteEnUso = agentId;
  }

  async buscarVoz(nombre: string): Promise<Resultado<{ voz: VozPlataforma | null; candidatas: VozPlataforma[] }>> {
    const candidatas = this.voces.filter((v) => mismoNombre(v.nombre, nombre));
    return { ok: true, error: null, voz: candidatas.length === 1 ? candidatas[0]! : null, candidatas };
  }

  async buscarAgente(nombre: string): Promise<Resultado<{ agente: AgentePlataforma | null; candidatos: AgentePlataforma[] }>> {
    const candidatos = this.agentes.filter((a) => mismoNombre(a.nombre, nombre));
    return { ok: true, error: null, agente: candidatos.length === 1 ? candidatos[0]! : null, candidatos };
  }

  async llamarSaliente(p: Parameters<ClienteVoz['llamarSaliente']>[0]): Promise<ResultadoOriginacion> {
    this.llamadas.push({ telefono: p.telefono, idConversacion: p.idConversacionPropuesto, idNumero: p.numero.idPlataforma });
    return { ok: true, idConversacion: p.idConversacionPropuesto, idLlamadaProveedor: null, error: null };
  }

  async listarNumeros(): Promise<NumeroPlataforma[]> {
    return this.numeros;
  }

  async actualizarReglasTransferencia(reglas: readonly ReglaTransferencia[]): Promise<{ ok: boolean; error: string | null }> {
    this.reglas = [...reglas];
    return { ok: true, error: null };
  }

  async leerAgente(): Promise<Resultado<{ datos: unknown }>> {
    return { ok: true, error: null, datos: this.agente ? { agent_id: 'agente-simulado', ...this.agente } : null };
  }

  async escribirAgente(cuerpo: Record<string, unknown>): Promise<Resultado> {
    this.agente = cuerpo;
    this.reglas = reglasDe(cuerpo);
    return { ok: true, error: null };
  }

  async crearAgente(cuerpo: Record<string, unknown>): Promise<Resultado<{ agentId: string }>> {
    this.agente = cuerpo;
    this.reglas = reglasDe(cuerpo);
    return { ok: true, error: null, agentId: 'agente-simulado' };
  }

  async asegurarSecreto(nombre: string, valor: string): Promise<Resultado<{ secretId: string; creado: boolean }>> {
    const previo = this.secretos.get(nombre);
    const secretId = previo?.secretId ?? `sec_${this.secretos.size + 1}`;
    this.secretos.set(nombre, { secretId, valor });
    return { ok: true, error: null, secretId, creado: !previo };
  }

  async crearWebhookPostLlamada(nombre: string, url: string): Promise<Resultado<{ webhookId: string; secreto: string | null }>> {
    const webhookId = `wh_${this.webhooks.length + 1}`;
    this.webhooks.push({ webhookId, nombre, url });
    return { ok: true, error: null, webhookId, secreto: 'secreto-simulado-0123456789' };
  }
}

function reglasDe(cuerpo: Record<string, unknown>): ReglaTransferencia[] | null {
  const t = ['conversation_config', 'agent', 'prompt', 'built_in_tools', 'transfer_to_number', 'params', 'transfers'].reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
    cuerpo,
  );
  return Array.isArray(t) ? (t as ReglaTransferencia[]) : null;
}
