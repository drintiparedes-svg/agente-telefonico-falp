/**
 * Números dichos en voz alta.
 *
 * Un transcriptor telefónico entrega «cuatro ocho dos uno», «cuarenta y ocho
 * veintiuno», «quince del cuatro» o «a las diez de la noche» tanto como
 * «4821», «15-04» o «22:00». La máquina compara factores de identidad y horas,
 * y esa comparación no puede depender de cómo vino escrito. Aquí se convierte
 * lo dicho a números; no se interpreta nada más.
 *
 * Todo es determinista y sin modelo: es parte del piso que no se mueve.
 */

// «un» y «una» no están: son artículos («un momento», «una consulta») mucho más
// a menudo que números, y colarlos como 1 rompe un RUT dicho después.
const UNIDADES: Record<string, number> = {
  cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28,
  veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
};

const CENTENAS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Todos los números que aparecen en el texto, en orden, ya sea en cifras o en
 * palabras. Los compuestos («cuarenta y ocho», «cuatro mil ochocientos
 * veintiuno») se juntan; los sueltos («cuatro ocho dos uno») se devuelven uno
 * a uno. Un nombre de mes vale como su número.
 */
export function extraerNumeros(texto: string): number[] {
  const tokens = normalizarTexto(texto).split(/[^a-z0-9]+/).filter(Boolean);
  const salida: number[] = [];
  let actual: number | null = null;
  let trasY = false;

  const cerrar = () => {
    if (actual !== null) salida.push(actual);
    actual = null;
    trasY = false;
  };

  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      cerrar();
      salida.push(Number(t));
      continue;
    }
    if (t === 'y') {
      trasY = actual !== null && actual % 10 === 0 && actual % 100 >= 20;
      continue;
    }
    if (t === 'mil') {
      actual = actual === null ? 1000 : actual * 1000;
      trasY = false;
      continue;
    }
    if (t in CENTENAS) {
      if (actual !== null && actual >= 1000 && actual % 1000 === 0) actual += CENTENAS[t]!;
      else {
        cerrar();
        actual = CENTENAS[t]!;
      }
      continue;
    }
    if (t in UNIDADES) {
      const v = UNIDADES[t]!;
      const encaja =
        actual !== null &&
        ((trasY && v < 10) ||
          (actual >= 100 && actual % 100 === 0 && v < 100) ||
          (actual >= 1000 && actual % 1000 === 0 && v < 1000));
      if (encaja) actual = (actual as number) + v;
      else {
        cerrar();
        actual = v;
      }
      trasY = false;
      continue;
    }
    if (t in MESES) {
      cerrar();
      salida.push(MESES[t]!);
      continue;
    }
    cerrar();
  }
  cerrar();
  return salida;
}

/** Cadena de dígitos que forman los números dichos: «cuarenta y ocho veintiuno» → «4821». */
export function digitosDichos(texto: string): string {
  return extraerNumeros(texto).map((n) => String(n)).join('');
}

/**
 * Compara un factor numérico (últimos dígitos del RUT). Tolerante a cómo se
 * dijo. Se pide «los últimos cuatro», así que si el paciente dice el RUT
 * entero, o antepone otro número («los últimos cuatro: cuatro ocho dos uno»),
 * vale con que los dígitos dichos terminen en los esperados.
 */
export function coincideDigitos(dicho: string, esperado: string): boolean {
  const meta = esperado.replace(/\D/g, '');
  if (meta === '') return false;
  return [dicho.replace(/\D/g, ''), digitosDichos(dicho)].some((d) => d.length >= meta.length && d.endsWith(meta));
}

/**
 * Compara un día y mes. `esperado` viene como «DD-MM». Lo dicho puede ser
 * «15-04», «15 04», «quince del cuatro» o «quince de abril».
 */
