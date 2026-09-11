/**
 * Criterios de éxito y extracción estructurada.
 *
 * Diferencia deliberada respecto de la evaluación nativa de la plataforma: allí
 * un segundo modelo lee la transcripción y juzga. Aquí los criterios se derivan
 * de forma determinista del estado final y del registro de auditoría. El mismo
 * recorrido produce siempre el mismo veredicto, y el veredicto es reproducible
 * ante un comité clínico sin depender de un modelo.
 *
 * Regla operacional: un criterio indeterminado se trata como no cumplido.
 */
import type { ContextoLlamada } from '../tipos.js';
import type { EstadoLlamada } from '../checklist/maquina.js';

export type Veredicto = 'cumplido' | 'no_cumplido' | 'indeterminado';

export interface ResultadoCriterio {
  id: string;
  veredicto: Veredicto;
  /** Justificación legible por un revisor clínico. Es lo que hace auditable el resultado. */
  justificacion: string;
}

export interface DatosExtraidos {
  identidad_confirmada: boolean;
  hora_ayuno_repetida: string;
  farmacos_no_confirmados: string;
  examenes_faltantes: string;
  acompanante_confirmado: boolean;
  sintomas_alarma_mencionados: boolean;
  sintoma_textual: string;
  consulta_fuera_de_guion: string;
  solicito_persona: boolean;
  rechazo_grabacion: boolean;
  requiere_revision_humana: boolean;
  motivo_revision: string;
}

export interface ResultadoLlamada {
  idLlamada: string;
  estadoFinal: string;
  criterios: ResultadoCriterio[];
  datos: DatosExtraidos;
  requiereRevisionHumana: boolean;
}

export function evaluar(ctx: ContextoLlamada, st: EstadoLlamada): ResultadoLlamada {
  const c = st.capturado;
  const alarma = c.sintomaLiteral !== '';

  const criterios: ResultadoCriterio[] = [
    {
      id: 'identidad_verificada',
      veredicto: st.identidadVerificada ? 'cumplido' : 'no_cumplido',
      justificacion: st.identidadVerificada
        ? `Se confirmaron ${st.factoresConfirmados} factores de verificación no clínicos antes de abrir contenido clínico.`
        : 'No se completó la verificación de identidad. No se entregó contenido clínico.',
    },
    {
      id: 'divulgacion_realizada',
      veredicto: st.auditoria.some((e) => e.estadoNuevo === 'apertura') ? 'cumplido' : 'no_cumplido',
      justificacion:
        'La apertura del guion informa que es un sistema automatizado y que la llamada se graba, ' +
        'antes de cualquier contenido clínico.',
    },
    {
      id: 'ayuno_comprendido',
      ...evaluarAyuno(ctx, st),
    },
    {
      id: 'farmacos_confirmados',
      ...evaluarFarmacos(ctx, st),
    },
    {
      id: 'examenes_verificados',
      ...evaluarExamenes(ctx, st),
    },
    {
      id: 'logistica_confirmada',
      ...evaluarLogistica(ctx, st),
    },
    {
      id: 'sin_generacion_clinica',
      veredicto: st.auditoria.every((e) => e.guardrail !== 'contenido_no_autorizado') ? 'cumplido' : 'no_cumplido',
      justificacion:
        'Toda línea pronunciada fue validada contra la lista blanca del guion antes de entregarse a la capa de voz.',
    },
    {
      id: 'alarma_gestionada',
      veredicto: alarma
        ? st.estado === 'transferida_alarma'
          ? 'cumplido'
          : 'no_cumplido'
        : 'cumplido',
      justificacion: alarma
        ? st.estado === 'transferida_alarma'
          ? `Se detectó un síntoma de alarma y se transfirió de inmediato sin terminar el checklist. Literal: "${c.sintomaLiteral}"`
          : 'Se detectó un síntoma de alarma y la llamada NO terminó en transferencia. Revisión obligatoria.'
        : 'No hubo mención de síntomas de alarma.',
    },
  ];

  const noCumplidos = criterios.filter((k) => k.veredicto !== 'cumplido');
  const requiereRevision = noCumplidos.length > 0 || alarma || c.consultaLiteral !== '';

  const datos: DatosExtraidos = {
    identidad_confirmada: st.identidadVerificada,
    hora_ayuno_repetida: c.horaAyunoRepetida,
    farmacos_no_confirmados: c.farmacosNoConfirmados.join('; '),
    examenes_faltantes: c.examenesFaltantes === 'pendiente' ? '' : c.examenesFaltantes,
    acompanante_confirmado: c.acompananteConfirmado === true,
    sintomas_alarma_mencionados: alarma,
    sintoma_textual: c.sintomaLiteral,
    consulta_fuera_de_guion: c.consultaLiteral,
    solicito_persona: c.solicitoPersona,
    rechazo_grabacion: c.rechazoGrabacion,
    requiere_revision_humana: requiereRevision,
    motivo_revision: motivoRevision(st, noCumplidos, alarma),
  };

  return {
    idLlamada: st.idLlamada,
    estadoFinal: st.estado,
    criterios,
    datos,
    requiereRevisionHumana: requiereRevision,
  };
}

