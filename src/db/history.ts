/**
 * Tabla `event_history`: historial de eventos procesados por el motor (Fase 4A).
 *
 * Guarda qué regla disparó (si alguna), el resultado y el motivo cuando no
 * disparó (por ejemplo "cooldown" o "sin permiso"). Se limpia por cantidad y por
 * antigüedad para no crecer sin control.
 */

import type { SqliteDatabase } from "./database.ts";

export interface EventHistoryEntry {
  eventId: string;
  platform: string;
  type: string;
  userId: string;
  userName: string;
  payloadJson: string;
  eventTs: number;
  ruleId: string | null;
  /** "fired" | "skipped" | "error" | "no_match" | "duplicate". */
  outcome: string;
  reason: string | null;
  createdAt: string;
}

export interface EventHistoryRecord extends EventHistoryEntry {
  id: number;
}

interface HistoryRow {
  id: number;
  event_id: string;
  platform: string;
  type: string;
  user_id: string;
  user_name: string;
  payload_json: string;
  event_ts: number;
  rule_id: string | null;
  outcome: string;
  reason: string | null;
  created_at: string;
}

function toRecord(row: HistoryRow): EventHistoryRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    platform: row.platform,
    type: row.type,
    userId: row.user_id,
    userName: row.user_name,
    payloadJson: row.payload_json,
    eventTs: row.event_ts,
    ruleId: row.rule_id,
    outcome: row.outcome,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function addHistory(
  db: SqliteDatabase,
  entry: EventHistoryEntry,
  maxEntries: number,
): EventHistoryRecord {
  const result = db
    .prepare(
      `INSERT INTO event_history
         (event_id, platform, type, user_id, user_name, payload_json, event_ts, rule_id, outcome, reason, created_at)
       VALUES
         (@eventId, @platform, @type, @userId, @userName, @payloadJson, @eventTs, @ruleId, @outcome, @reason, @createdAt)`,
    )
    .run(entry);
  const id = Number(result.lastInsertRowid);
  pruneHistory(db, maxEntries);
  return { ...entry, id };
}

export function listHistory(db: SqliteDatabase, limit = 200): EventHistoryRecord[] {
  const capped = Math.max(1, Math.min(limit, 1000));
  const rows = db
    .prepare<HistoryRow>("SELECT * FROM event_history ORDER BY id DESC LIMIT ?")
    .all(capped);
  return rows.map(toRecord);
}

/** Borra los registros más viejos, dejando a lo sumo `maxEntries`. */
export function pruneHistory(db: SqliteDatabase, maxEntries: number): number {
  const keep = Math.max(1, maxEntries);
  const row = db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM event_history").get();
  const total = row?.count ?? 0;
  if (total <= keep) return 0;
  const result = db
    .prepare(
      `DELETE FROM event_history
        WHERE id IN (SELECT id FROM event_history ORDER BY id ASC LIMIT ?)`,
    )
    .run(total - keep);
  return result.changes;
}

/** Borra registros más viejos que `maxAgeMs`. Devuelve cuántos borró. */
export function pruneHistoryByAge(
  db: SqliteDatabase,
  maxAgeMs: number,
  now: number = Date.now(),
): number {
  const cutoff = new Date(now - Math.max(0, maxAgeMs)).toISOString();
  const result = db.prepare("DELETE FROM event_history WHERE created_at < ?").run(cutoff);
  return result.changes;
}
