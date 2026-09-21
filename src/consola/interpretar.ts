/**
 * Intérprete de texto libre: convierte lo que una persona del equipo escribe o
 * dicta («María Pérez, RUT termina en 4821, endoscopía el 15 de abril, ayuno
 * desde las 22, suspender acenocumarol tres días antes, traer hemograma, llega
 * a las 7:30 con acompañante, indica la Dra. Silva») en un borrador.
 *
 * Es una PROPUESTA. La persona la revisa campo por campo en el formulario y es
 * ella quien programa. Dos reglas que no se negocian:
 *
 * 1. La instrucción de cada fármaco se copia literal de lo dicho. Ni el modelo
 *    ni las reglas la redactan, completan ni corrigen: es contenido clínico
 *    emitido por el equipo tratante y el agente la leerá tal cual.
 * 2. Lo que no está en el texto queda vacío. Nada se infiere ni se rellena con
 *    valores típicos.
 *
 * Igual que el clasificador: hay una versión por reglas, sin red, que sirve
 * para desarrollo y como respaldo, y una versión por modelo que solo estructura.
 */
import { extraerHoraDicha, formatearHora } from '../dominio/checklist/numeros.js';
import { borradorVacio, completarBorrador, faltantesDe, normalizarFecha, normalizarTelefono, type Borrador } from './borrador.js';

export interface Interpretacion {
  borrador: Borrador;
  faltantes: string[];
  /** Cosas que la persona debe mirar con atención antes de programar. */
  avisos: string[];
  origen: 'reglas' | 'modelo';
}

export interface Interprete {
  interpretar(texto: string, base?: Partial<Borrador>): Promise<Interpretacion>;
}

const SERVICIOS: Array<[RegExp, string]> = [
  [/colonoscop/i, 'colonoscopia'],
  [/endoscop/i, 'endoscopia'],
  [/quimio/i, 'quimioterapia'],
  [/radioterap/i, 'radioterapia'],
  [/biopsia/i, 'biopsia'],
  [/reson|scanner|tac\b|tomograf|imagenolog/i, 'imagenologia'],
  [/cirug|operaci|pabell/i, 'cirugia'],
];

