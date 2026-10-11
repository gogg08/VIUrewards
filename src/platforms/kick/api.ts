/**
 * Cliente HTTP de la API de Kick (Fase 4B).
 *
 * Un solo lugar que arma requests, adjunta el Bearer, observa los headers de
 * rate limit y separa los ids en lotes de 25 para accept/reject. No decide
 * reintentos: eso es del `KickEventSource` (backoff con jitter).
 *
 * La base de la API es inyectable para poder probar contra un servidor falso.
 */

import { KICK_API_BASE_URL, MAX_REDEMPTION_PAGES, MAX_RESOLVE_BATCH } from "./config.ts";
import type {
  ApiEnvelope,
  ChannelReward,
  ChannelRewardInput,
  KickUser,
  RedemptionFailure,
  RedemptionsPage,
  TokenResponse,
} from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RateLimitInfo {
  status: number;
  headers: Record<string, string>;
  retryAfterMs: number | null;
}

export interface KickApiOptions {
  apiBaseUrl?: string;
  fetchFn?: FetchLike;
  /** Access token vigente (refresca si hace falta) o `null` si no hay vínculo. */
  accessToken: () => Promise<string | null>;
  onRateLimit?: (info: RateLimitInfo) => void;
  logger?: (message: string) => void;
}

export class KickApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  readonly body: string;

  constructor(status: number, message: string, retryAfterMs: number | null = null, body = "") {
    super(message);
    this.name = "KickApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}

const RATE_LIMIT_HEADER = /(^|[-_])rate.?limit|retry-after/i;

function collectRateLimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (RATE_LIMIT_HEADER.test(key)) out[key.toLowerCase()] = value;
  });
  return out;
}