function evaluarAyuno(ctx: ContextoLlamada, st: EstadoLlamada): Omit<ResultadoCriterio, 'id'> {
  const repetida = st.capturado.horaAyunoRepetida;
  if (repetida === '') {
    return {
      veredicto: st.identidadVerificada ? 'no_cumplido' : 'indeterminado',
      justificacion: st.identidadVerificada
        ? 'El paciente no repitió la hora de inicio del ayuno. Una confirmación verbal sin repetir la hora no acredita comprensión.'
        : 'No se llegó al bloque de ayuno porque no se verificó la identidad.',
    };
  }
  const coincide = repetida === ctx.indicacion.horaInicioAyuno;
  return {
    veredicto: coincide ? 'cumplido' : 'no_cumplido',
    justificacion: coincide
      ? `El paciente repitió la hora de ayuno (${repetida}) y coincide con la indicación.`
      : `El paciente repitió "${repetida}" y la indicación es ${ctx.indicacion.horaInicioAyuno}.`,
  };
}

function evaluarFarmacos(ctx: ContextoLlamada, st: EstadoLlamada): Omit<ResultadoCriterio, 'id'> {
  const total = ctx.indicacion.farmacosASuspender.length;
  if (total === 0) {
    return { veredicto: 'cumplido', justificacion: 'La indicación no contempla fármacos a suspender.' };
  }
  const confirmados = st.capturado.farmacosConfirmados.length;
  if (!st.identidadVerificada) {
    return { veredicto: 'indeterminado', justificacion: 'No se llegó al bloque de fármacos.' };
  }
  if (confirmados === total) {
    return {
      veredicto: 'cumplido',
      justificacion: `Los ${total} fármacos fueron recorridos y confirmados individualmente.`,
    };
  }
  return {
    veredicto: 'no_cumplido',
    justificacion:
      `Solo ${confirmados} de ${total} fármacos quedaron confirmados individualmente. ` +
      `Sin confirmar: ${st.capturado.farmacosNoConfirmados.join('; ') || 'no se alcanzaron'}.`,
  };
}

function evaluarExamenes(ctx: ContextoLlamada, st: EstadoLlamada): Omit<ResultadoCriterio, 'id'> {
  if (ctx.indicacion.examenesRequeridos.length === 0) {
    return { veredicto: 'cumplido', justificacion: 'La indicación no contempla exámenes previos.' };
  }
  const visitado = st.auditoria.some((e) => e.estadoNuevo === 'examenes');
  if (!visitado) {
    return { veredicto: 'indeterminado', justificacion: 'No se alcanzó el bloque de exámenes.' };
  }
  const faltantes = st.capturado.examenesFaltantes;
  if (faltantes === '' ) {
    return { veredicto: 'cumplido', justificacion: 'El paciente declaró tener todos los exámenes requeridos.' };
  }
  return {
    veredicto: 'cumplido',
    justificacion: `Se preguntó por los exámenes y se registró lo que falta: "${faltantes}". El criterio mide que se haya verificado, no que estén completos.`,
  };
}

function evaluarLogistica(ctx: ContextoLlamada, st: EstadoLlamada): Omit<ResultadoCriterio, 'id'> {
  const visitado = st.auditoria.some((e) => e.estadoNuevo === 'logistica');
  if (!visitado) {
    return { veredicto: 'indeterminado', justificacion: 'No se alcanzó el bloque de logística.' };
  }
  if (!ctx.indicacion.requiereAcompanante) {
    return { veredicto: 'cumplido', justificacion: 'Se comunicó la hora de llegada. No se requiere acompañante.' };
  }
  const ok = st.capturado.acompananteConfirmado === true;
  return {
    veredicto: ok ? 'cumplido' : 'no_cumplido',
    justificacion: ok
      ? 'El paciente confirmó tener acompañante para el traslado posterior.'
      : 'El paciente no confirmó acompañante y el procedimiento lo requiere. Derivar a trabajo social.',
  };
}

function motivoRevision(st: EstadoLlamada, noCumplidos: ResultadoCriterio[], alarma: boolean): string {
  if (alarma) return 'Síntoma de alarma reportado durante la llamada.';
  if (st.capturado.consultaLiteral !== '') return 'El paciente planteó una consulta clínica fuera del guion.';
  const primero = noCumplidos[0];
  if (primero) return `Criterio no cumplido: ${primero.id}. ${primero.justificacion}`;
  return '';
}
