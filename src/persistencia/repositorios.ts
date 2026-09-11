import type { ContextoLlamada, EventoAuditoria } from '../dominio/tipos.js';
import type { EstadoLlamada } from '../dominio/checklist/maquina.js';
import type { ResultadoLlamada } from '../dominio/criterios/index.js';
import type { DB } from './db.js';

const ahora = () => new Date().toISOString();

// ---------------------------------------------------------------- trabajos

export interface Trabajo {
  id: string;
  idPaciente: string;
  telefono: string;
  contexto: ContextoLlamada;
  estado: 'pendiente' | 'despachado' | 'completado' | 'fallido';
  intentos: number;
  programadoPara: string;
  idConversacion: string | null;
}

export function crearRepoTrabajos(db: DB) {
  return {
    encolar(t: Omit<Trabajo, 'estado' | 'intentos' | 'idConversacion'>): void {
      db.prepare(
        `INSERT INTO trabajos (id, id_paciente, telefono, contexto_json, estado, intentos,
                               programado_para, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, 'pendiente', 0, ?, ?, ?)`,
      ).run(t.id, t.idPaciente, t.telefono, JSON.stringify(t.contexto), t.programadoPara, ahora(), ahora());
    },

    /** Toma hasta `limite` trabajos vencidos y los marca despachados en la misma transacción. */
    tomarPendientes(limite: number): Trabajo[] {
      const tx = db.transaction((n: number): Trabajo[] => {
        const filas = db
          .prepare(
            `SELECT * FROM trabajos
             WHERE estado = 'pendiente' AND programado_para <= ?
             ORDER BY programado_para LIMIT ?`,
          )
          .all(ahora(), n) as Record<string, unknown>[];
        const upd = db.prepare(
          `UPDATE trabajos SET estado='despachado', intentos=intentos+1, actualizado_en=? WHERE id=?`,
        );
        for (const f of filas) upd.run(ahora(), f['id']);
        return filas.map(aTrabajo);
      });
      return tx(limite);
    },

    asociarConversacion(idTrabajo: string, idConversacion: string): void {
      db.prepare(`UPDATE trabajos SET id_conversacion=?, actualizado_en=? WHERE id=?`).run(
        idConversacion,
        ahora(),
        idTrabajo,
      );
    },

    porConversacion(idConversacion: string): Trabajo | null {
      const f = db.prepare(`SELECT * FROM trabajos WHERE id_conversacion=?`).get(idConversacion) as
        | Record<string, unknown>
        | undefined;
      return f ? aTrabajo(f) : null;
    },

    marcar(id: string, estado: Trabajo['estado']): void {
      db.prepare(`UPDATE trabajos SET estado=?, actualizado_en=? WHERE id=?`).run(estado, ahora(), id);
    },

    /** Trabajos despachados sin resultado recibido. Insumo de la conciliación diaria. */
    despachadosSinResultado(antesDe: string): Trabajo[] {
      const filas = db
        .prepare(
          `SELECT t.* FROM trabajos t
           LEFT JOIN resultados r ON r.id_llamada = t.id
           WHERE t.estado='despachado' AND r.id_llamada IS NULL AND t.actualizado_en < ?`,
        )
        .all(antesDe) as Record<string, unknown>[];
      return filas.map(aTrabajo);
    },
  };
}

function aTrabajo(f: Record<string, unknown>): Trabajo {
  return {
    id: String(f['id']),
    idPaciente: String(f['id_paciente']),
    telefono: String(f['telefono']),
    contexto: JSON.parse(String(f['contexto_json'])) as ContextoLlamada,
    estado: String(f['estado']) as Trabajo['estado'],
    intentos: Number(f['intentos']),
    programadoPara: String(f['programado_para']),
    idConversacion: f['id_conversacion'] == null ? null : String(f['id_conversacion']),
  };
}

// ------------------------------------------------------------------- cola

export interface EventoEnCola {
  id: number;
  tipo: string;
  idConversacion: string | null;
  payload: unknown;
  intentos: number;
}

