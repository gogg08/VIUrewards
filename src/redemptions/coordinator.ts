/**
 * Coordinador del ciclo de vida de canjes (Fase 4B).
 *
 * Recibe cada canje normalizado, decide su tratamiento (canje viejo, sin regla,
 * regla que dispara) y registra cada transición en la tabla `redemptions`, que
 * es lo que ve el dashboard. Las transiciones se validan con
 * `canTransitionRedemption`: una transición ilegal lanza, no corrompe el estado.
 *
 * Políticas configurables (settings):
 *  - onSkip:    "leave_pending" (default) | "reject"  → canje omitido o fallido.
 *  - oldAction: "ignore" (default) | "reject" | "process" → canje más viejo que N min.
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

export interface RedemptionCoordinatorOptions {
  db: SqliteDatabase;
  policy: () => RedemptionPolicy;
  /** Resuelve el canje en la plataforma (accept/reject). */
  resolve: (event: NormalizedEvent, outcome: ResolveOutcome) => Promise<void>;
  /** Procesa un canje normal (lo entrega al motor de reglas). */
  process: (event: NormalizedEvent) => Promise<{ outcome: string; reason?: string }>;
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
    const event = JSON.parse(record.eventJson) as NormalizedEvent;
    this.transition(platform, eventId, "ignored", "received", "Reprocesado a pedido");
    return this.runProcess(event, this.policy());
  }

  /** Rechaza todos los canjes "ignored" (botón "Rechazar todos"). */
  async rejectAllIgnored(platform: string): Promise<number> {
    const rows = this.listByStatus("ignored").filter((row) => row.platform === platform);
    let count = 0;
    for (const row of rows) {
      const event = JSON.parse(row.eventJson) as NormalizedEvent;
      const ok = await this.safeResolve(event, "reject");
      if (ok) {
        this.transition(row.platform, row.eventId, "ignored", "rejected", "Rechazado por el usuario");
        count += 1;
      }
    }
    return count;
  }

  /** Estado de un canje, para la UI y los tests. */
  get(platform: string, eventId: string): RedemptionRecord | null {
    return getRedemption(this.db, platform, eventId);
  }

  /**
   * Marca el resultado de una propuesta de moderación ligada a un canje: la
   * descarga falló y el canje se rechaza o queda pendiente según la política.
   */
  async onProposalFailed(platform: string, eventId: string, reason: string): Promise<void> {
    const record = getRedemption(this.db, platform, eventId);
    if (!record) return;
    const policy = this.policy();
    if (policy.onSkip === "reject") {
      const event = JSON.parse(record.eventJson) as NormalizedEvent;
      const ok = await this.safeResolve(event, "reject");
      this.transition(platform, eventId, record.status as RedemptionStatus, "failed", reason, ok ? null : "No se pudo rechazar en Kick");
      return;
    }
    this.transition(platform, eventId, record.status as RedemptionStatus, "ignored", reason);
  }

  /** Marca el resultado final de una propuesta aprobada cuando el clip quedó listo. */
  async onProposalReady(platform: string, eventId: string): Promise<void> {
    const record = getRedemption(this.db, platform, eventId);
    if (!record) return;
    const event = JSON.parse(record.eventJson) as NormalizedEvent;
    const ok = await this.safeResolve(event, "accept");
    if (ok) {
      this.transition(platform, eventId, record.status as RedemptionStatus, "accepted", "Clip listo");
    } else {
      this.transition(platform, eventId, record.status as RedemptionStatus, "failed", "No se pudo aceptar en Kick");
    }
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
    let outcome: { outcome: string; reason?: string };
    try {
      outcome = await this.process(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido";
      this.logger?.(`redemptions: el procesamiento falló (${message})`);
      return this.settleFromRecord(event, "failed", message);
    }

    if (outcome.outcome === "fired") {
      return this.settleFromRecord(event, "accepted", null);
    }
    if (outcome.outcome === "awaiting_moderation") {
      this.transitionFromCurrent(event, "awaiting_moderation", "Esperando aprobación");
      return { status: "awaiting_moderation", reason: "Esperando aprobación" };
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

  /** Cierra un canje omitido o rechazado. `resolved` dice si Kick aceptó el cambio. */
  private settle(event: NormalizedEvent, status: RedemptionStatus, reason: string, resolved: boolean): ReceiveResult {
    const final: RedemptionStatus = resolved ? status : "failed";
    const detail = resolved ? reason : `${reason} (no se pudo actualizar en Kick)`;
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

  private transition(
    platform: string,
    eventId: string,
    from: RedemptionStatus,
    to: RedemptionStatus,
    reason: string | null,
    extraReason: string | null = null,
  ): void {
    if (from !== to && !canTransitionRedemption(from, to)) {
      throw new Error(`Transición de canje no permitida: ${from} -> ${to}`);
    }
    const finalReason = extraReason ? `${reason ?? ""} · ${extraReason}`.trim() : reason;
    updateRedemptionStatus(this.db, platform, eventId, to, finalReason);
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
