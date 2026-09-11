/**
 * Cliente de la plataforma de voz. Su única responsabilidad es originar llamadas
 * salientes y consultar su estado. No toma ninguna decisión clínica.
 */
export interface ClienteVoz {
  llamarSaliente(p: {
    telefono: string;
    idConversacionPropuesto: string;
    variables: Record<string, string>;
  }): Promise<{ ok: boolean; idConversacion: string | null; error: string | null }>;
}

export interface OpcionesCliente {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  phoneNumberId: string;
  fetchImpl?: typeof fetch;
}

export class ClienteElevenLabs implements ClienteVoz {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: OpcionesCliente) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async llamarSaliente(p: {
    telefono: string;
    idConversacionPropuesto: string;
    variables: Record<string, string>;
  }): Promise<{ ok: boolean; idConversacion: string | null; error: string | null }> {
    try {
      const r = await this.fetchImpl(`${this.o.baseUrl}/v1/convai/sip-trunk/outbound-call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': this.o.apiKey },
        body: JSON.stringify({
          agent_id: this.o.agentId,
          agent_phone_number_id: this.o.phoneNumberId,
          to_number: p.telefono,
          conversation_initiation_client_data: {
            // Las variables dinámicas viajan aquí. El id de conversación permite al
            // endpoint de LLM recuperar la sesión con la indicación ya verificada.
            dynamic_variables: { ...p.variables, idConversacion: p.idConversacionPropuesto },
          },
        }),
      });
      const cuerpo = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) {
        return { ok: false, idConversacion: null, error: `HTTP ${r.status}: ${JSON.stringify(cuerpo)}` };
      }
      const id =
        typeof cuerpo['conversation_id'] === 'string'
          ? (cuerpo['conversation_id'] as string)
          : p.idConversacionPropuesto;
      return { ok: true, idConversacion: id, error: null };
    } catch (e) {
      return { ok: false, idConversacion: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Cliente que no hace red. Para pruebas, CI y ensayos en seco del despachador. */
export class ClienteVozSimulado implements ClienteVoz {
  public readonly llamadas: Array<{ telefono: string; idConversacion: string }> = [];

  async llamarSaliente(p: {
    telefono: string;
    idConversacionPropuesto: string;
    variables: Record<string, string>;
  }): Promise<{ ok: boolean; idConversacion: string | null; error: string | null }> {
    this.llamadas.push({ telefono: p.telefono, idConversacion: p.idConversacionPropuesto });
    return { ok: true, idConversacion: p.idConversacionPropuesto, error: null };
  }
}
