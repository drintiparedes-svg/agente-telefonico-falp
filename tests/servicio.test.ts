import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cargarConfig, _limpiarCacheConfig } from '../src/config/index.js';
import { construirServicio, type Servicio } from '../src/api/servidor.js';
import { ClienteVozSimulado } from '../src/telefonia/elevenlabs.js';
import { firmar } from '../src/webhooks/hmac.js';
import { trocear } from '../src/llm/servidor.js';
import { contexto } from './fixtures.js';

const SECRETO = 'secreto-de-pruebas-1234567890';
const TOKEN = 'token-de-pruebas';

let svc: Servicio;
let cliente: ClienteVozSimulado;

beforeEach(() => {
  _limpiarCacheConfig();
  const cfg = cargarConfig({
    NODE_ENV: 'test',
    DB_RUTA: ':memory:',
    WEBHOOK_SECRETO: SECRETO,
    LLM_TOKEN: TOKEN,
    NUMERO_TRANSFERENCIA: '+56000000000',
    NIVEL_LOG: 'fatal',
  } as NodeJS.ProcessEnv);
  cliente = new ClienteVozSimulado();
  svc = construirServicio(cfg, cliente);
});

afterEach(async () => {
  await svc.cerrar();
  _limpiarCacheConfig();
});

describe('Programación de llamadas', () => {
  it('acepta una indicación completa', async () => {
    const r = await svc.app.inject({
      method: 'POST',
      url: '/llamadas',
      payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto },
    });
    expect(r.statusCode).toBe(201);
  });

  it('rechaza una indicación sin profesional emisor', async () => {
    const malo = { ...contexto, indicacion: { ...contexto.indicacion, emitidaPor: '' } };
    const r = await svc.app.inject({
      method: 'POST',
      url: '/llamadas',
      payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto: malo },
    });
    expect(r.statusCode).toBe(422);
  });

  it('rechaza una hora de ayuno mal formada', async () => {
    const malo = { ...contexto, indicacion: { ...contexto.indicacion, horaInicioAyuno: '25:99' } };
    const r = await svc.app.inject({
      method: 'POST',
      url: '/llamadas',
      payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto: malo },
    });
    expect(r.statusCode).toBe(422);
  });
});

describe('Webhooks', () => {
  const evento = {
    type: 'post_call_transcription',
    event_timestamp: 1,
    data: { conversation_id: 'conv-xyz' },
  };

  it('rechaza un webhook sin firma', async () => {
    const r = await svc.app.inject({ method: 'POST', url: '/webhooks/postcall', payload: evento });
    expect(r.statusCode).toBe(401);
  });

  it('rechaza una firma incorrecta', async () => {
    const crudo = JSON.stringify(evento);
    const r = await svc.app.inject({
      method: 'POST',
      url: '/webhooks/postcall',
      payload: crudo,
      headers: { 'content-type': 'application/json', 'elevenlabs-signature': firmar(crudo, 'otro-secreto-cualquiera') },
    });
    expect(r.statusCode).toBe(401);
  });

  it('rechaza una firma vencida', async () => {
    const crudo = JSON.stringify(evento);
    const viejo = Date.now() - 2 * 60 * 60 * 1000;
    const r = await svc.app.inject({
      method: 'POST',
      url: '/webhooks/postcall',
      payload: crudo,
      headers: { 'content-type': 'application/json', 'elevenlabs-signature': firmar(crudo, SECRETO, viejo) },
    });
    expect(r.statusCode).toBe(401);
  });

  it('acepta una firma válida y persiste el evento ANTES de procesarlo', async () => {
    const crudo = JSON.stringify(evento);
    const r = await svc.app.inject({
      method: 'POST',
      url: '/webhooks/postcall',
      payload: crudo,
      headers: { 'content-type': 'application/json', 'elevenlabs-signature': firmar(crudo, SECRETO) },
    });
    expect(r.statusCode).toBe(200);

    // El evento está en la cola incluso antes de que el trabajador corra.
    const salud = await svc.app.inject({ method: 'GET', url: '/salud' });
    expect(salud.json().eventosPendientes).toBe(1);

    const res = svc.trabajador.procesarLote();
    expect(res.procesados).toBe(1);
    expect(res.errores).toBe(0);

    const salud2 = await svc.app.inject({ method: 'GET', url: '/salud' });
    expect(salud2.json().eventosPendientes).toBe(0);
  });
});

describe('Endpoint de LLM', () => {
  it('exige autenticación', async () => {
    const r = await svc.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(401);
  });

  it('sin sesión precargada corta la llamada en vez de improvisar', async () => {
    const r = await svc.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': 'conv-inexistente' },
      payload: { messages: [{ role: 'user', content: 'hola' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('end_call');
    expect(r.body).toContain('[DONE]');
    // No aparece nada clínico.
    expect(r.body).not.toMatch(/ayuno|acenocumarol/i);
  });

  it('conduce una llamada completa de extremo a extremo', async () => {
    const prog = await svc.app.inject({
      method: 'POST',
      url: '/llamadas',
      payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto },
    });
    expect(prog.statusCode).toBe(201);

    const r = await svc.despachador.despacharLote(new Date('2026-04-13T15:00:00Z')); // 11:00 en Chile
    expect(r.despachados).toBe(1);
    const idConv = cliente.llamadas[0]?.idConversacion;
    expect(idConv).toBeTruthy();

    const turno = async (mensajes: Array<{ role: string; content: string }>) =>
      svc.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': idConv! },
        payload: { messages: mensajes },
      });

    const t1 = await turno([]);
    expect(t1.body).toMatch(/asistente telefónico automatizado/i);
    expect(t1.body).toMatch(/grabada/i);

    const t2 = await turno([{ role: 'assistant', content: 'apertura' }, { role: 'user', content: 'sí, soy yo' }]);
    expect(t2.body).toMatch(/RUT/i);

    const t3 = await turno([{ role: 'assistant', content: 'rut' }, { role: 'user', content: '4821' }]);
    expect(t3.body).toMatch(/día y el mes/i);

    const t4 = await turno([{ role: 'assistant', content: 'fecha' }, { role: 'user', content: '15 04' }]);
    // Recién ahora aparece contenido clínico.
    expect(t4.body).toMatch(/ayuno/i);
  });
});

describe('Troceado para la capa de voz', () => {
  it('divide por frase conservando la puntuación', () => {
    const t = trocear('Buenos días. ¿Hablo con María? Gracias.');
    expect(t.length).toBeGreaterThan(1);
    expect(t.join('')).toBe('Buenos días. ¿Hablo con María? Gracias.');
  });

  it('devuelve vacío para texto vacío', () => {
    expect(trocear('')).toEqual([]);
  });
});

describe('Conciliación', () => {
  it('detecta llamadas despachadas sin resultado', async () => {
    await svc.app.inject({
      method: 'POST',
      url: '/llamadas',
      payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto },
    });
    await svc.despachador.despacharLote(new Date('2026-04-13T15:00:00Z'));

    // Sin margen cumplido todavía: no hay huecos.
    const ahora = svc.conciliar();
    expect(ahora.totalSinResultado).toBe(0);
  });
});
