import { afterEach, describe, expect, it } from 'vitest';
import { cargarConfig, _limpiarCacheConfig } from '../src/config/index.js';
import { construirServicio, type Servicio } from '../src/api/servidor.js';
import { ClienteElevenLabs, ClienteVozSimulado, cuerpoReglasAgente } from '../src/telefonia/elevenlabs.js';
import { capacidadLibre, elegirNumero } from '../src/telefonia/numeros.js';
import { argumentosTransferencia, reglasParaAgente, resolverDestino } from '../src/telefonia/transferencias.js';
import { validarSalida } from '../src/dominio/checklist/maquina.js';
import type { DestinoTransferencia, NumeroSalida } from '../src/persistencia/repositorios.js';
import { contexto } from './fixtures.js';

const TOKEN = 'token-de-pruebas';
const ADMIN = 'admin-de-pruebas-123456';
const RESPALDO = '+56000000000';
/** Lunes 13 de abril de 2026, 11:00 en Santiago. */
const LUNES_11 = new Date('2026-04-13T15:00:00Z');

function numero(id: string, c: Partial<NumeroSalida> = {}): NumeroSalida {
  return { idPlataforma: id, e164: '', etiqueta: id, proveedor: 'twilio', activo: true, concurrenciaMax: 2, prioridad: 100, ...c };
}

function destino(id: string, c: Partial<DestinoTransferencia> = {}): DestinoTransferencia {
  return {
    id, e164: '+56911110000', etiqueta: id, motivo: 'general', servicio: '',
    horaDesde: 0, horaHasta: 24, dias: '1234567', prioridad: 100, activo: true, ...c,
  };
}

let actual: Servicio | null = null;

afterEach(async () => {
  if (actual) await actual.cerrar();
  actual = null;
  _limpiarCacheConfig();
});

function levantar(extra: Record<string, string> = {}) {
  _limpiarCacheConfig();
  const cfg = cargarConfig({
    NODE_ENV: 'test',
    DB_RUTA: ':memory:',
    WEBHOOK_SECRETO: 'secreto-de-pruebas-1234567890',
    LLM_TOKEN: TOKEN,
    NUMERO_TRANSFERENCIA: RESPALDO,
    NIVEL_LOG: 'fatal',
    ...extra,
  } as NodeJS.ProcessEnv);
  const cliente = new ClienteVozSimulado();
  const pausas: number[] = [];
  const svc = construirServicio(cfg, cliente, { esperar: async (ms) => void pausas.push(ms) });
  actual = svc;
  return { svc, cliente, pausas };
}

async function programar(svc: Servicio, idLlamada: string, extra: Record<string, unknown> = {}) {
  const r = await svc.app.inject({
    method: 'POST',
    url: '/llamadas',
    payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto: { ...contexto, idLlamada, ...extra } },
  });
  expect(r.statusCode).toBe(201);
}

/** Extrae la llamada a herramienta de una respuesta SSE del endpoint de LLM. */
function herramienta(body: string): { nombre: string; args: Record<string, string> } | null {
  for (const linea of body.split('\n')) {
    if (!linea.startsWith('data: ') || linea.includes('[DONE]')) continue;
    const d = JSON.parse(linea.slice(6)) as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
    };
    const tc = d.choices?.[0]?.delta?.tool_calls?.[0];
    if (tc) return { nombre: tc.function.name, args: JSON.parse(tc.function.arguments) as Record<string, string> };
  }
  return null;
}

describe('Selección del número de salida', () => {
  it('elige el de menor ocupación y respeta el techo de cada número', () => {
    const activos = [numero('a'), numero('b')];
    expect(elegirNumero(activos, new Map([['a', 1]]))?.idPlataforma).toBe('b');
    expect(elegirNumero(activos, new Map([['a', 1], ['b', 1]]))?.idPlataforma).toBe('a');
    expect(elegirNumero(activos, new Map([['a', 2], ['b', 2]]))).toBeNull();
    expect(capacidadLibre(activos, new Map([['a', 1]]))).toBe(3);
  });

  it('a igual ocupación prefiere la menor prioridad', () => {
    const activos = [numero('a', { prioridad: 200 }), numero('b', { prioridad: 100 })];
    expect(elegirNumero(activos, new Map())?.idPlataforma).toBe('b');
  });
});

