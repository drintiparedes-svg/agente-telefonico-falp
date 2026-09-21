/**
 * Consola del equipo: carga por texto, planilla, informe tabulado y anotaciones.
 *
 * Lo que se protege aquí: que el intérprete proponga sin inventar y copie las
 * instrucciones de fármacos literales; que la planilla pase por la misma
 * validación que el formulario; que el informe tabule educación, protocolo,
 * transcripción y faltantes a partir de lo que ya dejó la llamada; que una
 * anotación humana quede junto al dato original con autor; y que todo lo que
 * trata datos de pacientes exija el token de integración.
 */
import { afterEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { cargarConfig, _limpiarCacheConfig } from '../src/config/index.js';
import { construirServicio, type Servicio } from '../src/api/servidor.js';
import { ClienteVozSimulado } from '../src/telefonia/elevenlabs.js';
import { interpretarPorReglas } from '../src/consola/interpretar.js';
import { borradorAContexto, completarBorrador, normalizarFecha, normalizarHora, normalizarTelefono } from '../src/consola/borrador.js';
import { COLUMNAS, generarPlantilla, leerCsv, leerPlanilla } from '../src/consola/planilla.js';
import { contexto } from './fixtures.js';

const SECRETO = 'secreto-de-pruebas-1234567890';
const TOKEN = 'token-de-pruebas';
const INTEGRACION = 'token-integracion-de-pruebas-1';
const LUNES_11 = new Date('2026-04-13T15:00:00Z');
const HOY = new Date('2026-03-01T12:00:00Z');

const TEXTO =
  'Paciente María Pérez, ficha 12345, teléfono 9 1111 1111, RUT termina en 4821. ' +
  'Endoscopía el 15 de abril, llega a las 7:30 con acompañante. Ayuno desde las 22 horas. ' +
  'Suspender el acenocumarol desde el lunes en la mañana, tres días antes. Suspender la aspirina el mismo lunes. ' +
  'Traer hemograma y perfil de coagulación. Indica la Dra. Silva.';

// ------------------------------------------------------------- intérprete

describe('Intérprete por reglas', () => {
  const r = interpretarPorReglas(TEXTO, {}, HOY);
  const b = r.borrador;

  it('extrae identificación, contacto y verificación', () => {
    expect(b.nombre).toBe('María Pérez');
    expect(b.idPaciente).toBe('12345');
    expect(b.telefono).toBe('+56911111111');
    expect(b.rutUltimosCuatro).toBe('4821');
    expect(b.emitidaPor).toBe('Dra. Silva');
    expect(b.servicio).toBe('endoscopia');
  });

  it('extrae fecha y horas con el año próximo y en formato de la indicación', () => {
    expect(b.fechaProcedimiento).toBe('2026-04-15');
    expect(b.horaLlegada).toBe('07:30');
    expect(b.horaInicioAyuno).toBe('22:00');
    expect(b.requiereAcompanante).toBe(true);
  });

  it('copia cada instrucción de fármaco literal y lo advierte', () => {
    expect(b.farmacos.map((f) => f.nombre)).toEqual(['acenocumarol', 'aspirina']);
    expect(b.farmacos[0]!.instruccion).toBe('Suspender el acenocumarol desde el lunes en la mañana, tres días antes.');
    expect(b.farmacos[1]!.instruccion).toBe('Suspender la aspirina el mismo lunes.');
    expect(r.avisos.some((a) => /literal/.test(a))).toBe(true);
  });

  it('extrae la lista de exámenes', () => {
    expect(b.examenes).toEqual(['hemograma', 'perfil de coagulacion']);
  });

  it('lo que no está en el texto queda vacío y se reporta como faltante', () => {
    const p = interpretarPorReglas('Paciente Juan Soto, teléfono 987654321.', {}, HOY);
    expect(p.borrador.emitidaPor).toBe('');
    expect(p.borrador.fechaProcedimiento).toBe('');
    expect(p.borrador.farmacos).toEqual([]);
    expect(p.faltantes).toContain('profesional que emitió la indicación');
    expect(p.faltantes).toContain('fecha del procedimiento');
  });

  it('lo que la persona ya fijó manda sobre el texto', () => {
    const p = interpretarPorReglas(TEXTO, { telefono: '+56922222222', emitidaPor: 'Dr. Rojas' }, HOY);
    expect(p.borrador.telefono).toBe('+56922222222');
    expect(p.borrador.emitidaPor).toBe('Dr. Rojas');
  });

  it('un RUT completo aporta sus últimos cuatro dígitos', () => {
    expect(interpretarPorReglas('RUT 12.345.678-9', {}, HOY).borrador.rutUltimosCuatro).toBe('5678');
  });

  it('el borrador completo convierte a un contexto válido', () => {
    const c = borradorAContexto(b);
    expect(c.ok).toBe(true);
    expect(c.contexto?.verificacion.diaMesProcedimiento).toBe('15-04');
    expect(c.contexto?.indicacion.farmacosASuspender[0]?.instruccion).toBe(b.farmacos[0]!.instruccion);
  });
});

// -------------------------------------------------------------- borrador

describe('Normalización del borrador', () => {
  it('teléfonos chilenos en distintos formatos', () => {
    expect(normalizarTelefono('9 1111 1111')).toBe('+56911111111');
    expect(normalizarTelefono('56911111111')).toBe('+56911111111');
    expect(normalizarTelefono('+56 9 1111 1111')).toBe('+56911111111');
    expect(normalizarTelefono('1234')).toBe('1234');
  });

  it('fechas en varios formatos, con el año próximo cuando falta', () => {
    expect(normalizarFecha('2026-04-15', HOY)).toBe('2026-04-15');
    expect(normalizarFecha('15/04/2026', HOY)).toBe('2026-04-15');
    expect(normalizarFecha('15 de abril', HOY)).toBe('2026-04-15');
    expect(normalizarFecha('15 de enero', HOY)).toBe('2027-01-15');
    expect(normalizarFecha('15-04', HOY)).toBe('2026-04-15');
  });

  it('horas en varios formatos', () => {
    expect(normalizarHora('7:30')).toBe('07:30');
    expect(normalizarHora('22 hrs')).toBe('22:00');
    expect(normalizarHora('7 pm')).toBe('19:00');
    expect(normalizarHora('07.30')).toBe('07:30');
  });

  it('un borrador incompleto o mal formado no convierte y explica por qué', () => {
    const c = borradorAContexto(completarBorrador({ nombre: 'Ana', telefono: '123', rutUltimosCuatro: '12', fechaProcedimiento: 'ayer' }));
    expect(c.ok).toBe(false);
    expect(c.faltantes).toContain('identificador del paciente');
    expect(c.errores.some((e) => /teléfono/.test(e))).toBe(true);
    expect(c.errores.some((e) => /RUT/.test(e))).toBe(true);
    expect(c.errores.some((e) => /fecha/.test(e))).toBe(true);
  });

  it('un fármaco sin instrucción es un error, nunca se completa', () => {
    const b = interpretarPorReglas(TEXTO, {}, HOY).borrador;
    b.farmacos = [{ nombre: 'aspirina', instruccion: '' }];
    const c = borradorAContexto(b);
    expect(c.ok).toBe(false);
    expect(c.errores.some((e) => /fármaco/.test(e))).toBe(true);
  });
});

// -------------------------------------------------------------- planilla

describe('Planilla', () => {
  it('la plantilla se genera con todas las columnas y su fila de ejemplo es válida', async () => {
    const buf = await generarPlantilla();
    const r = await leerPlanilla(buf, 'plantilla.xlsx');
    expect(r.columnasIgnoradas).toEqual([]);
    expect(r.filas).toHaveLength(1);
    expect(r.filas[0]!.fila).toBe(2);
    expect(r.filas[0]!.conversion.ok).toBe(true);
    expect(r.filas[0]!.borrador.farmacos).toHaveLength(2);
    expect(r.filas[0]!.borrador.examenes).toEqual(['hemograma', 'perfil de coagulación']);
    expect(COLUMNAS.filter((c) => c.requerido).length).toBeGreaterThanOrEqual(9);
  });

  it('acepta títulos con alias, celdas de fecha y hora de Excel, y reporta filas inválidas con su número', async () => {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('x');
    hoja.addRow(['Ficha', 'Nombre paciente', 'Celular', 'RUT', 'Fecha', 'Llegada', 'Ayuno', 'Acompañante', 'Profesional', 'Columna extraña']);
    hoja.addRow(['p-1', 'Ana', '912345678', '1234', new Date(Date.UTC(2026, 3, 15)), new Date(Date.UTC(1899, 11, 30, 7, 30)), 22 / 24, 'sí', 'Dr. Rojas', 'x']);
    hoja.addRow(['p-2', 'Luis', '', '99', '2026-04-16', '08:00', '21:00', 'no', '', '']);
    const buf = Buffer.from(await libro.xlsx.writeBuffer());
    const r = await leerPlanilla(buf, 'pacientes.xlsx');
    expect(r.columnasIgnoradas).toEqual(['Columna extraña']);
    expect(r.filas).toHaveLength(2);
    const [a, b] = r.filas;
    expect(a!.conversion.ok).toBe(true);
    expect(a!.borrador).toMatchObject({ idPaciente: 'p-1', telefono: '+56912345678', fechaProcedimiento: '2026-04-15', horaLlegada: '07:30', horaInicioAyuno: '22:00', requiereAcompanante: true });
    expect(b!.fila).toBe(3);
    expect(b!.conversion.ok).toBe(false);
    expect(b!.conversion.faltantes).toEqual(expect.arrayContaining(['teléfono', 'profesional que emitió la indicación']));
    expect(b!.conversion.errores.some((e) => /RUT/.test(e))).toBe(true);
  });

  it('lee CSV con punto y coma y comillas', () => {
    const m = leerCsv('id_paciente;nombre;farmacos\n"p-1";"Ana; la de al lado";"a: Suspender ""a"" el lunes."\n');
    expect(m[1]).toEqual(['p-1', 'Ana; la de al lado', 'a: Suspender "a" el lunes.']);
  });
});

// -------------------------------------------------------------- servicio

describe('Consola en el servicio', () => {
  let svc: Servicio;
  let cliente: ClienteVozSimulado;

  function levantar(extra: Record<string, string> = {}) {
    _limpiarCacheConfig();
    const cfg = cargarConfig({
      NODE_ENV: 'test',
      DB_RUTA: ':memory:',
      WEBHOOK_SECRETO: SECRETO,
      LLM_TOKEN: TOKEN,
      NUMERO_TRANSFERENCIA: '+56000000000',
      NIVEL_LOG: 'fatal',
      ...extra,
    } as NodeJS.ProcessEnv);
    cliente = new ClienteVozSimulado();
    svc = construirServicio(cfg, cliente, { esperar: async () => undefined, reloj: () => LUNES_11 });
  }
  afterEach(async () => {
    await svc?.cerrar();
    _limpiarCacheConfig();
  });

  type Respuesta = Awaited<ReturnType<Servicio['app']['inject']>>;
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}): Promise<Respuesta> =>
    svc.app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers });
  const get = (url: string, headers: Record<string, string> = {}): Promise<Respuesta> => svc.app.inject({ method: 'GET', url, headers });

  /** Recorre una llamada completa por el endpoint de LLM y devuelve el id de trabajo. */
  async function llamadaCompleta(turnos: string[]): Promise<string> {
    const lote = await post('/llamadas/lote', { borradores: [interpretarPorReglas(TEXTO, {}, HOY).borrador], inmediata: true });
    expect(lote.statusCode).toBe(201);
    const idTrabajo = (lote.json() as { resultados: Array<{ idTrabajo: string }> }).resultados[0]!.idTrabajo;
    const idConv = cliente.llamadas.at(-1)!.idConversacion;
    const turno = (mensajes: Array<{ role: string; content: string }>) =>
      svc.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': idConv }, payload: { messages: mensajes } });
    await turno([]);
    for (const t of turnos) {
      const r = await turno([{ role: 'assistant', content: 'x' }, { role: 'user', content: t }]);
      if (r.body.includes('end_call') || r.body.includes('transfer_to_number')) break;
    }
    return idTrabajo;
  }

  it('sirve la página sin token y protege los datos con INTEGRACION_TOKEN', async () => {
    levantar({ INTEGRACION_TOKEN: INTEGRACION });
    const pagina = await get('/consola');
    expect(pagina.statusCode).toBe(200);
    expect(pagina.headers['content-type']).toMatch(/text\/html/);
    expect(pagina.body).toMatch(/Consola de llamadas/);
    for (const url of ['/informes/llamadas', '/consola/api/plantilla', '/consola/api/columnas']) {
      expect((await get(url)).statusCode).toBe(401);
      expect((await get(url, { authorization: `Bearer ${INTEGRACION}` })).statusCode).toBe(200);
    }
    expect((await post('/consola/api/interpretar', { texto: 'x' })).statusCode).toBe(401);
    expect((await post('/llamadas/lote', { borradores: [] })).statusCode).toBe(401);
  });

  it('interpreta texto y programa el lote validando de nuevo en el servidor', async () => {
    levantar();
    const i = await post('/consola/api/interpretar', { texto: TEXTO });
    expect(i.statusCode).toBe(200);
    const j = i.json() as { borrador: Record<string, unknown>; listo: boolean; origen: string };
    expect(j.origen).toBe('reglas');
    expect(j.borrador['nombre']).toBe('María Pérez');

    const malo = { ...j.borrador, emitidaPor: '' };
    const lote = await post('/llamadas/lote', { borradores: [j.borrador, malo], inmediata: true });
    expect(lote.statusCode).toBe(201);
    const r = lote.json() as { programadas: number; rechazadas: number; resultados: Array<{ ok: boolean; error: string | null }>; despacho: { intentado: boolean; despachados: number } };
    expect(r.programadas).toBe(1);
    expect(r.rechazadas).toBe(1);
    expect(r.resultados[1]!.error).toMatch(/profesional/);
    expect(r.despacho).toEqual({ intentado: true, despachados: 1 });
    expect(cliente.llamadas).toHaveLength(1);
  });

  it('valida una planilla subida en base64 sin programar nada', async () => {
    levantar();
    const buf = await generarPlantilla();
    const r = await post('/consola/api/planilla', { nombre: 'pacientes.xlsx', base64: buf.toString('base64') });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ total: 1, validas: 1 });
    expect(cliente.llamadas).toHaveLength(0);
    expect((await post('/consola/api/planilla', { nombre: 'x.pdf', base64: 'AAAA' })).statusCode).toBe(415);
  });

  it('tabula una llamada completa: educación entregada, protocolo cumplido, transcripción y sin faltantes', async () => {
    levantar();
    const id = await llamadaCompleta(['sí, soy yo', '4821', '15 del 04', 'a las 22:00', 'entendí', 'entendí', 'sí, los tengo', 'sí, viene mi hija']);
    const inf = (await get(`/llamadas/${id}/informe`)).json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(inf.estado).toBe('terminada');
    expect(inf.estadoFinal).toBe('terminada_ok');
    expect(inf.educacion.every((b: { entregado: boolean }) => b.entregado)).toBe(true);
    expect(inf.educacion.every((b: { confirmado: string }) => b.confirmado === 'si')).toBe(true);
    expect(inf.educacion.find((b: { bloque: string }) => b.bloque === 'farmaco:1').detalle).toMatch(/acenocumarol/);
    expect(inf.protocolo.cumplido).toBe(true);
    expect(inf.protocolo.cumplidos).toBe(inf.protocolo.total);
    expect(inf.transcripcion.length).toBeGreaterThanOrEqual(9);
    expect(inf.transcripcion[1].paciente).toBe('sí, soy yo');
    expect(inf.transcripcion[1].agente).toMatch(/RUT/);
    expect(inf.faltantes).toEqual([]);

    const tabla = (await get('/informes/llamadas')).json() as { total: number; llamadas: Array<Record<string, unknown>> };
    expect(tabla.total).toBe(1);
    expect(tabla.llamadas[0]).toMatchObject({ id, nombre: 'María Pérez', estado: 'terminada', protocoloCumplido: 'sí', faltantes: '' });
    expect(tabla.llamadas[0]!['educacionConfirmada']).toBe(`${inf.educacion.length}/${inf.educacion.length}`);
  });

  it('una llamada con alarma deja faltantes, que una persona completa con autor', async () => {
    levantar();
    const id = await llamadaCompleta(['sí, soy yo', '4821', '15 del 04', 'ya, pero ando con fiebre desde ayer']);
    let inf = (await get(`/llamadas/${id}/informe`)).json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(inf.estadoFinal).toBe('transferida_alarma');
    expect(inf.protocolo.requiereRevision).toBe(true);
    const campos = inf.faltantes.map((f: { campo: string }) => f.campo);
    expect(campos).toContain('hora_ayuno_repetida');
    expect(campos).toContain('contacto_manual');
    expect(inf.faltantes.every((f: { completado: unknown }) => f.completado === null)).toBe(true);

    const sinAutor = await post(`/llamadas/${id}/anotaciones`, { campo: 'contacto_manual', valor: 'x' });
    expect(sinAutor.statusCode).toBe(422);
    const malCampo = await post(`/llamadas/${id}/anotaciones`, { campo: 'diagnostico', valor: 'x', autor: 'Enf. Paz' });
    expect(malCampo.statusCode).toBe(422);

    const a = await post(`/llamadas/${id}/anotaciones`, { campo: 'contacto_manual', valor: 'Enfermería llamó a las 12:10; fiebre evaluada, se mantiene el procedimiento.', nota: 'Registrado en ficha', autor: 'Enf. Paz' });
    expect(a.statusCode).toBe(201);
    inf = (a.json() as { informe: Record<string, any> }).informe; // eslint-disable-line @typescript-eslint/no-explicit-any
    const contacto = inf.faltantes.find((f: { campo: string }) => f.campo === 'contacto_manual');
    expect(contacto.completado).toMatchObject({ autor: 'Enf. Paz', nota: 'Registrado en ficha' });
    expect(inf.faltantes.find((f: { campo: string }) => f.campo === 'hora_ayuno_repetida').completado).toBeNull();
    expect(inf.anotaciones).toHaveLength(1);
    // La transcripción no cambia: la anotación se guarda aparte.
    expect(inf.transcripcion.at(-1).paciente).toMatch(/fiebre/);

    const rev = await post(`/llamadas/${id}/revisar`, { revisor: 'Dra. Silva' });
    expect(rev.statusCode).toBe(200);
    expect((rev.json() as { informe: { protocolo: { revisadoEn: string | null } } }).informe.protocolo.revisadoEn).not.toBeNull();

    const fila = ((await get('/informes/llamadas')).json() as { llamadas: Array<Record<string, string>> }).llamadas[0]!;
    expect(fila['faltantes']).toMatch(/Hora de ayuno/);
    expect(fila['faltantesCompletados']).toMatch(/Enf\. Paz/);
    expect(fila['requiereRevision']).toBe('sí');
    expect(fila['revisadoEn']).not.toBe('');
  });

  it('una llamada sin resultado aparece con verificación manual pendiente', async () => {
    levantar();
    const lote = await post('/llamadas/lote', { borradores: [interpretarPorReglas(TEXTO, {}, HOY).borrador] });
    const id = (lote.json() as { resultados: Array<{ idTrabajo: string }> }).resultados[0]!.idTrabajo;
    const inf = (await get(`/llamadas/${id}/informe`)).json() as { estado: string; faltantes: Array<{ campo: string }>; protocolo: { total: number } };
    expect(inf.estado).toBe('programada');
    expect(inf.protocolo.total).toBe(0);
    expect(inf.faltantes[0]!.campo).toBe('contacto_manual');
  });

  it('exporta el informe tabulado como planilla', async () => {
    levantar();
    await llamadaCompleta(['sí, soy yo', '4821', '15 del 04', 'a las 22:00', 'entendí', 'entendí', 'sí', 'sí']);
    const r = await get('/informes/llamadas.xlsx');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    const hoja = libro.worksheets[0]!;
    expect(hoja.rowCount).toBe(2);
    expect(String(hoja.getRow(1).getCell(1).value)).toBe('ID llamada');
    expect(hoja.getRow(2).getCell(3).value).toBe('María Pérez');
  });

  it('no altera el contrato existente de POST /llamadas', async () => {
    levantar();
    const r = await post('/llamadas', { idPaciente: 'pac-001', telefono: '+56911111111', contexto });
    expect(r.statusCode).toBe(201);
  });
});
