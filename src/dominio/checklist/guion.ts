/**
 * El guion. Todas las líneas que el agente puede pronunciar están aquí.
 *
 * Cada función devuelve texto construido por plantilla a partir de datos de la
 * ficha. El modelo de lenguaje NUNCA redacta una línea: solo clasifica lo que
 * dijo el paciente. Esta separación es la mitigación central del riesgo de
 * alucinación clínica y es lo que permite calificar la llamada como ejecución
 * de una indicación ya emitida y no como consejo clínico nuevo.
 */
import { MOTIVOS_ENRUTAMIENTO, type ContextoLlamada, type MotivoEnrutamiento } from '../tipos.js';

const NOMBRE_INSTITUCION = 'Fundación Arturo López Pérez';

/**
 * Nombre con que el agente se presenta. Es el mismo que lleva el agente en la
 * plataforma de voz («Catalina AI»); cambiarlo aquí es cambiar el guion, y por
 * tanto pasa por revisión clínica. Aprobado por la gerencia el 2026-09-21.
 */
export const NOMBRE_AGENTE_VOZ = 'Catalina';

/** Motivo de transferencia tal como lo oye el operador. Sin datos del paciente. */
const MOTIVO_LEGIBLE: Record<MotivoEnrutamiento, string> = {
  alarma: 'el paciente reportó un síntoma de alarma',
  consulta: 'el paciente necesita hablar con una persona',
  incomprension: 'el paciente no logró confirmar una indicación',
  fuera_de_guion: 'falla de validación del guion',
};

/** Convierte "07:30" en "siete y media de la mañana" no es necesario: la capa de
 *  voz normaliza. Se entrega la hora tal cual está en la ficha. */
function hora(h: string): string {
  return h;
}

