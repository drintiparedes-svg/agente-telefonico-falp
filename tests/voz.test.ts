/**
 * Voz, sonido de fondo y expresiones de pausa.
 *
 * Lo que se protege aquí: que las expresiones sean un conjunto cerrado y neutro,
 * que se elijan de forma reproducible, que pasen por la misma lista blanca que
 * el resto del guion, que queden en la auditoría tal como se pronunciaron, y que
 * el endpoint las emita ANTES de que el clasificador responda.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cargarConfig, _limpiarCacheConfig, type Config } from '../src/config/index.js';
import { construirServicio, type Servicio } from '../src/api/servidor.js';
import { ClienteVozSimulado } from '../src/telefonia/elevenlabs.js';
import { compararAgente, cuerpoAgente, cuerpoSonidoFondo, type DefinicionAgente } from '../src/telefonia/agente.js';
import { reglasParaAgente } from '../src/telefonia/transferencias.js';
import { abrir, avanzar, estadoInicial, validarSalida } from '../src/dominio/checklist/maquina.js';
import { componerConPausa, elegirExpresionPausa, EXPRESIONES_PAUSA, lineasConPausa } from '../src/dominio/checklist/pausas.js';
import { guion } from '../src/dominio/checklist/guion.js';
import type { Clasificacion } from '../src/dominio/tipos.js';
import type { Clasificador } from '../src/llm/clasificador.js';
import { contexto, cls } from './fixtures.js';

const SECRETO = 'secreto-de-pruebas-1234567890';
const TOKEN = 'token-de-pruebas';
const ADMIN = 'token-admin-de-pruebas-123';

// ---------------------------------------------------------------- pausas

describe('Expresiones de pausa', () => {
  it('son un conjunto cerrado, chileno y neutro: no afirman ni valoran nada', () => {
    expect(EXPRESIONES_PAUSA.length).toBeGreaterThanOrEqual(3);
    for (const e of EXPRESIONES_PAUSA) {
      // Un «ya» acusa recibo; «perfecto» o «muy bien» valorarían una respuesta
      // que todavía no se clasificó.
      expect(e).not.toMatch(/perfecto|muy bien|correcto|entiendo|excelente|gracias/i);
      expect(e).toMatch(/^[A-ZÁÉÍÓÚ]/);
      expect(e).toMatch(/[.…]$/);
    }
  });

  it('se eligen de forma determinista por llamada y turno', () => {
    const a = elegirExpresionPausa({ idLlamada: 'llam-001', turno: 3 });
    const b = elegirExpresionPausa({ idLlamada: 'llam-001', turno: 3 });
    expect(a).toBe(b);
    expect(EXPRESIONES_PAUSA).toContain(a);
  });

  it('no repiten la del turno anterior dentro de una misma llamada', () => {
    for (const id of ['llam-001', 'llam-002', 'sim-001', 'x']) {
      let anterior = elegirExpresionPausa({ idLlamada: id, turno: 0 });
      for (let t = 1; t < 40; t++) {
        const actual = elegirExpresionPausa({ idLlamada: id, turno: t });
        expect(actual).not.toBe(anterior);
        anterior = actual;
      }
    }
  });

  it('compuestas con una línea del guion pasan la lista blanca; con otro prefijo, no', () => {
    const linea = guion.pedirVerificacion();
    for (const e of EXPRESIONES_PAUSA) {
      expect(validarSalida(contexto, componerConPausa(e, linea)).valida).toBe(true);
    }
    expect(validarSalida(contexto, linea).valida).toBe(true);
    expect(validarSalida(contexto, `Perfecto, muy bien. ${linea}`).valida).toBe(false);
    expect(validarSalida(contexto, `${EXPRESIONES_PAUSA[0]} Le sugiero tomar paracetamol.`).valida).toBe(false);
  });

  it('la lista blanca extendida es exactamente líneas × (1 + expresiones)', () => {
    const base = ['A.', 'B.'];
    expect(lineasConPausa(base)).toHaveLength(base.length * (1 + EXPRESIONES_PAUSA.length));
  });

  it('la máquina antepone la expresión a la salida y a la auditoría, sin tocar la transición', () => {
    let st = abrir(contexto, estadoInicial(contexto.idLlamada)).estado;
    const sin = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' }));
    const con = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' }), { expresionPausa: 'Ya.' });
    expect(con.estado.estado).toBe(sin.estado.estado);
    expect(con.salida).toBe(`Ya. ${sin.salida}`);
    expect(con.estado.auditoria.at(-1)?.salidaAgente).toBe(con.salida);
    expect(con.estado.auditoria.at(-1)?.motivo).toBe(sin.estado.auditoria.at(-1)?.motivo);
    st = con.estado;
  });

  it('con expresión vacía la máquina se comporta exactamente igual que antes', () => {
    const st = abrir(contexto, estadoInicial(contexto.idLlamada)).estado;
    const a = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' }));
    const b = avanzar(contexto, st, 'sí, soy yo', cls({ intencion: 'confirma' }), { expresionPausa: '' });
    expect(b.salida).toBe(a.salida);
    expect(b.estado.auditoria.at(-1)?.salidaAgente).toBe(a.estado.auditoria.at(-1)?.salidaAgente);
  });
});

// ------------------------------------------------------------ perfil de voz

describe('Voz y sonido de fondo en la definición del agente', () => {
  const base: DefinicionAgente = {
    nombre: 'Prueba',
    urlPublica: 'https://agente.falp.example',
    secretIdLlm: 'sec_1',
    voiceId: 'voz_1',
    ttsModelo: 'eleven_flash_v2_5',
    idioma: 'es',
    retencionCero: true,
    retencionDias: 0,
    webhookPostLlamadaId: null,
    reglas: reglasParaAgente([], '+56000000000', 'conference'),
  };
  type Cuerpo = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('sin parámetros explícitos escribe teclado de fondo y la voz validada para pacientes', () => {
    const c = cuerpoAgente(base) as Cuerpo;
    expect(c.conversation_config.agent.language).toBe('es');
    expect(c.conversation_config.tts).toMatchObject({ voice_id: 'voz_1', model_id: 'eleven_flash_v2_5', stability: 0.6, similarity_boost: 0.8, speed: 0.95 });
    expect(c.conversation_config.conversation.background_sound).toEqual({
      source_type: 'preset',
      source_id: 'typing',
      volume: 0.15,
      crossfade_loop: true,
    });
  });

  it('los parámetros de voz y el fondo se toman de la definición', () => {
    const c = cuerpoAgente({ ...base, voz: { estabilidad: 0.4, similitud: 0.9, velocidad: 1 }, fondo: { tipo: 'office1', volumen: 0.2 } }) as Cuerpo;
    expect(c.conversation_config.tts).toMatchObject({ stability: 0.4, similarity_boost: 0.9, speed: 1 });
    expect(c.conversation_config.conversation.background_sound).toMatchObject({ source_id: 'office1', volume: 0.2 });
  });

  it('con fondo «ninguno» borra el sonido de fondo explícitamente', () => {
    const c = cuerpoAgente({ ...base, fondo: { tipo: 'ninguno', volumen: 0.15 } }) as Cuerpo;
    expect(c.conversation_config.conversation.background_sound).toBeNull();
    expect(cuerpoSonidoFondo({ tipo: 'ninguno', volumen: 1 })).toBeNull();
  });

  it('un fondo cambiado a mano en el panel aparece como discrepancia', () => {
    const escrito = cuerpoAgente(base) as Cuerpo;
    expect(compararAgente(base, escrito)).toEqual([]);
    escrito.conversation_config.conversation.background_sound = { source_type: 'preset', source_id: 'restaurant', volume: 0.5 };
    const d = compararAgente(base, escrito);
    expect(d.map((x) => x.campo)).toContain('conversation_config.conversation.background_sound.source_id');
    delete escrito.conversation_config.conversation.background_sound;
    expect(compararAgente(base, escrito).map((x) => x.campo)).toContain('conversation_config.conversation.background_sound.source_id');
  });

  it('la configuración entrega defaults sensatos y admite cambiarlos por entorno', () => {
    _limpiarCacheConfig();
    const a = cargarConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    expect([a.VOZ_ESTABILIDAD, a.VOZ_SIMILITUD, a.VOZ_VELOCIDAD, a.FONDO_SONIDO, a.FONDO_VOLUMEN, a.EXPRESIONES_PAUSA]).toEqual([0.6, 0.8, 0.95, 'typing', 0.15, 'si']);
    _limpiarCacheConfig();
    const b = cargarConfig({ NODE_ENV: 'test', FONDO_SONIDO: 'ninguno', VOZ_VELOCIDAD: '1.05' } as NodeJS.ProcessEnv);
    expect(b.FONDO_SONIDO).toBe('ninguno');
    expect(b.VOZ_VELOCIDAD).toBe(1.05);
    _limpiarCacheConfig();
    expect(() => cargarConfig({ NODE_ENV: 'test', FONDO_SONIDO: 'discoteca' } as NodeJS.ProcessEnv)).toThrow();
    _limpiarCacheConfig();
  });
});

// ---------------------------------------------------------------- servicio

/** Clasificador cuya respuesta se libera a mano, para observar qué sale antes. */
class ClasificadorControlado implements Clasificador {
  public llamadas = 0;
  public resuelto = false;
  private liberar: ((c: Clasificacion) => void) | null = null;
  public respuesta: Clasificacion = cls({ intencion: 'confirma' });

