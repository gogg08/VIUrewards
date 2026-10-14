/**
 * Servicio de recompensas (rediseño, Etapa 4A).
 *
 * Une el modelo local (tabla `rewards`) con la lista de la plataforma para armar
 * la **vista unificada**, y ejecuta cada operación (crear, editar, activar,
 * desactivar, borrar, recrear, quitar) con su manejo de fallos explícito: ningún
 * estado queda invisible.
 *
 * Es genérico: solo conoce `PlatformIntegration` (AGENTS.md: aislamiento). La
 * regla interna de cada recompensa se mantiene 1:1 y el creador nunca la ve.
 *
 * Decisiones:
 *  - Título, costo, color y descripción los manda la plataforma (se espejan en la
 *    fila local para poder mostrarlos sin conexión). El clip y las opciones de
 *    reproducción son solo locales.
 *  - `desiredEnabled` es la intención del creador; cuando hay conexión, el estado
 *    mostrado sale de la plataforma.
 *  - La regla interna se crea con `enabled = desiredEnabled`: así un canje de una
 *    recompensa desactivada localmente se trata como omitido según la política.
 */

import { randomUUID } from "node:crypto";

import {
  deleteReward,
  deleteRule,
  getClip,
  getReward,
  getRuleRecord,
  listRewardsForPlatform,
  setRewardError,
  upsertReward,
  upsertRule,
  type RewardRecord,
  type RuleRecord,
  type SqliteDatabase,
} from "../db/index.ts";
import type { PlatformIntegration, RewardInput, RewardView } from "../platforms/integration.ts";
import type { PlayClipActionConfig } from "../rules/index.ts";
import { ANIMATION_NAMES, normalizeRewardInput, type AnimationName } from "./validate.ts";
import { resolveAudioOnly } from "./audio-only.ts";
import type {
  RewardCreateInput,
  RewardListItem,
  RewardOperationResult,
  RewardPendingResult,
  RewardState,
  RewardUpdateInput,
  RewardsSnapshot,
} from "./types.ts";

export interface RewardServiceOptions {
  db: SqliteDatabase;
  integration: PlatformIntegration;
  /** Se llama cuando cambia el conjunto de reglas (el motor debe recargarlas). */
  onRulesChanged?: () => void;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface PendingOptions {
  /** El usuario ya confirmó rechazar los pendientes. */
  confirm?: boolean;
  /** Deshabilitar/borrar igual aunque queden rechazos fallidos. */
  force?: boolean;
}

function fail<T>(reason: string, message: string): { ok: false; reason: string; message: string } {
  return { ok: false, reason, message };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "error desconocido";
}

/**
 * Una recompensa importada por la migración arranca con datos provisorios y todavía
 * no sincronizados con la plataforma. Editar eso mandaría datos falsos a la API, así
 * que se bloquea hasta que la plataforma responda (el listado la marca `synced: true`).
 */
const NOT_SYNCED_MESSAGE =
  "Los datos de esta recompensa todavía no se sincronizaron con la plataforma. Esperá a que responda y volvé a intentar.";

function animationOrNull(value: string | null): AnimationName | undefined {
  return value !== null && (ANIMATION_NAMES as readonly string[]).includes(value)
    ? (value as AnimationName)
    : undefined;
}

export class RewardService {
  private readonly db: SqliteDatabase;
  private readonly integration: PlatformIntegration;
  private readonly onRulesChanged?: () => void;
  private readonly now: () => number;
  private readonly logger?: (message: string) => void;

