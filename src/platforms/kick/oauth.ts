/**
 * OAuth2 (authorization code + PKCE) de Kick (Fase 4B).
 *
 * - `beginLink` genera state + code_verifier aleatorios (guardados en memoria,
 *   con expiración corta y de un solo uso) y arma la URL de autorización.
 * - `completeLink` valida SOLO con state + PKCE (no depende de la cookie de
 *   sesión: la navegación del callback no la lleva) y cambia el código por tokens.
 * - `accessToken` refresca cuando hace falta, con un único refresh en curso a la
 *   vez (single-flight). Si el refresh falla o el token fue revocado, el estado
 *   pasa a "requires_relink" y el polling se detiene.
 *
 * Los tokens y el secreto viven en la base y nunca se devuelven ni se loguean.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  getPlatformAccount,
  upsertPlatformAccount,
  type PlatformAccountRecord,
  type PlatformAccountState,
  type PlatformCredentials,
  type PlatformTokens,
  type SqliteDatabase,
} from "../../db/index.ts";
import { KickApiError, type FetchLike } from "./api.ts";
import {
  KICK_AUTHORIZE_PATH,
  KICK_ID_BASE_URL,
  KICK_SCOPES,
  KICK_TOKEN_PATH,
  LINK_ATTEMPT_TTL_MS,
} from "./config.ts";
import type { TokenResponse } from "./types.ts";

export interface KickOAuthOptions {
  db: SqliteDatabase;
  platform: string;
  idBaseUrl?: string;
  fetchFn?: FetchLike;
  now?: () => number;
  logger?: (message: string) => void;
}

interface LinkAttempt {
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  baseUrl: string,
  params: { clientId: string; redirectUri: string; state: string; challenge: string; scopes?: readonly string[] },
): string {
  const url = new URL(KICK_AUTHORIZE_PATH, baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", (params.scopes ?? KICK_SCOPES).join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export class KickOAuth {
  private readonly db: SqliteDatabase;
  private readonly platform: string;
  private readonly idBaseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly logger?: (message: string) => void;
  private readonly attempts = new Map<string, LinkAttempt>();
  private refreshInFlight: Promise<PlatformTokens> | null = null;

  constructor(options: KickOAuthOptions) {
    this.db = options.db;
    this.platform = options.platform;
    this.idBaseUrl = (options.idBaseUrl ?? KICK_ID_BASE_URL).replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  getAccount(): PlatformAccountRecord | null {
    return getPlatformAccount(this.db, this.platform);
  }

  private ensureAccount(): PlatformAccountRecord {
    return (
      this.getAccount() ?? {
        platform: this.platform,
        credentials: null,
        tokens: null,
        status: "unlinked",
        account: null,
        updatedAt: new Date(this.now()).toISOString(),
      }
    );
  }

  private save(record: PlatformAccountRecord): void {
    upsertPlatformAccount(this.db, { ...record, updatedAt: new Date(this.now()).toISOString() });
  }

  getCredentials(): PlatformCredentials | null {
    return this.ensureAccount().credentials;
  }

  saveCredentials(clientId: string, clientSecret?: string): void {
    const account = this.ensureAccount();
    const existing = account.credentials;
    const secret = clientSecret && clientSecret.length > 0 ? clientSecret : existing?.clientSecret;
    if (!secret) throw new Error("Falta el Client Secret.");
    this.save({ ...account, credentials: { clientId, clientSecret: secret } });
  }

  clearCredentials(): void {
    const account = this.ensureAccount();
    this.save({ ...account, credentials: null, tokens: null, account: null, status: "unlinked" });
  }

  setStatus(status: PlatformAccountState, account: { id: string; name: string } | null = null): void {
    const current = this.ensureAccount();
    this.save({ ...current, status, account: account ?? current.account });
  }

  /** Guarda la identidad de la cuenta vinculada (sin cambiar el estado). */
  setAccount(account: { id: string; name: string }): void {
    const current = this.ensureAccount();
    this.save({ ...current, account });
  }

  saveTokens(tokens: PlatformTokens): void {
    const account = this.ensureAccount();
    this.save({ ...account, tokens, status: "connected" });
  }


  isLinked(): boolean {
    const account = this.getAccount();
    return account?.status === "connected" && account.tokens !== null;
  }

  /** Inicia el vínculo. Requiere credenciales cargadas. */
  beginLink(redirectUri: string): { authorizeUrl: string; expiresAt: number } {
    const credentials = this.getCredentials();
    if (!credentials) throw new Error("Cargá el Client ID y el Client Secret antes de vincular.");
    const { verifier, challenge } = createPkce();
    const state = base64Url(randomBytes(16));
    const expiresAt = this.now() + LINK_ATTEMPT_TTL_MS;
    this.attempts.set(state, { codeVerifier: verifier, redirectUri, expiresAt });
    this.pruneAttempts();
    const authorizeUrl = buildAuthorizeUrl(this.idBaseUrl, {
      clientId: credentials.clientId,
      redirectUri,
      state,
      challenge,
    });
    return { authorizeUrl, expiresAt };
  }

  /**
   * Termina el vínculo con los parámetros del callback. Rechaza todo state
   * desconocido, vencido o reutilizado. No usa cookies.
   */
  async completeLink(query: URLSearchParams): Promise<{ ok: boolean; message?: string; account?: { id: string; name: string } }> {
    const state = query.get("state");
    const code = query.get("code");
    const error = query.get("error");

    if (error) return { ok: false, message: "La plataforma rechazó la autorización." };
    if (!state || !code) return { ok: false, message: "Faltan parámetros en el callback." };

    const attempt = this.attempts.get(state);
    // De un solo uso: se consume siempre, exista o no.
    this.attempts.delete(state);

    if (!attempt) return { ok: false, message: "El intento de vínculo no es válido o ya se usó." };
    if (attempt.expiresAt <= this.now()) return { ok: false, message: "El intento de vínculo venció; probá de nuevo." };

    const credentials = this.getCredentials();
    if (!credentials) return { ok: false, message: "Faltan las credenciales de la app." };

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: credentials.clientId,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.codeVerifier,
      code,
    });
    if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.idBaseUrl}${KICK_TOKEN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      return { ok: false, message: "No se pudo contactar al servidor de la plataforma." };
    }

    if (!response.ok) {
      this.logger?.(`oauth: intercambio de código falló con HTTP ${response.status}`);
      return { ok: false, message: "No se pudo completar el vínculo con la plataforma." };
    }

    const tokens = (await response.json()) as TokenResponse;
    if (!tokens.access_token) return { ok: false, message: "La plataforma no devolvió un token válido." };

    this.saveTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      expiresAt: this.now() + tokens.expires_in * 1000,
      scope: tokens.scope ?? KICK_SCOPES.join(" "),
    });

    return { ok: true };
  }

  /** Access token vigente, refrescando si hace falta. `null` si no hay vínculo. */
  async accessToken(): Promise<string | null> {
    const account = this.getAccount();
    if (!account?.tokens || account.status === "unlinked") return null;
    if (account.tokens.expiresAt - 60_000 > this.now()) return account.tokens.accessToken;
    try {
      const tokens = await this.refreshTokens();
      return tokens?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  /** Un único refresh en curso a la vez (single-flight). */
  refreshTokens(): Promise<PlatformTokens> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<PlatformTokens> {
    const account = this.ensureAccount();
    const credentials = account.credentials;
    if (!credentials || !account.tokens?.refreshToken) {
      this.markRelink("No hay refresh token; hay que volver a vincular la cuenta.");
      throw new Error("Sin refresh token");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      refresh_token: account.tokens.refreshToken,
    });
    if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);

    const response = await this.fetchFn(`${this.idBaseUrl}${KICK_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      this.logger?.(`oauth: refresh falló con HTTP ${response.status}`);
      this.markRelink("La sesión venció o fue revocada. Hay que volver a vincular la cuenta.");
      throw new KickApiError(response.status, "refresh falló");
    }

    const tokens = (await response.json()) as TokenResponse;
    const updated: PlatformTokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? account.tokens.refreshToken,
      expiresAt: this.now() + tokens.expires_in * 1000,
      scope: tokens.scope ?? account.tokens.scope,
    };
    const fresh = this.ensureAccount();
    this.save({ ...fresh, tokens: updated, status: "connected" });
    return updated;
  }

  private markRelink(message: string): void {
    this.logger?.(`oauth: ${message}`);
    const account = this.ensureAccount();
    this.save({ ...account, status: "requires_relink" });
  }

  /** Desvincula: borra tokens y el nombre de la cuenta, pero conserva credenciales. */
  unlink(): void {
    const account = this.ensureAccount();
    this.save({ ...account, tokens: null, account: null, status: "unlinked" });
  }

  private pruneAttempts(): void {
    const now = this.now();
    for (const [state, attempt] of this.attempts) {
      if (attempt.expiresAt <= now) this.attempts.delete(state);
    }
  }
}