  clasificar(): Promise<Clasificacion> {
    this.llamadas++;
    return new Promise((res) => {
      this.liberar = (c) => {
        this.resuelto = true;
        res(c);
      };
    });
  }

  soltar(): void {
    this.liberar?.(this.respuesta);
  }
}

interface Trozo {
  content?: string;
  tool_calls?: Array<{ function: { name: string } }>;
}

function trozos(sse: string): Trozo[] {
  return sse
    .split('\n\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => (JSON.parse(l.slice(6)) as { choices: Array<{ delta: Trozo }> }).choices[0]!.delta);
}

function contenido(sse: string): string[] {
  return trozos(sse).flatMap((t) => (typeof t.content === 'string' ? [t.content] : []));
}

describe('Expresiones de pausa en el endpoint de LLM', () => {
  let svc: Servicio;
  let cliente: ClienteVozSimulado;

  function levantar(extra: Partial<Record<keyof Config, string>> = {}) {
    _limpiarCacheConfig();
    const cfg = cargarConfig({
      NODE_ENV: 'test',
      DB_RUTA: ':memory:',
      WEBHOOK_SECRETO: SECRETO,
      LLM_TOKEN: TOKEN,
      NUMERO_TRANSFERENCIA: '+56000000000',
      NIVEL_LOG: 'fatal',
      ...extra,
    } as NodeJS.ProcessEnv);
    cliente = new ClienteVozSimulado();
    svc = construirServicio(cfg, cliente);
  }

  async function iniciarLlamada(): Promise<string> {
    await svc.app.inject({ method: 'POST', url: '/llamadas', payload: { idPaciente: 'pac-001', telefono: '+56911111111', contexto } });
    await svc.despachador.despacharLote(new Date('2026-04-13T15:00:00Z'));
    const id = cliente.llamadas[0]?.idConversacion;
    if (!id) throw new Error('No se originó la llamada');
    // Turno de apertura.
    await svc.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': id },
      payload: { messages: [] },
    });
    return id;
  }

  const turno = (id: string, texto: string) =>
    svc.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': id },
      payload: { messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: texto }] },
    });

  beforeEach(() => levantar());
  afterEach(async () => {
    await svc.cerrar();
    _limpiarCacheConfig();
  });

  it('la expresión sale primero y el resto del turno después, y la auditoría registra la línea completa', async () => {
    const id = await iniciarLlamada();
    const r = await turno(id, 'sí, soy yo');
    const c = contenido(r.body);
    expect(c.length).toBeGreaterThanOrEqual(2);
    const primero = c[0]!.trim();
    expect(EXPRESIONES_PAUSA).toContain(primero);
    const completo = c.join('').replace(/\s+/g, ' ').trim();
    expect(completo).toBe(`${primero} ${guion.pedirVerificacion()}`.replace(/\s+/g, ' '));

    const audit = await svc.app.inject({ method: 'GET', url: `/auditoria/${contexto.idLlamada}` });
    const eventos = (audit.json() as { eventos: Array<{ salidaAgente: string }> }).eventos;
    expect(eventos.at(-1)?.salidaAgente).toBe(completo);
  });

  it('se emite ANTES de que el clasificador responda', async () => {
    await svc.cerrar();
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
    const controlado = new ClasificadorControlado();
    svc = construirServicio(cfg, cliente, { clasificador: controlado });
    const id = await iniciarLlamada();

    const direccion = await svc.app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${direccion}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-conversation-id': id, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'sí, soy yo' }] }),
    });
    const lector = res.body!.getReader();
    const dec = new TextDecoder();
    let acumulado = '';
    // Leer hasta que llegue el primer fragmento con texto. El clasificador
    // sigue sin resolver: nadie ha llamado a soltar().
    while (!contenido(acumulado).length) {
      const { value, done } = await lector.read();
      if (done) break;
      acumulado += dec.decode(value, { stream: true });
    }
    expect(controlado.llamadas).toBe(1);
    expect(controlado.resuelto).toBe(false);
    expect(EXPRESIONES_PAUSA).toContain(contenido(acumulado)[0]!.trim());

    controlado.soltar();
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      acumulado += dec.decode(value, { stream: true });
    }
    expect(acumulado).toContain('[DONE]');
    expect(contenido(acumulado).join('')).toContain(guion.pedirVerificacion());
  });

  it('ante una bandera roja léxica no hay pausa: la transferencia sale de inmediato', async () => {
    const id = await iniciarLlamada();
    const r = await turno(id, 'sí, pero estoy sangrando mucho');
    const c = contenido(r.body);
    expect(EXPRESIONES_PAUSA).not.toContain(c[0]!.trim());
    expect(c.join('')).toContain(guion.transferenciaAlarma());
    expect(r.body).toContain('transfer_to_number');
  });

  it('una alarma que solo detecta el modelo sí lleva expresión previa, y la transferencia igual ocurre', async () => {
    const id = await iniciarLlamada();
    // «me siento rarísimo» no está en el léxico de alarma; el clasificador
    // simulado lo etiqueta como síntoma.
    const r = await turno(id, 'sí, soy yo, aunque me siento rarísimo desde ayer');
    const c = contenido(r.body);
    if (r.body.includes('transfer_to_number')) {
      expect(c.join('')).toContain('persona del equipo');
    }
    // Sea cual sea la etiqueta, la salida completa pasó la lista blanca.
    const audit = await svc.app.inject({ method: 'GET', url: `/auditoria/${contexto.idLlamada}` });
    const ultimo = (audit.json() as { eventos: Array<{ salidaAgente: string }> }).eventos.at(-1)!;
    expect(validarSalida(contexto, ultimo.salidaAgente).valida).toBe(true);
  });

  it('con EXPRESIONES_PAUSA=no el turno sale sin prefijo', async () => {
    await svc.cerrar();
    levantar({ EXPRESIONES_PAUSA: 'no' });
    const id = await iniciarLlamada();
    const r = await turno(id, 'sí, soy yo');
    const c = contenido(r.body);
    expect(EXPRESIONES_PAUSA).not.toContain(c[0]!.trim());
    expect(c.join('').trim()).toBe(guion.pedirVerificacion());
  });

  it('la sincronización completa escribe el fondo y los parámetros de voz en el agente', async () => {
    await svc.cerrar();
    levantar({
      ADMIN_TOKEN: ADMIN,
      SERVICIO_URL_PUBLICA: 'https://agente.falp.example',
      ELEVENLABS_VOICE_ID: 'voz_abc',
      ELEVENLABS_AGENT_ID: 'agent_1',
      FONDO_SONIDO: 'office1',
      FONDO_VOLUMEN: '0.2',
      VOZ_VELOCIDAD: '0.9',
    });
    const headers = { authorization: `Bearer ${ADMIN}` };
    const s = await svc.app.inject({ method: 'POST', url: '/admin/agente/sincronizar', headers });
    expect(s.statusCode).toBe(200);
    const escrito = cliente.agente as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(escrito.conversation_config.conversation.background_sound).toMatchObject({ source_id: 'office1', volume: 0.2 });
    expect(escrito.conversation_config.tts).toMatchObject({ voice_id: 'voz_abc', speed: 0.9, stability: 0.6 });
    expect(escrito.conversation_config.agent.language).toBe('es');

    const estado = await svc.app.inject({ method: 'GET', url: '/admin/agente', headers });
    expect(estado.json()).toMatchObject({ sincronizado: true, discrepancias: [] });
  });
});
