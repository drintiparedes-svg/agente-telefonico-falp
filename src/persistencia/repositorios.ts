import type { ContextoLlamada, EventoAuditoria, MotivoEnrutamiento } from '../dominio/tipos.js';
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
  /** Número de salida (id en la plataforma) con que se originó la llamada. */
  numeroSalida: string | null;
}

export function crearRepoTrabajos(db: DB) {
  return {
    encolar(t: Omit<Trabajo, 'estado' | 'intentos' | 'idConversacion' | 'numeroSalida'>): void {
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

    porId(id: string): (Trabajo & { creadoEn: string; actualizadoEn: string }) | null {
      const f = db.prepare(`SELECT * FROM trabajos WHERE id=?`).get(id) as Record<string, unknown> | undefined;
      return f ? { ...aTrabajo(f), creadoEn: String(f['creado_en']), actualizadoEn: String(f['actualizado_en']) } : null;
    },

    marcar(id: string, estado: Trabajo['estado']): void {
      db.prepare(`UPDATE trabajos SET estado=?, actualizado_en=? WHERE id=?`).run(estado, ahora(), id);
    },

    asignarNumero(idTrabajo: string, idNumero: string): void {
      db.prepare(`UPDATE trabajos SET numero_salida=?, actualizado_en=? WHERE id=?`).run(idNumero, ahora(), idTrabajo);
    },

    /**
     * Llamadas en curso: despachadas y sin cierre desde `desde`. Pasado ese margen
     * se asume que la llamada terminó aunque el webhook no llegara; la conciliación
     * se ocupa de esos casos. Sin el margen, un webhook perdido ocuparía un canal
     * para siempre.
     */
    enCurso(desde: string): { total: number; porNumero: Map<string, number> } {
      const filas = db
        .prepare(
          `SELECT numero_salida AS n, COUNT(*) AS c FROM trabajos
           WHERE estado='despachado' AND actualizado_en >= ?
           GROUP BY numero_salida`,
        )
        .all(desde) as Array<{ n: string | null; c: number }>;
      const porNumero = new Map<string, number>();
      let total = 0;
      for (const f of filas) {
        total += f.c;
        if (f.n) porNumero.set(f.n, f.c);
      }
      return { total, porNumero };
    },

    /** Devuelve a la cola un trabajo tomado que no se pudo originar, sin contar el intento. */
    devolver(id: string): void {
      db.prepare(
        `UPDATE trabajos SET estado='pendiente', intentos=MAX(intentos-1, 0), actualizado_en=? WHERE id=?`,
      ).run(ahora(), id);
    },

    /**
     * Llamadas más recientes primero, para la consola del equipo. Filtra por
     * fecha de creación y por paciente; el detalle de cada una se arma aparte.
     */
    listar(f: { limite?: number; desde?: string; hasta?: string; idPaciente?: string } = {}): Array<Trabajo & { creadoEn: string; actualizadoEn: string }> {
      const cond: string[] = [];
      const args: unknown[] = [];
      if (f.desde) { cond.push('creado_en >= ?'); args.push(f.desde); }
      if (f.hasta) { cond.push('creado_en <= ?'); args.push(f.hasta); }
      if (f.idPaciente) { cond.push('id_paciente = ?'); args.push(f.idPaciente); }
      const where = cond.length > 0 ? `WHERE ${cond.join(' AND ')}` : '';
      const filas = db
        .prepare(`SELECT * FROM trabajos ${where} ORDER BY creado_en DESC LIMIT ?`)
        .all(...args, Math.min(f.limite ?? 200, 1000)) as Record<string, unknown>[];
      return filas.map((x) => ({ ...aTrabajo(x), creadoEn: String(x['creado_en']), actualizadoEn: String(x['actualizado_en']) }));
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
    numeroSalida: f['numero_salida'] == null ? null : String(f['numero_salida']),
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

    porLlamada(idLlamada: string): (ResultadoLlamada & { creadoEn: string; revisadoEn: string | null }) | null {
      const f = db.prepare(`SELECT * FROM resultados WHERE id_llamada=?`).get(idLlamada) as
        | Record<string, unknown>
        | undefined;
      if (!f) return null;
      return {
        idLlamada: String(f['id_llamada']),
        estadoFinal: String(f['estado_final']),
        criterios: JSON.parse(String(f['criterios_json'])) as ResultadoLlamada['criterios'],
        datos: JSON.parse(String(f['datos_json'])) as ResultadoLlamada['datos'],
        requiereRevisionHumana: Number(f['requiere_revision']) === 1,
        creadoEn: String(f['creado_en']),
        revisadoEn: f['revisado_en'] == null ? null : String(f['revisado_en']),
      };
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

// ------------------------------------------------------- números de salida

export type ProveedorTelefonia = 'twilio' | 'sip_trunk';

export interface NumeroSalida {
  /** `phone_number_id` del número en la plataforma de voz. */
  idPlataforma: string;
  e164: string;
  etiqueta: string;
  proveedor: ProveedorTelefonia;
  activo: boolean;
  /** Llamadas simultáneas que FALP permite originar desde este número. */
  concurrenciaMax: number;
  /** Menor gana a igual ocupación. */
  prioridad: number;
}

export function crearRepoNumeros(db: DB) {
  const leer = (f: Record<string, unknown>): NumeroSalida => ({
    idPlataforma: String(f['id_plataforma']),
    e164: String(f['e164']),
    etiqueta: String(f['etiqueta']),
    proveedor: String(f['proveedor']) === 'sip_trunk' ? 'sip_trunk' : 'twilio',
    activo: Number(f['activo']) === 1,
    concurrenciaMax: Number(f['concurrencia_max']),
    prioridad: Number(f['prioridad']),
  });
  const obtener = (id: string): NumeroSalida | null => {
    const f = db.prepare(`SELECT * FROM numeros_salida WHERE id_plataforma=?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return f ? leer(f) : null;
  };
  const insertar = db.prepare(
    `INSERT OR IGNORE INTO numeros_salida
       (id_plataforma, e164, etiqueta, proveedor, activo, concurrencia_max, prioridad, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    listar(): NumeroSalida[] {
      const filas = db.prepare(`SELECT * FROM numeros_salida ORDER BY prioridad, id_plataforma`).all();
      return (filas as Record<string, unknown>[]).map(leer);
    },

    activos(): NumeroSalida[] {
      const filas = db
        .prepare(`SELECT * FROM numeros_salida WHERE activo=1 ORDER BY prioridad, id_plataforma`)
        .all();
      return (filas as Record<string, unknown>[]).map(leer);
    },

    obtener,

    /** Inserta si no existe. Para el número configurado por entorno y el simulado. */
    sembrar(n: NumeroSalida): void {
      insertar.run(n.idPlataforma, n.e164, n.etiqueta, n.proveedor, n.activo ? 1 : 0, n.concurrenciaMax, n.prioridad, ahora(), ahora());
    },

    /**
     * Registra un número leído de la plataforma. Un número nuevo entra INACTIVO:
     * que esté importado en la plataforma no significa que alguien haya decidido
     * llamar a pacientes con él. Si ya existía, solo se refrescan los datos
     * descriptivos; su estado operativo no se toca.
     */
    registrarDesdePlataforma(
      n: { idPlataforma: string; e164: string; etiqueta: string; proveedor: ProveedorTelefonia },
      concurrenciaMax: number,
    ): 'nuevo' | 'actualizado' {
      if (obtener(n.idPlataforma)) {
        db.prepare(
          `UPDATE numeros_salida SET e164=?, etiqueta=?, proveedor=?, actualizado_en=? WHERE id_plataforma=?`,
        ).run(n.e164, n.etiqueta, n.proveedor, ahora(), n.idPlataforma);
        return 'actualizado';
      }
      insertar.run(n.idPlataforma, n.e164, n.etiqueta, n.proveedor, 0, concurrenciaMax, 100, ahora(), ahora());
      return 'nuevo';
    },

    actualizar(
      id: string,
      c: {
        activo?: boolean | undefined;
        concurrenciaMax?: number | undefined;
        prioridad?: number | undefined;
        etiqueta?: string | undefined;
      },
    ): NumeroSalida | null {
      const n = obtener(id);
      if (!n) return null;
      const m: NumeroSalida = {
        ...n,
        activo: c.activo ?? n.activo,
        concurrenciaMax: c.concurrenciaMax ?? n.concurrenciaMax,
        prioridad: c.prioridad ?? n.prioridad,
        etiqueta: c.etiqueta ?? n.etiqueta,
      };
      db.prepare(
        `UPDATE numeros_salida SET activo=?, concurrencia_max=?, prioridad=?, etiqueta=?, actualizado_en=?
         WHERE id_plataforma=?`,
      ).run(m.activo ? 1 : 0, m.concurrenciaMax, m.prioridad, m.etiqueta, ahora(), id);
      return obtener(id);
    },
  };
}

// -------------------------------------------------- destinos de transferencia

export type MotivoDestino = MotivoEnrutamiento | 'general';

export interface DestinoTransferencia {
  id: string;
  e164: string;
  etiqueta: string;
  /** `general` atiende cualquier motivo que no tenga un destino propio. */
  motivo: MotivoDestino;
  /** Vacío: cualquier servicio. */
  servicio: string;
  /** Hora de Chile, inclusiva. */
  horaDesde: number;
  /** Hora de Chile, exclusiva. */
  horaHasta: number;
  /** Días en que atiende: 1 lunes … 7 domingo. */
  dias: string;
  prioridad: number;
  activo: boolean;
}

export function crearRepoDestinos(db: DB) {
  const leer = (f: Record<string, unknown>): DestinoTransferencia => ({
    id: String(f['id']),
    e164: String(f['e164']),
    etiqueta: String(f['etiqueta']),
    motivo: String(f['motivo']) as MotivoDestino,
    servicio: String(f['servicio']),
    horaDesde: Number(f['hora_desde']),
    horaHasta: Number(f['hora_hasta']),
    dias: String(f['dias']),
    prioridad: Number(f['prioridad']),
    activo: Number(f['activo']) === 1,
  });

  return {
    listar(): DestinoTransferencia[] {
      const filas = db.prepare(`SELECT * FROM destinos_transferencia ORDER BY motivo, prioridad, id`).all();
      return (filas as Record<string, unknown>[]).map(leer);
    },

    activos(): DestinoTransferencia[] {
      const filas = db
        .prepare(`SELECT * FROM destinos_transferencia WHERE activo=1 ORDER BY motivo, prioridad, id`)
        .all();
      return (filas as Record<string, unknown>[]).map(leer);
    },

    guardar(d: DestinoTransferencia): void {
      db.prepare(
        `INSERT INTO destinos_transferencia
           (id, e164, etiqueta, motivo, servicio, hora_desde, hora_hasta, dias, prioridad, activo, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           e164=excluded.e164, etiqueta=excluded.etiqueta, motivo=excluded.motivo,
           servicio=excluded.servicio, hora_desde=excluded.hora_desde, hora_hasta=excluded.hora_hasta,
           dias=excluded.dias, prioridad=excluded.prioridad, activo=excluded.activo,
           actualizado_en=excluded.actualizado_en`,
      ).run(
        d.id, d.e164, d.etiqueta, d.motivo, d.servicio, d.horaDesde, d.horaHasta, d.dias,
        d.prioridad, d.activo ? 1 : 0, ahora(), ahora(),
      );
    },
  };
}

// ------------------------------------------------------------ anotaciones

/**
 * Campos que una persona puede completar después de la llamada. Conjunto
 * cerrado: cada uno se muestra en el informe junto al dato original, nunca en
 * su lugar.
 */
export const CAMPOS_ANOTABLES = [
  'acompanante_confirmado',
  'examenes_faltantes',
  'farmacos_no_confirmados',
  'hora_ayuno_repetida',
  'educacion_reforzada',
  'contacto_manual',
  'telefono_alternativo',
  'observacion',
] as const;
export type CampoAnotable = (typeof CAMPOS_ANOTABLES)[number];

export interface Anotacion {
  id: number;
  idLlamada: string;
  campo: CampoAnotable;
  valor: string;
  nota: string;
  autor: string;
  creadoEn: string;
}

export function crearRepoAnotaciones(db: DB) {
  const aAnotacion = (f: Record<string, unknown>): Anotacion => ({
    id: Number(f['id']),
    idLlamada: String(f['id_llamada']),
    campo: String(f['campo']) as CampoAnotable,
    valor: String(f['valor']),
    nota: String(f['nota'] ?? ''),
    autor: String(f['autor']),
    creadoEn: String(f['creado_en']),
  });
  return {
    agregar(a: Omit<Anotacion, 'id' | 'creadoEn'>): Anotacion {
      const r = db
        .prepare(`INSERT INTO anotaciones (id_llamada, campo, valor, nota, autor, creado_en) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(a.idLlamada, a.campo, a.valor, a.nota, a.autor, ahora());
      return aAnotacion(db.prepare(`SELECT * FROM anotaciones WHERE id=?`).get(Number(r.lastInsertRowid)) as Record<string, unknown>);
    },
    porLlamada(idLlamada: string): Anotacion[] {
      return (db.prepare(`SELECT * FROM anotaciones WHERE id_llamada=? ORDER BY id`).all(idLlamada) as Record<string, unknown>[]).map(aAnotacion);
    },
  };
}