  constructor(options: RewardServiceOptions) {
    this.db = options.db;
    this.integration = options.integration;
    this.onRulesChanged = options.onRulesChanged;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  private get platform(): string {
    return this.integration.platform;
  }

  private isConnected(): boolean {
    return this.integration.status().state === "connected";
  }

  /** ¿El clip tiene imagen? Sin clip o sin dato se asume que sí. */
  private clipHasVideo(clipId: string | null): boolean {
    if (!clipId) return true;
    const clip = getClip(this.db, clipId);
    return clip ? clip.hasVideo : true;
  }

  /** Valor efectivo de "solo audio" para una fila (overlap y clips sin imagen fuerzan). */
  private effectiveAudioOnly(reward: RewardRecord): boolean {
    return resolveAudioOnly({
      repetition: reward.repetition,
      requested: reward.audioOnly,
      clipHasVideo: this.clipHasVideo(reward.clipId),
    }).value;
  }

  // --- Vista unificada -------------------------------------------------------

  /** Combina las filas locales con la lista de la plataforma y calcula el estado. */
  async list(): Promise<RewardsSnapshot> {
    const status = this.integration.status();
    const locals = listRewardsForPlatform(this.db, this.platform);
    const remote = await this.integration.listRewards();

    if (!remote.ok) {
      return {
        platformState: status.state,
        connected: false,
        offline: true,
        message: remote.message,
        rewards: locals.map((local) => this.toItem(local, null, { offline: true })),
      };
    }

    const byRemote = new Map(remote.value.map((reward) => [reward.id, reward]));
    const seen = new Set<string>();
    const rewards: RewardListItem[] = [];

    for (const local of locals) {
      const remoteReward = local.remoteRewardId ? byRemote.get(local.remoteRewardId) : undefined;
      if (remoteReward) {
        seen.add(remoteReward.id);
        rewards.push(this.toItem(this.cacheRemote(local, remoteReward), remoteReward, {}));
      } else {
        rewards.push(this.toItem(local, null, { missing: true }));
      }
    }

    for (const remoteReward of remote.value) {
      if (seen.has(remoteReward.id)) continue;
      rewards.push(this.toForeignItem(remoteReward));
    }

    return {
      platformState: status.state,
      connected: true,
      offline: false,
      message: null,
      rewards,
    };
  }

  // --- Operaciones -----------------------------------------------------------

  async create(input: RewardCreateInput): Promise<RewardOperationResult<RewardListItem>> {
    const validation = normalizeRewardInput(input);
    if (!validation.ok) return fail("INVALID", validation.message);
    const fields = validation.value;
    if (fields.title === undefined || fields.cost === undefined) {
      return fail("INVALID", "El título y el costo son obligatorios.");
    }
    if (fields.clipId === undefined) return fail("INVALID", "Elegí un clip de la biblioteca.");
    if (!getClip(this.db, fields.clipId)) return fail("CLIP_NOT_FOUND", "El clip elegido no existe.");
    if (!this.isConnected()) return fail("NOT_LINKED", "Vinculá tu cuenta para crear recompensas.");

    const enabled = fields.enabled ?? true;
    const remote = await this.integration.createReward({
      title: fields.title,
      cost: fields.cost,
      description: fields.description ?? "",
      color: fields.color,
      enabled,
      // Esta app no pide texto al espectador: se envía explícitamente en falso.
      userInputRequired: false,
      skipRequestQueue: false,
    });
    if (!remote.ok) return fail(remote.reason, remote.message);

    const now = new Date(this.now()).toISOString();
    const ruleId = randomUUID();
    const record: RewardRecord = {
      id: randomUUID(),
      platform: this.platform,
      remoteRewardId: remote.value.id,
      title: remote.value.title,
      cost: remote.value.cost,
      color: remote.value.color,
      description: remote.value.description,
      clipId: fields.clipId,
      volume: fields.volume ?? 1,
      maxDurationSec: fields.maxDurationSec ?? null,
      cooldownSec: fields.cooldownSec ?? 0,
      repetition: fields.repetition ?? "queue",
      audioOnly: resolveAudioOnly({
        repetition: fields.repetition ?? "queue",
        requested: fields.audioOnly ?? false,
        clipHasVideo: this.clipHasVideo(fields.clipId),
      }).value,
      lastFiredAt: null,
      position: fields.position ?? null,
      enterAnimation: fields.enterAnimation ?? null,
      exitAnimation: fields.exitAnimation ?? null,
      desiredEnabled: enabled,
      managed: true,
      synced: true,
      ruleId,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      this.db.transaction(() => {
        upsertReward(this.db, record);
        upsertRule(this.db, this.buildRule(ruleId, remote.value.id, record, now, now));
      })();
    } catch (error) {
      const message = describe(error);
      this.logger?.(`rewards: no se pudo guardar la recompensa localmente (${message})`);
      const compensation = await this.integration.deleteReward(remote.value.id);
      if (!compensation.ok) {
        this.logger?.(
          `rewards: quedó una recompensa huérfana en la plataforma (${remote.value.id}); no se pudo borrar`,
        );
        return fail(
          "PARTIAL",
          "Se creó la recompensa en la plataforma pero no se pudo guardar localmente ni deshacerla. Eliminala a mano en Kick.",
        );
      }
      return fail("LOCAL_FAILED", `No se pudo guardar la recompensa: ${message}`);
    }

    this.onRulesChanged?.();
    return { ok: true, value: this.toItem(record, remote.value, {}) };
  }

  async update(localId: string, input: RewardUpdateInput): Promise<RewardOperationResult<RewardListItem>> {
    const local = getReward(this.db, localId);
    if (!local) return fail("NOT_FOUND", "La recompensa no existe.");
    if (!local.synced) return fail("NOT_SYNCED", NOT_SYNCED_MESSAGE);

    const validation = normalizeRewardInput(input);
    if (!validation.ok) return fail("INVALID", validation.message);
    const fields = validation.value;

    // Campos que manda la plataforma. Si fallan, no se toca nada local.
    const remoteInput: Partial<RewardInput> = {};
    if (fields.title !== undefined) remoteInput.title = fields.title;
    if (fields.cost !== undefined) remoteInput.cost = fields.cost;
    if (fields.description !== undefined) remoteInput.description = fields.description;
    if (fields.color !== undefined) remoteInput.color = fields.color;

    let remote: RewardView | null = null;
    if (Object.keys(remoteInput).length > 0) {
      if (!local.remoteRewardId) {
        return fail("MISSING", "La recompensa no está en la plataforma. Recreala primero.");
      }
      if (!this.isConnected()) return fail("NOT_LINKED", "Vinculá tu cuenta para editar recompensas.");
      const result = await this.integration.updateReward(local.remoteRewardId, remoteInput);
      if (!result.ok) return fail(result.reason, result.message);
      remote = result.value;
    }

    if (fields.clipId !== undefined && !getClip(this.db, fields.clipId)) {
      return fail("CLIP_NOT_FOUND", "El clip elegido no existe.");
    }

    const merged: RewardRecord = { ...local };
    if (fields.title !== undefined) merged.title = fields.title;
    if (fields.cost !== undefined) merged.cost = fields.cost;
    if (fields.description !== undefined) merged.description = fields.description;
    if (fields.color !== undefined) merged.color = fields.color;
    if (fields.clipId !== undefined) merged.clipId = fields.clipId;
    if (fields.volume !== undefined) merged.volume = fields.volume;
    if (fields.maxDurationSec !== undefined) merged.maxDurationSec = fields.maxDurationSec;
    if (fields.cooldownSec !== undefined) merged.cooldownSec = fields.cooldownSec;
    if (fields.repetition !== undefined) merged.repetition = fields.repetition;
    if (fields.audioOnly !== undefined) merged.audioOnly = fields.audioOnly;
    if (fields.position !== undefined) merged.position = fields.position;
    if (fields.enterAnimation !== undefined) merged.enterAnimation = fields.enterAnimation;
    if (fields.exitAnimation !== undefined) merged.exitAnimation = fields.exitAnimation;
    // "Solo audio" se recalcula: overlap y clips sin imagen lo fuerzan.
    merged.audioOnly = this.effectiveAudioOnly(merged);
    merged.lastError = null;

    return this.persist(merged, remote, "No se pudo guardar la recompensa");
  }

  async enable(localId: string): Promise<RewardOperationResult<RewardListItem>> {
    const local = getReward(this.db, localId);
    if (!local) return fail("NOT_FOUND", "La recompensa no existe.");
    if (!local.synced) return fail("NOT_SYNCED", NOT_SYNCED_MESSAGE);
    if (!local.remoteRewardId) return fail("MISSING", "La recompensa no está en la plataforma.");
    if (!this.isConnected()) return fail("NOT_LINKED", "Vinculá tu cuenta para activar recompensas.");

    const result = await this.integration.updateReward(local.remoteRewardId, { enabled: true });
    if (!result.ok) {
      setRewardError(this.db, localId, result.message);
      return fail(result.reason, result.message);
    }
    return this.persist({ ...local, desiredEnabled: true, lastError: null }, result.value, "No se pudo activar la recompensa");
  }

  async disable(localId: string, options: PendingOptions = {}): Promise<RewardPendingResult> {
    const local = getReward(this.db, localId);
    if (!local) return { ok: false, reason: "NOT_FOUND", message: "La recompensa no existe." };
    if (!local.synced) return { ok: false, reason: "NOT_SYNCED", message: NOT_SYNCED_MESSAGE };
    if (!local.remoteRewardId) return { ok: false, reason: "MISSING", message: "La recompensa no está en la plataforma." };
    if (!this.isConnected()) return { ok: false, reason: "NOT_LINKED", message: "Vinculá tu cuenta para desactivar recompensas." };

    const pending = await this.integration.listPendingRedemptions(local.remoteRewardId);
    if (!pending.ok) return { ok: false, reason: pending.reason, message: pending.message };
    if (pending.value.length > 0 && !options.confirm) {
      return {
        ok: false,
        needsConfirm: true,
        pending: pending.value.length,
        message: `Se rechazarán ${pending.value.length} canje(s) pendiente(s).`,
      };
    }

    const rejection = await this.rejectPending(pending.value);
    if (!rejection.ok) return rejection.result;
    if (rejection.failed.length > 0 && !options.force) {
      return {
        ok: false,
        reason: "REJECT_FAILED",
        failed: rejection.failed,
        message: "No se pudieron rechazar algunos canjes. No se deshabilitó.",
      };
    }

    const result = await this.integration.updateReward(local.remoteRewardId, { enabled: false });
    if (!result.ok) {
      setRewardError(this.db, localId, result.message);
      return { ok: false, reason: result.reason, message: result.message };
    }

    const warning = await this.sweepRemaining(local.remoteRewardId, rejection.failed.length > 0);
    const saved = await this.persist({ ...local, desiredEnabled: false, lastError: warning }, result.value, "No se pudo deshabilitar la recompensa");
    if (!saved.ok) return { ok: false, reason: saved.reason, message: saved.message };
    return { ok: true, reward: saved.value, warning };
  }

  async remove(localId: string, options: PendingOptions = {}): Promise<RewardPendingResult> {
    const local = getReward(this.db, localId);
    if (!local) return { ok: false, reason: "NOT_FOUND", message: "La recompensa no existe." };

    if (local.remoteRewardId && this.isConnected()) {
      const pending = await this.integration.listPendingRedemptions(local.remoteRewardId);
      if (!pending.ok) return { ok: false, reason: pending.reason, message: pending.message };
      if (pending.value.length > 0 && !options.confirm) {
        return {
          ok: false,
          needsConfirm: true,
          pending: pending.value.length,
          message: `Se rechazarán ${pending.value.length} canje(s) pendiente(s) antes de borrar.`,
        };
      }
      const rejection = await this.rejectPending(pending.value);
      if (!rejection.ok) return rejection.result;
      if (rejection.failed.length > 0 && !options.force) {
        return {
          ok: false,
          reason: "REJECT_FAILED",
          failed: rejection.failed,
          message: "No se pudieron rechazar algunos canjes. No se borró la recompensa.",
        };
      }
    }

    // Borrar en la plataforma solo si la administra esta app.
    if (local.remoteRewardId && local.managed) {
      const deleted = await this.integration.deleteReward(local.remoteRewardId);
      if (!deleted.ok) {
        setRewardError(this.db, localId, deleted.message);
        return { ok: false, reason: deleted.reason, message: deleted.message };
      }
    }

    this.db.transaction(() => {
      if (local.ruleId) deleteRule(this.db, local.ruleId);
      deleteReward(this.db, localId);
    })();
    this.onRulesChanged?.();
    return { ok: true };
  }

  /** Recrea en la plataforma una recompensa que "Falta en Kick". */
  async recreate(localId: string): Promise<RewardOperationResult<RewardListItem>> {
    const local = getReward(this.db, localId);
    if (!local) return fail("NOT_FOUND", "La recompensa no existe.");
    if (!local.synced) return fail("NOT_SYNCED", NOT_SYNCED_MESSAGE);
    if (!this.isConnected()) return fail("NOT_LINKED", "Vinculá tu cuenta para recrear recompensas.");
    if (!local.clipId) return fail("NO_CLIP", "Elegí un clip antes de recrear la recompensa.");

    const created = await this.integration.createReward({
      title: local.title,
      cost: local.cost,
      description: local.description,
      color: local.color,
      enabled: local.desiredEnabled,
      userInputRequired: false,
      skipRequestQueue: false,
    });
    if (!created.ok) {
      setRewardError(this.db, localId, created.message);
      return fail(created.reason, created.message);
    }

    const merged: RewardRecord = { ...local, remoteRewardId: created.value.id, synced: true, lastError: null };
    return this.persist(merged, created.value, "No se pudo recrear la recompensa");
  }

  /** Quita la recompensa de esta app sin tocar la plataforma. */
  async detach(localId: string): Promise<RewardOperationResult<{ id: string }>> {
    const local = getReward(this.db, localId);
    if (!local) return fail("NOT_FOUND", "La recompensa no existe.");
    this.db.transaction(() => {
      if (local.ruleId) deleteRule(this.db, local.ruleId);
      deleteReward(this.db, localId);
    })();
    this.onRulesChanged?.();
    return { ok: true, value: { id: localId } };
  }

  /** Cantidad de canjes pendientes de una recompensa (para la confirmación). */
  async pendingCount(localId: string): Promise<RewardOperationResult<number>> {
    const local = getReward(this.db, localId);
    if (!local) return fail("NOT_FOUND", "La recompensa no existe.");
    if (!local.remoteRewardId) return fail("MISSING", "La recompensa no está en la plataforma.");
    const pending = await this.integration.listPendingRedemptions(local.remoteRewardId);
    if (!pending.ok) return fail(pending.reason, pending.message);
    return { ok: true, value: pending.value.length };
  }

  // --- Internos --------------------------------------------------------------

  private async persist(
    record: RewardRecord,
    remote: RewardView | null,
    errorContext: string,
  ): Promise<RewardOperationResult<RewardListItem>> {
    const now = new Date(this.now()).toISOString();
    const saved: RewardRecord = { ...record, updatedAt: now };
    try {
      this.db.transaction(() => {
        upsertReward(this.db, saved);
        this.syncRule(saved, now);
      })();
    } catch (error) {
      return fail("LOCAL_FAILED", `${errorContext}: ${describe(error)}`);
    }
    this.onRulesChanged?.();
    return { ok: true, value: this.toItem(saved, remote, {}) };
  }

  private async rejectPending(
    ids: string[],
  ): Promise<
    | { ok: true; failed: Array<{ id: string; reason: string }> }
    | { ok: false; result: RewardPendingResult }
  > {
    if (ids.length === 0) return { ok: true, failed: [] };
    const rejection = await this.integration.rejectRedemptions(ids);
    if (!rejection.ok) {
      return { ok: false, result: { ok: false, reason: rejection.reason, message: rejection.message } };
    }
    const failed = rejection.value
      .filter((failure) => !failure.benign)
      .map((failure) => ({ id: failure.id, reason: failure.reason }));
    return { ok: true, failed };
  }

  /** Tras deshabilitar, revisa una vez más si se coló algún pendiente. */
  private async sweepRemaining(remoteRewardId: string, hadFailures: boolean): Promise<string | null> {
    const again = await this.integration.listPendingRedemptions(remoteRewardId);
    if (!again.ok) return hadFailures ? "Quedaron canjes pendientes que no se pudieron rechazar." : null;
    if (again.value.length === 0) return hadFailures ? "Algunos canjes no se pudieron rechazar." : null;
    const second = await this.integration.rejectRedemptions(again.value);
    const stillFailed = !second.ok || second.value.some((failure) => !failure.benign);
    if (stillFailed) return "Quedaron canjes pendientes que no se pudieron rechazar.";
    return hadFailures ? "Algunos canjes no se pudieron rechazar." : null;
  }

  /** Espeja en la fila local los campos que manda la plataforma y la marca sincronizada. */
  private cacheRemote(local: RewardRecord, remote: RewardView): RewardRecord {
    if (
      local.synced &&
      local.title === remote.title &&
      local.cost === remote.cost &&
      local.color === remote.color &&
      local.description === remote.description &&
      local.remoteRewardId === remote.id
    ) {
      return local;
    }
    const updated: RewardRecord = {
      ...local,
      remoteRewardId: remote.id,
      title: remote.title,
      cost: remote.cost,
      color: remote.color,
      description: remote.description,
      synced: true,
      updatedAt: new Date(this.now()).toISOString(),
    };
    upsertReward(this.db, updated);
    return updated;
  }

  private syncRule(local: RewardRecord, now: string): void {
    if (!local.ruleId) return;
    const existing = getRuleRecord(this.db, local.ruleId);
    upsertRule(this.db, this.buildRule(local.ruleId, local.remoteRewardId, local, existing?.createdAt ?? now, now));
  }

  private buildRule(
    ruleId: string,
    remoteRewardId: string | null,
    local: RewardRecord,
    createdAt: string,
    updatedAt: string,
  ): RuleRecord {
    const action: PlayClipActionConfig = { kind: "play_clip", clipId: local.clipId ?? "", volume: local.volume, label: local.title };
    if (local.maxDurationSec !== null) action.maxDurationSec = local.maxDurationSec;
    if (local.position) action.position = local.position;
    if (this.effectiveAudioOnly(local)) action.audioOnly = true;
    // El recorte es del clip (no destructivo): se refleja en la acción para que la
    // alerta lo respete igual que "Probar alerta".
    const clip = local.clipId ? getClip(this.db, local.clipId) : null;
    if (clip?.trimStart !== null && clip?.trimStart !== undefined) action.trimStart = clip.trimStart;
    if (clip?.trimEnd !== null && clip?.trimEnd !== undefined) action.trimEnd = clip.trimEnd;
    const enter = animationOrNull(local.enterAnimation);
    if (enter) action.enterAnimation = enter;
    const exit = animationOrNull(local.exitAnimation);
    if (exit) action.exitAnimation = exit;

    return {
      id: ruleId,
      name: `Recompensa: ${local.title}`.slice(0, 100),
      enabled: local.desiredEnabled,
      trigger: { type: "reward_redeemed", rewardId: remoteRewardId ?? "" },
      conditions: { permission: "everyone" },
      action,
      createdAt,
      updatedAt,
    };
  }

  private toItem(
    local: RewardRecord,
    remote: RewardView | null,
    flags: { offline?: boolean; missing?: boolean },
  ): RewardListItem {
    let state: RewardState;
    if (flags.offline) state = "offline";
    else if (local.lastError) state = "apply_failed";
    else if (flags.missing || !remote) state = "missing";
    else state = remote.enabled ? "enabled" : "disabled";

    return {
      id: local.id,
      localId: local.id,
      remoteId: local.remoteRewardId,
      title: remote ? remote.title : local.title,
      cost: remote ? remote.cost : local.cost,
      description: remote ? remote.description : local.description,
      color: remote ? remote.color : local.color,
      enabled: remote ? remote.enabled : local.desiredEnabled,
      managed: local.managed,
      userInputRequired: false,
      synced: local.synced,
      skipRequestQueue: false,
      clipId: local.clipId,
      clipTitle: local.clipId ? (getClip(this.db, local.clipId)?.title ?? null) : null,
      volume: local.volume,
      maxDurationSec: local.maxDurationSec,
      cooldownSec: local.cooldownSec,
      repetition: local.repetition,
      audioOnly: this.effectiveAudioOnly(local),
      position: local.position,
      enterAnimation: local.enterAnimation,
      exitAnimation: local.exitAnimation,
      state,
      error: local.lastError,
    };
  }

  private toForeignItem(remote: RewardView): RewardListItem {
    return {
      id: remote.id,
      localId: null,
      remoteId: remote.id,
      title: remote.title,
      cost: remote.cost,
      description: remote.description,
      color: remote.color,
      enabled: remote.enabled,
      managed: false,
      userInputRequired: remote.userInputRequired,
      skipRequestQueue: remote.skipRequestQueue,
      clipId: null,
      clipTitle: null,
      volume: 1,
      maxDurationSec: null,
      cooldownSec: 0,
      repetition: "queue",
      audioOnly: false,
      position: null,
      enterAnimation: null,
      exitAnimation: null,
      state: "foreign",
      error: null,
      synced: true,
    };
  }
}