export function coincideDiaMes(dicho: string, esperado: string): boolean {
  const m = esperado.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const numeros = extraerNumeros(dicho);
  if (numeros.length === 1 && numeros[0]! >= 100) {
    // «1504»: día y mes pegados.
    const s = String(numeros[0]).padStart(4, '0');
    return Number(s.slice(0, 2)) === dia && Number(s.slice(2)) === mes;
  }
  // El par día-mes puede venir precedido de otro número («el día quince del cuatro»).
  return numeros.some((n, i) => n === dia && numeros[i + 1] === mes);
}

const PERIODO_TARDE = /\b(de la tarde|de la noche|pm|p\.m\.)\b/;
const PERIODO_MANANA = /\b(de la manana|de la madrugada|am|a\.m\.)\b/;

export interface HoraDicha {
  hora: number;
  minutos: number;
  /** Si el paciente dijo «de la mañana», «de la noche», etc. Sin eso, «diez» es ambiguo. */
  periodoExplicito: boolean;
}

/**
 * Extrae una hora de lo dicho. Acepta «22:00», «22.00», «a las veintidós»,
 * «diez de la noche», «nueve y media», «ocho menos cuarto». No infiere: sin un
 * número reconocible devuelve null.
 */
export function extraerHoraDicha(texto: string): HoraDicha | null {
  // «a la una» es la única hora que no se dice con «las»; y «una» no cuenta
  // como número en el resto del texto (ver UNIDADES).
  const t = normalizarTexto(texto).replace(/\ba la una\b/g, 'a las 1');
  const tarde = PERIODO_TARDE.test(t);
  const manana = PERIODO_MANANA.test(t);

  // «10:00 de la noche» lleva el periodo aparte de la cifra; se respeta igual.
  const explicita = t.match(/\b([01]?\d|2[0-3])\s*[:.]\s*([0-5]\d)\b/);
  if (explicita) {
    const hora = Number(explicita[1]);
    let h = hora;
    if (tarde && h < 12) h += 12;
    if (tarde && h === 12 && /noche/.test(t)) h = 0;
    return { hora: h, minutos: Number(explicita[2]), periodoExplicito: tarde || manana || hora > 12 };
  }

  const numeros = extraerNumeros(t);
  const hora = numeros.find((n) => n >= 0 && n <= 24);
  if (hora === undefined) return null;

  let minutos = 0;
  let h = hora === 24 ? 0 : hora;
  if (/\bmenos cuarto\b/.test(t)) {
    h = (h + 23) % 24;
    minutos = 45;
  } else if (/\by media\b/.test(t)) minutos = 30;
  else if (/\by cuarto\b/.test(t)) minutos = 15;
  else {
    const idx = numeros.indexOf(hora);
    const siguiente = numeros[idx + 1];
    if (siguiente !== undefined && siguiente < 60 && /\b(y|con)\b/.test(t)) minutos = siguiente;
  }

  if (tarde && h < 12) h += 12;
  // «doce de la noche» es medianoche.
  if (tarde && h === 12 && /noche/.test(t)) h = 0;
  return { hora: h, minutos, periodoExplicito: tarde || manana || hora > 12 };
}

/** Formato HH:MM. */
export function formatearHora(h: HoraDicha): string {
  return `${String(h.hora).padStart(2, '0')}:${String(h.minutos).padStart(2, '0')}`;
}

/**
 * Si la hora dicha coincide con la esperada («22:00»). Cuando el paciente no
 * dijo el periodo, «diez» vale por 22:00: es lo que dice cualquiera de un
 * ayuno nocturno, y exigir «veintidós» no mide comprensión sino vocabulario.
 */
export function coincideHora(dicho: string, esperada: string): boolean {
  const h = extraerHoraDicha(dicho);
  const m = esperada.match(/^(\d{2}):(\d{2})$/);
  if (!h || !m) return false;
  const eh = Number(m[1]);
  const em = Number(m[2]);
  if (h.minutos !== em) return false;
  if (h.hora === eh) return true;
  return !h.periodoExplicito && (h.hora + 12) % 24 === eh;
}
