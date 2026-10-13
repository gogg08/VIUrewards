/**
 * Tabla `rewards`: modelo local de recompensas del canal (rediseño, Etapa 4A;
 * rework de cooldown/superposición en la Parte B).
 *
 * Cada recompensa tiene un **id local propio y estable** (columna `id`) y, si está
 * vinculada, el id remoto de la plataforma (`remote_reward_id`, reemplazable). El
 * resto de los campos son opciones de esta app: el clip y sus parámetros de
 * reproducción viven solo acá. El título, costo, color y descripción son un
 * espejo de lo que dice la plataforma, para poder mostrarlos sin conexión.
 *
 * Cooldown: solo GLOBAL, persistido en `last_fired_at` (ms desde epoch), así
 * sobrevive a reinicios. `repetition` es "queue" (esperar turno) u "overlap".
 *
 * Es genérico: no menciona ninguna plataforma (AGENTS.md: aislamiento).
 */

import type { SqliteDatabase } from "./database.ts";

/** Modo de repetición de una recompensa. */
export type RewardRepetition = "queue" | "overlap";

/** ¿El valor es un modo de repetición válido? */
export function isRewardRepetition(value: unknown): value is RewardRepetition {
  return value === "queue" || value === "overlap";
}

export interface RewardRecord {
  /** Id local, estable durante toda la vida de la recompensa. */
  id: string;
  platform: string;
  /** Id remoto de la plataforma; `null` si todavía no está vinculada ("Falta en Kick"). */
  remoteRewardId: string | null;
  title: string;
  cost: number;
  color: string;
  description: string;
  clipId: string | null;
  /** Volumen de 0 a 1. */
  volume: number;
  /** Duración máxima en segundos; `null` = sin límite propio. */
  maxDurationSec: number | null;
  /** Cooldown global de la recompensa, en segundos (0 = sin cooldown). */
  cooldownSec: number;
  /** "queue" (esperar turno) u "overlap" (superponer audios). */
  repetition: RewardRepetition;
  /** Momento (ms) en que la alerta se disparó por última vez; `null` si nunca. */
  lastFiredAt: number | null;
  /** Posición en el overlay (fracciones 0..1) o `null` (centro por defecto). */
  position: { x: number; y: number } | null;
  enterAnimation: string | null;
  exitAnimation: string | null;
  /** Estado deseado por el creador (activa o no). */
  desiredEnabled: boolean;
  /** ¿La creó esta app? Solo esas se pueden editar o borrar en la plataforma. */
  managed: boolean;
  /**
   * ¿Los campos espejo (título, costo, color, descripción) ya se sincronizaron con
   * la plataforma? Las recompensas importadas por la migración v6 arrancan en
   * `false` (datos provisorios) y no se pueden editar hasta que la plataforma responda.
   */
  synced: boolean;
  /** Id de la regla interna 1:1 que dispara la alerta. */
  ruleId: string | null;
  /** Mensaje de la última operación que no se pudo aplicar (estado visible). */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RewardRow {
  id: string;
  platform: string;
  remote_reward_id: string | null;
  title: string;
  cost: number;
  color: string;
  description: string;
  clip_id: string | null;
  volume: number;
  max_duration_sec: number | null;
  cooldown_sec: number;
  repetition: string;
  last_fired_at: number | null;
  position_json: string | null;
  enter_animation: string | null;
  exit_animation: string | null;
  desired_enabled: number;
  managed: number;
  synced: number;
  rule_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function parsePosition(raw: string | null): { x: number; y: number } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof value.x === "number" && typeof value.y === "number") {
      return { x: value.x, y: value.y };
    }
    return null;
  } catch {
    return null;
  }
}

function parseRepetition(raw: string | null): RewardRepetition {
  return raw === "overlap" ? "overlap" : "queue";
}

