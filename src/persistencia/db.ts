import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));

export type DB = Database.Database;

export function abrirDB(ruta: string): DB {
  if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
  const db = new Database(ruta);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // synchronous = FULL: bajo retención cero no hay segunda oportunidad para un
  // resultado perdido, así que se paga la latencia de fsync.
  db.pragma('synchronous = FULL');
  migrar(db);
  return db;
}

export function migrar(db: DB): void {
  const sql = readFileSync(join(aqui, 'esquema.sql'), 'utf8');
  db.exec(sql);
  // `CREATE TABLE IF NOT EXISTS` no altera tablas que ya existen. Las columnas
  // añadidas después de la primera versión se agregan aquí.
  agregarColumna(db, 'trabajos', 'numero_salida', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_trabajos_numero ON trabajos (estado, numero_salida)');
}

function agregarColumna(db: DB, tabla: string, columna: string, tipo: string): void {
  const cols = db.prepare(`PRAGMA table_info(${tabla})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === columna)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipo}`);
}
