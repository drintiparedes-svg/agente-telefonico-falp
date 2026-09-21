/**
 * Borrador de una llamada: lo que el equipo captura antes de programar.
 *
 * Es la forma plana que comparten el formulario de la consola, el intérprete de
 * texto libre y la planilla. Un borrador puede estar incompleto; la conversión a
 * `ContextoLlamada` es la que decide si alcanza para programar, y lo hace con
 * el mismo esquema estricto que valida `POST /llamadas`. No hay un camino de
 * entrada más laxo que otro.
 */
import { randomUUID } from 'node:crypto';
import { ContextoLlamada } from '../dominio/tipos.js';

export interface Borrador {
  idPaciente: string;
  nombre: string;
  telefono: string;
  rutUltimosCuatro: string;
  /** AAAA-MM-DD */
  fechaProcedimiento: string;
  /** HH:MM */
  horaLlegada: string;
  /** HH:MM */
  horaInicioAyuno: string;
  farmacos: Array<{ nombre: string; instruccion: string }>;
  examenes: string[];
  requiereAcompanante: boolean | null;
  servicio: string;
  emitidaPor: string;
  /** Opcional: se genera si falta. */
  idIndicacion: string;
  /** Opcional: ahora si falta. */
  emitidaEn: string;
  /** Opcional: ISO 8601. Vacío programa para ahora. */
  programadoPara: string;
}

export function borradorVacio(): Borrador {
  return {
    idPaciente: '',
    nombre: '',
    telefono: '',
    rutUltimosCuatro: '',
    fechaProcedimiento: '',
    horaLlegada: '',
    horaInicioAyuno: '',
    farmacos: [],
    examenes: [],
    requiereAcompanante: null,
    servicio: '',
    emitidaPor: '',
    idIndicacion: '',
    emitidaEn: '',
    programadoPara: '',
  };
}

/** Campos sin los cuales no se puede programar, con el nombre que ve el equipo. */
export const CAMPOS_OBLIGATORIOS: ReadonlyArray<{ clave: keyof Borrador; titulo: string }> = [
  { clave: 'idPaciente', titulo: 'identificador del paciente' },
  { clave: 'nombre', titulo: 'nombre del paciente' },
  { clave: 'telefono', titulo: 'teléfono' },
  { clave: 'rutUltimosCuatro', titulo: 'últimos cuatro dígitos del RUT' },
  { clave: 'fechaProcedimiento', titulo: 'fecha del procedimiento' },
  { clave: 'horaLlegada', titulo: 'hora de llegada' },
  { clave: 'horaInicioAyuno', titulo: 'hora de inicio del ayuno' },
  { clave: 'requiereAcompanante', titulo: 'si requiere acompañante' },
  { clave: 'emitidaPor', titulo: 'profesional que emitió la indicación' },
];

export function faltantesDe(b: Borrador): string[] {
  return CAMPOS_OBLIGATORIOS.filter(({ clave }) => {
    const v = b[clave];
    return v === null || v === '' || v === undefined;
  }).map((c) => c.titulo);
}

/** Acepta un borrador parcial y lo completa con vacíos, sin inventar nada. */
export function completarBorrador(p: Partial<Borrador> | null | undefined): Borrador {
  const b = borradorVacio();
  if (!p || typeof p !== 'object') return b;
  const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  b.idPaciente = texto(p.idPaciente);
  b.nombre = texto(p.nombre);
  b.telefono = normalizarTelefono(texto(p.telefono));
  b.rutUltimosCuatro = texto(p.rutUltimosCuatro).replace(/\D/g, '').slice(-4);
  b.fechaProcedimiento = normalizarFecha(texto(p.fechaProcedimiento));
  b.horaLlegada = normalizarHora(texto(p.horaLlegada));
  b.horaInicioAyuno = normalizarHora(texto(p.horaInicioAyuno));
  b.farmacos = Array.isArray(p.farmacos)
    ? p.farmacos
        .map((f) => ({ nombre: texto((f as { nombre?: unknown })?.nombre), instruccion: texto((f as { instruccion?: unknown })?.instruccion) }))
        .filter((f) => f.nombre !== '' || f.instruccion !== '')
    : [];
  b.examenes = Array.isArray(p.examenes) ? p.examenes.map(texto).filter((x) => x !== '') : [];
  b.requiereAcompanante = typeof p.requiereAcompanante === 'boolean' ? p.requiereAcompanante : interpretarBooleano(texto(p.requiereAcompanante));
  b.servicio = texto(p.servicio);
  b.emitidaPor = texto(p.emitidaPor);
  b.idIndicacion = texto(p.idIndicacion);
  b.emitidaEn = texto(p.emitidaEn);
  b.programadoPara = texto(p.programadoPara);
  return b;
}

export interface ConversionBorrador {
  ok: boolean;
  contexto: ContextoLlamada | null;
  idPaciente: string;
  telefono: string;
  programadoPara: string | null;
  faltantes: string[];
  errores: string[];
}

/**
 * Convierte el borrador en lo que `POST /llamadas` acepta. Devuelve la lista de
 * faltantes y de errores en palabras del equipo; nunca lanza.
 */