function sinAcentos(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Fragmento de texto alrededor de una palabra clave, hasta el siguiente punto o coma. */
function clausula(texto: string, indice: number): string {
  const desde = Math.max(texto.lastIndexOf('.', indice), texto.lastIndexOf(',', indice), texto.lastIndexOf(';', indice)) + 1;
  const finPunto = texto.indexOf('.', indice);
  const finComa = texto.indexOf(',', indice);
  const finPc = texto.indexOf(';', indice);
  const fines = [finPunto, finComa, finPc].filter((x) => x !== -1);
  const hasta = fines.length > 0 ? Math.min(...fines) : texto.length;
  return texto.slice(desde, hasta).trim();
}

/** Oración completa (hasta el punto) que contiene el índice. Para instrucciones de fármacos. */
function oracion(texto: string, indice: number): string {
  const desde = Math.max(texto.lastIndexOf('.', indice), texto.lastIndexOf(';', indice)) + 1;
  const fin = [texto.indexOf('.', indice), texto.indexOf(';', indice)].filter((x) => x !== -1);
  const hasta = fin.length > 0 ? Math.min(...fin) : texto.length;
  return texto.slice(desde, hasta).trim();
}

export function interpretarPorReglas(texto: string, base: Partial<Borrador> = {}, hoy: Date = new Date()): Interpretacion {
  const b = completarBorrador({ ...borradorVacio(), ...base });
  const avisos: string[] = [];
  const t = texto.replace(/\s+/g, ' ').trim();
  const bajo = sinAcentos(t.toLowerCase());

  // Teléfono.
  const tel = t.match(/(\+?56\s?)?(9\s?\d{4}\s?\d{4})\b/);
  if (tel && !b.telefono) b.telefono = normalizarTelefono(`${tel[1] ?? ''}${tel[2]}`);

  // RUT completo o sus últimos cuatro dígitos.
  const rutCompleto = t.match(/\b(\d{1,2})\.?(\d{3})\.?(\d{3})-?([\dkK])\b/);
  const rutCuatro = bajo.match(/(?:rut|run)[^\d]{0,40}?(\d{4})\b(?!\.\d)/);
  if (!b.rutUltimosCuatro) {
    if (rutCompleto) b.rutUltimosCuatro = `${rutCompleto[2]}${rutCompleto[3]}`.slice(-4);
    else if (rutCuatro) b.rutUltimosCuatro = rutCuatro[1]!;
  }

  // Profesional que emite la indicación.
  const prof = t.match(/\b(Dr\.?|Dra\.?|Doctor|Doctora|Enf\.?|Enfermera|Enfermero|Matrona)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)/);
  if (prof && !b.emitidaPor) b.emitidaPor = `${prof[1]!.replace(/\.$/, '')}. ${prof[2]}`.replace(/^(Doctor|Doctora|Enfermera|Enfermero|Matrona)\./, '$1');

  // Nombre del paciente: después de «paciente», «se llama», «nombre».
  const nom = t.match(/(?:[Pp]aciente|[Ss]e llama|[Nn]ombre)\s*:?\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+(?:de\s+|del\s+)?[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/);
  if (nom && !b.nombre) b.nombre = nom[1]!;
  else if (!b.nombre) {
    // Texto que empieza con un nombre propio, antes de la primera coma.
    const inicio = t.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3})\s*,/);
    if (inicio && !/^(Dr|Dra|Doctor|Doctora|Paciente|Nombre)\b/.test(inicio[1]!)) b.nombre = inicio[1]!;
  }

  // Identificador del paciente: «ficha 12345», «id 12345».
  const idp = bajo.match(/\b(?:ficha|id paciente|id|episodio)\s*:?\s*([a-z0-9-]{3,})\b/);
  if (idp && !b.idPaciente) b.idPaciente = idp[1]!;

  // Servicio.
  if (!b.servicio) for (const [re, s] of SERVICIOS) if (re.test(bajo)) { b.servicio = s; break; }

  // Fecha del procedimiento.
  if (!b.fechaProcedimiento) {
    const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    const dmy = t.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/);
    const larga = bajo.match(/\b(\d{1,2})\s+(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+|del\s+)?(\d{4}))?\b/);
    const fecha = iso?.[1] ?? dmy?.[1] ?? (larga ? `${larga[1]} de ${larga[2]}${larga[3] ? ` de ${larga[3]}` : ''}` : '');
    if (fecha) b.fechaProcedimiento = normalizarFecha(fecha, hoy);
  }

  // Horas: la de ayuno va junto a «ayuno»; la de llegada junto a «lleg» o «presentarse».
  const horaJunto = (re: RegExp): string => {
    const m = bajo.match(re);
    if (!m || m.index === undefined) return '';
    const frag = clausula(bajo, m.index);
    const h = extraerHoraDicha(frag.replace(/\b(\d{1,2})\s*(hrs?|horas)\b/g, '$1:00'));
    return h ? formatearHora(h) : '';
  };
  if (!b.horaInicioAyuno) b.horaInicioAyuno = horaJunto(/\bayun/);
  if (!b.horaLlegada) b.horaLlegada = horaJunto(/\b(lleg|presentar|citad)/);

  // Fármacos: cada oración con «suspender» es una instrucción literal.
  if (b.farmacos.length === 0) {
    const vistos = new Set<string>();
    const re = /\bsuspend\w*\s+(?:el|la|los|las|su|sus)?\s*([a-záéíóúñ][\wáéíóúñ-]{2,})/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const nombre = m[1]!.toLowerCase();
      if (['el', 'la', 'los', 'las', 'que', 'todo', 'todos'].includes(nombre) || vistos.has(nombre)) continue;
      vistos.add(nombre);
      const instr = oracion(t, m.index);
      b.farmacos.push({ nombre, instruccion: instr.endsWith('.') ? instr : `${instr}.` });
    }
    if (b.farmacos.length > 0) avisos.push('Revise que cada instrucción de fármaco sea exactamente la que emitió el equipo tratante: el agente la leerá literal.');
  }

  // Exámenes: lista después de «traer», «exámenes», «con».
  if (b.examenes.length === 0) {
    const m = bajo.match(/\b(?:traer|examenes?|llevar)\s*:?\s+([^.;]+)/);
    if (m) {
      const lista = m[1]!
        .replace(/\b(los|las|el|la|sus|un|una)\b/g, ' ')
        .split(/,|\by\b|\be\b/)
        .map((x) => x.trim())
        .filter((x) => x.length > 2 && !/^(con|sin|acompan|lleg|ayun|a las)/.test(x));
      // «traer hemograma y perfil de coagulación» termina donde empieza otra cláusula.
      b.examenes = lista.slice(0, 6);
    }
  }

  // Acompañante.
  if (b.requiereAcompanante === null) {
    if (/\b(sin acompanante|no requiere acompanante|no necesita acompanante)\b/.test(bajo)) b.requiereAcompanante = false;
    else if (/\bacompanante\b/.test(bajo)) b.requiereAcompanante = true;
  }

  const faltantes = faltantesDe(b);
  if (b.fechaProcedimiento && !/^\d{4}-\d{2}-\d{2}$/.test(b.fechaProcedimiento)) avisos.push(`No se pudo interpretar la fecha «${b.fechaProcedimiento}».`);
  return { borrador: b, faltantes, avisos, origen: 'reglas' };
}