describe('Despacho con grupo de números', () => {
  it('reparte entre números, respeta el techo por número y espacia según las llamadas por segundo', async () => {
    const { svc, cliente, pausas } = levantar();
    svc.numeros.actualizar('simulado-1', { activo: false });
    svc.numeros.sembrar(numero('num-a', { concurrenciaMax: 1 }));
    svc.numeros.sembrar(numero('num-b', { concurrenciaMax: 1 }));
    for (const id of ['llam-1', 'llam-2', 'llam-3']) await programar(svc, id);

    const r1 = await svc.despachador.despacharLote(LUNES_11);
    expect(r1).toEqual({ despachados: 2, omitidos: 0, fallidos: 0 });
    expect(new Set(cliente.llamadas.map((l) => l.idNumero))).toEqual(new Set(['num-a', 'num-b']));
    expect(pausas).toEqual([1000]);

    // Los dos números están ocupados: la tercera llamada espera.
    const r2 = await svc.despachador.despacharLote(LUNES_11);
    expect(r2.despachados).toBe(0);
  });

  it('con más llamadas por segundo la pausa se acorta', async () => {
    const { svc, pausas } = levantar({ TWILIO_CPS: '5' });
    for (const id of ['llam-1', 'llam-2', 'llam-3']) await programar(svc, id);
    const r = await svc.despachador.despacharLote(LUNES_11);
    expect(r.despachados).toBe(3);
    expect(pausas).toEqual([200, 200]);
  });

  it('sin números activos no despacha y el trabajo sigue en cola', async () => {
    const { svc, cliente } = levantar();
    svc.numeros.actualizar('simulado-1', { activo: false });
    await programar(svc, 'llam-1');

    expect((await svc.despachador.despacharLote(LUNES_11)).despachados).toBe(0);
    expect(cliente.llamadas).toHaveLength(0);

    svc.numeros.actualizar('simulado-1', { activo: true });
    expect((await svc.despachador.despacharLote(LUNES_11)).despachados).toBe(1);
  });
});

describe('Enrutamiento de transferencias', () => {
  const destinos = [
    destino('general'),
    destino('alarma', { motivo: 'alarma', e164: '+56922220000' }),
    destino('alarma-endo', { motivo: 'alarma', servicio: 'endoscopia', e164: '+56933330000' }),
    destino('consulta-noche', { motivo: 'consulta', horaDesde: 20, horaHasta: 24, e164: '+56944440000' }),
    destino('consulta-finde', { motivo: 'consulta', dias: '67', e164: '+56955550000' }),
  ];

  it('prefiere motivo y servicio exactos', () => {
    expect(resolverDestino(destinos, { motivo: 'alarma', servicio: 'endoscopia', ahora: LUNES_11 }, RESPALDO).idDestino).toBe('alarma-endo');
    expect(resolverDestino(destinos, { motivo: 'alarma', ahora: LUNES_11 }, RESPALDO).idDestino).toBe('alarma');
  });

  it('descarta destinos fuera de horario o de día y cae en el general', () => {
    expect(resolverDestino(destinos, { motivo: 'consulta', ahora: LUNES_11 }, RESPALDO).idDestino).toBe('general');
  });

  it('sin destinos usa el respaldo', () => {
    expect(resolverDestino([], { motivo: 'alarma', ahora: LUNES_11 }, RESPALDO)).toEqual({ e164: RESPALDO, idDestino: null });
  });

  it('las reglas del agente tienen un número por destino distinto, incluido el respaldo', () => {
    const reglas = reglasParaAgente([destino('x', { e164: '+56911110000' }), destino('y', { e164: '+56911110000' })], RESPALDO, 'conference');
    expect(reglas.map((r) => r.transfer_destination.phone_number)).toEqual([RESPALDO, '+56911110000']);
    expect(reglas.every((r) => r.transfer_type === 'conference' && r.transfer_destination.type === 'phone')).toBe(true);
  });

  it('los mensajes de la transferencia salen del guion y no llevan datos del paciente', () => {
    const a = argumentosTransferencia({ e164: '+56922220000', motivo: 'alarma', idLlamada: contexto.idLlamada });
    expect(Object.keys(a).sort()).toEqual(['agent_message', 'client_message', 'reason', 'transfer_number']);
    expect(validarSalida(contexto, a.client_message).valida).toBe(true);
    expect(validarSalida(contexto, a.agent_message).valida).toBe(true);
    expect(a.agent_message).not.toContain(contexto.verificacion.nombrePaciente);
    expect(a.agent_message).not.toMatch(/acenocumarol|ayuno/i);
  });
});

