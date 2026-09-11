/**
 * Detección de banderas rojas oncológicas.
 *
 * Se evalúa sobre CADA intervención del paciente, antes de cualquier otra lógica,
 * y en cualquier estado — incluso antes de verificar identidad. Un síntoma de
 * alarma interrumpe el checklist y transfiere de inmediato, sin pedir confirmación
 * y sin terminar el checklist primero.
 *
 * Doble red deliberada:
 *   1. Coincidencia léxica determinista (esta capa). No depende del modelo.
 *   2. Clasificación del LLM con intención `reporta_sintoma`.
 * Basta que UNA dispare. La evidencia documenta que la sensibilidad de un agente
 * de voz se degrada con el tiempo, así que la capa determinista es el piso que
 * no se mueve.
 */

/** Términos que disparan transferencia inmediata. En español de Chile, con variantes coloquiales. */
const TERMINOS_ALARMA: readonly string[] = [
  // Fiebre e infección
  'fiebre', 'febril', 'calentura', 'tiritones', 'escalofrios', 'escalofríos',
  // Sangrado
  'sangre', 'sangrando', 'sangrado', 'hemorragia', 'sangre en la deposicion',
  'sangre en la deposición', 'vomite sangre', 'vomité sangre', 'tosi sangre', 'tosí sangre',
  // Dolor
  'dolor intenso', 'dolor fuerte', 'dolor insoportable', 'mucho dolor',
  'dolor en el pecho', 'me duele el pecho', 'dolor nuevo',
  // Respiratorio
  'no puedo respirar', 'me falta el aire', 'ahogo', 'ahogada', 'ahogado',
  'dificultad para respirar', 'dificultad respiratoria',
  // Neurológico
  'confundido', 'confundida', 'desorientado', 'desorientada', 'no reconozco',
  'me desmaye', 'me desmayé', 'desmayo', 'convulsion', 'convulsión',
  // Digestivo
  'vomitando', 'vomito mucho', 'vómito', 'no paro de vomitar', 'no retengo nada',
  // Estado general
  'me siento muy mal', 'estoy muy mal', 'estoy grave', 'no doy mas', 'no doy más',
  'me siento pesimo', 'me siento pésimo',
];

/** Negaciones que anulan la coincidencia: "no tengo fiebre" no es una bandera roja. */
const PREFIJOS_NEGACION: readonly string[] = [
  'no tengo', 'no he tenido', 'no tuve', 'sin ', 'nada de', 'no siento',
  'no me duele', 'no hay', 'ninguna', 'ningun', 'ningún', 'no presento',
];

export interface ResultadoBanderaRoja {
  detectada: boolean;
  /** Término que disparó la detección. Vacío si no hubo. */
  termino: string;
  /** Fragmento literal donde apareció, para el registro clínico. */
  fragmento: string;
}

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Comprueba si la coincidencia está negada. Mira hasta 30 caracteres hacia atrás:
 * suficiente para "no tengo nada de" sin cruzar a la oración anterior.
 */
function estaNegada(textoNorm: string, posicion: number): boolean {
  const inicio = Math.max(0, posicion - 30);
  const contexto = textoNorm.slice(inicio, posicion);
  // Un punto o "pero" corta el alcance de la negación.
  const corte = Math.max(contexto.lastIndexOf('.'), contexto.lastIndexOf(' pero '));
  const ventana = corte >= 0 ? contexto.slice(corte) : contexto;
  return PREFIJOS_NEGACION.some((p) => ventana.includes(normalizar(p)));
}

export function detectarBanderaRoja(entradaPaciente: string): ResultadoBanderaRoja {
  const norm = normalizar(entradaPaciente);
  for (const termino of TERMINOS_ALARMA) {
    const t = normalizar(termino);
    const pos = norm.indexOf(t);
    if (pos === -1) continue;
    if (estaNegada(norm, pos)) continue;
    const inicio = Math.max(0, pos - 40);
    const fin = Math.min(entradaPaciente.length, pos + t.length + 40);
    return { detectada: true, termino, fragmento: entradaPaciente.slice(inicio, fin).trim() };
  }
  return { detectada: false, termino: '', fragmento: '' };
}

/** Expuesto solo para las pruebas de cobertura del vocabulario. */
export const _TERMINOS_ALARMA = TERMINOS_ALARMA;
