/**
 * Interfaz genérica de integración con una plataforma (Fase 4B).
 *
 * Vive fuera de `src/platforms/<nombre>/` a propósito: el servidor y el dashboard
 * solo conocen esta forma, nunca los nombres ni los tipos de una plataforma
 * concreta (AGENTS.md: "Ningún código fuera de /src/platforms/<nombre>/ puede
 * importar tipos o nombres específicos de una plataforma").
 *
 * El adaptador de cada plataforma la implementa; el único archivo autorizado a
 * importar de `src/platforms/<nombre>/` es el registro `src/platforms/index.ts`.
 */

import type { EventSource, EventSourceCapabilities } from "../events/index.ts";

/** Estado del vínculo de la cuenta del streamer. */
export type AccountLinkState = "unlinked" | "connected" | "requires_relink";

export interface PlatformAccount {
  /** Id de la integración (para las rutas /api/platforms/:id). */
  id: string;
  platform: string;
  /** Nombre visible para el usuario (p. ej. "Kick"). */
  name: string;
  state: AccountLinkState;
  accountId: string | null;
  accountName: string | null;
  capabilities: EventSourceCapabilities;
  /** ¿Ya hay credenciales cargadas? El secreto nunca sale de acá. */
  hasCredentials: boolean;
  /** Client id (no es secreto), si está cargado. */
  clientId: string | null;
  lastError: string | null;
}

/** Recompensa tal como la ve el dashboard (campos genéricos, en camelCase). */
export interface RewardView {
  id: string;
  title: string;
  cost: number;
  description: string;
  color: string;
  enabled: boolean;
  paused: boolean;
  userInputRequired: boolean;
  skipRequestQueue: boolean;
  /** ¿La creó esta app? Solo esas se pueden editar o borrar. */
  managed: boolean;
}

export interface RewardInput {
  title: string;
  cost: number;
  description?: string;
  color?: string;
  enabled?: boolean;
  userInputRequired?: boolean;
  skipRequestQueue?: boolean;
}

/** Fallo al rechazar un canje, ya traducido a una forma genérica. */
export interface RedemptionRejectFailure {
  id: string;
  reason: string;
  /** `true` si el canje ya estaba resuelto (no es un error real). */
  benign: boolean;
}

export interface CredentialsInput {
  clientId: string;
  /** Si se omite, se conserva el secreto ya guardado. */
  clientSecret?: string;
}

export interface LinkStart {
  authorizeUrl: string;
  /** Epoch en ms en que expira el intento de vínculo. */
  expiresAt: number;
}

export interface LinkComplete {
  ok: boolean;
  message?: string;
}

export interface PlatformTestResult {
  ok: boolean;
  message: string;
  accountName?: string;
  rewards?: number;
}

export interface PollingDiagnostics {
  enabled: boolean;
  intervalMs: number;
  lastCheckAt: number | null;
  lastResult: string | null;
  lastError: string | null;
  latencyLastMs: number | null;
  latencyMinMs: number | null;
  latencyTypicalMs: number | null;
  latencyMaxMs: number | null;
  rateLimit429Count: number;
  /** Headers de rate limit observados en la última respuesta (si hubo). */
  lastRateLimitHeaders: Record<string, string>;
}

export type PlatformOperationError = { ok: false; reason: string; message: string };
export type PlatformOperationResult<T> = { ok: true; value: T } | PlatformOperationError;

/**
 * Una integración de plataforma. El servidor la consume entera a través de esta
 * interfaz: vínculo de cuenta, gestión de recompensas, diagnóstico y eventos.
 */
export interface PlatformIntegration {
  readonly id: string;
  readonly platform: string;
  readonly name: string;
  /** Fuente de eventos normalizados; se registra en el motor de reglas. */
  readonly source: EventSource;

  status(): PlatformAccount;
  setCredentials(input: CredentialsInput): Promise<PlatformOperationResult<PlatformAccount>>;
  clearCredentials(): Promise<void>;

  /** Inicia el vínculo OAuth. Devuelve la URL a la que mandar al streamer. */
  beginLink(redirectUri: string): Promise<PlatformOperationResult<LinkStart>>;
  /** Termina el vínculo a partir del callback. Valida solo state + PKCE. */
  completeLink(query: URLSearchParams): Promise<LinkComplete>;
  unlink(): Promise<void>;

  test(): Promise<PlatformTestResult>;
  diagnostics(): PollingDiagnostics;

  listRewards(): Promise<PlatformOperationResult<RewardView[]>>;
  createReward(input: RewardInput): Promise<PlatformOperationResult<RewardView>>;
  updateReward(rewardId: string, input: Partial<RewardInput>): Promise<PlatformOperationResult<RewardView>>;
  deleteReward(rewardId: string): Promise<PlatformOperationResult<{ id: string }>>;

  /**
   * Ids de canjes pendientes de una recompensa (con paginación). Se usa para
   * contar los pendientes antes de deshabilitar o borrar una recompensa.
   */
  listPendingRedemptions(rewardId: string): Promise<PlatformOperationResult<string[]>>;
  /** Rechaza canjes en lotes. Devuelve solo los que fallaron (con `benign`). */
  rejectRedemptions(ids: string[]): Promise<PlatformOperationResult<RedemptionRejectFailure[]>>;

  start(): Promise<void>;
  stop(): Promise<void>;
}