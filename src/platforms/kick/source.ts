/**
 * Fuente de eventos de Kick: canjes de recompensas por polling REST (Fase 4B).
 *
 * Sin webhooks, sin túnel y sin Pusher: se consulta
 * `GET /channels/rewards/redemptions?status=pending` cada `intervalMs()`. Cada
 * canje nuevo se emite como `reward_redeemed` normalizado. El id del canje es el
 * id del evento y se guarda como procesado en la base antes de emitir, para que
 * un reinicio no lo dispare de nuevo.
 *
 * `payload.userInput` es input NO confiable: se valida en la capa de acciones.
 */

import { hasProcessedEvent, markEventProcessed, pruneProcessedEvents, type SqliteDatabase } from "../../db/index.ts";
import { createEvent, type EventHandler, type EventSource, type EventSourceCapabilities, type NormalizedEvent, type ResolveOutcome } from "../../events/index.ts";
import { KickApiError, type KickApi, type RateLimitInfo } from "./api.ts";
import { LATENCY_WINDOW, MAX_REDEMPTION_PAGES, MAX_USER_INPUT_STORED, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS } from "./config.ts";
import type { ChannelRewardRedemption, RedemptionFailure, RedemptionFailureReason } from "./types.ts";

export const KICK_PLATFORM = "kick";
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_CACHED_USERS = 500;
const PROCESSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UNKNOWN_USER_NAME = "desconocido";

export interface PollingSnapshot {
  lastCheckAt: number | null;
  lastResult: string | null;
  lastError: string | null;
  latencyLastMs: number | null;
  latencyMinMs: number | null;
  latencyTypicalMs: number | null;
  latencyMaxMs: number | null;
  rateLimit429Count: number;
  lastRateLimitHeaders: Record<string, string>;
}

/** Estadísticas de polling para el panel de diagnóstico. Sin tokens ni secretos. */
export class PollingStats {
  private lastCheckAt: number | null = null;
  private lastResult: string | null = null;
  private lastError: string | null = null;
  private rateLimit429Count = 0;
  private lastRateLimitHeaders: Record<string, string> = {};
  private readonly latencies: number[] = [];

  recordCheck(at: number, result: string, error: string | null): void {
    this.lastCheckAt = at;
    this.lastResult = result;
    this.lastError = error;
  }

  recordLatency(ms: number): void {
    this.latencies.push(Math.max(0, ms));
    while (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  /** Callback para `KickApi`: cuenta 429 y guarda los headers de rate limit. */
  observeRateLimit = (info: RateLimitInfo): void => {
    if (info.status === 429) this.rateLimit429Count += 1;
    if (Object.keys(info.headers).length > 0) this.lastRateLimitHeaders = { ...info.headers };
  };

  snapshot(): PollingSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const last = this.latencies.at(-1) ?? null;
    return {
      lastCheckAt: this.lastCheckAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      latencyLastMs: last,
      latencyMinMs: sorted[0] ?? null,
      latencyTypicalMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      latencyMaxMs: sorted.at(-1) ?? null,
      rateLimit429Count: this.rateLimit429Count,
      lastRateLimitHeaders: { ...this.lastRateLimitHeaders },
    };
  }
}

export class KickResolveError extends Error {
  readonly reason: RedemptionFailureReason | "UNKNOWN_LOCAL";

