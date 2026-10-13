/**
 * Apertura y migraciones de la base SQLite local (Fase 3).
 *
 * Migraciones simples: una lista ordenada de funciones. Se aplican las que
 * falten según `PRAGMA user_version`, cada una dentro de una transacción.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** Cantidad de migraciones aplicadas; equivale al `user_version` esperado. */
export const SCHEMA_VERSION = 9;

interface LegacyRuleRow {
  id: string;
  name: string;
  enabled: number;
  trigger_json: string;
  conditions_json: string;
  action_json: string;
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Deriva un título aceptable a partir del nombre de una regla heredada. */
function legacyRewardTitle(ruleName: string): string {
  const withoutPrefix = ruleName.replace(/^recompensa:\s*/i, "").trim();
  const base = withoutPrefix.length > 0 ? withoutPrefix : "Alerta";
  return [...base].slice(0, 50).join("");
}

interface MigratedRuleReward {
  rule: LegacyRuleRow;
  triggerRewardId: string;
  action: Record<string, unknown>;
  conditions: Record<string, unknown>;
}

/** Reglas `reward_redeemed` con su `rewardId`, para importar recompensas ya gestionadas. */
function legacyRulesByRewardId(db: SqliteDatabase): Map<string, MigratedRuleReward> {
  const rows = db
    .prepare<LegacyRuleRow>(
      "SELECT id, name, enabled, trigger_json, conditions_json, action_json FROM rules",
    )
    .all();
  const map = new Map<string, MigratedRuleReward>();
  for (const rule of rows) {
    const trigger = safeJson(rule.trigger_json);
    const rewardId = trigger?.rewardId;
    if (trigger?.type !== "reward_redeemed" || typeof rewardId !== "string" || rewardId.length === 0) continue;
    if (map.has(rewardId)) continue;
    map.set(rewardId, {
      rule,
      triggerRewardId: rewardId,
      action: safeJson(rule.action_json) ?? {},
      conditions: safeJson(rule.conditions_json) ?? {},
    });
  }
  return map;
}

function numberOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

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
  // Rediseño (Etapa 1): el público ya no envía links. Se eliminan la tabla de
  // propuestas de moderación y los settings que solo usaba ese flujo. NO se toca
  // ninguna otra tabla (clips, settings activos, reglas, historial, canjes).
  (db) => {
    db.exec(`DROP TABLE IF EXISTS proposals;`);
    db.exec(
      `DELETE FROM settings WHERE key IN ('moderation.maxPending', 'moderation.maxPendingPerUser');`,
    );
  },
  // Rediseño (Etapa 4A): modelo local de recompensas, con su regla interna 1:1.
  // Es genérico (columna `platform`): no menciona ninguna plataforma concreta.
  // Importa las recompensas ya gestionadas que tienen una regla `reward_redeemed`
  // por `rewardId`: la fila local se arma con los datos de esa regla. Los campos
  // que la regla no guarda (título exacto, costo, color y descripción) se dejan
  // con valores provisorios y se completan desde la plataforma en el primer listado.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rewards (
        id                TEXT PRIMARY KEY,
        platform          TEXT NOT NULL,
        remote_reward_id  TEXT,
        title             TEXT NOT NULL,
        cost              INTEGER NOT NULL DEFAULT 1,
        color             TEXT NOT NULL DEFAULT '#00e701',
        description       TEXT NOT NULL DEFAULT '',
        clip_id           TEXT,
        volume            REAL NOT NULL DEFAULT 1,
        max_duration_sec  INTEGER,
        cooldown_sec      INTEGER NOT NULL DEFAULT 0,
        user_cooldown_sec INTEGER NOT NULL DEFAULT 0,
        position_json     TEXT,
        enter_animation   TEXT,
        exit_animation    TEXT,
        desired_enabled   INTEGER NOT NULL DEFAULT 1,
        managed           INTEGER NOT NULL DEFAULT 1,
        rule_id           TEXT,
        last_error        TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rewards_platform ON rewards(platform);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rewards_remote
        ON rewards(platform, remote_reward_id) WHERE remote_reward_id IS NOT NULL;
    `);

    const managed = db
      .prepare<{ platform: string; reward_id: string }>(
        "SELECT platform, reward_id FROM platform_managed_rewards",
      )
      .all();
    if (managed.length === 0) return;

    const rulesByRewardId = legacyRulesByRewardId(db);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO rewards
        (id, platform, remote_reward_id, title, cost, color, description, clip_id, volume,
         max_duration_sec, cooldown_sec, user_cooldown_sec, position_json, enter_animation,
         exit_animation, desired_enabled, managed, rule_id, last_error, created_at, updated_at)
      VALUES
        (@id, @platform, @remoteRewardId, @title, @cost, @color, @description, @clipId, @volume,
         @maxDurationSec, @cooldownSec, @userCooldownSec, @positionJson, @enterAnimation,
         @exitAnimation, @desiredEnabled, 1, @ruleId, NULL, @now, @now)
    `);

    for (const row of managed) {
      const migrated = rulesByRewardId.get(row.reward_id);
      if (!migrated) continue;
      const { rule, action, conditions } = migrated;
      const position = action.position;
      insert.run({
        id: randomUUID(),
        platform: row.platform,
        remoteRewardId: row.reward_id,
        title: legacyRewardTitle(rule.name),
        cost: 1,
        color: "#00e701",
        description: "",
        clipId: typeof action.clipId === "string" ? action.clipId : null,
        volume: numberOr(action.volume, 1),
        maxDurationSec: typeof action.maxDurationSec === "number" ? action.maxDurationSec : null,
        cooldownSec: numberOr(conditions.cooldownSec, 0),
        userCooldownSec: numberOr(conditions.userCooldownSec, 0),
        positionJson:
          typeof position === "object" && position !== null ? JSON.stringify(position) : null,
        enterAnimation: typeof action.enterAnimation === "string" ? action.enterAnimation : null,
        exitAnimation: typeof action.exitAnimation === "string" ? action.exitAnimation : null,
        desiredEnabled: rule.enabled === 1 ? 1 : 0,
        ruleId: rule.id,
        now: new Date().toISOString(),
      });
    }
  },
  // Rediseño (Etapa 4A, ajuste): marca si la fila ya se sincronizó con la plataforma.
  // Las recompensas importadas por la migración v6 quedan en 0 (datos provisorios:
  // costo/color/descripción) hasta que la plataforma responde; las que crea esta app
  // nacen en 1. Una fila sin sincronizar no se puede editar, para no mandar datos
  // provisorios a la API. Es genérico: la columna se llama `synced`, sin plataforma.
  (db) => {
    db.exec(`ALTER TABLE rewards ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;`);
  },
  // Rework de cooldown y superposición (Parte B). El cooldown pasa a ser un dato
  // de la recompensa (global, persistido en `last_fired_at` para sobrevivir
  // reinicios) y se elimina el cooldown por usuario de todo el sistema. Se agrega
  // el modo de repetición (`repetition`): "queue" (esperar turno) u "overlap"
  // (superponer audios). Genérico: no menciona ninguna plataforma.
  (db) => {
    db.exec(`ALTER TABLE rewards ADD COLUMN repetition TEXT NOT NULL DEFAULT 'queue';`);
    db.exec(`ALTER TABLE rewards ADD COLUMN last_fired_at INTEGER;`);
    // Se descarta el cooldown por usuario (no hay datos que preservar de esa
    // columna: deja de existir el concepto).
    db.exec(`ALTER TABLE rewards DROP COLUMN user_cooldown_sec;`);
  },
  // Rework de superposición (Parte B, B4): marca de "solo audio" en los clips.
  // Los clips de solo audio pueden usarse en modo overlap y se reproducen sin
  // imagen en modo cola.
  (db) => {
    db.exec(`ALTER TABLE clips ADD COLUMN audio_only INTEGER NOT NULL DEFAULT 0;`);
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