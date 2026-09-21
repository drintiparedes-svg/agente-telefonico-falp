/**
 * Aprovisiona el agente en la plataforma de voz desde la configuración de este
 * servicio. Es idempotente: se puede ejecutar cuantas veces haga falta.
 *
 *   npm run aprovisionar              # localiza o crea el agente y lo sincroniza
 *   npm run aprovisionar -- --webhook # además crea el webhook post-llamada
 *
 * Qué hace, en orden:
 *   1. Resuelve la voz: ELEVENLABS_VOICE_ID o, si no está, la busca por
 *      ELEVENLABS_VOICE_NOMBRE en el workspace. Exige una coincidencia única.
 *   2. Escribe LLM_TOKEN como secreto del workspace (crea o actualiza).
 *   3. Localiza el agente: ELEVENLABS_AGENT_ID o, si no está, lo busca por
 *      ELEVENLABS_AGENTE_NOMBRE. Si existe lo reescribe; si no, lo crea. En
 *      ambos casos imprime el id para guardarlo en el entorno.
 *   4. Con --webhook, crea el webhook post-llamada apuntando a este servicio e
 *      imprime el secreto de firma UNA sola vez, para guardarlo como
 *      WEBHOOK_SECRETO. Sin él la plataforma no notifica el cierre de llamadas.
 *
 * No toca números ni destinos: eso se administra en /admin/*.
 */
import { cargarConfig } from '../src/config/index.js';
import { abrirDB } from '../src/persistencia/db.js';
import { crearRepoDestinos } from '../src/persistencia/repositorios.js';
import { ClienteElevenLabs } from '../src/telefonia/elevenlabs.js';
import { compararAgente, cuerpoAgente } from '../src/telefonia/agente.js';
import { reglasParaAgente } from '../src/telefonia/transferencias.js';
import { definicionAgente, faltantesParaAgente, resolverVoz } from '../src/api/servidor.js';

const cfg = cargarConfig();
const crearWebhook = process.argv.includes('--webhook');

function abortar(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!cfg.ELEVENLABS_API_KEY) abortar('Falta ELEVENLABS_API_KEY.');
const faltan = faltantesParaAgente(cfg);
if (faltan.length > 0) abortar(`Faltan variables para definir el agente: ${faltan.join(', ')}.`);
if (cfg.NUMERO_TRANSFERENCIA === '') abortar('Falta NUMERO_TRANSFERENCIA: un agente sin ruta de escape a persona no se aprovisiona.');

const db = abrirDB(cfg.DB_RUTA);
const destinos = crearRepoDestinos(db);
const reglas = reglasParaAgente(destinos.activos(), cfg.NUMERO_TRANSFERENCIA, cfg.TRANSFERENCIA_TIPO);

const cliente = new ClienteElevenLabs({
  baseUrl: cfg.ELEVENLABS_BASE_URL,
  apiKey: cfg.ELEVENLABS_API_KEY,
  agentId: cfg.ELEVENLABS_AGENT_ID ?? '',
});

console.log(`\nAgente: ${cfg.ELEVENLABS_AGENTE_NOMBRE}`);
console.log(`Servicio: ${cfg.SERVICIO_URL_PUBLICA}`);
console.log(`Retención cero: ${cfg.ELEVENLABS_RETENCION_CERO ? 'sí' : 'NO (solo desarrollo)'}`);
console.log(`Reglas de transferencia: ${reglas.length}\n`);

// 1. Voz.
const voz = await resolverVoz(cfg, cliente);
if (!voz.ok) abortar(voz.error);
console.log(
  voz.origen === 'id'
    ? `✓ Voz ${voz.voiceId} (ELEVENLABS_VOICE_ID) · modelo ${cfg.ELEVENLABS_TTS_MODELO} · idioma ${cfg.ELEVENLABS_IDIOMA}`
    : `✓ Voz «${cfg.ELEVENLABS_VOICE_NOMBRE}» encontrada: ${voz.voiceId} · modelo ${cfg.ELEVENLABS_TTS_MODELO} · idioma ${cfg.ELEVENLABS_IDIOMA}`,
);
if (voz.origen === 'nombre') console.log(`  Para fijarla: ELEVENLABS_VOICE_ID=${voz.voiceId}`);