export function crearRepoCola(db: DB) {
  return {
    /**
     * Persiste el evento ANTES de procesarlo. Es lo primero que hace el receptor
     * de webhooks: sin esto, un fallo posterior pierde el resultado para siempre,
     * porque la plataforma no reintenta ni guarda copia bajo retención cero.
     */
    encolar(tipo: string, idConversacion: string | null, payload: unknown): number {
      const r = db
        .prepare(
          `INSERT INTO cola_eventos (tipo, id_conversacion, payload_json, recibido_en)
           VALUES (?, ?, ?, ?)`,
        )
        .run(tipo, idConversacion, JSON.stringify(payload), ahora());
      return Number(r.lastInsertRowid);
    },

    tomarPendientes(limite: number): EventoEnCola[] {
      const filas = db
        .prepare(`SELECT * FROM cola_eventos WHERE estado='pendiente' ORDER BY id LIMIT ?`)
        .all(limite) as Record<string, unknown>[];
      return filas.map((f) => ({
        id: Number(f['id']),
        tipo: String(f['tipo']),
        idConversacion: f['id_conversacion'] == null ? null : String(f['id_conversacion']),
        payload: JSON.parse(String(f['payload_json'])),
        intentos: Number(f['intentos']),
      }));
    },

    marcarProcesado(id: number): void {
      db.prepare(`UPDATE cola_eventos SET estado='procesado', procesado_en=? WHERE id=?`).run(ahora(), id);
    },

    marcarError(id: number, error: string): void {
      db.prepare(
        `UPDATE cola_eventos SET estado='pendiente', intentos=intentos+1, ultimo_error=? WHERE id=?`,
      ).run(error, id);
    },

    pendientes(): number {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM cola_eventos WHERE estado='pendiente'`).get() as {
        n: number;
      };
      return r.n;
    },
  };
}

// ------------------------------------------------------------- resultados

export function crearRepoResultados(db: DB) {
  return {
    guardar(idPaciente: string, r: ResultadoLlamada): void {
      db.prepare(
        `INSERT OR REPLACE INTO resultados
           (id_llamada, id_paciente, estado_final, criterios_json, datos_json,
            requiere_revision, motivo_revision, creado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.idLlamada,
        idPaciente,
        r.estadoFinal,
        JSON.stringify(r.criterios),
        JSON.stringify(r.datos),
        r.requiereRevisionHumana ? 1 : 0,
        r.datos.motivo_revision,
        ahora(),
      );
    },

    colaDeRevision(limite = 100): Array<{ idLlamada: string; idPaciente: string; motivo: string; estadoFinal: string }> {
      const filas = db
        .prepare(
          `SELECT id_llamada, id_paciente, motivo_revision, estado_final FROM resultados
           WHERE requiere_revision = 1 AND revisado_en IS NULL
           ORDER BY creado_en LIMIT ?`,
        )
        .all(limite) as Record<string, unknown>[];
      return filas.map((f) => ({
        idLlamada: String(f['id_llamada']),
        idPaciente: String(f['id_paciente']),
        motivo: String(f['motivo_revision']),
        estadoFinal: String(f['estado_final']),
      }));
    },

    marcarRevisado(idLlamada: string, revisor: string): void {
      db.prepare(`UPDATE resultados SET revisado_por=?, revisado_en=? WHERE id_llamada=?`).run(
        revisor,
        ahora(),
        idLlamada,
      );
    },
  };
}

// -------------------------------------------------------------- auditoría

export function crearRepoAuditoria(db: DB) {
  const ins = db.prepare(
    `INSERT INTO auditoria (id_llamada, ts, estado_anterior, estado_nuevo, motivo,
                            entrada_paciente, salida_agente, guardrail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    registrar(eventos: readonly EventoAuditoria[]): void {
      const tx = db.transaction((es: readonly EventoAuditoria[]) => {
        for (const e of es) {
          ins.run(e.idLlamada, e.ts, e.estadoAnterior, e.estadoNuevo, e.motivo, e.entradaPaciente, e.salidaAgente, e.guardrail);
        }
      });
      tx(eventos);
    },
    porLlamada(idLlamada: string): EventoAuditoria[] {
      const filas = db.prepare(`SELECT * FROM auditoria WHERE id_llamada=? ORDER BY ts, id`).all(idLlamada) as Record<string, unknown>[];
      return filas.map((f) => ({
        idLlamada: String(f['id_llamada']),
        ts: String(f['ts']),
        estadoAnterior: String(f['estado_anterior']) as EventoAuditoria['estadoAnterior'],
        estadoNuevo: String(f['estado_nuevo']) as EventoAuditoria['estadoNuevo'],
        motivo: String(f['motivo']),
        entradaPaciente: String(f['entrada_paciente']),
        salidaAgente: String(f['salida_agente']),
        guardrail: f['guardrail'] == null ? null : String(f['guardrail']),
      }));
    },
  };
}

// --------------------------------------------------------------- sesiones

export function crearRepoSesiones(db: DB) {
  return {
    guardar(idConversacion: string, ctx: ContextoLlamada, st: EstadoLlamada): void {
      db.prepare(
        `INSERT OR REPLACE INTO sesiones (id_conversacion, estado_json, contexto_json, actualizado_en)
         VALUES (?, ?, ?, ?)`,
      ).run(idConversacion, JSON.stringify(st), JSON.stringify(ctx), ahora());
    },
    cargar(idConversacion: string): { ctx: ContextoLlamada; st: EstadoLlamada } | null {
      const f = db.prepare(`SELECT * FROM sesiones WHERE id_conversacion=?`).get(idConversacion) as
        | Record<string, unknown>
        | undefined;
      if (!f) return null;
      return {
        ctx: JSON.parse(String(f['contexto_json'])) as ContextoLlamada,
        st: JSON.parse(String(f['estado_json'])) as EstadoLlamada,
      };
    },
    borrar(idConversacion: string): void {
      db.prepare(`DELETE FROM sesiones WHERE id_conversacion=?`).run(idConversacion);
    },
  };
}
