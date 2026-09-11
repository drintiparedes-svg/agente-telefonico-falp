/**
 * Guardrails clínicos como código, no como instrucciones de prompt.
 *
 * Un prompt es una petición al modelo. Esto es una condición del programa: si el
 * guardrail no se cumple, la llamada no avanza, con independencia de lo que el
 * modelo haya decidido. Es la diferencia entre pedirle a un sistema que se porte
 * bien y hacer que no pueda portarse mal.
 */
import {
  ESTADOS_CON_CONTENIDO_CLINICO,
  type Clasificacion,
  type Estado,
  type MotivoTransferencia,
} from '../tipos.js';
import { detectarBanderaRoja } from './banderas-rojas.js';

export { detectarBanderaRoja } from './banderas-rojas.js';

/** Por debajo de esta confianza, la clasificación del modelo no se usa. */
export const UMBRAL_CONFIANZA = 0.6;

/** Intentos de aclaración antes de transferir a una persona. */
export const MAX_INTENTOS_ACLARACION = 2;

export type Veredicto =
  | { tipo: 'continuar' }
  | { tipo: 'transferir'; motivo: MotivoTransferencia; detalle: string; guardrail: string }
  | { tipo: 'terminar'; estado: Estado; detalle: string; guardrail: string };

export interface EntradaGuardrails {
  estadoActual: Estado;
  identidadVerificada: boolean;
  entradaPaciente: string;
  clasificacion: Clasificacion;
  intentosAclaracion: number;
}

/**
 * Evalúa los guardrails en orden estricto de precedencia. El orden importa:
 * la alarma clínica gana a todo lo demás, incluida la verificación de identidad.
 * Un paciente que dice "estoy sangrando" antes de identificarse sigue siendo un
 * paciente que sangra.
 */
export function evaluarGuardrails(e: EntradaGuardrails): Veredicto {
  // ---- 1. Bandera roja clínica. Máxima precedencia, en cualquier estado. ----
  const lexica = detectarBanderaRoja(e.entradaPaciente);
  const porModelo =
    e.clasificacion.intencion === 'reporta_sintoma' &&
    e.clasificacion.confianza >= UMBRAL_CONFIANZA;

  if (lexica.detectada || porModelo) {
    const detalle = lexica.detectada
      ? `Término de alarma detectado: "${lexica.termino}". Fragmento: "${lexica.fragmento}"`
      : `Síntoma reportado según clasificación: "${e.clasificacion.sintomaLiteral}"`;
    return {
      tipo: 'transferir',
      motivo: 'sintoma_alarma',
      detalle,
      guardrail: lexica.detectada ? 'bandera_roja_lexica' : 'bandera_roja_modelo',
    };
  }

  // ---- 2. Solicitud explícita de hablar con una persona. Se acata sin objetar. ----
  if (e.clasificacion.intencion === 'pide_persona') {
    return {
      tipo: 'transferir',
      motivo: 'solicitud_del_paciente',
      detalle: 'El paciente pidió hablar con una persona.',
      guardrail: 'solicitud_persona',
    };
  }

  // ---- 3. Pregunta clínica fuera del guion. El agente no responde: transfiere. ----
  if (e.clasificacion.intencion === 'pregunta_clinica') {
    return {
      tipo: 'transferir',
      motivo: 'consulta_clinica',
      detalle: `Pregunta fuera de guion: "${e.clasificacion.preguntaLiteral}"`,
      guardrail: 'consulta_fuera_de_guion',
    };
  }

  // ---- 4. Compuerta de identidad. Sin verificación, cero contenido clínico. ----
  if (!e.identidadVerificada && ESTADOS_CON_CONTENIDO_CLINICO.includes(e.estadoActual)) {
    return {
      tipo: 'terminar',
      estado: 'terminada_sin_verificar',
      detalle:
        'Se intentó alcanzar un estado con contenido clínico sin identidad verificada. ' +
        'La llamada se cierra con mensaje neutro.',
      guardrail: 'compuerta_identidad',
    };
  }

  // ---- 5. Incomprensión reiterada. Dos intentos y pasa a una persona. ----
  const noEntiende =
    e.clasificacion.intencion === 'no_entiende' ||
    e.clasificacion.intencion === 'irrelevante' ||
    e.clasificacion.confianza < UMBRAL_CONFIANZA;

  if (noEntiende && e.intentosAclaracion >= MAX_INTENTOS_ACLARACION) {
    return {
      tipo: 'transferir',
      motivo: 'incomprension_reiterada',
      detalle: `Sin comprensión tras ${e.intentosAclaracion} intentos de aclaración.`,
      guardrail: 'incomprension_reiterada',
    };
  }

  return { tipo: 'continuar' };
}

/**
 * Verifica que una línea a pronunciar provenga del guion y no del modelo.
 * Se ejecuta sobre TODA salida antes de entregarla a la capa de voz.
 *
 * La comparación es contra el conjunto de líneas que el guion podía producir en
 * ese turno. Si la salida no está entre ellas, algo generó texto libre y la
 * llamada se detiene. No se intenta corregir sobre la marcha.
 */
export function verificarContenidoCerrado(
  salida: string,
  lineasPermitidas: readonly string[],
): { valida: boolean; motivo: string } {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const salidaNorm = norm(salida);
  if (salidaNorm.length === 0) {
    return { valida: false, motivo: 'La salida está vacía.' };
  }
  const permitida = lineasPermitidas.some((l) => norm(l) === salidaNorm);
  if (!permitida) {
    return {
      valida: false,
      motivo:
        'La salida no coincide con ninguna línea del guion para este turno. ' +
        'Indica generación de contenido no autorizado.',
    };
  }
  return { valida: true, motivo: '' };
}
