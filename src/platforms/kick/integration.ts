/**
 * Integración de Kick (Fase 4B): une OAuth, cliente REST y fuente de canjes.
 *
 * Implementa la interfaz genérica `PlatformIntegration`. El servidor solo ve esa
 * forma; los nombres de Kick no salen de esta carpeta (ver el registro en
 * `src/platforms/index.ts` y el test de aislamiento).
 */

import { listManagedRewards, markRewardManaged, unmarkRewardManaged, type SqliteDatabase } from "../../db/index.ts";
import type { EventSource } from "../../events/index.ts";
import type {
  CredentialsInput,
  LinkComplete,
  LinkStart,
  PlatformAccount,
  PlatformIntegration,
  PlatformOperationResult,
  PlatformTestResult,
  PollingDiagnostics,
  RewardInput,
  RewardView,
} from "../integration.ts";
import { KickApi, KickApiError, type FetchLike, describeStatus } from "./api.ts";
import { DEFAULT_POLL_INTERVAL_MS, KICK_DISPLAY_NAME } from "./config.ts";
import { KickOAuth } from "./oauth.ts";
import { KickEventSource, PollingStats, KICK_PLATFORM } from "./source.ts";
import type { ChannelReward, ChannelRewardInput } from "./types.ts";

export interface KickIntegrationOptions {
  db: SqliteDatabase;
  fetchFn?: FetchLike;
  apiBaseUrl?: string;
  idBaseUrl?: string;
  now?: () => number;
  random?: () => number;
  logger?: (message: string) => void;
  /** Intervalo de polling configurable (ms). */
  pollIntervalMs?: () => number;
  /** Notifica al servidor cuando cambia el estado del vínculo. */
  onStateChange?: () => void;
}

function toRewardView(reward: ChannelReward, managed: boolean): RewardView {
  return {
    id: reward.id,
    title: reward.title,
    cost: reward.cost,
    description: reward.description ?? "",
    color: reward.background_color,
    enabled: reward.is_enabled,
    paused: reward.is_paused,
    userInputRequired: reward.is_user_input_required,
    skipRequestQueue: reward.should_redemptions_skip_request_queue,
    managed,
  };
}

function toApiInput(input: Partial<RewardInput>): Partial<ChannelRewardInput> {
  const out: Partial<ChannelRewardInput> = {};
  if (input.title !== undefined) out.title = input.title;
  if (input.cost !== undefined) out.cost = input.cost;
  if (input.description !== undefined) out.description = input.description;
  if (input.color !== undefined) out.background_color = input.color;
  if (input.enabled !== undefined) out.is_enabled = input.enabled;
  if (input.userInputRequired !== undefined) out.is_user_input_required = input.userInputRequired;
  if (input.skipRequestQueue !== undefined) out.should_redemptions_skip_request_queue = input.skipRequestQueue;
  return out;
}

function failure<T>(reason: string, message: string): PlatformOperationResult<T> {
  return { ok: false, reason, message };
}

function fromApiError(error: unknown, context: string): { reason: string; message: string } {
  if (error instanceof KickApiError) return { reason: `HTTP_${error.status}`, message: error.message };
  return { reason: "UNKNOWN", message: describeStatus(0, context) };
}

export class KickIntegration implements PlatformIntegration {
  readonly id = "kick";
  readonly platform = KICK_PLATFORM;
  readonly name = KICK_DISPLAY_NAME;
  readonly source: EventSource;

  private readonly db: SqliteDatabase;
  private readonly oauth: KickOAuth;
  private readonly api: KickApi;
  private readonly stats: PollingStats;
  private readonly sourceImpl: KickEventSource;
  private readonly logger?: (message: string) => void;
  private readonly onStateChange?: () => void;

  constructor(options: KickIntegrationOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.onStateChange = options.onStateChange;
    this.oauth = new KickOAuth({
      db: options.db,
      platform: KICK_PLATFORM,
      idBaseUrl: options.idBaseUrl,
      fetchFn: options.fetchFn,
      now: options.now,
      logger: options.logger,
    });
    this.stats = new PollingStats();
    this.api = new KickApi({
      apiBaseUrl: options.apiBaseUrl,
      fetchFn: options.fetchFn,
      accessToken: () => this.oauth.accessToken(),
      onRateLimit: this.stats.observeRateLimit,
      logger: options.logger,
    });
    this.sourceImpl = new KickEventSource({
      api: this.api,
      db: options.db,
      stats: this.stats,
      intervalMs: options.pollIntervalMs ?? (() => DEFAULT_POLL_INTERVAL_MS),
      enabled: () => this.oauth.isLinked(),
      onAuthLost: () => {
        this.oauth.setStatus("requires_relink");
        this.onStateChange?.();
      },
      now: options.now,
      random: options.random,
      logger: options.logger,
    });
    this.source = this.sourceImpl;
  }

  status(): PlatformAccount {
    const account = this.oauth.getAccount();
    const credentials = account?.credentials ?? null;
    return {
      id: this.id,
      platform: this.platform,
      name: this.name,
      state: account?.status ?? "unlinked",
      accountId: account?.account?.id ?? null,
      accountName: account?.account?.name ?? null,
      capabilities: this.source.capabilities,
      hasCredentials: credentials !== null,
      // El client id no es secreto; el client secret NUNCA sale de acá.
      clientId: credentials?.clientId ?? null,
      lastError: this.stats.snapshot().lastError,
    };
  }

  async setCredentials(input: CredentialsInput): Promise<PlatformOperationResult<PlatformAccount>> {
    const clientId = input.clientId.trim();
    if (!clientId) return failure("INVALID", "Falta el Client ID.");
    try {
      this.oauth.saveCredentials(clientId, input.clientSecret?.trim());
    } catch (error) {
      return failure("INVALID", error instanceof Error ? error.message : "Credenciales inválidas.");
    }
    return { ok: true, value: this.status() };
  }

