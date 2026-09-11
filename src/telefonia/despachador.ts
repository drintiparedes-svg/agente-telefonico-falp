/**
 * Despachador de llamadas salientes.
 *
 * Tres restricciones que vienen del análisis de factibilidad y que aquí son código:
 *  1. Concurrencia por debajo del límite del plan, reservando capacidad para entrantes.
 *  2. Ventana horaria: no se llama a un paciente oncológico fuera de horario razonable.
 *  3. La sesión con la indicación clínica se precarga ANTES de originar la llamada.
 *     Si no hay indicación verificada, no hay llamada.
 */
import { randomUUID } from 'node:crypto';
import { estadoInicial } from '../dominio/checklist/maquina.js';
import { ContextoLlamada } from '../dominio/tipos.js';
import type { ClienteVoz } from './elevenlabs.js';
import type { crearRepoSesiones, crearRepoTrabajos } from '../persistencia/repositorios.js';

export interface DepsDespachador {
  trabajos: ReturnType<typeof crearRepoTrabajos>;
  sesiones: ReturnType<typeof crearRepoSesiones>;
  cliente: ClienteVoz;
  concurrenciaMax: number;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

/** Ventana permitida, hora local de Chile. Fuera de ella no se marca. */
export const VENTANA = { desde: 9, hasta: 20 } as const;

export function dentroDeVentana(fecha: Date = new Date(), tz = 'America/Santiago'): boolean {
  const hora = Number(
    new Intl.DateTimeFormat('es-CL', { hour: 'numeric', hour12: false, timeZone: tz }).format(fecha),
  );
  const dia = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(fecha);
  if (dia === 'Sun') return false;
  return hora >= VENTANA.desde && hora < VENTANA.hasta;
}

export function crearDespachador(deps: DepsDespachador) {
  return {
    /** Programa una llamada. Valida la indicación antes de aceptarla en la cola. */
    programar(p: {
      idPaciente: string;
      telefono: string;
      contexto: unknown;
      programadoPara?: string;
    }): { ok: boolean; idTrabajo: string | null; error: string | null } {
      const c = ContextoLlamada.safeParse(p.contexto);
      if (!c.success) {
        return {
          ok: false,
          idTrabajo: null,
          error: `Indicación inválida: ${c.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        };
      }
      if (!c.data.indicacion.emitidaPor) {
        return { ok: false, idTrabajo: null, error: 'La indicación no tiene profesional emisor. No es lícito comunicarla.' };
      }
      const id = c.data.idLlamada || randomUUID();
      deps.trabajos.encolar({
        id,
        idPaciente: p.idPaciente,
        telefono: p.telefono,
        contexto: { ...c.data, idLlamada: id },
        programadoPara: p.programadoPara ?? new Date().toISOString(),
      });
      return { ok: true, idTrabajo: id, error: null };
    },

    /** Toma un lote de trabajos vencidos y los origina. */
    async despacharLote(ahora: Date = new Date()): Promise<{ despachados: number; omitidos: number; fallidos: number }> {
      if (!dentroDeVentana(ahora)) {
        deps.log.info({ hora: ahora.toISOString() }, 'Fuera de ventana horaria: no se despacha');
        return { despachados: 0, omitidos: 0, fallidos: 0 };
      }

      const lote = deps.trabajos.tomarPendientes(deps.concurrenciaMax);
      let despachados = 0;
      let fallidos = 0;

      for (const t of lote) {
        const idConversacion = `conv_${t.id}`;

        // La sesión se guarda ANTES de originar. Si la llamada conecta y la sesión
        // no está, el endpoint de LLM no tiene indicación verificada y corta.
        deps.sesiones.guardar(idConversacion, t.contexto, estadoInicial(t.id));

        const r = await deps.cliente.llamarSaliente({
          telefono: t.telefono,
          idConversacionPropuesto: idConversacion,
          variables: {
            nombre_paciente: t.contexto.verificacion.nombrePaciente,
            fecha_procedimiento: t.contexto.indicacion.fechaProcedimiento,
          },
        });

        if (r.ok && r.idConversacion) {
          if (r.idConversacion !== idConversacion) {
            // La plataforma asignó su propio id: se reindexa la sesión.
            deps.sesiones.guardar(r.idConversacion, t.contexto, estadoInicial(t.id));
            deps.sesiones.borrar(idConversacion);
          }
          deps.trabajos.asociarConversacion(t.id, r.idConversacion);
          despachados++;
        } else {
          deps.sesiones.borrar(idConversacion);
          deps.trabajos.marcar(t.id, 'fallido');
          deps.log.error({ idTrabajo: t.id, error: r.error }, 'Fallo al originar llamada');
          fallidos++;
        }
      }

      return { despachados, omitidos: 0, fallidos };
    },
  };
}
