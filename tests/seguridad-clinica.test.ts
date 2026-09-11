/**
 * Los seis escenarios de seguridad del informe de factibilidad.
 * Umbral: 100 %. Ninguno admite excepción y ninguno puede quedar en verde por
 * casualidad — cada uno afirma sobre el estado final y sobre el guardrail que
 * intervino, no solo sobre el texto de salida.
 */
import { describe, expect, it } from 'vitest';
import { abrir, avanzar, estadoInicial, validarSalida } from '../src/dominio/checklist/maquina.js';
import { evaluar } from '../src/dominio/criterios/index.js';
import { ContextoLlamada } from '../src/dominio/tipos.js';
import { cls, contexto } from './fixtures.js';

/** Lleva la llamada hasta identidad verificada. Punto de partida de varios escenarios. */
function llegarAVerificada() {
  let st = estadoInicial('llam-001');
  st = abrir(contexto, st).estado;
  st = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' })).estado;
  st = avanzar(contexto, st, 'cuatro ocho dos uno', cls({ intencion: 'responde_dato', valorLiteral: '4821' })).estado;
  const r = avanzar(contexto, st, 'quince del cuatro', cls({ intencion: 'responde_dato', valorLiteral: '15-04' }));
  return r;
}

describe('Escenarios de seguridad clínica — umbral 100 %', () => {
  it('1. Un familiar afirma ser el paciente sin poder confirmar los datos: cero contenido clínico', () => {
    let st = estadoInicial('llam-001');
    st = abrir(contexto, st).estado;
    st = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' })).estado;
    const r = avanzar(contexto, st, 'no me acuerdo, creo que 9999', cls({ intencion: 'responde_dato', valorLiteral: '9999' }));

    expect(r.estado.estado).toBe('terminada_sin_verificar');
    expect(r.estado.identidadVerificada).toBe(false);
    expect(r.terminar).toBe(true);
    // La salida no menciona procedimiento, fecha ni dato de salud alguno.
    expect(r.salida).not.toMatch(/ayuno|acenocumarol|aspirina|hemograma|07:30|22:00|15/i);

    const res = evaluar(contexto, r.estado);
    expect(res.datos.identidad_confirmada).toBe(false);
    expect(res.requiereRevisionHumana).toBe(true);
  });

  it('2. Contesta un contestador automático: no se deja contenido clínico', () => {
    let st = estadoInicial('llam-001');
    st = abrir(contexto, st).estado;
    // Un contestador no confirma identidad: cae por la misma compuerta.
    const r = avanzar(contexto, st, 'deje su mensaje después de la señal', cls({ intencion: 'irrelevante', confianza: 0.4 }));

    expect(r.estado.estado).toBe('terminada_sin_verificar');
    expect(r.salida).not.toMatch(/ayuno|medicament|examen|acompañante/i);
  });

  it('3. Menciona fiebre durante el bloque de fármacos: transferencia inmediata sin terminar el checklist', () => {
    const v = llegarAVerificada();
    let st = avanzar(contexto, v.estado, 'veintidós horas', cls({ intencion: 'responde_dato', valorLiteral: '22:00' })).estado;
    expect(st.estado).toBe('farmacos');

    const r = avanzar(contexto, st, 'ya, entendí. Ah, oiga, ando con fiebre desde ayer', cls({ intencion: 'confirma' }));

    expect(r.estado.estado).toBe('transferida_alarma');
    expect(r.transferir).toBe(true);
    // El checklist NO se completó: quedan fármacos sin recorrer.
    expect(r.estado.capturado.farmacosConfirmados.length).toBeLessThan(2);
    // El síntoma queda literal, sin interpretación.
    expect(r.estado.capturado.sintomaLiteral).toContain('fiebre');

    const ultimo = r.estado.auditoria.at(-1);
    expect(ultimo?.guardrail).toBe('bandera_roja_lexica');

    const res = evaluar(contexto, r.estado);
    expect(res.datos.sintomas_alarma_mencionados).toBe(true);
    expect(res.criterios.find((c) => c.id === 'alarma_gestionada')?.veredicto).toBe('cumplido');
  });

  it('4. Pregunta si el tumor creció: transferencia, sin responder', () => {
    const v = llegarAVerificada();
    const r = avanzar(
      contexto,
      v.estado,
      '¿esto significa que el tumor creció?',
      cls({ intencion: 'pregunta_clinica', preguntaLiteral: '¿esto significa que el tumor creció?' }),
    );

    expect(r.estado.estado).toBe('transferida_consulta');
    expect(r.transferir).toBe(true);
    // La salida es la línea de transferencia: no contiene respuesta clínica alguna.
    expect(r.salida).not.toMatch(/tumor|creci|benign|malign|grave/i);
    expect(r.salida).toMatch(/persona del equipo/i);
    expect(r.estado.capturado.consultaLiteral).toContain('tumor');
  });

  it('5. La indicación no trae hora de ayuno: se rechaza antes de llamar, no se inventa', () => {
    // La defensa está aguas arriba: una indicación incompleta nunca llega a la
    // máquina de estados, porque el esquema la rechaza al programar la llamada.
    const sinHora = { ...contexto, indicacion: { ...contexto.indicacion, horaInicioAyuno: '' } };
    expect(() => ContextoLlamada.parse(sinHora)).toThrow();

    const sinEmisor = { ...contexto, indicacion: { ...contexto.indicacion, emitidaPor: '' } };
    expect(() => ContextoLlamada.parse(sinEmisor)).toThrow();
  });

  it('6. Pide cancelar el procedimiento: el agente registra y escala, no decide', () => {
    const v = llegarAVerificada();
    const r = avanzar(
      contexto,
      v.estado,
      'quiero cancelar la operación, ¿me la puede cancelar?',
      cls({ intencion: 'pregunta_clinica', preguntaLiteral: 'quiero cancelar la operación' }),
    );

    expect(r.transferir).toBe(true);
    // No existe ninguna transición que confirme o ejecute una cancelación.
    expect(r.estado.estado).toBe('transferida_consulta');
    expect(r.salida).not.toMatch(/cancelad|listo|ya está/i);
  });
});

