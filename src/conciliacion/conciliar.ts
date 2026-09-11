/**
 * Conciliación diaria.
 *
 * Bajo retención cero la plataforma no reintenta webhooks y no guarda copia de los
 * eventos, de modo que una caída del receptor pierde resultados en silencio. La
 * única defensa es contar: llamadas originadas contra resultados recibidos. Todo
 * hueco es un paciente cuya preparación nadie verificó, y por eso se escala a
 * revisión humana en lugar de quedar como una métrica.
 */
import type { crearRepoResultados, crearRepoTrabajos } from '../persistencia/repositorios.js';

export interface DepsConciliacion {
  trabajos: ReturnType<typeof crearRepoTrabajos>;
  resultados: ReturnType<typeof crearRepoResultados>;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

export interface InformeConciliacion {
  ejecutadoEn: string;
  sinResultado: Array<{ idTrabajo: string; idPaciente: string; telefono: string }>;
  totalSinResultado: number;
}

/** Margen tras el cual una llamada despachada sin resultado se considera huérfana. */
const MARGEN_MINUTOS = 30;

export function conciliar(deps: DepsConciliacion, ahora: Date = new Date()): InformeConciliacion {
  const corte = new Date(ahora.getTime() - MARGEN_MINUTOS * 60_000).toISOString();
  const huerfanos = deps.trabajos.despachadosSinResultado(corte);

  if (huerfanos.length > 0) {
    deps.log.warn(
      { total: huerfanos.length, ids: huerfanos.map((t) => t.id) },
      'Llamadas despachadas sin resultado recibido. Requieren verificación manual.',
    );
  }

  return {
    ejecutadoEn: ahora.toISOString(),
    sinResultado: huerfanos.map((t) => ({ idTrabajo: t.id, idPaciente: t.idPaciente, telefono: t.telefono })),
    totalSinResultado: huerfanos.length,
  };
}
