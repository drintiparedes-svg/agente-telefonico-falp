/**
 * Contrato con los sistemas que programan llamadas y leen resultados: la
 * agenda, la ficha o un asistente como Catalina Ejecutiva.
 *
 * Lo que se protege: que sin token no se lea ni se escriba nada clínico, que una
 * llamada programada «inmediata» suene en la misma petición si hay ventana y
 * capacidad, y que el resumen por llamada diga en qué está sin exponer lo que
 * dijo el paciente.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cargarConfig, _limpiarCacheConfig } from '../src/config/index.js';
import { construirServicio, esRutaDeIntegracion, type Servicio } from '../src/api/servidor.js';
import { fraseDelResultado, resumirLlamada } from '../src/api/estado-llamada.js';
import { ClienteVozSimulado } from '../src/telefonia/elevenlabs.js';
import { contexto } from './fixtures.js';

const TOKEN = 'token-de-pruebas';
const INTEGRACION = 'integracion-de-pruebas-123456';
/** Lunes 13 de abril de 2026, 11:00 en Santiago. */
const LUNES_11 = new Date('2026-04-13T15:00:00Z');

let actual: Servicio | null = null;

afterEach(async () => {
  if (actual) await actual.cerrar();
  actual = null;
  _limpiarCacheConfig();
});

function levantar(extra: Record<string, string> = {}, reloj: () => Date = () => LUNES_11) {
  _limpiarCacheConfig();
  const cfg = cargarConfig({
    NODE_ENV: 'test',
    DB_RUTA: ':memory:',
    WEBHOOK_SECRETO: 'secreto-de-pruebas-1234567890',
    LLM_TOKEN: TOKEN,
    NUMERO_TRANSFERENCIA: '+56000000000',
    NIVEL_LOG: 'fatal',
    ...extra,
  } as NodeJS.ProcessEnv);
  const cliente = new ClienteVozSimulado();
  const svc = construirServicio(cfg, cliente, { esperar: async () => undefined, reloj });
  actual = svc;
  return { svc, cliente };
}

const cuerpo = (extra: Record<string, unknown> = {}) => ({
  idPaciente: 'pac-001',
  telefono: '+56911111111',
  contexto: { ...contexto, idLlamada: 'llam-int-1' },
  ...extra,
});

async function conducirHastaElFinal(svc: Servicio, idConv: string) {
  const turno = (messages: Array<{ role: string; content: string }>) =>
    svc.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': idConv },
      payload: { messages },
    });
  await turno([]);
  for (const dicho of ['sí, soy yo', '4821', '15 04', 'a las 22:00', 'sí, entendí', 'sí', 'sí, los tengo', 'sí, viene mi hija']) {
    await turno([{ role: 'assistant', content: 'x' }, { role: 'user', content: dicho }]);
  }
}

