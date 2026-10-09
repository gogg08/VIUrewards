/**
 * Tabla `redemptions`: ciclo de vida de cada canje de recompensa (Fase 4B).
 *
 * Cada fila sigue a un canje desde que se recibe hasta que se resuelve (aceptado
 * o rechazado en la plataforma) o se descarta. El estado se modela de forma
 * explícita en `src/redemptions/state.ts` y siempre es visible en el dashboard.
 */

import type { SqliteDatabase } from "./database.ts";

export interface RedemptionRecord {
  platform: string;
  eventId: string;
  rewardId: string | null;
  rewardTitle: string | null;
  userId: string | null;
  userName: string | null;
  userInput: string | null;
  status: string;
  reason: string | null;
  /** Evento normalizado serializado, para reprocesar un canje viejo. */
  eventJson: string;
  redeemedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RedemptionRow {
  platform: string;
  event_id: string;
  reward_id: string | null;
  reward_title: string | null;
  user_id: string | null;
  user_name: string | null;
  user_input: string | null;
  status: string;
  reason: string | null;
  event_json: string;
  redeemed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: RedemptionRow): RedemptionRecord {
  return {
    platform: row.platform,
    eventId: row.event_id,
    rewardId: row.reward_id,
    rewardTitle: row.reward_title,
    userId: row.user_id,
    userName: row.user_name,
    userInput: row.user_input,
    status: row.status,
    reason: row.reason,
    eventJson: row.event_json,
    redeemedAt: row.redeemed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertRedemption(db: SqliteDatabase, record: RedemptionRecord): void {
  db.prepare(
    `INSERT INTO redemptions
       (platform, event_id, reward_id, reward_title, user_id, user_name, user_input,
        status, reason, event_json, redeemed_at, created_at, updated_at)
     VALUES
       (@platform, @eventId, @rewardId, @rewardTitle, @userId, @userName, @userInput,
        @status, @reason, @eventJson, @redeemedAt, @createdAt, @updatedAt)`,
  ).run(record);
}

export function getRedemption(db: SqliteDatabase, platform: string, eventId: string): RedemptionRecord | null {
  const row = db
    .prepare<RedemptionRow>("SELECT * FROM redemptions WHERE platform = ? AND event_id = ?")
    .get(platform, eventId);
  return row ? toRecord(row) : null;
}

/** Actualiza el estado y el motivo. Devuelve `false` si el canje no existe. */
export function updateRedemptionStatus(
  db: SqliteDatabase,
  platform: string,
  eventId: string,
  status: string,
  reason: string | null,
  updatedAt: string = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `UPDATE redemptions SET status = @status, reason = @reason, updated_at = @updatedAt
       WHERE platform = @platform AND event_id = @eventId`,
    )
    .run({ platform, eventId, status, reason, updatedAt });
  return result.changes > 0;
}

export function listRedemptions(
  db: SqliteDatabase,
  options: { status?: string; platform?: string; limit?: number } = {},
): RedemptionRecord[] {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.platform) {
    clauses.push("platform = ?");
    params.push(options.platform);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare<RedemptionRow>(`SELECT * FROM redemptions ${where} ORDER BY created_at DESC, event_id DESC LIMIT ?`)
    .all(...params, limit);
  return rows.map(toRecord);
}

export function countRedemptions(db: SqliteDatabase, status: string): number {
  const row = db
    .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM redemptions WHERE status = ?")
    .get(status);
  return row?.count ?? 0;
}