export const guion = {
  /**
   * Apertura. El agente se presenta por su nombre y declara que es un sistema
   * automatizado, con aviso de grabación, ANTES de cualquier contenido clínico y
   * antes incluso de pedir identidad. El nombre no atenúa la divulgación: la
   * palabra «automatizada» va en la misma frase.
   */
  apertura(c: ContextoLlamada): string {
    return (
      `Buenos días, soy ${NOMBRE_AGENTE_VOZ}, la asistente telefónica automatizada de ${NOMBRE_INSTITUCION}. ` +
      `Esta llamada es grabada. En cualquier momento puede pedir hablar con una persona del equipo. ` +
      `¿Hablo con ${c.verificacion.nombrePaciente}?`
    );
  },

  /** Primer factor de verificación. Dato no clínico. */
  pedirVerificacion(): string {
    return (
      'Antes de continuar necesito confirmar su identidad. ' +
      '¿Me puede decir los últimos cuatro dígitos de su RUT, sin el dígito verificador?'
    );
  },

  /** Segundo factor. Tampoco es un dato clínico: es una fecha administrativa. */
  pedirSegundoFactor(): string {
    return 'Gracias. ¿Y me confirma el día y el mes de su próxima atención? Por ejemplo, quince del cuatro.';
  },

  verificacionFallida(): string {
    return (
      `Le llamamos desde ${NOMBRE_INSTITUCION} por un tema de su atención. ` +
      'Por favor comuníquese con nosotros al número de contacto habitual. Que tenga buen día.'
    );
  },

  ayuno(c: ContextoLlamada): string {
    return (
      `Perfecto. Le voy a recordar cómo prepararse. Lo primero es el ayuno: ` +
      `usted debe dejar de comer y de beber a las ${hora(c.indicacion.horaInicioAyuno)}. ` +
      `Para que quede claro, ¿me repite a qué hora empieza su ayuno?`
    );
  },

  ayunoNoConfirmado(c: ContextoLlamada): string {
    return `Le repito, más despacio. El ayuno empieza a las ${hora(c.indicacion.horaInicioAyuno)}. ¿Me repite la hora?`;
  },

  /** Un fármaco por turno. Nunca se agrupan: cada uno se confirma individualmente. */
  farmaco(c: ContextoLlamada, indice: number): string {
    const f = c.indicacion.farmacosASuspender[indice];
    if (!f) return '';
    const prefijo = indice === 0 ? 'Ahora, sobre sus medicamentos. ' : '';
    return `${prefijo}${f.instruccion} ¿Me confirma que lo entendió?`;
  },

  farmacoNoConfirmado(c: ContextoLlamada, indice: number): string {
    const f = c.indicacion.farmacosASuspender[indice];
    if (!f) return '';
    return `Se lo repito más despacio. ${f.instruccion} ¿Lo entendió?`;
  },

  sinFarmacos(): string {
    return 'En su caso no hay medicamentos que suspender. Seguimos.';
  },

  examenes(c: ContextoLlamada): string {
    const lista = c.indicacion.examenesRequeridos.join(', ');
    return `Necesita traer estos exámenes: ${lista}. ¿Los tiene todos?`;
  },

  examenesCuales(): string {
    return '¿Cuáles le faltan?';
  },

  sinExamenes(): string {
    return 'No necesita traer exámenes. Seguimos.';
  },

  logisticaConAcompanante(c: ContextoLlamada): string {
    return (
      `Debe llegar a las ${hora(c.indicacion.horaLlegada)} y tiene que venir con un acompañante ` +
      `que pueda llevarlo de vuelta a su casa. ¿Tiene a alguien que lo acompañe?`
    );
  },

  logisticaSinAcompanante(c: ContextoLlamada): string {
    return `Por último, debe llegar a las ${hora(c.indicacion.horaLlegada)}. ¿Le queda clara la hora de llegada?`;
  },

  cierre(): string {
    return (
      'Eso es todo. Si le surge cualquier duda antes de su atención, puede llamarnos al número de contacto habitual. ' +
      'Que esté muy bien. Hasta luego.'
    );
  },

  // ---- Salidas de excepción ----

  transferenciaAlarma(): string {
    return 'Voy a comunicarlo de inmediato con una persona del equipo. No corte, por favor.';
  },

  transferenciaConsulta(): string {
    return 'Esa consulta la tiene que responder una persona del equipo. Se la paso ahora. No corte, por favor.';
  },

  transferenciaIncomprension(): string {
    return 'Prefiero que lo atienda una persona del equipo. Se la paso ahora. No corte, por favor.';
  },

  transferenciaSolicitada(): string {
    return 'Por supuesto. Le paso con una persona del equipo. No corte, por favor.';
  },

  transferenciaFallida(): string {
    return (
      'No logré comunicarlo con una persona en este momento. ' +
      `Por favor llame usted a ${NOMBRE_INSTITUCION} al número de contacto habitual. Es importante que lo haga hoy.`
    );
  },

  /**
   * Lo que oye el paciente mientras la plataforma conecta con la persona. Viaja
   * como `client_message` de la herramienta de transferencia.
   */
  esperaTransferencia(): string {
    return 'Un momento, por favor.';
  },

  /**
   * Aviso al operador que recibe la transferencia (`agent_message`). No lleva el
   * nombre del paciente ni contenido clínico: solo el motivo y un código para
   * ubicar la traza en la auditoría.
   */
  avisoOperador(motivo: MotivoEnrutamiento, idLlamada: string): string {
    return (
      `Transferencia del asistente de preparación de ${NOMBRE_INSTITUCION}. ` +
      `Motivo: ${MOTIVO_LEGIBLE[motivo]}. Código de llamada ${idLlamada}.`
    );
  },

  noEsBuenMomento(): string {
    return 'Entiendo. Lo llamamos en otro momento. Que esté bien.';
  },

  /**
   * El paciente rechaza la grabación. La llamada continúa sin grabar: el
   * consentimiento de grabación es separable del de la llamada. No se
   * condiciona la entrega de la información a que acepte ser grabado.
   */
  rechazoGrabacion(): string {
    return 'Sin problema, no queda grabada. Igual le entrego la información. Seguimos.';
  },

  noEscucho(): string {
    return 'Disculpe, no logré escucharlo. ¿Sigue ahí?';
  },
} as const;

/**
 * Conjunto plano de todas las líneas que el guion puede emitir para un contexto
 * dado. Lo usa `verificarContenidoCerrado` como lista blanca.
 */
export function todasLasLineas(c: ContextoLlamada): string[] {
  const lineas: string[] = [
    guion.apertura(c),
    guion.pedirVerificacion(),
    guion.pedirSegundoFactor(),
    guion.verificacionFallida(),
    guion.ayuno(c),
    guion.ayunoNoConfirmado(c),
    guion.sinFarmacos(),
    guion.examenes(c),
    guion.examenesCuales(),
    guion.sinExamenes(),
    guion.logisticaConAcompanante(c),
    guion.logisticaSinAcompanante(c),
    guion.cierre(),
    guion.transferenciaAlarma(),
    guion.transferenciaConsulta(),
    guion.transferenciaIncomprension(),
    guion.transferenciaSolicitada(),
    guion.transferenciaFallida(),
    guion.esperaTransferencia(),
    guion.noEsBuenMomento(),
    guion.rechazoGrabacion(),
    guion.noEscucho(),
  ];
  for (let i = 0; i < c.indicacion.farmacosASuspender.length; i++) {
    lineas.push(guion.farmaco(c, i), guion.farmacoNoConfirmado(c, i));
  }
  for (const m of MOTIVOS_ENRUTAMIENTO) lineas.push(guion.avisoOperador(m, c.idLlamada));
  return lineas.filter((l) => l.length > 0);
}