function toRecord(row: RewardRow): RewardRecord {
  return {
    id: row.id,
    platform: row.platform,
    remoteRewardId: row.remote_reward_id,
    title: row.title,
    cost: row.cost,
    color: row.color,
    description: row.description,
    clipId: row.clip_id,
    volume: row.volume,
    maxDurationSec: row.max_duration_sec,
    cooldownSec: row.cooldown_sec,
    repetition: parseRepetition(row.repetition),
    lastFiredAt: row.last_fired_at,
    position: parsePosition(row.position_json),
    enterAnimation: row.enter_animation,
    exitAnimation: row.exit_animation,
    desiredEnabled: row.desired_enabled === 1,
    managed: row.managed === 1,
    synced: row.synced === 1,
    ruleId: row.rule_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serialize(reward: RewardRecord): Record<string, unknown> {
  return {
    id: reward.id,
    platform: reward.platform,
    remoteRewardId: reward.remoteRewardId,
    title: reward.title,
    cost: reward.cost,
    color: reward.color,
    description: reward.description,
    clipId: reward.clipId,
    volume: reward.volume,
    maxDurationSec: reward.maxDurationSec,
    cooldownSec: reward.cooldownSec,
    repetition: reward.repetition,
    lastFiredAt: reward.lastFiredAt,
    positionJson: reward.position ? JSON.stringify({ x: reward.position.x, y: reward.position.y }) : null,
    enterAnimation: reward.enterAnimation,
    exitAnimation: reward.exitAnimation,
    desiredEnabled: reward.desiredEnabled ? 1 : 0,
    managed: reward.managed ? 1 : 0,
    synced: reward.synced ? 1 : 0,
    ruleId: reward.ruleId,
    lastError: reward.lastError,
    createdAt: reward.createdAt,
    updatedAt: reward.updatedAt,
  };
}

const UPSERT_SQL = `INSERT INTO rewards
  (id, platform, remote_reward_id, title, cost, color, description, clip_id, volume,
   max_duration_sec, cooldown_sec, repetition, last_fired_at, position_json, enter_animation,
   exit_animation, desired_enabled, managed, synced, rule_id, last_error, created_at, updated_at)
 VALUES
  (@id, @platform, @remoteRewardId, @title, @cost, @color, @description, @clipId, @volume,
   @maxDurationSec, @cooldownSec, @repetition, @lastFiredAt, @positionJson, @enterAnimation,
   @exitAnimation, @desiredEnabled, @managed, @synced, @ruleId, @lastError, @createdAt, @updatedAt)
 ON CONFLICT(id) DO UPDATE SET
   remote_reward_id  = excluded.remote_reward_id,
   title             = excluded.title,
   cost              = excluded.cost,
   color             = excluded.color,
   description       = excluded.description,
   clip_id           = excluded.clip_id,
   volume            = excluded.volume,
   max_duration_sec  = excluded.max_duration_sec,
   cooldown_sec      = excluded.cooldown_sec,
   repetition        = excluded.repetition,
   position_json     = excluded.position_json,
   enter_animation   = excluded.enter_animation,
   exit_animation    = excluded.exit_animation,
   desired_enabled   = excluded.desired_enabled,
   managed           = excluded.managed,
   synced            = excluded.synced,
   rule_id           = excluded.rule_id,
   last_error        = excluded.last_error,
   updated_at        = excluded.updated_at`;

export function listRewardsForPlatform(db: SqliteDatabase, platform: string): RewardRecord[] {
  const rows = db
    .prepare<RewardRow>("SELECT * FROM rewards WHERE platform = ? ORDER BY created_at ASC, id ASC")
    .all(platform);
  return rows.map(toRecord);
}

export function getReward(db: SqliteDatabase, id: string): RewardRecord | null {
  const row = db.prepare<RewardRow>("SELECT * FROM rewards WHERE id = ?").get(id);
  return row ? toRecord(row) : null;
}

export function findRewardByRemoteId(
  db: SqliteDatabase,
  platform: string,
  remoteRewardId: string,
): RewardRecord | null {
  const row = db
    .prepare<RewardRow>("SELECT * FROM rewards WHERE platform = ? AND remote_reward_id = ?")
    .get(platform, remoteRewardId);
  return row ? toRecord(row) : null;
}

export function upsertReward(db: SqliteDatabase, reward: RewardRecord): void {
  db.prepare(UPSERT_SQL).run(serialize(reward));
}

export function deleteReward(db: SqliteDatabase, id: string): boolean {
  const result = db.prepare("DELETE FROM rewards WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Guarda un mensaje de error visible (o lo limpia con `null`). */
export function setRewardError(db: SqliteDatabase, id: string, error: string | null): void {
  db.prepare("UPDATE rewards SET last_error = ?, updated_at = ? WHERE id = ?").run(
    error,
    new Date().toISOString(),
    id,
  );
}

/**
 * Registra el último disparo de una recompensa (ms). Es la operación que hace
 * atómico el cooldown: se llama en el mismo tick que la decisión, sin `await`.
 */
export function setRewardLastFired(db: SqliteDatabase, id: string, at: number): void {
  db.prepare("UPDATE rewards SET last_fired_at = ? WHERE id = ?").run(at, id);
}

/** Recompensas que usan un clip dado (incluidas las desactivadas). */
export function listRewardsUsingClip(db: SqliteDatabase, clipId: string): RewardRecord[] {
  const rows = db
    .prepare<RewardRow>("SELECT * FROM rewards WHERE clip_id = ? ORDER BY created_at ASC, id ASC")
    .all(clipId);
  return rows.map(toRecord);
}

/** Recompensas en modo `overlap` que usan un clip dado (para validar "solo audio"). */
export function listOverlapRewardsUsingClip(db: SqliteDatabase, clipId: string): RewardRecord[] {
  return listRewardsUsingClip(db, clipId).filter((reward) => reward.repetition === "overlap");
}