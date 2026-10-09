/**
 * Apertura y migraciones de la base SQLite local (Fase 3).
 *
 * Migraciones simples: una lista ordenada de funciones. Se aplican las que
 * falten según `PRAGMA user_version`, cada una dentro de una transacción.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** Cantidad de migraciones aplicadas; equivale al `user_version` esperado. */
export const SCHEMA_VERSION = 2;

const MIGRATIONS: ReadonlyArray<(db: SqliteDatabase) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clips (
        id           TEXT PRIMARY KEY,
        source_url   TEXT NOT NULL,
        title        TEXT NOT NULL,
        duration_sec INTEGER NOT NULL DEFAULT 0,
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        file         TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
  // Fase 3 (parte B): recorte no destructivo de clips (null = sin recorte).
  (db) => {
    db.exec(`ALTER TABLE clips ADD COLUMN trim_start REAL;`);
    db.exec(`ALTER TABLE clips ADD COLUMN trim_end REAL;`);
  },
];

function currentVersion(db: SqliteDatabase): number {
  const value = db.pragma("user_version", { simple: true });
  return typeof value === "number" ? value : 0;
}

/** Aplica las migraciones pendientes. Es idempotente. */
export function migrate(db: SqliteDatabase): void {
  const version = currentVersion(db);
  for (let index = version; index < MIGRATIONS.length; index++) {
    const migration = MIGRATIONS[index];
    db.transaction(() => {
      migration(db);
      db.pragma(`user_version = ${index + 1}`);
    })();
  }
}

/** Abre (o crea) la base en disco y la deja migrada. */
export function openDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Base en memoria, para tests. */
export function openMemoryDatabase(): SqliteDatabase {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}