/** Espera indicada por `Retry-After` (segundos) o `X-RateLimit-Reset` (epoch seg.), si están. */
function retryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds) && seconds > 0) return Math.max(0, seconds * 1000 - Date.now());
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export class KickApi {
  private readonly apiBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly accessToken: () => Promise<string | null>;
  private readonly onRateLimit?: (info: RateLimitInfo) => void;
  private readonly logger?: (message: string) => void;

  constructor(options: KickApiOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? KICK_API_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.accessToken = options.accessToken;
    this.onRateLimit = options.onRateLimit;
    this.logger = options.logger;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, { ...init, headers });
    const info: RateLimitInfo = {
      status: response.status,
      headers: collectRateLimitHeaders(response.headers),
      retryAfterMs: retryAfterMs(response.headers),
    };
    if (Object.keys(info.headers).length > 0 || response.status === 429) this.onRateLimit?.(info);
    return response;
  }

  /** Lanza `KickApiError` si la respuesta no es 2xx. Nunca incluye tokens. */
  private async ensureOk(response: Response, context: string): Promise<Response> {
    if (response.ok) return response;
    const body = await response.text().catch(() => "");
    const message = describeStatus(response.status, context);
    this.logger?.(`${context}: HTTP ${response.status}`);
    throw new KickApiError(response.status, message, retryAfterMs(response.headers), body.slice(0, 500));
  }

  async getUsers(ids: Array<string | number>): Promise<KickUser[]> {
    const unique = [...new Set(ids.map(String))];
    if (unique.length === 0) return [];
    const query = unique.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    const response = await this.ensureOk(await this.request(`/public/v1/users?${query}`), "users");
    const json = (await response.json()) as ApiEnvelope<KickUser[]>;
    return Array.isArray(json.data) ? json.data : [];
  }

  /**
   * Usuario autorizado por el token actual. Verificado en docs.kick.com: si no se
   * pasan ids, `GET /public/v1/users` devuelve el usuario autenticado. Requiere
   * el scope `user:read`.
   */
  async getSelfUser(): Promise<KickUser | null> {
    const response = await this.ensureOk(await this.request("/public/v1/users"), "users.self");
    const json = (await response.json()) as ApiEnvelope<KickUser[]>;
    const first = Array.isArray(json.data) ? json.data[0] : undefined;
    return first && typeof first.name === "string" ? first : null;
  }

  async listRewards(): Promise<ChannelReward[]> {
    const response = await this.ensureOk(await this.request("/public/v1/channels/rewards"), "rewards.list");
    const json = (await response.json()) as ApiEnvelope<ChannelReward[]>;
    return Array.isArray(json.data) ? json.data : [];
  }

  async createReward(input: ChannelRewardInput): Promise<ChannelReward> {
    const response = await this.ensureOk(
      await this.request("/public/v1/channels/rewards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      "rewards.create",
    );
    const json = (await response.json()) as ApiEnvelope<ChannelReward>;
    return json.data;
  }

  async updateReward(id: string, input: Partial<ChannelRewardInput>): Promise<ChannelReward> {
    const response = await this.ensureOk(
      await this.request(`/public/v1/channels/rewards/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      "rewards.update",
    );
    const json = (await response.json()) as ApiEnvelope<ChannelReward>;
    return json.data;
  }

  async deleteReward(id: string): Promise<void> {
    const response = await this.request(`/public/v1/channels/rewards/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (response.status !== 204 && !response.ok) {
      const body = await response.text().catch(() => "");
      throw new KickApiError(response.status, describeStatus(response.status, "rewards.delete"), null, body.slice(0, 500));
    }
  }

  async listPendingRedemptions(cursor?: string): Promise<RedemptionsPage> {
    const query = new URLSearchParams({ status: "pending" });
    if (cursor) query.set("cursor", cursor);
    const response = await this.ensureOk(
      await this.request(`/public/v1/channels/rewards/redemptions?${query.toString()}`),
      "redemptions.list",
    );
    return (await response.json()) as RedemptionsPage;
  }

  /**
   * Ids de canjes pendientes de una recompensa, paginando por cursor.
   *
   * Verificado en docs.kick.com (§8): `GET /public/v1/channels/rewards/redemptions`
   * acepta los filtros `reward_id` y `status`.
   */
  async listPendingRedemptionIds(rewardId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REDEMPTION_PAGES; page += 1) {
      const query = new URLSearchParams({ status: "pending", reward_id: rewardId });
      if (cursor) query.set("cursor", cursor);
      const response = await this.ensureOk(
        await this.request(`/public/v1/channels/rewards/redemptions?${query.toString()}`),
        "redemptions.list",
      );
      const json = (await response.json()) as RedemptionsPage;
      for (const group of json.data ?? []) {
        for (const redemption of group.redemptions ?? []) {
          if (redemption.status === "pending") ids.push(redemption.id);
        }
      }
      cursor = json.pagination?.next_cursor || undefined;
      if (!cursor) break;
    }
    return ids;
  }

  /** Acepta canjes en lotes de 25. Devuelve solo los que fallaron. */
  acceptRedemptions(ids: string[]): Promise<RedemptionFailure[]> {
    return this.resolveRedemptions("accept", ids);
  }

  /** Rechaza canjes en lotes de 25. Devuelve solo los que fallaron. */
  rejectRedemptions(ids: string[]): Promise<RedemptionFailure[]> {
    return this.resolveRedemptions("reject", ids);
  }

  private async resolveRedemptions(kind: "accept" | "reject", ids: string[]): Promise<RedemptionFailure[]> {
    const failures: RedemptionFailure[] = [];
    for (const batch of chunk(ids, MAX_RESOLVE_BATCH)) {
      const response = await this.ensureOk(
        await this.request(`/public/v1/channels/rewards/redemptions/${kind}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: batch }),
        }),
        `redemptions.${kind}`,
      );
      const json = (await response.json()) as ApiEnvelope<RedemptionFailure[]>;
      if (Array.isArray(json.data)) failures.push(...json.data);
    }
    return failures;
  }
}

/** Mensajes cortos en español para los errores de la API. */
export function describeStatus(status: number, context: string): string {
  if (status === 401) return "La sesión con la plataforma venció. Hay que volver a vincular la cuenta.";
  if (status === 403) return "La plataforma rechazó la operación por permisos.";
  if (status === 404) return "El recurso no existe en la plataforma.";
  if (status === 409) return "La operación no es válida en el estado actual.";
  if (status === 429) return "Demasiadas solicitudes a la plataforma; se reintentará.";
  if (status >= 500) return "La plataforma devolvió un error temporal.";
  if (context === "rewards.create" && status === 400) {
    return "No se pudo crear la recompensa (puede que ya haya 50 en el canal o los datos no sean válidos).";
  }
  return `La plataforma devolvió un error (HTTP ${status}).`;
}

export { chunk };
export type { TokenResponse };