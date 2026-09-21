/**
 * Números dichos en voz alta. Un transcriptor telefónico entrega palabras
 * tanto como cifras, y la verificación de identidad no puede fallar por eso.
 */
import { describe, expect, it } from 'vitest';
import {
  coincideDiaMes,
  coincideDigitos,
  coincideHora,
  digitosDichos,
  extraerHoraDicha,
  extraerNumeros,
  formatearHora,
} from '../src/dominio/checklist/numeros.js';
import { abrir, avanzar, estadoInicial } from '../src/dominio/checklist/maquina.js';
import { ClasificadorSimulado } from '../src/llm/clasificador.js';
import { cls, contexto } from './fixtures.js';

describe('Extracción de números', () => {
  it('lee cifras y palabras, sueltas y compuestas', () => {
    expect(extraerNumeros('4821')).toEqual([4821]);
    expect(extraerNumeros('48 21')).toEqual([48, 21]);
    expect(extraerNumeros('cuatro ocho dos uno')).toEqual([4, 8, 2, 1]);
    expect(extraerNumeros('cuarenta y ocho veintiuno')).toEqual([48, 21]);
    expect(extraerNumeros('cuatro mil ochocientos veintiuno')).toEqual([4821]);
    expect(extraerNumeros('mil quinientos')).toEqual([1500]);
    expect(extraerNumeros('ciento cinco')).toEqual([105]);
    expect(extraerNumeros('cero ocho')).toEqual([0, 8]);
    expect(extraerNumeros('quince del cuatro')).toEqual([15, 4]);
    expect(extraerNumeros('quince de abril')).toEqual([15, 4]);
    expect(extraerNumeros('el 15 de Abril')).toEqual([15, 4]);
    expect(extraerNumeros('diez y veinte')).toEqual([10, 20]);
    expect(extraerNumeros('sí, soy yo')).toEqual([]);
    expect(extraerNumeros('alguno de ninguno')).toEqual([]);
  });

  it('junta los dígitos dichos', () => {
    expect(digitosDichos('cuatro ocho dos uno')).toBe('4821');
    expect(digitosDichos('cuarenta y ocho, veintiuno')).toBe('4821');
    expect(digitosDichos('cuatro mil ochocientos veintiuno')).toBe('4821');
  });
});

describe('Factores de identidad', () => {
  it('el RUT coincide dicho de cualquier forma, y no coincide si está mal', () => {
    for (const d of ['4821', '4 8 2 1', 'cuatro ocho dos uno', 'cuarenta y ocho veintiuno', 'el cuatro, ocho, dos, uno', 'son 48 21']) {
      expect(coincideDigitos(d, '4821')).toBe(true);
    }
    for (const d of ['4822', 'cuatro ocho dos dos', 'no me acuerdo', '', 'cuarenta y ocho']) {
      expect(coincideDigitos(d, '4821')).toBe(false);
    }
  });

  it('el día y mes coinciden en cifras, palabras o nombre de mes', () => {
    for (const d of ['15-04', '15 04', '15/4', '1504', 'quince del cuatro', 'quince de abril', 'el 15 de abril', 'quince cuatro']) {
      expect(coincideDiaMes(d, '15-04')).toBe(true);
    }
    for (const d of ['16-04', 'quince de mayo', 'quince', '', 'abril quince']) {
      expect(coincideDiaMes(d, '15-04')).toBe(false);
    }
  });
});

describe('Horas dichas', () => {
  it('lee cifras, palabras, fracciones y periodos', () => {
    const f = (t: string) => {
      const h = extraerHoraDicha(t);
      return h ? formatearHora(h) : null;
    };
    expect(f('a las 22:00')).toBe('22:00');
    expect(f('22.00')).toBe('22:00');
    expect(f('a las veintidós')).toBe('22:00');
    expect(f('veintidós horas')).toBe('22:00');
    expect(f('a las diez de la noche')).toBe('22:00');
    expect(f('diez de la mañana')).toBe('10:00');
    expect(f('nueve y media')).toBe('09:30');
    expect(f('siete y cuarto de la mañana')).toBe('07:15');
    expect(f('ocho menos cuarto')).toBe('07:45');
    expect(f('siete y veinte')).toBe('07:20');
    expect(f('a las doce de la noche')).toBe('00:00');
    expect(f('sí, entendí')).toBeNull();
  });

  it('compara con la hora esperada tolerando la ambigüedad de doce horas solo sin periodo', () => {
    for (const d of ['22:00', 'a las veintidós', 'diez de la noche', 'a las diez', 'las 10']) {
      expect(coincideHora(d, '22:00')).toBe(true);
    }
    for (const d of ['diez de la mañana', 'once', '22:30', 'nueve de la noche', 'ya']) {
      expect(coincideHora(d, '22:00')).toBe(false);
    }
    expect(coincideHora('siete y media', '07:30')).toBe(true);
    expect(coincideHora('siete y media de la tarde', '07:30')).toBe(false);
  });
});

describe('La máquina acepta los factores y la hora dichos con palabras', () => {
  it('verifica identidad y ayuno con «cuatro ocho dos uno», «quince de abril» y «diez de la noche»', async () => {
    const clasificador = new ClasificadorSimulado();
    let st = abrir(contexto, estadoInicial('llam-001')).estado;
    st = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' })).estado;

    const c1 = await clasificador.clasificar({ textoPaciente: 'cuatro ocho dos uno', estado: st.estado, preguntaDelAgente: '' });
    expect(c1.intencion).toBe('responde_dato');
    st = avanzar(contexto, st, 'cuatro ocho dos uno', c1).estado;
    expect(st.factoresConfirmados).toBe(1);

    const c2 = await clasificador.clasificar({ textoPaciente: 'el quince de abril', estado: st.estado, preguntaDelAgente: '' });
    expect(c2.intencion).toBe('responde_dato');
    const r = avanzar(contexto, st, 'el quince de abril', c2);
    expect(r.estado.identidadVerificada).toBe(true);
    expect(r.estado.estado).toBe('ayuno');

    const c3 = await clasificador.clasificar({ textoPaciente: 'a las diez de la noche', estado: r.estado.estado, preguntaDelAgente: '' });
    const r2 = avanzar(contexto, r.estado, 'a las diez de la noche', c3);
    expect(r2.estado.estado).toBe('farmacos');
    expect(r2.estado.capturado.horaAyunoRepetida).toBe('22:00');
  });

  it('un factor dicho con palabras pero incorrecto sigue cerrando sin contenido clínico', () => {
    let st = abrir(contexto, estadoInicial('llam-001')).estado;
    st = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' })).estado;
    const r = avanzar(contexto, st, 'cuatro ocho dos dos', cls({ intencion: 'responde_dato', valorLiteral: 'cuatro ocho dos dos' }));
    expect(r.estado.estado).toBe('terminada_sin_verificar');
    expect(r.salida).not.toMatch(/ayuno|acenocumarol/i);
  });
});
