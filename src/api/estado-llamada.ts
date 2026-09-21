/**
 * Resumen de una llamada para quien la programó desde fuera.
 *
 * Un sistema cliente (la agenda, la ficha, un asistente) necesita saber en qué
 * está la llamada sin leer la tabla de transiciones. Este resumen se deriva del
 * trabajo y del resultado, y es deliberadamente escueto: el desenlace y qué
 * hacer con él. No incluye lo que dijo el paciente; eso vive en la auditoría,
 * con su propio control de acceso.
 */
import type { ResultadoLlamada } from '../dominio/criterios/index.js';
import type { Trabajo } from '../persistencia/repositorios.js';
import { MARGEN_EN_CURSO_MIN } from '../telefonia/despachador.js';

export type EstadoResumen = 'programada' | 'en_curso' | 'terminada' | 'fallida' | 'sin_resultado';

export interface ResumenLlamada {
  id: string;
  idPaciente: string;
  telefono: string;
  /** Estado para quien programó la llamada. */
  estado: EstadoResumen;
  /** Explicación del estado, legible por una persona. */
  detalle: string;
  programadaPara: string;
  idConversacion: string | null;
  resultado: {
    estadoFinal: string;
    requiereRevisionHumana: boolean;
    motivoRevision: string;
    criterios: ResultadoLlamada['criterios'];
    datos: ResultadoLlamada['datos'];
    /** Una frase con el desenlace, para leerla en voz alta o ponerla en una bandeja. */
    resumen: string;
  } | null;
}

/** Estados finales de la máquina, en palabras de quien no leyó el código. */
const DESENLACE: Record<string, string> = {
  terminada_ok: 'El paciente confirmó toda la preparación.',
  terminada_sin_verificar: 'No se pudo verificar la identidad; no se entregó ninguna indicación.',
  terminada_rechazo: 'El paciente pidió que se le llame en otro momento.',
  terminada_buzon: 'Contestó un buzón de voz; no se entregó ninguna indicación.',
  transferida_alarma: 'El paciente mencionó un síntoma de alarma y la llamada pasó a una persona del equipo.',
  transferida_consulta: 'El paciente hizo una consulta o pidió hablar con una persona; la llamada se transfirió.',
  transferida_incomprension: 'El paciente no logró confirmar una indicación y la llamada pasó a una persona.',
};

export function fraseDelResultado(r: Pick<ResultadoLlamada, 'estadoFinal' | 'criterios' | 'requiereRevisionHumana' | 'datos'>): string {
  const base = DESENLACE[r.estadoFinal] ?? `La llamada terminó en estado ${r.estadoFinal}.`;
  const pendientes = r.criterios.filter((c) => c.veredicto !== 'cumplido').map((c) => c.id.replace(/_/g, ' '));
  const motivo = (r.datos.motivo_revision ?? '').trim().replace(/\.$/, '');
  const cola = r.requiereRevisionHumana ? ` Requiere revisión humana${motivo ? `: ${motivo}` : ''}.` : '';
  const faltas = pendientes.length > 0 && r.estadoFinal === 'terminada_ok' ? ` Criterios no cumplidos: ${pendientes.join(', ')}.` : '';
  return `${base}${faltas}${cola}`;
}

export function resumirLlamada(
  t: Trabajo & { actualizadoEn: string },
  r: (ResultadoLlamada & { creadoEn: string }) | null,
  ahora: Date = new Date(),
): ResumenLlamada {
  const resultado = r
    ? {
        estadoFinal: r.estadoFinal,
        requiereRevisionHumana: r.requiereRevisionHumana,
        motivoRevision: r.datos.motivo_revision,
        criterios: r.criterios,
        datos: r.datos,
        resumen: fraseDelResultado(r),
      }
    : null;

  let estado: EstadoResumen;
  let detalle: string;
  if (r) {
    estado = 'terminada';
    detalle = resultado!.resumen;
  } else if (t.estado === 'fallido') {
    estado = 'fallida';
    detalle = 'La llamada no se pudo originar o no se estableció.';
  } else if (t.estado === 'pendiente') {
    estado = 'programada';
    detalle =
      new Date(t.programadoPara).getTime() > ahora.getTime()
        ? `Programada para ${t.programadoPara}.`
        : 'En cola. Sale en cuanto haya ventana horaria y un número libre.';
  } else if (t.estado === 'despachado' && ahora.getTime() - new Date(t.actualizadoEn).getTime() < MARGEN_EN_CURSO_MIN * 60_000) {
    estado = 'en_curso';
    detalle = 'La llamada está en curso.';
  } else {
    // Despachada hace más del margen y sin resultado, o completada sin
    // resultado: nadie sabe qué pasó. Eso es un hueco para la conciliación.
    estado = 'sin_resultado';
    detalle = 'La llamada se originó pero no llegó ningún resultado. Requiere verificación manual.';
  }

  return {
    id: t.id,
    idPaciente: t.idPaciente,
    telefono: t.telefono,
    estado,
    detalle,
    programadaPara: t.programadoPara,
    idConversacion: t.idConversacion,
    resultado,
  };
}
