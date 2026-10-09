/**
 * Tabla `proposals`: propuestas de URL hechas por el público (Fase 4A).
 *
 * Cada fila es una URL propuesta que pasa por la cola de moderación antes de
 * descargarse. El estado se modela de forma explícita (ver moderation/state.ts).
 */

import type { SqliteDatabase } from "./database.ts";

export interface ProposalRecord {
  id: string;
  platform: string;
  userId: string;
  userName: string;
  /** URL normalizada (ya validada antes de llegar acá). */
  url: string;
  /** Id del evento de origen (permite resolver un canje pendiente). */
  eventId: string;
  status: string;
  reason: string | null;
  clipId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalRow {
  id: string;
  platform: string;
  user_id: string;
  user_name: string;
  url: string;
  event_id: string;
  status: string;
  reason: string | null;
  clip_id: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    platform: row.platform,
    userId: row.user_id,
    userName: row.user_name,
    url: row.url,
    eventId: row.event_id,
    status: row.status,
    reason: row.reason,
    clipId: row.clip_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertProposal(db: SqliteDatabase, proposal: ProposalRecord): void {
  db.prepare(
    `INSERT INTO proposals
       (id, platform, user_id, user_name, url, event_id, status, reason, clip_id, created_at, updated_at)
     VALUES
       (@id, @platform, @userId, @userName, @url, @eventId, @status, @reason, @clipId, @createdAt, @updatedAt)`,
  ).run(proposal);
}

export function getProposal(db: SqliteDatabase, id: string): ProposalRecord | null {
  const row = db.prepare<ProposalRow>("SELECT * FROM proposals WHERE id = ?").get(id);
  return row ? toRecord(row) : null;
}

export function listProposals(
  db: SqliteDatabase,
  options: { status?: string; limit?: number } = {},
): ProposalRecord[] {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  if (options.status) {
    const rows = db
      .prepare<ProposalRow>(
        "SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(options.status, limit);
    return rows.map(toRecord);
  }
  const rows = db
    .prepare<ProposalRow>("SELECT * FROM proposals ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit);
  return rows.map(toRecord);
}

export interface ProposalPatch {
  reason?: string | null;
  clipId?: string | null;
}

/** Actualiza el estado. Devuelve `false` si la propuesta no existe. */
export function updateProposalStatus(
  db: SqliteDatabase,
  id: string,
  status: string,
  patch: ProposalPatch = {},
  updatedAt: string = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      `UPDATE proposals
         SET status = @status,
             reason = CASE WHEN @hasReason = 1 THEN @reason ELSE reason END,
             clip_id = CASE WHEN @hasClip = 1 THEN @clipId ELSE clip_id END,
             updated_at = @updatedAt
       WHERE id = @id`,
    )
    .run({
      id,
      status,
      reason: patch.reason ?? null,
      clipId: patch.clipId ?? null,
      hasReason: patch.reason !== undefined ? 1 : 0,
      hasClip: patch.clipId !== undefined ? 1 : 0,
      updatedAt,
    });
  return result.changes > 0;
}

/** ¿Ya hay una propuesta pendiente con esta URL? (deduplicación) */
export function findPendingProposalByUrl(db: SqliteDatabase, url: string): ProposalRecord | null {
  const row = db
    .prepare<ProposalRow>("SELECT * FROM proposals WHERE url = ? AND status = 'pending' LIMIT 1")
    .get(url);
  return row ? toRecord(row) : null;
}

/** Cuenta propuestas pendientes; si se pasa `userId`, solo las de ese usuario. */
export function countPendingProposals(db: SqliteDatabase, userId?: string): number {
  if (userId !== undefined) {
    const row = db
      .prepare<{ count: number }>(
        "SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending' AND user_id = ?",
      )
      .get(userId);
    return row?.count ?? 0;
  }
  const row = db
    .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM proposals WHERE status = 'pending'")
    .get();
  return row?.count ?? 0;
}
