/**
 * Rutas de la consola del equipo.
 *
 *   GET  /consola                       la página (sin datos; el token se pide ahí)
 *   POST /consola/api/interpretar       texto libre → borrador propuesto
 *   POST /consola/api/validar           borrador → contexto válido o lista de faltantes
 *   POST /consola/api/planilla          archivo (base64) → filas validadas, sin programar
 *   GET  /consola/api/plantilla         plantilla .xlsx descargable
 *   POST /llamadas/lote                 programa varios borradores ya validados
 *   GET  /informes/llamadas             tabla de llamadas (educación, protocolo, faltantes)
 *   GET  /informes/llamadas.xlsx        la misma tabla, exportada
 *   GET  /llamadas/:id/informe          detalle: educación, protocolo, transcripción, faltantes
 *   POST /llamadas/:id/anotaciones      completar información faltante, con autor
 *   POST /llamadas/:id/revisar          cerrar la revisión humana
 *
 * Todo lo que no es la página trata datos de pacientes y va detrás de
 * INTEGRACION_TOKEN (ver RUTAS_DE_INTEGRACION en api/servidor.ts).
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { borradorAContexto, completarBorrador, type Borrador } from './borrador.js';
import type { Interprete } from './interpretar.js';
import { aFila, armarInforme } from './informe.js';
import { COLUMNAS, exportarInforme, generarPlantilla, leerPlanilla } from './planilla.js';
import { CAMPOS_ANOTABLES, type crearRepoAnotaciones, type crearRepoAuditoria, type crearRepoResultados, type crearRepoTrabajos } from '../persistencia/repositorios.js';
import type { crearDespachador } from '../telefonia/despachador.js';

export interface DepsConsola {
  interprete: Interprete;
  despachador: ReturnType<typeof crearDespachador>;
  trabajos: ReturnType<typeof crearRepoTrabajos>;
  resultados: ReturnType<typeof crearRepoResultados>;
  auditoria: ReturnType<typeof crearRepoAuditoria>;
  anotaciones: ReturnType<typeof crearRepoAnotaciones>;
  reloj?: () => Date;
}

const Interpretar = z.object({ texto: z.string().max(20_000), base: z.record(z.unknown()).optional() });
const Validar = z.object({ borrador: z.record(z.unknown()) });
const Planilla = z.object({ nombre: z.string().min(1).max(200), base64: z.string().min(1) });
const Lote = z.object({ borradores: z.array(z.record(z.unknown())).min(1).max(500), inmediata: z.boolean().optional() });
const NuevaAnotacion = z.object({
  campo: z.enum(CAMPOS_ANOTABLES),
  valor: z.string().min(1).max(2000),
  nota: z.string().max(2000).default(''),
  autor: z.string().min(2).max(120),
});
const Revisar = z.object({ revisor: z.string().min(2).max(120) });

export function registrarConsola(app: FastifyInstance, deps: DepsConsola): void {
  const pagina = readFileSync(new URL('./pagina.html', import.meta.url), 'utf8');
  const ahora = () => (deps.reloj ?? (() => new Date()))();

  app.get('/consola', async (_req, reply) => reply.type('text/html; charset=utf-8').send(pagina));

  app.post('/consola/api/interpretar', async (req, reply) => {
    const p = Interpretar.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'Falta el texto.' });
    const r = await deps.interprete.interpretar(p.data.texto, (p.data.base ?? {}) as Partial<Borrador>);
    const conversion = borradorAContexto(r.borrador);
    return { ...r, listo: conversion.ok, errores: conversion.errores };
  });

  app.post('/consola/api/validar', async (req, reply) => {
    const p = Validar.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'Falta el borrador.' });
    const borrador = completarBorrador(p.data.borrador as Partial<Borrador>);
    const c = borradorAContexto(borrador);
    return { borrador, ok: c.ok, faltantes: c.faltantes, errores: c.errores, contexto: c.contexto };
  });

  app.get('/consola/api/columnas', async () => ({ columnas: COLUMNAS }));

  app.get('/consola/api/plantilla', async (_req, reply) => {
    const buf = await generarPlantilla();
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="plantilla-llamadas.xlsx"')
      .send(buf);
  });

  app.post('/consola/api/planilla', async (req, reply) => {
    const p = Planilla.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'Falta el archivo.' });
    if (!/\.(xlsx|csv)$/i.test(p.data.nombre)) return reply.code(415).send({ error: 'Solo se aceptan archivos .xlsx o .csv.' });
    let lectura;
    try {
      lectura = await leerPlanilla(Buffer.from(p.data.base64, 'base64'), p.data.nombre);
    } catch (e) {
      return reply.code(422).send({ error: `No se pudo leer la planilla: ${e instanceof Error ? e.message : String(e)}` });
    }
    const filas = lectura.filas.map((f) => ({
      fila: f.fila,
      borrador: f.borrador,
      ok: f.conversion.ok,
      faltantes: f.conversion.faltantes,
      errores: f.conversion.errores,
    }));
    return {
      total: filas.length,
      validas: filas.filter((f) => f.ok).length,
      columnasIgnoradas: lectura.columnasIgnoradas,
      filas,
    };
  });

  // Programa varios borradores. Cada uno se valida de nuevo aquí: lo que el
  // navegador dijo que era válido no se toma por cierto.
  app.post('/llamadas/lote', async (req, reply) => {
    const p = Lote.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'Se esperaba una lista de borradores (máximo 500).' });
    const resultados = p.data.borradores.map((raw, i) => {
      const b = completarBorrador(raw as Partial<Borrador>);
      const c = borradorAContexto(b);
      if (!c.ok || !c.contexto) {
        return { indice: i, idPaciente: b.idPaciente, ok: false, idTrabajo: null, error: [...c.faltantes.map((f) => `Falta ${f}`), ...c.errores].join(' ') };
      }
      const r = deps.despachador.programar({
        idPaciente: c.idPaciente,
        telefono: c.telefono,
        contexto: c.contexto,
        ...(c.programadoPara ? { programadoPara: c.programadoPara } : {}),
      });
      return { indice: i, idPaciente: b.idPaciente, ok: r.ok, idTrabajo: r.idTrabajo, error: r.error };
    });
    let despacho: { intentado: boolean; despachados: number } = { intentado: false, despachados: 0 };
    if (p.data.inmediata === true && resultados.some((r) => r.ok)) {
      const d = await deps.despachador.despacharLote(ahora());
      despacho = { intentado: true, despachados: d.despachados };
    }
    const programadas = resultados.filter((r) => r.ok).length;
    return reply.code(programadas > 0 ? 201 : 422).send({ programadas, rechazadas: resultados.length - programadas, resultados, despacho });
  });

  const informeDe = (id: string) => {
    const t = deps.trabajos.porId(id);
    if (!t) return null;
    return armarInforme(t, deps.resultados.porLlamada(id), deps.auditoria.porLlamada(id), deps.anotaciones.porLlamada(id), ahora());
  };

  app.get('/informes/llamadas', async (req) => {
    const q = req.query as { limite?: string; desde?: string; hasta?: string; idPaciente?: string };
    const trabajos = deps.trabajos.listar({
      limite: q.limite ? Number(q.limite) : 200,
      ...(q.desde ? { desde: q.desde } : {}),
      ...(q.hasta ? { hasta: q.hasta } : {}),
      ...(q.idPaciente ? { idPaciente: q.idPaciente } : {}),
    });
    const llamadas = trabajos.map((t) =>
      aFila(armarInforme(t, deps.resultados.porLlamada(t.id), deps.auditoria.porLlamada(t.id), deps.anotaciones.porLlamada(t.id), ahora())),
    );
    return { total: llamadas.length, llamadas };
  });

  app.get('/informes/llamadas.xlsx', async (req, reply) => {
    const q = req.query as { desde?: string; hasta?: string };
    const trabajos = deps.trabajos.listar({ limite: 1000, ...(q.desde ? { desde: q.desde } : {}), ...(q.hasta ? { hasta: q.hasta } : {}) });
    const filas = trabajos.map((t) =>
      aFila(armarInforme(t, deps.resultados.porLlamada(t.id), deps.auditoria.porLlamada(t.id), deps.anotaciones.porLlamada(t.id), ahora())),
    );
    const buf = await exportarInforme(filas);
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="llamadas-${ahora().toISOString().slice(0, 10)}.xlsx"`)
      .send(buf);
  });

  app.get('/llamadas/:id/informe', async (req, reply) => {
    const { id } = req.params as { id: string };
    const inf = informeDe(id);
    return inf ?? reply.code(404).send({ error: 'No hay ninguna llamada con ese identificador.' });
  });

  app.post('/llamadas/:id/anotaciones', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.trabajos.porId(id)) return reply.code(404).send({ error: 'No hay ninguna llamada con ese identificador.' });
    const p = NuevaAnotacion.safeParse(req.body);
    if (!p.success) {
      return reply.code(422).send({ error: 'Anotación inválida.', detalle: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), camposAdmitidos: CAMPOS_ANOTABLES });
    }
    const a = deps.anotaciones.agregar({ idLlamada: id, ...p.data });
    return reply.code(201).send({ anotacion: a, informe: informeDe(id) });
  });

  app.post('/llamadas/:id/revisar', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deps.resultados.porLlamada(id)) return reply.code(404).send({ error: 'Esa llamada no tiene resultado que revisar.' });
    const p = Revisar.safeParse(req.body);
    if (!p.success) return reply.code(422).send({ error: 'Falta el nombre de quien revisa.' });
    deps.resultados.marcarRevisado(id, p.data.revisor);
    return { ok: true, informe: informeDe(id) };
  });
}
