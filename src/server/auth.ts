/**
 * Autenticación local (Fase 3).
 *
 * - Contraseña: se guarda solo el hash con `crypto.scrypt` (salt aleatorio),
 *   nunca en texto plano.
 * - Sesión: token aleatorio en una cookie httpOnly SameSite=Strict. Las sesiones
 *   viven en memoria: al reiniciar el servidor hay que volver a entrar (decisión
 *   documentada en docs/dashboard.md).
 * - Rate limit: límite simple de intentos de login por IP.
 * - Origin/Host: las requests que modifican estado deben venir del host local.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import type { SqliteDatabase } from "../db/index.ts";
import { getSetting, setSetting, SETTING_AUTH_PASSWORD } from "../db/index.ts";

export const SESSION_COOKIE = "czero_session";

const SCRYPT_KEYLEN = 64;
const SCRYPT_PREFIX = "scrypt";
export const MIN_PASSWORD_LENGTH = 8;

export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
  lockMs: number;
}

export interface AuthOptions {
  /** Duración de una sesión. Por defecto 7 días. */
  sessionTtlMs?: number;
  rateLimit?: Partial<RateLimitOptions>;
  /** Reloj inyectable en tests. */
  now?: () => number;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  maxAttempts: 5,
  windowMs: 60_000,
  lockMs: 60_000,
};

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function scrypt(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/** Comparación en tiempo constante de dos strings. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hashPassword(password: string, salt: Buffer): Promise<string> {
  return scrypt(password, salt, SCRYPT_KEYLEN).then(
    (derived) => `${SCRYPT_PREFIX}:${salt.toString("base64")}:${derived.toString("base64")}`,
  );
}

async function verifyHash(password: string, stored: string): Promise<boolean> {
  const [prefix, saltB64, hashB64] = stored.split(":");
  if (prefix !== SCRYPT_PREFIX || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

interface AttemptRecord {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

export interface RateLimitStatus {
  allowed: boolean;
  retryAfterSec?: number;
}

export class AuthManager {
  private readonly db: SqliteDatabase;
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly sessionTtlMs: number;
  private readonly rateLimit: RateLimitOptions;
  private readonly now: () => number;

  constructor(db: SqliteDatabase, options: AuthOptions = {}) {
    this.db = db;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
    this.now = options.now ?? (() => Date.now());
  }

  /** ¿Ya hay una contraseña configurada? */
  isConfigured(): boolean {
    return getSetting(this.db, SETTING_AUTH_PASSWORD) !== null;
  }

  async setPassword(password: string): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    }
    const salt = randomBytes(16);
    setSetting(this.db, SETTING_AUTH_PASSWORD, await hashPassword(password, salt));
  }

  async verifyPassword(password: string): Promise<boolean> {
    const stored = getSetting(this.db, SETTING_AUTH_PASSWORD);
    if (stored === null) return false;
    return verifyHash(password, stored);
  }

  /**
   * Cambia la contraseña si la actual es correcta. Devuelve `false` sin tocar
   * nada si no coincide.
   */
  async changePassword(current: string, next: string): Promise<boolean> {
    if (!(await this.verifyPassword(current))) return false;
    await this.setPassword(next);
    return true;
  }

  /** Cierra todas las sesiones salvo `keep` (la del que cambia la contraseña). */
  invalidateOtherSessions(keep: string | null): number {
    let removed = 0;
    for (const token of [...this.sessions.keys()]) {
      if (token === keep) continue;
      this.sessions.delete(token);
      removed += 1;
    }
    return removed;
  }

  createSession(): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, this.now() + this.sessionTtlMs);
    this.pruneSessions();
    return token;
  }

  validateSession(token: string): boolean {
    const expiresAt = this.sessions.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroySession(token: string): void {
    this.sessions.delete(token);
  }

  checkRateLimit(key: string): RateLimitStatus {
    const record = this.attempts.get(key);
    if (!record) return { allowed: true };
    const now = this.now();
    if (record.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((record.lockedUntil - now) / 1000) };
    }
    if (now - record.firstAt > this.rateLimit.windowMs) {
      this.attempts.delete(key);
    }
    return { allowed: true };
  }

  recordFailure(key: string): void {
    const now = this.now();
    const record = this.attempts.get(key);
    if (!record || now - record.firstAt > this.rateLimit.windowMs) {
      this.attempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
      return;
    }
    record.count += 1;
    if (record.count >= this.rateLimit.maxAttempts) {
      record.lockedUntil = now + this.rateLimit.lockMs;
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private pruneSessions(): void {
    const now = this.now();
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token);
    }
  }
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** ¿El hostname es de loopback? */
export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}

/**
 * Valida que una request que modifica estado venga del host local.
 * Se prioriza `Origin` (lo mandan los navegadores y no se puede falsificar desde
 * otra web); si falta, se usa `Host`.
 */
export function isTrustedRequest(origin: string | undefined, host: string | undefined): boolean {
  if (origin) {
    try {
      return isLocalHostname(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  if (host) {
    const hostname = host.replace(/:\d+$/, "");
    return isLocalHostname(hostname);
  }
  return false;
}