describe('Transferencia desde el endpoint de LLM', () => {
  async function alarmaAntesDeVerificar(svc: Servicio, cliente: ClienteVozSimulado) {
    await programar(svc, 'llam-t1');
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
    const r = await turno([
      { role: 'assistant', content: 'apertura' },
      { role: 'user', content: 'ando con fiebre desde ayer' },
    ]);
    return herramienta(r.body);
  }

  it('una alarma transfiere al destino de alarma con los argumentos que exige la plataforma', async () => {
    const { svc, cliente } = levantar();
    svc.destinos.guardar(destino('alarma', { motivo: 'alarma', e164: '+56922223333' }));
    const h = await alarmaAntesDeVerificar(svc, cliente);
    expect(h?.nombre).toBe('transfer_to_number');
    expect(h?.args).toMatchObject({ transfer_number: '+56922223333', reason: 'alarma' });
    expect(h?.args['client_message']).toBeTruthy();
    expect(h?.args['agent_message']).toContain('llam-t1');
  });

  it('sin destinos transfiere al número de respaldo', async () => {
    const { svc, cliente } = levantar();
    const h = await alarmaAntesDeVerificar(svc, cliente);
    expect(h?.args['transfer_number']).toBe(RESPALDO);
  });
});

describe('Administración de telefonía', () => {
  it('no existe sin ADMIN_TOKEN y exige el token cuando existe', async () => {
    const sin = levantar();
    expect((await sin.svc.app.inject({ method: 'GET', url: '/admin/numeros' })).statusCode).toBe(404);
    await sin.svc.cerrar();
    actual = null;

    const con = levantar({ ADMIN_TOKEN: ADMIN });
    expect((await con.svc.app.inject({ method: 'GET', url: '/admin/numeros' })).statusCode).toBe(401);
  });

  it('sincroniza los números de la plataforma y los deja inactivos hasta activarlos', async () => {
    const { svc, cliente } = levantar({ ADMIN_TOKEN: ADMIN });
    const headers = { authorization: `Bearer ${ADMIN}` };
    cliente.numeros = [{ idPlataforma: 'phnum_1', e164: '+56223334444', etiqueta: 'FALP 1', proveedor: 'twilio' }];

    const sync = await svc.app.inject({ method: 'POST', url: '/admin/numeros/sincronizar', headers });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ total: 1, nuevos: 1 });

    const lista = (await svc.app.inject({ method: 'GET', url: '/admin/numeros', headers })).json() as {
      numeros: Array<{ idPlataforma: string; activo: boolean }>;
    };
    expect(lista.numeros.find((n) => n.idPlataforma === 'phnum_1')?.activo).toBe(false);

    const act = await svc.app.inject({
      method: 'PATCH', url: '/admin/numeros/phnum_1', headers, payload: { activo: true, concurrenciaMax: 3 },
    });
    expect(act.statusCode).toBe(200);
    expect(act.json()).toMatchObject({ activo: true, concurrenciaMax: 3 });

    expect((await svc.app.inject({ method: 'PATCH', url: '/admin/numeros/otro', headers, payload: { activo: true } })).statusCode).toBe(404);
    expect((await svc.app.inject({ method: 'PATCH', url: '/admin/numeros/phnum_1', headers, payload: { concurrenciaMax: 0 } })).statusCode).toBe(400);
  });

  it('valida los destinos y escribe las reglas en el agente', async () => {
    const { svc, cliente } = levantar({ ADMIN_TOKEN: ADMIN });
    const headers = { authorization: `Bearer ${ADMIN}` };

    const malo = await svc.app.inject({ method: 'PUT', url: '/admin/destinos/uci', headers, payload: { e164: '12345', motivo: 'alarma' } });
    expect(malo.statusCode).toBe(400);

    const bueno = await svc.app.inject({ method: 'PUT', url: '/admin/destinos/uci', headers, payload: { e164: '+56922223333', motivo: 'alarma' } });
    expect(bueno.statusCode).toBe(200);

    const sync = await svc.app.inject({ method: 'POST', url: '/admin/agente/sincronizar', headers });
    expect(sync.json()).toEqual({ ok: true, reglas: 2 });
    expect(cliente.reglas?.map((r) => r.transfer_destination.phone_number).sort()).toEqual([RESPALDO, '+56922223333'].sort());
  });
});

