/**
 * Planillas: carga masiva de pacientes desde Excel o CSV, plantilla descargable
 * y exportación del informe tabulado.
 *
 * Cada fila de la planilla es un borrador y pasa por la misma validación que el
 * formulario y que `POST /llamadas`. Una fila inválida se reporta con su número
 * y sus errores; las válidas se programan solo cuando la persona lo confirma.
 */
import ExcelJS from 'exceljs';
import { borradorAContexto, completarBorrador, type Borrador, type ConversionBorrador } from './borrador.js';
import type { FilaInforme } from './informe.js';

export interface ColumnaPlanilla {
  clave: string;
  titulo: string;
  requerido: boolean;
  ejemplo: string;
  ayuda: string;
}

export const COLUMNAS: readonly ColumnaPlanilla[] = [
  { clave: 'id_paciente', titulo: 'ID paciente', requerido: true, ejemplo: 'pac-001', ayuda: 'Identificador en el sistema clínico. Trazabilidad.' },
  { clave: 'nombre', titulo: 'Nombre', requerido: true, ejemplo: 'María', ayuda: 'Nombre con que se saluda al paciente.' },
  { clave: 'telefono', titulo: 'Teléfono', requerido: true, ejemplo: '+56911111111', ayuda: 'Nueve dígitos; se acepta con o sin +56.' },
  { clave: 'rut_ultimos4', titulo: 'RUT últimos 4', requerido: true, ejemplo: '4821', ayuda: 'Últimos cuatro dígitos sin dígito verificador. Primer factor de verificación.' },
  { clave: 'fecha_procedimiento', titulo: 'Fecha procedimiento', requerido: true, ejemplo: '2026-04-15', ayuda: 'AAAA-MM-DD o DD/MM/AAAA. Segundo factor de verificación.' },
  { clave: 'hora_llegada', titulo: 'Hora llegada', requerido: true, ejemplo: '07:30', ayuda: 'HH:MM.' },
  { clave: 'hora_inicio_ayuno', titulo: 'Hora inicio ayuno', requerido: true, ejemplo: '22:00', ayuda: 'HH:MM. El paciente debe repetirla.' },
  { clave: 'farmacos', titulo: 'Fármacos', requerido: false, ejemplo: 'acenocumarol: Debe suspender el acenocumarol desde el lunes en la mañana. | aspirina: La aspirina la suspende el mismo lunes.', ayuda: 'nombre: instrucción literal. Varios separados por |. La instrucción se lee tal cual.' },
  { clave: 'examenes', titulo: 'Exámenes', requerido: false, ejemplo: 'hemograma; perfil de coagulación', ayuda: 'Separados por ; o ,.' },
  { clave: 'requiere_acompanante', titulo: 'Requiere acompañante', requerido: true, ejemplo: 'sí', ayuda: 'sí / no.' },
  { clave: 'servicio', titulo: 'Servicio', requerido: false, ejemplo: 'endoscopia', ayuda: 'Enruta las transferencias al equipo de ese servicio.' },
  { clave: 'emitida_por', titulo: 'Emitida por', requerido: true, ejemplo: 'Dra. Silva', ayuda: 'Profesional que emitió la indicación. Sin esto la llamada no es lícita.' },
  { clave: 'emitida_en', titulo: 'Emitida en', requerido: false, ejemplo: '2026-04-10', ayuda: 'Fecha de emisión. Vacío: hoy.' },
  { clave: 'id_indicacion', titulo: 'ID indicación', requerido: false, ejemplo: 'ind-77', ayuda: 'Identificador en el sistema de origen. Vacío: se genera.' },
  { clave: 'programado_para', titulo: 'Programado para', requerido: false, ejemplo: '', ayuda: 'Fecha y hora ISO para llamar más tarde. Vacío: cuanto antes.' },
];

export interface FilaLeida {
  fila: number;
  borrador: Borrador;
  conversion: ConversionBorrador;
}

