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
}
