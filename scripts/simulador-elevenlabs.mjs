/**
 * Simulador de la API de ElevenLabs para QA sin credenciales.
 *
 *   node scripts/simulador-elevenlabs.mjs            # escucha en 127.0.0.1:9099
 *
 * Emula las rutas que usa este servicio (secretos, voces, agentes, webhooks,
 * números y originación por Twilio) y VALIDA los puntos del contrato que
 * importan: responde 422 si falta el discriminador `type` en un secreto, si el
 * agente no apunta a un LLM propio, si la originación no pide no grabar, etc.
 * Así un error de contrato se ve aquí y no en la primera llamada real.
 *
 * Con el simulador arriba, apunte el servicio a él:
 *
 *   ELEVENLABS_BASE_URL=http://127.0.0.1:9099 ELEVENLABS_API_KEY=clave-de-prueba \
 *   SERVICIO_URL_PUBLICA=https://agente.ejemplo npm run aprovisionar -- --webhook
 *
 * y después `npm run dev` con ELEVENLABS_AGENT_ID=agent_1. GET /_estado (con la
 * misma clave) muestra todo lo recibido. No sustituye la prueba con la
 * plataforma real: solo comprueba que este servicio habla el contrato.
 */
import { createServer } from "node:http";
const estado = { secretos: [], agentes: new Map(), webhooks: [], llamadas: [] };
const log = [];
const fallo = (res, code, msg) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ detail: msg })); log.push(`   !! ${code} ${msg}`); };
const ok = (res, cuerpo, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(cuerpo)); };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"); const p = url.pathname; const m = req.method;
  let cuerpo = ""; for await (const c of req) cuerpo += c; let b = {}; try { b = JSON.parse(cuerpo || "{}"); } catch {}
  log.push(`${m} ${p}${url.search}`);
  if (req.headers["xi-api-key"] !== "clave-de-prueba") return fallo(res, 401, "xi-api-key");
  if (m === "GET" && p === "/v1/convai/secrets") return ok(res, { secrets: estado.secretos.filter(s => !url.searchParams.get("search") || s.name.includes(url.searchParams.get("search"))), next_cursor: null });
  if (m === "POST" && p === "/v1/convai/secrets") { if (b.type !== "new" || !b.name || !b.value) return fallo(res, 422, "secret: type/new, name, value"); const s = { type: "stored", secret_id: `sec_${estado.secretos.length + 1}`, name: b.name, value: b.value }; estado.secretos.push(s); return ok(res, { type: "stored", secret_id: s.secret_id, name: s.name }); }
  const ms = p.match(/^\/v1\/convai\/secrets\/([^/]+)$/); if (ms && m === "PATCH") { if (b.type !== "update") return fallo(res, 422, "secret: type/update"); const s = estado.secretos.find(x => x.secret_id === ms[1]); if (!s) return fallo(res, 404, "secret"); s.value = b.value; return ok(res, { type: "stored", secret_id: s.secret_id, name: s.name }); }
  if (m === "GET" && p === "/v2/voices") return ok(res, { voices: [{ voice_id: "v_cat", name: "Catalina", labels: { accent: "chilean", language: "es" }, verified_languages: [{ language: "es", accent: "chilean" }] }, { voice_id: "v_otra", name: "Catalina Joven", labels: {} }], has_more: false, total_count: 2 });
  if (m === "GET" && p === "/v1/convai/agents") return ok(res, { agents: [...estado.agentes.values()].map(a => ({ agent_id: a.agent_id, name: a.name, voice_id: a.conversation_config?.tts?.voice_id ?? "", tags: a.tags ?? [], created_at_unix_secs: 1, access_info: {} })), has_more: false });
  const validarAgente = (c) => { const pr = c.conversation_config?.agent?.prompt; if (pr?.llm !== "custom-llm") return "llm"; if (!pr.custom_llm?.url?.endsWith("/v1")) return "custom_llm.url"; const sid = pr.custom_llm?.api_key?.secret_id; if (!estado.secretos.find(s => s.secret_id === sid)) return "custom_llm.api_key.secret_id desconocido"; if (!Array.isArray(pr.built_in_tools?.transfer_to_number?.params?.transfers)) return "transfers"; if (!c.conversation_config?.tts?.voice_id) return "tts.voice_id"; if (c.platform_settings?.privacy?.zero_retention_mode !== true) return "zero_retention_mode"; return null; };
  if (m === "POST" && p === "/v1/convai/agents/create") { const e = validarAgente(b); if (e) return fallo(res, 422, `agent create: ${e}`); const a = { agent_id: `agent_${estado.agentes.size + 1}`, ...b }; estado.agentes.set(a.agent_id, a); return ok(res, { agent_id: a.agent_id }); }
  const ma = p.match(/^\/v1\/convai\/agents\/([^/]+)$/); if (ma) { const a = estado.agentes.get(ma[1]); if (!a) return fallo(res, 404, "agent"); if (m === "GET") return ok(res, a); if (m === "PATCH") { const fusion = { ...a, ...b, conversation_config: { ...a.conversation_config, ...b.conversation_config }, platform_settings: { ...a.platform_settings, ...b.platform_settings } }; if (b.conversation_config?.agent?.prompt && !b.conversation_config?.tts) { /* PATCH parcial de reglas */ fusion.conversation_config.agent = { ...a.conversation_config.agent, prompt: { ...a.conversation_config.agent.prompt, ...b.conversation_config.agent.prompt } }; } else { const e = validarAgente(fusion); if (e) return fallo(res, 422, `agent patch: ${e}`); } estado.agentes.set(a.agent_id, fusion); return ok(res, fusion); } }
  if (m === "POST" && p === "/v1/workspace/webhooks") { if (b.settings?.auth_type !== "hmac" || !b.settings.webhook_url?.startsWith("https://")) return fallo(res, 422, "webhook settings"); const w = { webhook_id: `wh_${estado.webhooks.length + 1}`, url: b.settings.webhook_url }; estado.webhooks.push(w); return ok(res, { webhook_id: w.webhook_id, webhook_secret: "whsec_simulado_0123456789abcdef" }); }
  if (m === "GET" && p === "/v1/convai/phone-numbers") return ok(res, [{ provider: "twilio", phone_number: "+56223334444", phone_number_id: "phnum_1", label: "FALP 1" }, { provider: "exotel", phone_number: "+91", phone_number_id: "p2", label: "x" }]);
  if (m === "POST" && p === "/v1/convai/twilio/outbound-call") { if (!estado.agentes.has(b.agent_id)) return fallo(res, 422, "outbound: agent_id"); if (b.agent_phone_number_id !== "phnum_1") return fallo(res, 422, "outbound: agent_phone_number_id"); if (!/^\+\d+$/.test(b.to_number)) return fallo(res, 422, "outbound: to_number"); if (b.call_recording_enabled !== false) return fallo(res, 422, "outbound: call_recording_enabled"); if (!b.conversation_initiation_client_data?.custom_llm_extra_body?.idConversacion) return fallo(res, 422, "outbound: custom_llm_extra_body"); const id = `conv_plat_${estado.llamadas.length + 1}`; estado.llamadas.push({ id, propuesto: b.conversation_initiation_client_data.custom_llm_extra_body.idConversacion }); return ok(res, { success: true, message: "ok", conversation_id: id, callSid: `CA${estado.llamadas.length}` }); }
  if (m === "GET" && p === "/_estado") return ok(res, { log, secretos: estado.secretos, agentes: [...estado.agentes.keys()], webhooks: estado.webhooks, llamadas: estado.llamadas });
  return fallo(res, 404, `sin ruta ${m} ${p}`);
}).listen(9099, "127.0.0.1", () => console.log("Simulador de ElevenLabs en http://127.0.0.1:9099 (xi-api-key: clave-de-prueba)"));