function normalizarClave(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

const ALIAS: Record<string, string> = {
  idpaciente: 'id_paciente', id: 'id_paciente', paciente: 'id_paciente', ficha: 'id_paciente',
  nombre_paciente: 'nombre', fono: 'telefono', celular: 'telefono',
  rut: 'rut_ultimos4', rut_ultimos_4: 'rut_ultimos4', rut_ultimos_cuatro: 'rut_ultimos4',
  fecha: 'fecha_procedimiento', fecha_del_procedimiento: 'fecha_procedimiento',
  hora_de_llegada: 'hora_llegada', llegada: 'hora_llegada',
  ayuno: 'hora_inicio_ayuno', hora_ayuno: 'hora_inicio_ayuno', hora_de_inicio_del_ayuno: 'hora_inicio_ayuno',
  medicamentos: 'farmacos', farmacos_a_suspender: 'farmacos',
  examenes_requeridos: 'examenes',
  acompanante: 'requiere_acompanante',
  emitida_por: 'emitida_por', profesional: 'emitida_por', indica: 'emitida_por',
  emitida_en: 'emitida_en', fecha_emision: 'emitida_en',
  indicacion: 'id_indicacion', id_indicacion: 'id_indicacion',
  programado_para: 'programado_para', programar_para: 'programado_para',
};

function resolverColumna(titulo: string): string | null {
  const k = normalizarClave(titulo);
  if (COLUMNAS.some((c) => c.clave === k)) return k;
  if (ALIAS[k]) return ALIAS[k]!;
  const porTitulo = COLUMNAS.find((c) => normalizarClave(c.titulo) === k);
  return porTitulo?.clave ?? null;
}

/** Valor de celda como texto. Fechas y horas de Excel se convierten sin zona horaria. */
function celdaATexto(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // exceljs entrega fechas en UTC. Una celda de hora pura viene sobre 1899-12-30.
    const esHora = v.getUTCFullYear() < 1905;
    if (esHora) return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') {
    if (v > 0 && v < 1) {
      // Fracción de día: una hora sin fecha.
      const min = Math.round(v * 24 * 60);
      return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    }
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return celdaATexto(v.result as ExcelJS.CellValue);
    if ('error' in v) return '';
  }
  return String(v).trim();
}

export function filaABorrador(campos: Record<string, string>): Borrador {
  const farmacos = (campos['farmacos'] ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf(':');
      return i === -1 ? { nombre: x, instruccion: '' } : { nombre: x.slice(0, i).trim(), instruccion: x.slice(i + 1).trim() };
    });
  const examenes = (campos['examenes'] ?? '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  return completarBorrador({
    idPaciente: campos['id_paciente'] ?? '',
    nombre: campos['nombre'] ?? '',
    telefono: campos['telefono'] ?? '',
    rutUltimosCuatro: campos['rut_ultimos4'] ?? '',
    fechaProcedimiento: campos['fecha_procedimiento'] ?? '',
    horaLlegada: campos['hora_llegada'] ?? '',
    horaInicioAyuno: campos['hora_inicio_ayuno'] ?? '',
    farmacos,
    examenes,
    requiereAcompanante: (campos['requiere_acompanante'] ?? '') as unknown as boolean | null,
    servicio: campos['servicio'] ?? '',
    emitidaPor: campos['emitida_por'] ?? '',
    emitidaEn: campos['emitida_en'] ?? '',
    idIndicacion: campos['id_indicacion'] ?? '',
    programadoPara: campos['programado_para'] ?? '',
  });
}

/** Lee una planilla .xlsx (primera hoja) o .csv. La primera fila son los títulos. */
export async function leerPlanilla(contenido: Buffer, nombre: string): Promise<{ filas: FilaLeida[]; columnasIgnoradas: string[] }> {
  const matriz = /\.csv$/i.test(nombre) ? leerCsv(contenido.toString('utf8')) : await leerXlsx(contenido);
  const [cabecera, ...cuerpo] = matriz;
  if (!cabecera) return { filas: [], columnasIgnoradas: [] };
  const mapa: Array<string | null> = cabecera.map((t) => (t ? resolverColumna(t) : null));
  const columnasIgnoradas = cabecera.filter((t, i) => t && mapa[i] === null);
  const filas: FilaLeida[] = [];
  cuerpo.forEach((celdas, i) => {
    if (celdas.every((c) => c === '')) return;
    const campos: Record<string, string> = {};
    mapa.forEach((clave, j) => {
      if (clave) campos[clave] = celdas[j] ?? '';
    });
    const borrador = filaABorrador(campos);
    filas.push({ fila: i + 2, borrador, conversion: borradorAContexto(borrador) });
  });
  return { filas, columnasIgnoradas };
}

async function leerXlsx(contenido: Buffer): Promise<string[][]> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(contenido as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (!hoja) return [];
  const matriz: string[][] = [];
  hoja.eachRow({ includeEmpty: false }, (fila, n) => {
    const celdas: string[] = [];
    for (let c = 1; c <= hoja.columnCount; c++) celdas.push(celdaATexto(fila.getCell(c).value));
    matriz[n - 1] = celdas;
  });
  return matriz.map((f) => f ?? []);
}

