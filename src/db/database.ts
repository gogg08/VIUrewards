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
export const SCHEMA_VERSION = 4;

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
  // Fase 4A: reglas, historial de eventos y propuestas de moderación.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        trigger_json    TEXT NOT NULL,
        conditions_json TEXT NOT NULL,
        action_json     TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     TEXT NOT NULL,
        platform     TEXT NOT NULL,
        type         TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        user_name    TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        event_ts     INTEGER NOT NULL,
        rule_id      TEXT,
        outcome      TEXT NOT NULL,
        reason       TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposals (
        id         TEXT PRIMARY KEY,
        platform   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        user_name  TEXT NOT NULL,
        url        TEXT NOT NULL,
        event_id   TEXT NOT NULL,
        status     TEXT NOT NULL,
        reason     TEXT,
        clip_id    TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_history_created ON event_history(created_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      CREATE INDEX IF NOT EXISTS idx_proposals_url ON proposals(url);
    `);
  },
  // Fase 4B: cuentas de plataforma (tokens/credenciales), eventos de plataforma
  // ya procesados (idempotencia persistente), recompensas gestionadas por la app
  // y el ciclo de vida de cada canje. Todo genérico: sirve para cualquier
  // plataforma con la misma forma (no menciona ninguna en particular).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_accounts (
        platform         TEXT PRIMARY KEY,
        credentials_json TEXT,
        tokens_json      TEXT,
        status           TEXT NOT NULL DEFAULT 'unlinked',
        account_json     TEXT,
        updated_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_managed_rewards (
        platform   TEXT NOT NULL,
        reward_id  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (platform, reward_id)
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        platform   TEXT NOT NULL,
        event_id   TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (platform, event_id)
      );

      CREATE TABLE IF NOT EXISTS redemptions (
        platform     TEXT NOT NULL,
        event_id     TEXT NOT NULL,
        reward_id    TEXT,
        reward_title TEXT,
        user_id      TEXT,
        user_name    TEXT,
        user_input   TEXT,
        status       TEXT NOT NULL,
        reason       TEXT,
        event_json   TEXT NOT NULL,
        redeemed_at  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (platform, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_redemptions_status ON redemptions(status);
      CREATE INDEX IF NOT EXISTS idx_redemptions_created ON redemptions(created_at);
    `);
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