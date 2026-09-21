/**
 * Despachador de llamadas salientes.
 *
 * Restricciones que vienen del análisis de factibilidad y de la plataforma, y que
 * aquí son código:
 *  1. Tres techos de capacidad, y manda el menor: la concurrencia del workspace de
 *     la plataforma de voz, el techo de cada número de salida y las llamadas por
 *     segundo que admite la cuenta de Twilio.
 *  2. Ventana horaria: no se llama a un paciente oncológico fuera de horario razonable.
 *  3. La sesión con la indicación clínica se precarga ANTES de originar la llamada.
 *     Si no hay indicación verificada, no hay llamada.
 *  4. Sin número de salida activo no se despacha. Los trabajos esperan en la cola.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { estadoInicial } from '../dominio/checklist/maquina.js';
import { ContextoLlamada } from '../dominio/tipos.js';

/** Al programar, el identificador de llamada es opcional: si falta se genera. */
const ContextoAProgramar = ContextoLlamada.extend({ idLlamada: z.string().min(1).optional() });
import type { ClienteVoz } from './elevenlabs.js';
import { capacidadLibre, elegirNumero } from './numeros.js';
import type { crearRepoNumeros, crearRepoSesiones, crearRepoTrabajos } from '../persistencia/repositorios.js';

export interface DepsDespachador {
  trabajos: ReturnType<typeof crearRepoTrabajos>;
  sesiones: ReturnType<typeof crearRepoSesiones>;
  numeros: ReturnType<typeof crearRepoNumeros>;
  cliente: ClienteVoz;
  /** Techo global: concurrencia del plan de la plataforma, con reserva para entrantes. */
  concurrenciaMax: number;
  /** Llamadas por segundo que admite la cuenta de Twilio. */
  llamadasPorSegundo: number;
  /** Pausa entre originaciones. Inyectable para pruebas. */
  esperar?: (ms: number) => Promise<void>;
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

/**
 * Pasado este margen, una llamada despachada sin cierre deja de ocupar capacidad.
 * Sin él, un webhook perdido bloquearía un canal para siempre. La conciliación
 * se ocupa de esas llamadas por separado.
 */
export const MARGEN_EN_CURSO_MIN = 30;

const esperarReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function crearDespachador(deps: DepsDespachador) {
  const esperar = deps.esperar ?? esperarReal;
  const pausa = Math.ceil(1000 / deps.llamadasPorSegundo);
  // Los lotes se serializan: el ritmo de llamadas por segundo es por cuenta de
  // Twilio, no por lote, y una programación «inmediata» corre en el hilo de la
  // petición mientras el temporizador corre el suyo.
  let turno: Promise<unknown> = Promise.resolve();

  const despachador = {
    /** Programa una llamada. Valida la indicación antes de aceptarla en la cola. */
    programar(p: {
      idPaciente: string;
      telefono: string;
      contexto: unknown;
      programadoPara?: string;
    }): { ok: boolean; idTrabajo: string | null; error: string | null; duplicado?: boolean } {
      const c = ContextoAProgramar.safeParse(p.contexto);
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
      if (deps.trabajos.porId(id)) {
        return { ok: false, idTrabajo: id, error: `Ya existe una llamada con idLlamada ${id}.`, duplicado: true };
      }
      deps.trabajos.encolar({
        id,
        idPaciente: p.idPaciente,
        telefono: p.telefono,
        contexto: { ...c.data, idLlamada: id },
        programadoPara: p.programadoPara ?? new Date().toISOString(),
      });
      return { ok: true, idTrabajo: id, error: null };
    },

    /** Toma los trabajos vencidos que caben en la capacidad libre y los origina. Un lote a la vez. */
    despacharLote(ahora: Date = new Date()): Promise<{ despachados: number; omitidos: number; fallidos: number }> {
      const p = turno.then(() => ejecutarLote(ahora));
      turno = p.catch(() => undefined);
      return p;
    },
  };

  async function ejecutarLote(ahora: Date): Promise<{ despachados: number; omitidos: number; fallidos: number }> {
      const vacio = { despachados: 0, omitidos: 0, fallidos: 0 };
      if (!dentroDeVentana(ahora)) {
        deps.log.info({ hora: ahora.toISOString() }, 'Fuera de ventana horaria: no se despacha');
        return vacio;
      }

      const activos = deps.numeros.activos();
      if (activos.length === 0) {
        deps.log.warn({}, 'Sin números de salida activos: no se despacha');
        return vacio;
      }

      const desde = new Date(ahora.getTime() - MARGEN_EN_CURSO_MIN * 60_000).toISOString();
      const { total, porNumero } = deps.trabajos.enCurso(desde);
      const libres = Math.min(Math.max(0, deps.concurrenciaMax - total), capacidadLibre(activos, porNumero));
      if (libres === 0) return vacio;

      const lote = deps.trabajos.tomarPendientes(libres);
      const carga = new Map(porNumero);
      let despachados = 0;
      let fallidos = 0;
      let omitidos = 0;
      let originadas = 0;

      for (const t of lote) {
        const numero = elegirNumero(activos, carga);
        if (!numero) {
          deps.trabajos.devolver(t.id);
          omitidos++;
          continue;
        }

        // Twilio encola lo que exceda sus llamadas por segundo. Espaciar aquí
        // mantiene esa cola a la vista de este servicio y no en la del proveedor.
        if (originadas > 0) await esperar(pausa);
        originadas++;
        carga.set(numero.idPlataforma, (carga.get(numero.idPlataforma) ?? 0) + 1);
        deps.trabajos.asignarNumero(t.id, numero.idPlataforma);

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
          numero: { idPlataforma: numero.idPlataforma, proveedor: numero.proveedor },
        });

        if (r.ok && r.idConversacion) {
          if (r.idConversacion !== idConversacion) {
            // La plataforma asignó su propio id: se reindexa la sesión.
            deps.sesiones.guardar(r.idConversacion, t.contexto, estadoInicial(t.id));
            deps.sesiones.borrar(idConversacion);
          }
          deps.trabajos.asociarConversacion(t.id, r.idConversacion);
          deps.log.info(
            { idTrabajo: t.id, numero: numero.idPlataforma, idLlamadaProveedor: r.idLlamadaProveedor },
            'Llamada originada',
          );
          despachados++;
        } else {
          carga.set(numero.idPlataforma, Math.max(0, (carga.get(numero.idPlataforma) ?? 1) - 1));
          deps.sesiones.borrar(idConversacion);
          deps.trabajos.marcar(t.id, 'fallido');
          deps.log.error({ idTrabajo: t.id, numero: numero.idPlataforma, error: r.error }, 'Fallo al originar llamada');
          fallidos++;
        }
      }

      return { despachados, omitidos, fallidos };
  }

  return despachador;
}
