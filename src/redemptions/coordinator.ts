/**
 * Coordinador del ciclo de vida de canjes (Fase 4B).
 *
 * Recibe cada canje normalizado, decide su tratamiento (canje viejo, sin regla,
 * regla que dispara) y registra cada transición en la tabla `redemptions`, que
 * es lo que ve el dashboard. Ningún estado queda invisible: la UI lee siempre de
 * esa tabla.
 *
 * Quién resuelve en la plataforma:
 *  - Acción `PlayClip`: acepta el canje al encolar la alerta (acción del motor).
 *  - Omitido / viejo rechazado: el coordinador llama a `resolve` en esos caminos.
 *
 * Políticas configurables (settings):
 *  - onSkip:    "leave_pending" (default) | "reject"
 *  - oldAction: "ignore" (default) | "reject" | "process"
 */

import {
  getRedemption,
  insertRedemption,
  listRedemptions,
  updateRedemptionStatus,
  type RedemptionRecord,
  type SqliteDatabase,
} from "../db/index.ts";
import type { NormalizedEvent, ResolveOutcome } from "../events/index.ts";
import { payloadRewardId } from "../events/index.ts";
import { canTransitionRedemption, type RedemptionStatus } from "./state.ts";

export type OnSkipPolicy = "leave_pending" | "reject";
export type OldAction = "ignore" | "reject" | "process";

export interface RedemptionPolicy {
  onSkip: OnSkipPolicy;
  oldMinutes: number;
  oldAction: OldAction;
}

/** Resultado que devuelve el procesamiento de un canje normal (el motor de reglas). */
export type ProcessOutcome =
  | { outcome: "fired" }
  | { outcome: "skipped"; reason?: string }
  | { outcome: "no_match"; reason?: string }
  | { outcome: "error"; reason?: string }
  | { outcome: "waiting"; reason?: string };

export interface RedemptionCoordinatorOptions {
  db: SqliteDatabase;
  policy: () => RedemptionPolicy;
  /** Resuelve el canje en la plataforma (accept/reject). */
  resolve: (event: NormalizedEvent, outcome: ResolveOutcome) => Promise<void>;
  /** Procesa un canje normal (lo entrega al motor de reglas) y reporta el resultado. */
  process: (event: NormalizedEvent) => Promise<ProcessOutcome>;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface ReceiveResult {
  status: RedemptionStatus;
  reason: string | null;
}

export class RedemptionCoordinator {
  private readonly db: SqliteDatabase;
  private readonly policy: () => RedemptionPolicy;
  private readonly resolve: RedemptionCoordinatorOptions["resolve"];
  private readonly process: RedemptionCoordinatorOptions["process"];
  private readonly now: () => number;
  private readonly logger?: (message: string) => void;