  async clearCredentials(): Promise<void> {
    await this.stop();
    this.oauth.clearCredentials();
  }

  async beginLink(redirectUri: string): Promise<PlatformOperationResult<LinkStart>> {
    try {
      const { authorizeUrl, expiresAt } = this.oauth.beginLink(redirectUri);
      return { ok: true, value: { authorizeUrl, expiresAt } };
    } catch (error) {
      return failure("NO_CREDENTIALS", error instanceof Error ? error.message : "No se pudo iniciar el vínculo.");
    }
  }

  async completeLink(query: URLSearchParams): Promise<LinkComplete> {
    const result = await this.oauth.completeLink(query);
    if (!result.ok) return { ok: false, message: result.message };
    // Verificado en docs.kick.com: `GET /public/v1/users` sin ids devuelve el
    // usuario autorizado (scope user:read). Si falla, el vínculo queda igual y el
    // nombre simplemente no se muestra.
    try {
      const me = await this.api.getSelfUser();
      if (me) this.oauth.setAccount({ id: String(me.user_id), name: me.name });
    } catch (error) {
      this.logger?.(`kick: no se pudo leer la cuenta vinculada (${error instanceof Error ? error.message : "error"})`);
    }
    this.onStateChange?.();
    await this.start();
    return { ok: true };
  }

  async unlink(): Promise<void> {
    await this.stop();
    this.oauth.unlink();
    this.onStateChange?.();
  }

  async test(): Promise<PlatformTestResult> {
    if (!this.oauth.isLinked()) return { ok: false, message: "La cuenta no está vinculada." };
    try {
      const rewards = await this.api.listRewards();
      const account = this.status();
      return {
        ok: true,
        message: "Conexión correcta con Kick.",
        rewards: rewards.length,
        accountName: account.accountName ?? undefined,
      };
    } catch (error) {
      const { message } = fromApiError(error, "test");
      if (error instanceof KickApiError && error.status === 401) this.oauth.setStatus("requires_relink");
      return { ok: false, message };
    }
  }

  diagnostics(): PollingDiagnostics {
    const snapshot = this.stats.snapshot();
    return {
      enabled: this.sourceImpl.isRunning(),
      intervalMs: this.currentInterval(),
      lastCheckAt: snapshot.lastCheckAt,
      lastResult: snapshot.lastResult,
      lastError: snapshot.lastError,
      latencyLastMs: snapshot.latencyLastMs,
      latencyMinMs: snapshot.latencyMinMs,
      latencyTypicalMs: snapshot.latencyTypicalMs,
      latencyMaxMs: snapshot.latencyMaxMs,
      rateLimit429Count: snapshot.rateLimit429Count,
      lastRateLimitHeaders: snapshot.lastRateLimitHeaders,
    };
  }

  private currentInterval(): number {
    return this.sourceImpl.currentIntervalMs();
  }

  async listRewards(): Promise<PlatformOperationResult<RewardView[]>> {
    try {
      const managed = new Set(listManagedRewards(this.db, KICK_PLATFORM));
      const rewards = await this.api.listRewards();
      return { ok: true, value: rewards.map((reward) => toRewardView(reward, managed.has(reward.id))) };
    } catch (error) {
      const { reason, message } = fromApiError(error, "rewards.list");
      return failure(reason, message);
    }
  }

  async createReward(input: RewardInput): Promise<PlatformOperationResult<RewardView>> {
    try {
      const created = await this.api.createReward({
        title: input.title,
        cost: input.cost,
        description: input.description ?? "",
        background_color: input.color,
        is_enabled: input.enabled ?? true,
        is_user_input_required: input.userInputRequired ?? false,
        should_redemptions_skip_request_queue: input.skipRequestQueue ?? false,
      });
      markRewardManaged(this.db, KICK_PLATFORM, created.id);
      return { ok: true, value: toRewardView(created, true) };
    } catch (error) {
      const { reason, message } = fromApiError(error, "rewards.create");
      return failure(reason, message);
    }
  }

  async updateReward(rewardId: string, input: Partial<RewardInput>): Promise<PlatformOperationResult<RewardView>> {
    const managed = new Set(listManagedRewards(this.db, KICK_PLATFORM));
    if (!managed.has(rewardId)) {
      return failure("NOT_MANAGED", "Solo se pueden editar las recompensas creadas por esta app.");
    }
    try {
      const updated = await this.api.updateReward(rewardId, toApiInput(input));
      return { ok: true, value: toRewardView(updated, true) };
    } catch (error) {
      const { reason, message } = fromApiError(error, "rewards.update");
      return failure(reason, message);
    }
  }

  async deleteReward(rewardId: string): Promise<PlatformOperationResult<{ id: string }>> {
    const managed = new Set(listManagedRewards(this.db, KICK_PLATFORM));
    if (!managed.has(rewardId)) {
      return failure("NOT_MANAGED", "Solo se pueden borrar las recompensas creadas por esta app.");
    }
    try {
      await this.api.deleteReward(rewardId);
      unmarkRewardManaged(this.db, KICK_PLATFORM, rewardId);
      return { ok: true, value: { id: rewardId } };
    } catch (error) {
      const { reason, message } = fromApiError(error, "rewards.delete");
      return failure(reason, message);
    }
  }

  async start(): Promise<void> {
    if (!this.oauth.isLinked()) return;
    this.sourceImpl.start();
  }

  async stop(): Promise<void> {
    this.sourceImpl.stop();
  }

}

export function createKickIntegration(options: KickIntegrationOptions): KickIntegration {
  return new KickIntegration(options);
}
