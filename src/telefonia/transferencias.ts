/**
 * Enrutamiento de transferencias a persona.
 *
 * Una llamada que pasa a una persona no puede caer en un número que nadie
 * atiende. Por eso el destino se resuelve por motivo, servicio y horario, con un
 * número de respaldo que siempre existe en producción (NUMERO_TRANSFERENCIA). Si
 * la tabla está vacía o ningún destino está en horario, se usa el respaldo.
 *
 * La plataforma de voz solo transfiere a números precargados en las reglas del
 * agente. `reglasParaAgente` construye esa lista desde la tabla, y hay que
 * sincronizarla cada vez que cambian los destinos.
 */
import { guion } from '../dominio/checklist/guion.js';
import type { Estado, MotivoEnrutamiento } from '../dominio/tipos.js';
import type { DestinoTransferencia } from '../persistencia/repositorios.js';
import type { ReglaTransferencia } from './elevenlabs.js';

export function motivoDesdeEstado(estado: Estado): MotivoEnrutamiento {
  switch (estado) {
    case 'transferida_alarma':
      return 'alarma';
    case 'transferida_incomprension':
      return 'incomprension';
    default:
      return 'consulta';
  }
}

const DIAS: Record<string, string> = { Mon: '1', Tue: '2', Wed: '3', Thu: '4', Fri: '5', Sat: '6', Sun: '7' };

/** Si el destino atiende en ese instante, en hora de Chile. */
export function enHorario(
  d: Pick<DestinoTransferencia, 'horaDesde' | 'horaHasta' | 'dias'>,
  fecha: Date,
  tz = 'America/Santiago',
): boolean {
  const hora = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(fecha));
  const dia = DIAS[new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(fecha)] ?? '';
  return dia !== '' && d.dias.includes(dia) && hora >= d.horaDesde && hora < d.horaHasta;
}

/**
 * Elige el destino. Orden de preferencia: motivo exacto antes que `general`,
 * servicio exacto antes que genérico, luego `prioridad` y luego identificador.
 */
export function resolverDestino(
  destinos: readonly DestinoTransferencia[],
  p: { motivo: MotivoEnrutamiento; servicio?: string | undefined; ahora: Date },
  respaldo: string,
): { e164: string; idDestino: string | null } {
  const servicio = p.servicio ?? '';
  const rango = (d: DestinoTransferencia) => (d.motivo === p.motivo ? 0 : 2) + (d.servicio !== '' ? 0 : 1);
  const candidatos = destinos
    .filter((d) => d.activo)
    .filter((d) => d.motivo === p.motivo || d.motivo === 'general')
    .filter((d) => d.servicio === '' || d.servicio === servicio)
    .filter((d) => enHorario(d, p.ahora))
    .sort((a, b) => rango(a) - rango(b) || a.prioridad - b.prioridad || a.id.localeCompare(b.id));
  const d = candidatos[0];
  return d ? { e164: d.e164, idDestino: d.id } : { e164: respaldo, idDestino: null };
}

/**
 * Reglas de transferencia para la configuración del agente. Una por número
 * distinto, incluido el respaldo. La condición en lenguaje natural es obligatoria
 * para la plataforma, pero aquí no decide nada: quien elige el destino es este
 * servicio, en código.
 */
export function reglasParaAgente(
  destinos: readonly DestinoTransferencia[],
  respaldo: string,
  tipo: 'conference' | 'blind',
): ReglaTransferencia[] {
  const porNumero = new Map<string, string[]>();
  const anotar = (e164: string, etiqueta: string) => porNumero.set(e164, [...(porNumero.get(e164) ?? []), etiqueta]);
  for (const d of destinos) if (d.activo) anotar(d.e164, d.etiqueta || d.id);
  if (respaldo) anotar(respaldo, 'respaldo');
  return [...porNumero.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([e164, etiquetas]) => ({
      transfer_destination: { type: 'phone', phone_number: e164 },
      condition:
        `Transferir a este número solo cuando la respuesta del sistema lo indique con este mismo número ` +
        `(${etiquetas.join(', ')}). Nunca por decisión propia.`,
      transfer_type: tipo,
    }));
}

/**
 * Argumentos de la herramienta `transfer_to_number`, en el formato que exige la
 * plataforma. Los dos mensajes salen del guion: tampoco aquí se genera texto.
 */
export function argumentosTransferencia(p: {
  e164: string;
  motivo: MotivoEnrutamiento;
  idLlamada: string;
}): { transfer_number: string; reason: string; client_message: string; agent_message: string } {
  return {
    transfer_number: p.e164,
    reason: p.motivo,
    client_message: guion.esperaTransferencia(),
    agent_message: guion.avisoOperador(p.motivo, p.idLlamada),
  };
}