export function borradorAContexto(b: Borrador, opciones: { idLlamada?: string } = {}): ConversionBorrador {
  const faltantes = faltantesDe(b);
  const errores: string[] = [];
  if (b.telefono !== '' && !/^\+56\d{9}$/.test(b.telefono)) errores.push('El teléfono debe ser un número chileno de nueve dígitos.');
  if (b.rutUltimosCuatro !== '' && !/^\d{4}$/.test(b.rutUltimosCuatro)) errores.push('Los últimos cuatro dígitos del RUT deben ser exactamente cuatro números.');
  if (b.fechaProcedimiento !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(b.fechaProcedimiento)) errores.push('La fecha del procedimiento debe tener formato AAAA-MM-DD.');
  for (const [campo, valor] of [['hora de llegada', b.horaLlegada], ['hora de inicio del ayuno', b.horaInicioAyuno]] as const) {
    if (valor !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(valor)) errores.push(`La ${campo} debe tener formato HH:MM.`);
  }
  for (const f of b.farmacos) {
    if (f.nombre === '' || f.instruccion === '') errores.push('Cada fármaco necesita nombre e instrucción textual tal como la emitió el equipo tratante.');
  }
  if (b.programadoPara !== '' && Number.isNaN(Date.parse(b.programadoPara))) errores.push('La fecha de programación no es una fecha válida.');
  if (b.emitidaEn !== '' && Number.isNaN(Date.parse(b.emitidaEn))) errores.push('La fecha de emisión de la indicación no es una fecha válida.');

  const base = { ok: false, contexto: null, idPaciente: b.idPaciente, telefono: b.telefono, programadoPara: b.programadoPara || null, faltantes, errores };
  if (faltantes.length > 0 || errores.length > 0) return base;

  const candidato = {
    ...(opciones.idLlamada ? { idLlamada: opciones.idLlamada } : {}),
    idPaciente: b.idPaciente,
    ...(b.servicio ? { servicio: b.servicio } : {}),
    verificacion: {
      nombrePaciente: b.nombre,
      rutUltimosCuatro: b.rutUltimosCuatro,
      diaMesProcedimiento: `${b.fechaProcedimiento.slice(8, 10)}-${b.fechaProcedimiento.slice(5, 7)}`,
    },
    indicacion: {
      idIndicacion: b.idIndicacion || `ind-${randomUUID().slice(0, 8)}`,
      emitidaPor: b.emitidaPor,
      emitidaEn: b.emitidaEn ? new Date(b.emitidaEn).toISOString() : new Date().toISOString(),
      horaInicioAyuno: b.horaInicioAyuno,
      farmacosASuspender: b.farmacos,
      examenesRequeridos: b.examenes,
      requiereAcompanante: b.requiereAcompanante === true,
      horaLlegada: b.horaLlegada,
      fechaProcedimiento: b.fechaProcedimiento,
    },
  };
  // El esquema exige idLlamada; al programar se genera. Aquí se valida con uno provisional.
  const r = ContextoLlamada.safeParse({ idLlamada: opciones.idLlamada ?? 'provisional', ...candidato });
  if (!r.success) {
    return { ...base, errores: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const contexto = opciones.idLlamada ? r.data : ({ ...r.data, idLlamada: undefined } as unknown as ContextoLlamada);
  return { ...base, ok: true, contexto };
}

// ---------------------------------------------------------- normalizadores

/** Deja un número chileno en +56XXXXXXXXX. Lo que no se pueda interpretar se devuelve tal cual. */
export function normalizarTelefono(t: string): string {
  const d = t.replace(/\D/g, '');
  if (d.length === 9) return `+56${d}`;
  if (d.length === 11 && d.startsWith('56')) return `+${d}`;
  if (d.length === 8) return `+569${d}`;
  return t.trim();
}

const MESES: Record<string, string> = {
  enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09', setiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
};

/**
 * Acepta AAAA-MM-DD, DD-MM-AAAA, DD/MM/AAAA y «15 de abril [de 2026]». Sin año
 * se asume el próximo en que esa fecha cae en el futuro: una preparación se
 * programa antes del procedimiento, no después.
 */
export function normalizarFecha(v: string, hoy: Date = new Date()): string {
  const t = v.trim().toLowerCase();
  if (t === '') return '';
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (m) return proximaFecha(Number(m[1]), Number(m[2]), hoy);
  m = t.match(/^(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?$/);
  if (m) {
    const mes = MESES[m[2]!.normalize('NFD').replace(/[̀-ͯ]/g, '')];
    if (!mes) return v.trim();
    if (m[3]) return `${m[3]}-${mes}-${m[1]!.padStart(2, '0')}`;
    return proximaFecha(Number(m[1]), Number(mes), hoy);
  }
  return v.trim();
}

function proximaFecha(dia: number, mes: number, hoy: Date): string {
  const anio = hoy.getUTCFullYear();
  const candidata = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  const hoyIso = hoy.toISOString().slice(0, 10);
  return candidata >= hoyIso ? candidata : `${anio + 1}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Acepta «7:30», «07.30», «22 hrs», «7 am», «22:00». Lo demás se devuelve tal cual. */
export function normalizarHora(v: string): string {
  const t = v.trim().toLowerCase();
  if (t === '') return '';
  const m = t.match(/^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|hrs?|horas?)?\.?$/);
  if (!m) return v.trim();
  let h = Number(m[1]);
  const min = m[2] ?? '00';
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || Number(min) > 59) return v.trim();
  return `${String(h).padStart(2, '0')}:${min}`;
}

export function interpretarBooleano(v: string): boolean | null {
  const t = v.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (['si', 's', 'true', '1', 'x', 'verdadero', 'requiere'].includes(t)) return true;
  if (['no', 'n', 'false', '0', 'falso', 'no requiere'].includes(t)) return false;
  return null;
}