// 2. Secreto del token.
const secreto = await cliente.asegurarSecreto(cfg.ELEVENLABS_SECRETO_LLM_NOMBRE, cfg.LLM_TOKEN);
if (!secreto.ok) abortar(`No se pudo escribir el secreto del token: ${secreto.error}`);
console.log(`✓ Secreto «${cfg.ELEVENLABS_SECRETO_LLM_NOMBRE}» ${secreto.creado ? 'creado' : 'actualizado'} (${secreto.secretId})`);

// 3. Webhook (opcional).
let webhookId: string | null = cfg.ELEVENLABS_POSTCALL_WEBHOOK_ID ?? null;
if (crearWebhook) {
  const url = `${cfg.SERVICIO_URL_PUBLICA}/webhooks/postcall`;
  const w = await cliente.crearWebhookPostLlamada(`${cfg.ELEVENLABS_AGENTE_NOMBRE} · post-llamada`, url);
  if (!w.ok) abortar(`No se pudo crear el webhook: ${w.error}`);
  webhookId = w.webhookId;
  console.log(`✓ Webhook post-llamada creado (${w.webhookId}) → ${url}`);
  console.log('\n  Guarde estos valores en el entorno. El secreto NO vuelve a mostrarse:');
  console.log(`    ELEVENLABS_POSTCALL_WEBHOOK_ID=${w.webhookId}`);
  console.log(`    WEBHOOK_SECRETO=${w.secreto ?? '(la plataforma no devolvió el secreto: cópielo del panel)'}\n`);
}

// 4. Agente: por id, por nombre, o nuevo.
const definicion = definicionAgente(cfg, { secretIdLlm: secreto.secretId, voiceId: voz.voiceId, reglas, webhookPostLlamadaId: webhookId });
const cuerpo = cuerpoAgente(definicion);

let agentId: string | null = cfg.ELEVENLABS_AGENT_ID ?? null;
if (!agentId) {
  const b = await cliente.buscarAgente(cfg.ELEVENLABS_AGENTE_NOMBRE);
  if (!b.ok) abortar(`No se pudo buscar el agente «${cfg.ELEVENLABS_AGENTE_NOMBRE}»: ${b.error}`);
  if (b.agente) {
    agentId = b.agente.agentId;
    console.log(`✓ Agente «${b.agente.nombre}» encontrado en el workspace: ${agentId}`);
  } else if (b.candidatos.length > 1) {
    abortar(
      `Hay ${b.candidatos.length} agentes llamados «${cfg.ELEVENLABS_AGENTE_NOMBRE}»: ` +
        `${b.candidatos.map((a) => a.agentId).join(', ')}. Defina ELEVENLABS_AGENT_ID con el correcto.`,
    );
  }
}

if (agentId) {
  cliente.usarAgente(agentId);
  const previo = await cliente.leerAgente();
  if (!previo.ok) abortar(`No se pudo leer el agente ${agentId}: ${previo.error}`);
  const discrepancias = compararAgente(definicion, previo.datos);
  if (discrepancias.length === 0) {
    console.log('✓ El agente ya coincide con la definición. Se reescribe igualmente.');
  } else {
    console.log(`Diferencias encontradas (${discrepancias.length}), se corrigen:`);
    for (const d of discrepancias) console.log(`  · ${d.campo}: ${JSON.stringify(d.actual)} → ${JSON.stringify(d.esperado)}`);
  }
  const r = await cliente.escribirAgente(cuerpo);
  if (!r.ok) abortar(`No se pudo escribir el agente: ${r.error}`);
  console.log(`✓ Agente ${agentId} sincronizado.`);
  if (!cfg.ELEVENLABS_AGENT_ID) console.log(`\n  Guarde en el entorno:\n    ELEVENLABS_AGENT_ID=${agentId}\n`);
} else {
  const r = await cliente.crearAgente(cuerpo);
  if (!r.ok) abortar(`No se pudo crear el agente: ${r.error}`);
  console.log(`✓ Agente «${cfg.ELEVENLABS_AGENTE_NOMBRE}» creado.\n\n  Guarde en el entorno:\n    ELEVENLABS_AGENT_ID=${r.agentId}\n`);
}

if (!webhookId) {
  console.log(
    '\n⚠ Sin webhook post-llamada. La plataforma no notificará cierres ni fallos de originación.\n' +
      '  Ejecute de nuevo con --webhook o defina ELEVENLABS_POSTCALL_WEBHOOK_ID.',
  );
}

console.log('\nSiguiente paso: importar los números en la plataforma y sincronizarlos en /admin/numeros.\n');
db.close();