/** CSV simple con comillas dobles; separador , o ; según la cabecera. */
export function leerCsv(texto: string): string[][] {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const primera = lineas[0] ?? '';
  const sep = (primera.match(/;/g)?.length ?? 0) > (primera.match(/,/g)?.length ?? 0) ? ';' : ',';
  return lineas.map((l) => {
    const out: string[] = [];
    let actual = '';
    let entreComillas = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]!;
      if (ch === '"') {
        if (entreComillas && l[i + 1] === '"') { actual += '"'; i++; }
        else entreComillas = !entreComillas;
      } else if (ch === sep && !entreComillas) { out.push(actual.trim()); actual = ''; }
      else actual += ch;
    }
    out.push(actual.trim());
    return out;
  });
}

/** Plantilla con títulos, una fila de ejemplo y una hoja de instrucciones. */
export async function generarPlantilla(): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Pacientes');
  hoja.columns = COLUMNAS.map((c) => ({ header: c.clave, key: c.clave, width: Math.max(14, Math.min(48, c.ejemplo.length + 4)) }));
  hoja.addRow(Object.fromEntries(COLUMNAS.map((c) => [c.clave, c.ejemplo])));
  hoja.getRow(1).font = { bold: true };
  for (let i = 0; i < COLUMNAS.length; i++) {
    hoja.getCell(1, i + 1).note = `${COLUMNAS[i]!.titulo}${COLUMNAS[i]!.requerido ? ' (obligatorio)' : ''}. ${COLUMNAS[i]!.ayuda}`;
  }
  const ayuda = libro.addWorksheet('Instrucciones');
  ayuda.columns = [{ header: 'Columna', key: 'c', width: 24 }, { header: 'Obligatoria', key: 'o', width: 12 }, { header: 'Formato y ejemplo', key: 'a', width: 90 }];
  ayuda.getRow(1).font = { bold: true };
  for (const c of COLUMNAS) ayuda.addRow({ c: c.clave, o: c.requerido ? 'sí' : 'no', a: `${c.ayuda} Ejemplo: ${c.ejemplo}` });
  ayuda.addRow({});
  ayuda.addRow({ c: 'Nota', a: 'La fila 2 de «Pacientes» es un ejemplo: bórrela antes de cargar. Cada instrucción de fármaco se lee al paciente tal cual está escrita.' });
  return Buffer.from(await libro.xlsx.writeBuffer());
}

const COLUMNAS_INFORME: Array<{ key: keyof FilaInforme; header: string; width: number }> = [
  { key: 'id', header: 'ID llamada', width: 38 },
  { key: 'idPaciente', header: 'ID paciente', width: 14 },
  { key: 'nombre', header: 'Nombre', width: 16 },
  { key: 'telefono', header: 'Teléfono', width: 15 },
  { key: 'servicio', header: 'Servicio', width: 14 },
  { key: 'fechaProcedimiento', header: 'Fecha procedimiento', width: 14 },
  { key: 'emitidaPor', header: 'Emitida por', width: 16 },
  { key: 'creadaEn', header: 'Programada el', width: 22 },
  { key: 'estado', header: 'Estado', width: 13 },
  { key: 'estadoFinal', header: 'Desenlace', width: 24 },
  { key: 'resumen', header: 'Resumen', width: 60 },
  { key: 'educacionEntregada', header: 'Educación entregada', width: 12 },
  { key: 'educacionConfirmada', header: 'Educación confirmada', width: 12 },
  { key: 'protocoloCumplido', header: 'Protocolo cumplido', width: 12 },
  { key: 'criteriosCumplidos', header: 'Criterios', width: 10 },
  { key: 'criteriosNoCumplidos', header: 'Criterios no cumplidos', width: 40 },
  { key: 'requiereRevision', header: 'Requiere revisión', width: 12 },
  { key: 'revisadoEn', header: 'Revisado en', width: 22 },
  { key: 'faltantes', header: 'Información faltante', width: 60 },
  { key: 'faltantesCompletados', header: 'Completado a mano', width: 50 },
  { key: 'turnos', header: 'Turnos', width: 8 },
];

/** Exporta las filas tabuladas. La transcripción no viaja: está en el detalle de cada llamada. */
export async function exportarInforme(filas: FilaInforme[]): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Llamadas');
  hoja.columns = COLUMNAS_INFORME.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  hoja.getRow(1).font = { bold: true };
  hoja.views = [{ state: 'frozen', ySplit: 1 }];
  for (const f of filas) hoja.addRow(f);
  return Buffer.from(await libro.xlsx.writeBuffer());
}