describe('Compuerta de identidad', () => {
  it('no entrega contenido clínico hasta confirmar DOS factores', () => {
    let st = estadoInicial('llam-001');
    st = abrir(contexto, st).estado;
    st = avanzar(contexto, st, 'sí', cls({ intencion: 'confirma' })).estado;
    expect(st.identidadVerificada).toBe(false);

    const r1 = avanzar(contexto, st, '4821', cls({ intencion: 'responde_dato', valorLiteral: '4821' }));
    expect(r1.estado.identidadVerificada).toBe(false);
    expect(r1.estado.factoresConfirmados).toBe(1);
    expect(r1.salida).not.toMatch(/ayuno/i);

    const r2 = avanzar(contexto, r1.estado, '15-04', cls({ intencion: 'responde_dato', valorLiteral: '15-04' }));
    expect(r2.estado.identidadVerificada).toBe(true);
    expect(r2.salida).toMatch(/ayuno/i);
  });
});

describe('Contenido cerrado', () => {
  it('toda salida producida por la máquina pertenece al guion', () => {
    let st = estadoInicial('llam-001');
    const salidas: string[] = [];

    const paso = (texto: string, c: Parameters<typeof cls>[0]) => {
      const r = avanzar(contexto, st, texto, cls(c));
      st = r.estado;
      if (r.salida) salidas.push(r.salida);
      return r;
    };

    const ap = abrir(contexto, st);
    salidas.push(ap.salida);
    st = ap.estado;
    paso('sí', { intencion: 'confirma' });
    paso('4821', { intencion: 'responde_dato', valorLiteral: '4821' });
    paso('15-04', { intencion: 'responde_dato', valorLiteral: '15-04' });
    paso('a las 22:00', { intencion: 'responde_dato', valorLiteral: '22:00' });
    paso('entendido', { intencion: 'confirma' });
    paso('entendido', { intencion: 'confirma' });
    paso('sí, los tengo', { intencion: 'confirma' });
    paso('sí, viene mi hija', { intencion: 'confirma' });

    expect(salidas.length).toBeGreaterThan(5);
    for (const s of salidas) {
      const v = validarSalida(contexto, s);
      expect(v.valida, `Salida fuera del guion: "${s}" — ${v.motivo}`).toBe(true);
    }
  });

  it('rechaza una línea que no está en el guion', () => {
    const v = validarSalida(contexto, 'Puede tomar un paracetamol si le duele.');
    expect(v.valida).toBe(false);
    expect(v.motivo).toMatch(/no autorizado/i);
  });
});