describe('Token de integración', () => {
  it('reconoce exactamente las rutas que tratan datos de pacientes', () => {
    for (const r of ['/llamadas', '/llamadas/abc', '/auditoria/abc', '/revision', '/conciliacion', '/llamadas?x=1']) {
      expect(esRutaDeIntegracion(r)).toBe(true);
    }
    for (const r of ['/salud', '/v1/chat/completions', '/webhooks/postcall', '/admin/numeros', '/llamadasx']) {
      expect(esRutaDeIntegracion(r)).toBe(false);
    }
  });

  it('con token, las rutas clínicas exigen Bearer y /salud sigue abierta', async () => {
    const { svc } = levantar({ INTEGRACION_TOKEN: INTEGRACION });
    expect((await svc.app.inject({ method: 'POST', url: '/llamadas', payload: cuerpo() })).statusCode).toBe(401);
    expect((await svc.app.inject({ method: 'GET', url: '/llamadas/x' })).statusCode).toBe(401);
    expect((await svc.app.inject({ method: 'GET', url: '/auditoria/x' })).statusCode).toBe(401);
    expect((await svc.app.inject({ method: 'GET', url: '/revision' })).statusCode).toBe(401);
    expect((await svc.app.inject({ method: 'GET', url: '/conciliacion' })).statusCode).toBe(401);
    expect((await svc.app.inject({ method: 'GET', url: '/salud' })).statusCode).toBe(200);

    const con = { authorization: `Bearer ${INTEGRACION}` };
    expect((await svc.app.inject({ method: 'POST', url: '/llamadas', headers: con, payload: cuerpo() })).statusCode).toBe(201);
    expect((await svc.app.inject({ method: 'GET', url: '/revision', headers: con })).statusCode).toBe(200);
  });

  it('sin token en desarrollo las rutas quedan abiertas; en producción el servicio no arranca', () => {
    const { svc } = levantar();
    expect(svc.app.hasRoute({ method: 'GET', url: '/llamadas/:id' })).toBe(true);
    _limpiarCacheConfig();
    expect(() =>
      cargarConfig({
        NODE_ENV: 'production',
        WEBHOOK_SECRETO: 'secreto-de-produccion-1234567890',
        LLM_TOKEN: 'token-de-produccion',
        NUMERO_TRANSFERENCIA: '+56000000000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/INTEGRACION_TOKEN/);
  });
});

describe('Programación inmediata', () => {
  it('sin «inmediata» la llamada queda en cola y el resumen lo dice', async () => {
    const { svc, cliente } = levantar();
    const r = await svc.app.inject({ method: 'POST', url: '/llamadas', payload: cuerpo() });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ok: true, idTrabajo: 'llam-int-1', despacho: { intentado: false, originada: false } });
    expect(cliente.llamadas).toHaveLength(0);

    const e = await svc.app.inject({ method: 'GET', url: '/llamadas/llam-int-1' });
    expect(e.json()).toMatchObject({ id: 'llam-int-1', estado: 'programada', resultado: null, telefono: '+56911111111' });
  });

  it('con «inmediata» dentro de ventana la llamada se origina en la misma petición', async () => {
    const { svc, cliente } = levantar();
    const r = await svc.app.inject({ method: 'POST', url: '/llamadas', payload: cuerpo({ inmediata: true }) });
    expect(r.json().despacho).toMatchObject({ intentado: true, originada: true });
    expect(cliente.llamadas).toHaveLength(1);
    const e = await svc.app.inject({ method: 'GET', url: '/llamadas/llam-int-1' });
    expect(e.json()).toMatchObject({ estado: 'en_curso', idConversacion: cliente.llamadas[0]!.idConversacion });
  });

  it('con «inmediata» fuera de ventana queda en cola y se explica', async () => {
    const { svc, cliente } = levantar({}, () => new Date('2026-04-13T06:00:00Z')); // 02:00 en Chile
    const r = await svc.app.inject({ method: 'POST', url: '/llamadas', payload: cuerpo({ inmediata: true }) });
    expect(r.json().despacho).toMatchObject({ intentado: true, originada: false });
    expect(r.json().despacho.motivo).toMatch(/ventana horaria/);
    expect(cliente.llamadas).toHaveLength(0);
    const e = await svc.app.inject({ method: 'GET', url: '/llamadas/llam-int-1' });
    expect(e.json()).toMatchObject({ estado: 'programada' });
  });

  it('una llamada desconocida es 404', async () => {
    const { svc } = levantar();
    expect((await svc.app.inject({ method: 'GET', url: '/llamadas/nada' })).statusCode).toBe(404);
  });
});

describe('Resumen de la llamada', () => {
  it('cuando la llamada termina, el resumen trae el desenlace y los criterios, sin lo que dijo el paciente', async () => {
    const { svc, cliente } = levantar();
    await svc.app.inject({ method: 'POST', url: '/llamadas', payload: cuerpo() });
    await svc.despachador.despacharLote(LUNES_11);
    await conducirHastaElFinal(svc, cliente.llamadas[0]!.idConversacion);

    const e = (await svc.app.inject({ method: 'GET', url: '/llamadas/llam-int-1' })).json();
    expect(e.estado).toBe('terminada');
    expect(e.resultado.estadoFinal).toBe('terminada_ok');
    expect(e.resultado.requiereRevisionHumana).toBe(false);
    expect(e.resultado.resumen).toBe('El paciente confirmó toda la preparación.');
    expect(e.resultado.criterios.map((c: { id: string; veredicto: string }) => c.veredicto)).not.toContain('no_cumplido');
    expect(JSON.stringify(e)).not.toMatch(/soy yo|viene mi hija/);
  });

  it('una alarma se resume como transferencia con revisión humana', async () => {
    const { svc, cliente } = levantar();
    await svc.app.inject({ method: 'POST', url: '/llamadas', payload: cuerpo() });
    await svc.despachador.despacharLote(LUNES_11);
    const idConv = cliente.llamadas[0]!.idConversacion;
    const turno = (messages: Array<{ role: string; content: string }>) =>
      svc.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': idConv },
        payload: { messages },
      });
    await turno([]);
    await turno([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'sí, pero ando con fiebre desde ayer' }]);

    const e = (await svc.app.inject({ method: 'GET', url: '/llamadas/llam-int-1' })).json();
    expect(e.estado).toBe('terminada');
    expect(e.resultado.estadoFinal).toBe('transferida_alarma');
    expect(e.resultado.requiereRevisionHumana).toBe(true);
    expect(e.resultado.resumen).toMatch(/síntoma de alarma/);
    expect(e.resultado.resumen).toMatch(/Requiere revisión humana/);
  });

  it('distingue en curso, sin resultado y fallida a partir del trabajo', () => {
    const base = {
      id: 'x', idPaciente: 'p', telefono: '+56911111111', contexto, intentos: 1,
      programadoPara: '2026-04-13T15:00:00.000Z', idConversacion: 'conv_x', numeroSalida: 'n',
    };
    const ahora = new Date('2026-04-13T15:10:00Z');
    expect(resumirLlamada({ ...base, estado: 'despachado', actualizadoEn: '2026-04-13T15:05:00.000Z' }, null, ahora).estado).toBe('en_curso');
    expect(resumirLlamada({ ...base, estado: 'despachado', actualizadoEn: '2026-04-13T14:00:00.000Z' }, null, ahora).estado).toBe('sin_resultado');
    expect(resumirLlamada({ ...base, estado: 'completado', actualizadoEn: '2026-04-13T15:05:00.000Z' }, null, ahora).estado).toBe('sin_resultado');
    expect(resumirLlamada({ ...base, estado: 'fallido', actualizadoEn: '2026-04-13T15:05:00.000Z' }, null, ahora).estado).toBe('fallida');
    const futura = resumirLlamada({ ...base, estado: 'pendiente', programadoPara: '2026-04-14T15:00:00.000Z', actualizadoEn: '' }, null, ahora);
    expect(futura.estado).toBe('programada');
    expect(futura.detalle).toMatch(/Programada para 2026-04-14/);
  });

  it('la frase del resultado nombra los criterios no cumplidos de una llamada completa', () => {
    const frase = fraseDelResultado({
      estadoFinal: 'terminada_ok',
      requiereRevisionHumana: true,
      criterios: [
        { id: 'identidad_verificada', veredicto: 'cumplido', justificacion: '' },
        { id: 'examenes_verificados', veredicto: 'no_cumplido', justificacion: '' },
      ],
      datos: { motivo_revision: 'Faltan exámenes.' } as never,
    });
    expect(frase).toBe('El paciente confirmó toda la preparación. Criterios no cumplidos: examenes verificados. Requiere revisión humana: Faltan exámenes.');
  });
});
