/**
 * Expresiones de pausa.
 *
 * Son las muletillas que una persona chilena dice mientras revisa algo antes de
 * responder: «ya», «un segundito», «déjeme ver acá». Cubren el silencio que hay
 * entre que el paciente termina de hablar y el agente tiene lista su línea.
 *
 * Tres reglas las mantienen dentro del modelo de contenido cerrado:
 *
 * 1. Son un conjunto cerrado. Ninguna las redacta un modelo.
 * 2. Son semánticamente neutras. Se eligen ANTES de clasificar lo que dijo el
 *    paciente, así que no pueden afirmar ni valorar nada: ni «perfecto», ni
 *    «muy bien», ni «entiendo». Un «ya» chileno solo acusa recibo.
 * 3. Se eligen de forma determinista a partir del identificador de llamada y
 *    del número de turno. La misma llamada reproduce siempre las mismas
 *    expresiones, y cada una queda en la auditoría como parte de la línea.
 *
 * Los puntos suspensivos no son decorativos: la capa de voz los interpreta como
 * una pausa breve, y eso es lo que hace que suene a alguien mirando la pantalla.
 */

/** Registro: español de Chile, trato de usted. Neutras respecto del turno. */
export const EXPRESIONES_PAUSA: readonly string[] = [
  'Ya.',
  'Ya, un segundito...',
  'Mmm, ya.',
  'Ya, déjeme ver acá...',
];

/** FNV-1a de 32 bits. Basta para repartir expresiones; no es criptográfico. */
function fnv1a(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Elige la expresión de un turno. Determinista: misma llamada y mismo turno,
 * misma expresión. Turnos consecutivos de una misma llamada no repiten la
 * anterior, para que no suene a disco rayado.
 */
export function elegirExpresionPausa(p: { idLlamada: string; turno: number }): string {
  const n = EXPRESIONES_PAUSA.length;
  // Se recorre la secuencia desde el turno 0 para que la regla «distinta de la
  // anterior» se aplique sobre lo que de verdad se pronunció, no sobre el
  // hash crudo del turno previo. Los turnos de una llamada se cuentan con
  // los dedos; el costo es irrelevante.
  let anterior = -1;
  for (let t = 0; t <= p.turno; t++) {
    let i = fnv1a(`${p.idLlamada}:${t}`) % n;
    if (i === anterior) i = (i + 1) % n;
    anterior = i;
  }
  return EXPRESIONES_PAUSA[anterior]!;
}

/** Antepone la expresión a una línea del guion. Con línea vacía no hay nada que decir. */
export function componerConPausa(expresion: string, linea: string): string {
  if (linea === '' || expresion === '') return linea;
  return `${expresion} ${linea}`;
}

/**
 * Lista blanca extendida: cada línea del guion sola y precedida por cada
 * expresión. Es un producto cartesiano pequeño y explícito, para que la
 * validación siga siendo una comparación exacta y no un análisis de prefijos.
 */
export function lineasConPausa(lineas: readonly string[]): string[] {
  const out: string[] = [...lineas];
  for (const l of lineas) for (const e of EXPRESIONES_PAUSA) out.push(componerConPausa(e, l));
  return out;
}
