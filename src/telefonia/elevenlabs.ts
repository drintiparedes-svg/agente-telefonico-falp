/**
 * Cliente de la plataforma de voz. Origina llamadas salientes, lee los números
 * importados y mantiene las reglas de transferencia del agente. No toma ninguna
 * decisión clínica.
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

export interface ClienteVoz {
  llamarSaliente(p: {
    telefono: string;
    idConversacionPropuesto: string;
    variables: Record<string, string>;
    numero: { idPlataforma: string; proveedor: ProveedorTelefonia };
  }): Promise<ResultadoOriginacion>;
  listarNumeros(): Promise<NumeroPlataforma[]>;
  actualizarReglasTransferencia(reglas: readonly ReglaTransferencia[]): Promise<{ ok: boolean; error: string | null }>;
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

  constructor(private readonly o: OpcionesCliente) {
    this.fetchImpl = o.fetchImpl ?? fetch;
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

  async llamarSaliente(p: Parameters<ClienteVoz['llamarSaliente']>[0]): Promise<ResultadoOriginacion> {
    const cuerpo: Record<string, unknown> = {
      agent_id: this.o.agentId,
      agent_phone_number_id: p.numero.idPlataforma,
      to_number: p.telefono,
      conversation_initiation_client_data: {
        // Las variables dinámicas viajan aquí. El id de conversación permite al
        // endpoint de LLM recuperar la sesión con la indicación ya verificada.
        dynamic_variables: { ...p.variables, idConversacion: p.idConversacionPropuesto },
      },
    };
    // Este servicio no conserva audio, y tampoco se le pide a Twilio que lo haga.
    if (p.numero.proveedor === 'twilio') cuerpo['call_recording_enabled'] = false;

    try {
      const r = await this.pedir(RUTA_SALIENTE[p.numero.proveedor], 'POST', cuerpo);
      const c = (r.datos ?? {}) as Record<string, unknown>;
      if (!r.ok || c['success'] === false) {
        return { ok: false, idConversacion: null, idLlamadaProveedor: null, error: `HTTP ${r.status}: ${JSON.stringify(c)}` };
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
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.datos)}`);
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
      const r = await this.pedir(`/v1/convai/agents/${encodeURIComponent(this.o.agentId)}`, 'PATCH', cuerpoReglasAgente(reglas));
      return r.ok ? { ok: true, error: null } : { ok: false, error: `HTTP ${r.status}: ${JSON.stringify(r.datos)}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Cliente que no hace red. Para pruebas, CI y ensayos en seco del despachador. */
export class ClienteVozSimulado implements ClienteVoz {
  public readonly llamadas: Array<{ telefono: string; idConversacion: string; idNumero: string }> = [];
  /** Números que devolverá `listarNumeros`. */
  public numeros: NumeroPlataforma[] = [];
  /** Últimas reglas recibidas. */
  public reglas: ReglaTransferencia[] | null = null;

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
}
