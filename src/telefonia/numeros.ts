/**
 * Selección del número de salida.
 *
 * Por qué un grupo de números y no uno solo:
 *  1. Capacidad. Cada número tiene un techo de llamadas simultáneas que fija FALP.
 *     Agregar capacidad es agregar un número, no cambiar código.
 *  2. Reputación. Los operadores marcan como posible spam los números que originan
 *     mucho volumen. Un paciente oncológico que ve «posible spam» no contesta, y
 *     repartir la carga reduce ese riesgo.
 *  3. Continuidad. Un número caído o bloqueado se desactiva sin detener el servicio.
 */
import type { NumeroSalida } from '../persistencia/repositorios.js';

/** Capacidad libre del grupo, dada la carga actual de cada número. */
export function capacidadLibre(activos: readonly NumeroSalida[], carga: ReadonlyMap<string, number>): number {
  return activos.reduce((s, n) => s + Math.max(0, n.concurrenciaMax - (carga.get(n.idPlataforma) ?? 0)), 0);
}

/**
 * Elige el número con menor ocupación relativa. A igual ocupación gana el de
 * menor `prioridad` y después el de menor identificador, para que la elección
 * sea determinista y se pueda reconstruir en una auditoría.
 */
export function elegirNumero(activos: readonly NumeroSalida[], carga: ReadonlyMap<string, number>): NumeroSalida | null {
  let mejor: Candidato | null = null;
  for (const n of activos) {
    const enUso = carga.get(n.idPlataforma) ?? 0;
    if (n.concurrenciaMax <= 0 || enUso >= n.concurrenciaMax) continue;
    const c = { n, ocupacion: enUso / n.concurrenciaMax };
    if (!mejor || antes(c, mejor)) mejor = c;
  }
  return mejor?.n ?? null;
}

interface Candidato {
  n: NumeroSalida;
  ocupacion: number;
}

function antes(a: Candidato, b: Candidato): boolean {
  if (a.ocupacion !== b.ocupacion) return a.ocupacion < b.ocupacion;
  if (a.n.prioridad !== b.n.prioridad) return a.n.prioridad < b.n.prioridad;
  return a.n.idPlataforma < b.n.idPlataforma;
}