const INSTRUCCIONES = `Eres un extractor de datos. NO eres un asistente y NO conversas.

Recibes el texto que una persona del equipo de salud escribió o dictó para programar una
llamada de preparación pre-procedimiento, y devuelves un único objeto JSON con estos campos.
Lo que no esté en el texto queda como cadena vacía, lista vacía o null. NUNCA inventes,
completes ni corrijas un dato.

{
  "idPaciente": "", "nombre": "", "telefono": "", "rutUltimosCuatro": "",
  "fechaProcedimiento": "AAAA-MM-DD o vacío", "horaLlegada": "HH:MM o vacío", "horaInicioAyuno": "HH:MM o vacío",
  "farmacos": [{"nombre": "", "instruccion": "la oración LITERAL del texto sobre ese fármaco, sin parafrasear"}],
  "examenes": [], "requiereAcompanante": true | false | null,
  "servicio": "", "emitidaPor": "profesional que indica, con su título tal como aparece", "programadoPara": ""
}

Reglas sin excepción:
- La instrucción de cada fármaco se copia literal. Es contenido clínico emitido por el equipo tratante.
- Si un dato es ambiguo, déjalo vacío. Quien lee tu salida lo completará.
- No agregues texto antes ni después del JSON.`;

export class InterpretePorReglas implements Interprete {
  async interpretar(texto: string, base: Partial<Borrador> = {}): Promise<Interpretacion> {
    return interpretarPorReglas(texto, base);
  }
}

/** Intérprete por modelo. Ante cualquier fallo cae a las reglas. */
export class InterpreteAnthropic implements Interprete {
  private readonly respaldo = new InterpretePorReglas();

  constructor(
    private readonly apiKey: string,
    private readonly modelo: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async interpretar(texto: string, base: Partial<Borrador> = {}): Promise<Interpretacion> {
    try {
      const r = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: this.modelo,
          max_tokens: 800,
          system: INSTRUCCIONES,
          messages: [{ role: 'user', content: `Hoy es ${new Date().toISOString().slice(0, 10)}.\nTexto:\n"""${texto}"""\n\nDevuelve solo el JSON.` }],
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cuerpo = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      const salida = cuerpo.content?.find((c) => c.type === 'text')?.text ?? '';
      const json = JSON.parse(salida.slice(salida.indexOf('{'), salida.lastIndexOf('}') + 1)) as Partial<Borrador>;
      // Lo que la persona ya había fijado manda sobre lo que el modelo leyó.
      const borrador = completarBorrador({ ...json, ...sinVacios(base) });
      const avisos = borrador.farmacos.length > 0
        ? ['Revise que cada instrucción de fármaco sea exactamente la que emitió el equipo tratante: el agente la leerá literal.']
        : [];
      return { borrador, faltantes: faltantesDe(borrador), avisos, origen: 'modelo' };
    } catch {
      return this.respaldo.interpretar(texto, base);
    }
  }
}

function sinVacios(p: Partial<Borrador>): Partial<Borrador> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<Borrador>;
}

export function crearInterprete(cfg: { CLASIFICADOR: 'simulado' | 'anthropic'; ANTHROPIC_API_KEY?: string | undefined; ANTHROPIC_MODELO: string }): Interprete {
  if (cfg.CLASIFICADOR === 'anthropic' && cfg.ANTHROPIC_API_KEY) return new InterpreteAnthropic(cfg.ANTHROPIC_API_KEY, cfg.ANTHROPIC_MODELO);
  return new InterpretePorReglas();
}
