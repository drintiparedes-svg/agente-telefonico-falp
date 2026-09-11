-- Esquema del servicio. SQLite con WAL: durable y sin dependencia externa para el piloto.
-- Migrar a Postgres si el volumen o la concurrencia lo exigen; los repositorios
-- están aislados para que ese cambio no toque el dominio.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Trabajos de llamada pendientes de despacho.
CREATE TABLE IF NOT EXISTS trabajos (
  id                 TEXT PRIMARY KEY,
  id_paciente        TEXT NOT NULL,
  telefono           TEXT NOT NULL,
  contexto_json      TEXT NOT NULL,          -- ContextoLlamada serializado
  estado             TEXT NOT NULL,          -- pendiente | despachado | completado | fallido
  intentos           INTEGER NOT NULL DEFAULT 0,
  programado_para    TEXT NOT NULL,
  id_conversacion    TEXT,                   -- devuelto por la plataforma al despachar
  creado_en          TEXT NOT NULL,
  actualizado_en     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trabajos_estado ON trabajos (estado, programado_para);
CREATE INDEX IF NOT EXISTS idx_trabajos_conv ON trabajos (id_conversacion);

-- Cola durable de eventos entrantes.
-- Crítica bajo retención cero: la plataforma NO reintenta webhooks fallidos y no
-- guarda copia. Si este servicio no persiste el evento en el instante en que
-- llega, el resultado de esa llamada se pierde de forma irrecuperable.
CREATE TABLE IF NOT EXISTS cola_eventos (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo               TEXT NOT NULL,
  id_conversacion    TEXT,
  payload_json       TEXT NOT NULL,
  estado             TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | procesado | error
  intentos           INTEGER NOT NULL DEFAULT 0,
  ultimo_error       TEXT,
  recibido_en        TEXT NOT NULL,
  procesado_en       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cola_estado ON cola_eventos (estado, id);

-- Resultado consolidado de cada llamada.
CREATE TABLE IF NOT EXISTS resultados (
  id_llamada             TEXT PRIMARY KEY,
  id_paciente            TEXT NOT NULL,
  estado_final           TEXT NOT NULL,
  criterios_json         TEXT NOT NULL,
  datos_json             TEXT NOT NULL,
  requiere_revision      INTEGER NOT NULL,
  motivo_revision        TEXT NOT NULL DEFAULT '',
  revisado_por           TEXT,
  revisado_en            TEXT,
  creado_en              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resultados_revision ON resultados (requiere_revision, revisado_en);

-- Registro de auditoría. Una fila por transición de estado.
-- Es lo que permite reconstruir por qué el sistema hizo lo que hizo.
CREATE TABLE IF NOT EXISTS auditoria (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id_llamada         TEXT NOT NULL,
  ts                 TEXT NOT NULL,
  estado_anterior    TEXT NOT NULL,
  estado_nuevo       TEXT NOT NULL,
  motivo             TEXT NOT NULL,
  entrada_paciente   TEXT NOT NULL,
  salida_agente      TEXT NOT NULL,
  guardrail          TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditoria_llamada ON auditoria (id_llamada, ts);

-- Estado vivo de las conversaciones en curso, para el endpoint de LLM,
-- que es sin estado por definición del protocolo.
CREATE TABLE IF NOT EXISTS sesiones (
  id_conversacion    TEXT PRIMARY KEY,
  estado_json        TEXT NOT NULL,
  contexto_json      TEXT NOT NULL,
  actualizado_en     TEXT NOT NULL
);