  constructor(options: RedemptionCoordinatorOptions) {
    this.db = options.db;
    this.policy = options.policy;
    this.resolve = options.resolve;
    this.process = options.process;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  /** Punto de entrada: un canje nuevo de cualquier fuente que soporte resolve. */
  async receive(event: NormalizedEvent): Promise<ReceiveResult> {
    const existing = getRedemption(this.db, event.platform, event.id);
    if (existing && existing.status !== "ignored") {
      return { status: existing.status as RedemptionStatus, reason: existing.reason };
    }

    if (!existing) {
      insertRedemption(this.db, this.toRecord(event, "received", null));
    } else {
      // Un canje omitido que vuelve a entrar (reprocesado) pasa por "received".
      this.transition(event.platform, event.id, "ignored", "received", "Reprocesado");
    }

    const policy = this.policy();
    const ageMinutes = (this.now() - event.timestamp) / 60_000;
    if (ageMinutes > policy.oldMinutes) {
      return this.handleOld(event, policy);
    }
    return this.runProcess(event, policy);
  }

  /** Reprocesa un canje que quedó en "ignored" (botón "Procesar ahora"). */
  async reprocess(platform: string, eventId: string): Promise<ReceiveResult | null> {
    const record = getRedemption(this.db, platform, eventId);
    if (!record) return null;
    if (record.status !== "ignored") return { status: record.status as RedemptionStatus, reason: record.reason };
    const event = this.readEvent(record);
    if (!event) return null;
    this.transition(platform, eventId, "ignored", "received", "Reprocesado a pedido");
    return this.runProcess(event, this.policy());
  }

  /** Reprocesa todos los canjes "ignored" de una plataforma. Devuelve cuántos intentó. */
  async reprocessAll(platform: string): Promise<number> {
    const rows = this.listByStatus("ignored").filter((row) => row.platform === platform);
    for (const row of rows) await this.reprocess(platform, row.eventId);
    return rows.length;
  }

  /** Rechaza todos los canjes "ignored" (botón "Rechazar todos"). */
  async rejectAllIgnored(platform: string): Promise<number> {
    const rows = this.listByStatus("ignored").filter((row) => row.platform === platform);
    let count = 0;
    for (const row of rows) {
      const event = this.readEvent(row);
      if (!event) continue;
      const ok = await this.safeResolve(event, "reject");
      this.transition(row.platform, row.eventId, "ignored", ok ? "rejected" : "failed", "Rechazado por el usuario");
      if (ok) count += 1;
    }
    return count;
  }

  /** Canjes en "ignored" (pendientes de decisión) de una plataforma. */
  listIgnored(platform: string): RedemptionRecord[] {
    return this.listByStatus("ignored").filter((row) => row.platform === platform);
  }

  /**
   * Estado de un canje, para la UI y los tests.
   */
  get(platform: string, eventId: string): RedemptionRecord | null {
    return getRedemption(this.db, platform, eventId);
  }

  private async handleOld(event: NormalizedEvent, policy: RedemptionPolicy): Promise<ReceiveResult> {
    if (policy.oldAction === "process") return this.runProcess(event, policy);
    if (policy.oldAction === "reject") {
      const ok = await this.safeResolve(event, "reject");
      return this.settle(event, ok ? "rejected" : "failed", "Canje viejo rechazado", ok);
    }
    this.transition(event.platform, event.id, "received", "ignored", `Más de ${policy.oldMinutes} min de antigüedad`);
    return { status: "ignored", reason: `Más de ${policy.oldMinutes} min de antigüedad` };
  }

  private async runProcess(event: NormalizedEvent, policy: RedemptionPolicy): Promise<ReceiveResult> {
    let outcome: ProcessOutcome;
    try {
      outcome = await this.process(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido";
      this.logger?.(`redemptions: el procesamiento falló (${message})`);
      return this.settleFromRecord(event, "failed", message);
    }

    if (outcome.outcome === "fired") {
      // `PlayClip` ya aceptó el canje al encolar; acá solo se refleja.
      return this.settleFromRecord(event, "accepted", null);
    }

    if (outcome.outcome === "waiting") {
      // En espera por cooldown: NO se resuelve en la plataforma todavía (queda
      // pendiente hasta que suene). La alerta se acepta cuando se encola.
      const reason = outcome.reason ?? "En espera por cooldown";
      this.transitionFromCurrent(event, "waiting", reason);
      return { status: "waiting", reason };
    }

    // Omitido: sin regla, cooldown o sin permiso.
    const reason = outcome.reason ?? "Sin regla que coincida";
    if (policy.onSkip === "reject") {
      const ok = await this.safeResolve(event, "reject");
      return this.settle(event, ok ? "rejected" : "skipped", reason, ok);
    }
    return this.settle(event, "ignored", reason, true);
  }

  private settleFromRecord(event: NormalizedEvent, status: RedemptionStatus, reason: string | null): ReceiveResult {
    this.transitionFromCurrent(event, status, reason);
    return { status, reason };
  }

  /** Cierra un canje omitido o rechazado. `resolved` dice si la plataforma aceptó el cambio. */
  private settle(event: NormalizedEvent, status: RedemptionStatus, reason: string, resolved: boolean): ReceiveResult {
    const final: RedemptionStatus = resolved ? status : "failed";
    const detail = resolved ? reason : `${reason} (no se pudo actualizar en la plataforma)`;
    this.transitionFromCurrent(event, final, detail);
    return { status: final, reason: detail };
  }

  private async safeResolve(event: NormalizedEvent, outcome: ResolveOutcome): Promise<boolean> {
    try {
      await this.resolve(event, outcome);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      this.logger?.(`redemptions: resolve(${outcome}) falló (${message})`);
      return false;
    }
  }

  private transitionFromCurrent(event: NormalizedEvent, to: RedemptionStatus, reason: string | null): void {
    const current = getRedemption(this.db, event.platform, event.id);
    const from = (current?.status ?? "received") as RedemptionStatus;
    this.transition(event.platform, event.id, from, to, reason);
  }

  /**
   * Aplica una transición si está permitida. Una transición ilegal se registra y
   * se ignora, sin corromper el estado ni romper el flujo async (los callbacks de
   * moderación pueden llegar en cualquier orden respecto del procesamiento).
   */
  private transition(
    platform: string,
    eventId: string,
    from: RedemptionStatus,
    to: RedemptionStatus,
    reason: string | null,
  ): boolean {
    if (from !== to && !canTransitionRedemption(from, to)) {
      this.logger?.(`redemptions: transición no permitida ${from} -> ${to} (ignorada)`);
      return false;
    }
    updateRedemptionStatus(this.db, platform, eventId, to, reason);
    return true;
  }

  private readEvent(record: RedemptionRecord): NormalizedEvent | null {
    try {
      return JSON.parse(record.eventJson) as NormalizedEvent;
    } catch {
      return null;
    }
  }

  private toRecord(event: NormalizedEvent, status: RedemptionStatus, reason: string | null): RedemptionRecord {
    const at = new Date(this.now()).toISOString();
    const rewardId = payloadRewardId(event.payload);
    const payload = event.payload as Record<string, unknown>;
    return {
      platform: event.platform,
      eventId: event.id,
      rewardId,
      rewardTitle: typeof payload.rewardTitle === "string" ? payload.rewardTitle : null,
      userId: event.user.id,
      userName: event.user.name,
      userInput: typeof payload.userInput === "string" ? payload.userInput : null,
      status,
      reason,
      eventJson: JSON.stringify(event),
      redeemedAt: new Date(event.timestamp).toISOString(),
      createdAt: at,
      updatedAt: at,
    };
  }

  private listByStatus(status: RedemptionStatus): RedemptionRecord[] {
    return listRedemptions(this.db, { status, limit: 1000 });
  }
}
