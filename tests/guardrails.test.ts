import { describe, expect, it } from 'vitest';
import { detectarBanderaRoja } from '../src/dominio/guardrails/banderas-rojas.js';
import { evaluarGuardrails } from '../src/dominio/guardrails/index.js';
import { cls } from './fixtures.js';

describe('Detección léxica de banderas rojas', () => {
  const positivos = [
    'ando con fiebre desde ayer',
    'estoy sangrando',
    'tengo un dolor intenso en la guata',
    'no puedo respirar bien',
    'me siento muy mal la verdad',
    'me desmayé ayer en la casa',
    'ando con mucho dolor',
    'estoy vomitando desde anoche',
  ];
  for (const t of positivos) {
    it(`detecta: "${t}"`, () => {
      expect(detectarBanderaRoja(t).detectada).toBe(true);
    });
  }

  const negativos = [
    'no tengo fiebre',
    'no he tenido dolor',
    'no tuve sangrado',
    'sin fiebre ni nada',
    'no siento dolor',
    'sí, entendí todo perfecto',
    'a las diez de la noche',
    'viene mi hija a buscarme',
  ];
  for (const t of negativos) {
    it(`NO detecta: "${t}"`, () => {
      expect(detectarBanderaRoja(t).detectada).toBe(false);
    });
  }

  it('detecta pese a acentos y mayúsculas', () => {
    expect(detectarBanderaRoja('TENGO FIEBRE ALTA').detectada).toBe(true);
    expect(detectarBanderaRoja('me duele el pecho').detectada).toBe(true);
  });

  it('la negación no cruza el punto', () => {
    // "no tengo náuseas" no debe anular la fiebre de la frase siguiente.
    expect(detectarBanderaRoja('no tengo nauseas. Pero tengo fiebre.').detectada).toBe(true);
  });

  it('conserva el fragmento literal para el registro clínico', () => {
    const r = detectarBanderaRoja('oiga doctora, desde anoche ando con fiebre y escalofríos');
    expect(r.detectada).toBe(true);
    expect(r.fragmento).toContain('fiebre');
  });
});

describe('Precedencia de los guardrails', () => {
  const base = {
    estadoActual: 'farmacos' as const,
    identidadVerificada: true,
    intentosAclaracion: 0,
  };

  it('la alarma clínica gana a la falta de verificación de identidad', () => {
    const v = evaluarGuardrails({
      ...base,
      estadoActual: 'apertura',
      identidadVerificada: false,
      entradaPaciente: 'estoy sangrando mucho',
      clasificacion: cls({ intencion: 'confirma' }),
    });
    expect(v.tipo).toBe('transferir');
    if (v.tipo === 'transferir') expect(v.motivo).toBe('sintoma_alarma');
  });

  it('la doble red funciona: basta con que dispare el modelo', () => {
    const v = evaluarGuardrails({
      ...base,
      // Sin término del léxico: solo el modelo lo marca.
      entradaPaciente: 'me siento rarísimo desde ayer, como decaída',
      clasificacion: cls({ intencion: 'reporta_sintoma', sintomaLiteral: 'me siento rarísimo', confianza: 0.8 }),
    });
    expect(v.tipo).toBe('transferir');
    if (v.tipo === 'transferir') expect(v.guardrail).toBe('bandera_roja_modelo');
  });

  it('ignora al modelo si su confianza está bajo el umbral', () => {
    const v = evaluarGuardrails({
      ...base,
      entradaPaciente: 'mmm no sé',
      clasificacion: cls({ intencion: 'reporta_sintoma', confianza: 0.3 }),
    });
    // Confianza baja: no transfiere por alarma; cae a la rama de incomprensión.
    expect(v.tipo).toBe('continuar');
  });

  it('la compuerta de identidad cierra el contenido clínico', () => {
    const v = evaluarGuardrails({
      ...base,
      identidadVerificada: false,
      entradaPaciente: 'ya',
      clasificacion: cls({ intencion: 'confirma' }),
    });
    expect(v.tipo).toBe('terminar');
    if (v.tipo === 'terminar') expect(v.guardrail).toBe('compuerta_identidad');
  });

  it('la petición de hablar con una persona se acata sin objetar', () => {
    const v = evaluarGuardrails({
      ...base,
      entradaPaciente: 'prefiero hablar con una persona',
      clasificacion: cls({ intencion: 'pide_persona' }),
    });
    expect(v.tipo).toBe('transferir');
    if (v.tipo === 'transferir') expect(v.motivo).toBe('solicitud_del_paciente');
  });

  it('transfiere tras dos intentos fallidos de aclaración', () => {
    const v = evaluarGuardrails({
      ...base,
      intentosAclaracion: 2,
      entradaPaciente: '...',
      clasificacion: cls({ intencion: 'no_entiende', confianza: 0.9 }),
    });
    expect(v.tipo).toBe('transferir');
    if (v.tipo === 'transferir') expect(v.motivo).toBe('incomprension_reiterada');
  });
});