  constructor(reason: RedemptionFailureReason | "UNKNOWN_LOCAL", message: string) {
    super(message);
    this.name = "KickResolveError";
    this.reason = reason;
  }
}

export interface KickEventSourceOptions {
  api: KickApi;
  db: SqliteDatabase;
  stats: PollingStats;
  /** Intervalo configurable; se lee en cada ciclo para que los cambios apliquen. */
  intervalMs?: () => number;
  /** Si es `false`, no se hace polling (sin vínculo o con el vínculo roto). */
  enabled?: () => boolean;
  /** Se llama cuando el polling se detiene por pérdida de acceso (requiere volver a vincular). */
  onAuthLost?: (message: string) => void;
  now?: () => number;
  random?: () => number;
  logger?: (message: string) => void;
}

function clampInterval(value: number): number {
  return Math.max(MIN_POLL_INTERVAL_MS, Number.isFinite(value) ? value : DEFAULT_POLL_INTERVAL_MS);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

interface PendingItem {
  rewardId: string;
  rewardTitle: string;
  redemption: ChannelRewardRedemption;
}

export class KickEventSource implements EventSource {
  readonly id = "kick-rewards";
  readonly platform = KICK_PLATFORM;
  readonly capabilities: EventSourceCapabilities = { types: ["reward_redeemed"], resolve: true };

  private readonly api: KickApi;
  private readonly db: SqliteDatabase;
  private readonly stats: PollingStats;
  private readonly intervalMs: () => number;
  private readonly enabled: () => boolean;
  private readonly onAuthLost?: (message: string) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logger?: (message: string) => void;
  private readonly handlers = new Set<EventHandler>();
  private readonly userNames = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;

  constructor(options: KickEventSourceOptions) {
    this.api = options.api;
    this.db = options.db;
    this.stats = options.stats;
    this.intervalMs = options.intervalMs ?? (() => DEFAULT_POLL_INTERVAL_MS);
    this.enabled = options.enabled ?? (() => true);
    this.onAuthLost = options.onAuthLost;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.logger = options.logger;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    pruneProcessedEvents(this.db, PROCESSED_RETENTION_MS, this.now());
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Intervalo efectivo de polling (con el mínimo aplicado). */
  currentIntervalMs(): number {
    return clampInterval(this.intervalMs());
  }

  /** Un ciclo de polling. Público para tests y para el botón "Probar conexión". */
  async pollOnce(): Promise<void> {
    if (!this.enabled()) return;
    const checkedAt = this.now();
    try {
      const items = await this.fetchPending();
      // Dedupe dentro del mismo ciclo (la paginación puede repetir un ítem) y contra la base.
      const seen = new Set<string>();
      const fresh = items.filter((item) => {
        const id = item.redemption.id;
        if (seen.has(id) || hasProcessedEvent(this.db, KICK_PLATFORM, id)) return false;
        seen.add(id);
        return true;
      });
      const names = await this.resolveNames(fresh.map((item) => item.redemption.redeemer.user_id));
      for (const item of fresh) this.emitRedemption(item, names, checkedAt);
      this.failures = 0;
      this.stats.recordCheck(checkedAt, `OK: ${fresh.length} canje(s) nuevo(s)`, null);
    } catch (error) {
      this.handleFailure(error, checkedAt);
    }
  }

  /** Acepta o rechaza un canje. Lanza `KickResolveError` si Kick lo rechazó. */
  async resolve(eventId: string, outcome: ResolveOutcome): Promise<void> {
    const failures = await this.resolveIds([eventId], outcome);
    const failure = failures.find((item) => item.id === eventId);
    if (failure) throw new KickResolveError(failure.reason, describeFailure(failure.reason));
  }

  /** Resuelve varios canjes (lotes de 25 en la API). Devuelve solo los fallidos. */
  resolveMany(ids: string[], outcome: ResolveOutcome): Promise<RedemptionFailure[]> {
    return this.resolveIds(ids, outcome);
  }

  private resolveIds(ids: string[], outcome: ResolveOutcome): Promise<RedemptionFailure[]> {
    return outcome === "accept" ? this.api.acceptRedemptions(ids) : this.api.rejectRedemptions(ids);
  }

  private async fetchPending(): Promise<PendingItem[]> {
    const items: PendingItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REDEMPTION_PAGES; page += 1) {
      const result = await this.api.listPendingRedemptions(cursor);
      for (const group of result.data ?? []) {
        for (const redemption of group.redemptions ?? []) {
          if (redemption.status !== "pending") continue;
          items.push({ rewardId: group.reward.id, rewardTitle: group.reward.title, redemption });
        }
      }
      cursor = result.pagination?.next_cursor || undefined;
      if (!cursor) break;
    }
    return items;
  }

  private async resolveNames(userIds: number[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const missing: string[] = [];
    for (const id of userIds) {
      const key = String(id);
      const cached = this.userNames.get(key);
      if (cached) names.set(key, cached);
      else missing.push(key);
    }
    if (missing.length === 0) return names;
    try {
      const users = await this.api.getUsers(missing);
      for (const user of users) {
        const key = String(user.user_id);
        names.set(key, user.name);
        this.rememberName(key, user.name);
      }
    } catch (error) {
      // Sin nombre no se corta el ciclo: el canje sigue y se muestra "desconocido".
      this.logger?.(`kick: no se pudo resolver el nombre de usuario (${describeError(error)})`);
    }
    return names;
  }

  private rememberName(key: string, name: string): void {
    this.userNames.set(key, name);
    if (this.userNames.size > MAX_CACHED_USERS) {
      const oldest = this.userNames.keys().next().value;
      if (oldest !== undefined) this.userNames.delete(oldest);
    }
  }

  private emitRedemption(item: PendingItem, names: Map<string, string>, detectedAt: number): void {
    const { redemption } = item;
    // Se marca como procesado ANTES de emitir: un reinicio no lo vuelve a disparar.
    markEventProcessed(this.db, KICK_PLATFORM, redemption.id, new Date(detectedAt).toISOString());

    const redeemedAt = Date.parse(redemption.redeemed_at);
    if (!Number.isNaN(redeemedAt)) this.stats.recordLatency(detectedAt - redeemedAt);

    const userId = String(redemption.redeemer.user_id);
    const event: NormalizedEvent = createEvent({
      id: redemption.id,
      platform: KICK_PLATFORM,
      type: "reward_redeemed",
      user: { id: userId, name: names.get(userId) ?? UNKNOWN_USER_NAME, roles: [] },
      payload: {
        rewardId: item.rewardId,
        rewardTitle: item.rewardTitle,
        // NO CONFIABLE: se guarda acotado y sin validar; la validación ocurre antes de usarlo.
        userInput: truncate(typeof redemption.user_input === "string" ? redemption.user_input : "", MAX_USER_INPUT_STORED),
      },
      timestamp: Number.isNaN(redeemedAt) ? detectedAt : redeemedAt,
    });

    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (error) {
        this.logger?.(`kick: un handler falló al recibir el canje (${describeError(error)})`);
      }
    }
  }

  private handleFailure(error: unknown, checkedAt: number): void {
    const message = describeError(error);
    if (error instanceof KickApiError && error.status === 401) {
      this.stats.recordCheck(checkedAt, "Sin acceso", "La sesión con la plataforma venció.");
      this.stop();
      this.onAuthLost?.("La sesión con Kick venció o fue revocada. Volvé a vincular la cuenta.");
      return;
    }
    this.failures += 1;
    this.stats.recordCheck(checkedAt, "Error; reintentando", message);
    this.logger?.(`kick: polling falló (${message}); reintento ${this.failures}`);
    const retryAfter = error instanceof KickApiError ? error.retryAfterMs ?? 0 : 0;
    this.schedule(this.backoffMs(this.failures, retryAfter));
  }

  /**
   * Backoff exponencial con jitter, respetando Retry-After. `attempt` es el número
   * de fallos consecutivos (1 = primer fallo). Nunca es 0 tras un fallo.
   */
  backoffMs(attempt: number, retryAfterMs = 0): number {
    const base = clampInterval(this.intervalMs());
    const exponential = Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(Math.max(attempt, 1), 10));
    const jitter = this.random() * base * 0.2;
    return Math.max(retryAfterMs, exponential) + jitter;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    const delay = delayMs > 0 ? delayMs : clampInterval(this.intervalMs());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().finally(() => {
        if (this.running && this.timer === null) this.schedule(this.failures > 0 ? 0 : clampInterval(this.intervalMs()));
      });
    }, delay);
  }
}

function describeFailure(reason: RedemptionFailureReason): string {
  switch (reason) {
    case "NOT_PENDING":
      return "El canje ya no está pendiente en Kick.";
    case "NOT_FOUND":
      return "Kick no encontró ese canje.";
    case "NOT_OWNED":
      return "Ese canje no pertenece a esta app.";
    case "UNKNOWN":
      return "Kick no pudo procesar el canje.";
  }
}

function describeError(error: unknown): string {
  if (error instanceof KickApiError) return `HTTP ${error.status}`;
  return error instanceof Error ? error.message : "error desconocido";
}
