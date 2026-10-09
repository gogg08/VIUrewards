/**
 * Eventos de plataforma ya procesados, para idempotencia persistente (Fase 4B).
 *
 * Los canjes llegan por polling y un reinicio no debe volver a dispararlos. Se
 * guarda `(platform, event_id)`; el motor también recuerda ids en memoria, pero
 * eso se pierde al reiniciar.
 */

import type { SqliteDatabase } from "./database.ts";

export function hasProcessedEvent(db: SqliteDatabase, platform: string, eventId: string): boolean {
  const row = db
    .prepare<{ one: number }>(
      "SELECT 1 AS one FROM processed_events WHERE platform = ? AND event_id = ? LIMIT 1",
    )
    .get(platform, eventId);
  return row !== undefined;
}

export function markEventProcessed(
  db: SqliteDatabase,
  platform: string,
  eventId: string,
  createdAt: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO processed_events (platform, event_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(platform, event_id) DO NOTHING`,
  ).run(platform, eventId, createdAt);
}

export function forgetProcessedEvent(db: SqliteDatabase, platform: string, eventId: string): void {
  db.prepare("DELETE FROM processed_events WHERE platform = ? AND event_id = ?").run(platform, eventId);
}

/** Borra los registros más viejos que `maxAgeMs`, para que la tabla no crezca sin control. */
export function pruneProcessedEvents(
  db: SqliteDatabase,
  maxAgeMs: number,
  now: number = Date.now(),
): number {
  const cutoff = new Date(now - Math.max(0, maxAgeMs)).toISOString();
  const result = db.prepare("DELETE FROM processed_events WHERE created_at < ?").run(cutoff);
  return result.changes;
}

/** Recompensas que creó esta app (Kick solo deja editar/borrar las propias). */
export function markRewardManaged(
  db: SqliteDatabase,
  platform: string,
  rewardId: string,
  createdAt: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO platform_managed_rewards (platform, reward_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(platform, reward_id) DO NOTHING`,
  ).run(platform, rewardId, createdAt);
}

export function unmarkRewardManaged(db: SqliteDatabase, platform: string, rewardId: string): void {
  db.prepare("DELETE FROM platform_managed_rewards WHERE platform = ? AND reward_id = ?").run(platform, rewardId);
}

export function listManagedRewards(db: SqliteDatabase, platform: string): string[] {
  const rows = db
    .prepare<{ reward_id: string }>("SELECT reward_id FROM platform_managed_rewards WHERE platform = ?")
    .all(platform);
  return rows.map((row) => row.reward_id);
}