describe('Cliente ElevenLabs', () => {
  function falso(respuesta: unknown, status = 200) {
    const pedidos: Array<{ url: string; metodo: string; cuerpo: Record<string, unknown> | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      pedidos.push({
        url: String(url),
        metodo: init?.method ?? 'GET',
        cuerpo: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
      return new Response(JSON.stringify(respuesta), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const cliente = new ClienteElevenLabs({ baseUrl: 'https://api.prueba', apiKey: 'k', agentId: 'agent_1', fetchImpl });
    return { cliente, pedidos };
  }

  const llamada = (proveedor: 'twilio' | 'sip_trunk') => ({
    telefono: '+56911111111',
    idConversacionPropuesto: 'conv_x',
    variables: {},
    numero: { idPlataforma: 'phnum_1', proveedor },
  });

  it('origina por la ruta de Twilio con el número elegido y sin grabación en Twilio', async () => {
    const { cliente, pedidos } = falso({ success: true, message: 'ok', conversation_id: 'conv_1', callSid: 'CA1' });
    const r = await cliente.llamarSaliente(llamada('twilio'));
    expect(pedidos[0]?.url).toBe('https://api.prueba/v1/convai/twilio/outbound-call');
    expect(pedidos[0]?.cuerpo).toMatchObject({ agent_id: 'agent_1', agent_phone_number_id: 'phnum_1', call_recording_enabled: false });
    expect(r).toEqual({ ok: true, idConversacion: 'conv_1', idLlamadaProveedor: 'CA1', error: null });
  });

  it('un número SIP usa su propia ruta', async () => {
    const { cliente, pedidos } = falso({ success: true, message: 'ok', conversation_id: 'conv_1', sip_call_id: 'sip1' });
    const r = await cliente.llamarSaliente(llamada('sip_trunk'));
    expect(pedidos[0]?.url).toBe('https://api.prueba/v1/convai/sip-trunk/outbound-call');
    expect(pedidos[0]?.cuerpo).not.toHaveProperty('call_recording_enabled');
    expect(r.idLlamadaProveedor).toBe('sip1');
  });

  it('una respuesta con success=false es un fallo aunque el HTTP sea 200', async () => {
    const { cliente } = falso({ success: false, message: 'número no habilitado' });
    expect((await cliente.llamarSaliente(llamada('twilio'))).ok).toBe(false);
  });

  it('lee solo los números de Twilio y SIP', async () => {
    const { cliente } = falso([
      { provider: 'twilio', phone_number: '+56223334444', phone_number_id: 'p1', label: 'A' },
      { provider: 'exotel', phone_number: '+911234', phone_number_id: 'p2', label: 'B' },
    ]);
    expect(await cliente.listarNumeros()).toEqual([
      { idPlataforma: 'p1', e164: '+56223334444', etiqueta: 'A', proveedor: 'twilio' },
    ]);
  });

  it('escribe las reglas de transferencia en la configuración del agente', async () => {
    const { cliente, pedidos } = falso({});
    const reglas = reglasParaAgente([], RESPALDO, 'conference');
    expect((await cliente.actualizarReglasTransferencia(reglas)).ok).toBe(true);
    expect(pedidos[0]?.metodo).toBe('PATCH');
    expect(pedidos[0]?.url).toBe('https://api.prueba/v1/convai/agents/agent_1');
    expect(pedidos[0]?.cuerpo).toEqual(cuerpoReglasAgente(reglas));
  });
});
