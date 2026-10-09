/**
 * Cuenta de una plataforma: credenciales de la app del streamer, tokens OAuth y
 * estado del vínculo (Fase 4B).
 *
 * Todo es genérico: la clave es el id de la plataforma y el contenido va como
 * JSON, de modo que cada adaptador decide qué guarda. Los secretos y tokens
 * NUNCA se devuelven al frontend ni se escriben en logs (AGENTS.md #6).
 */

import type { SqliteDatabase } from "./database.ts";

export interface PlatformCredentials {
  clientId: string;
  clientSecret: string;
}

export interface PlatformTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch en ms en que vence el access token. */
  expiresAt: number;
  scope: string;
}

export type PlatformAccountState = "unlinked" | "connected" | "requires_relink";

export interface PlatformAccountRecord {
  platform: string;
  credentials: PlatformCredentials | null;
  tokens: PlatformTokens | null;
  status: PlatformAccountState;
  /** Cuenta vinculada (id y nombre visible), si la hay. */
  account: { id: string; name: string } | null;
  updatedAt: string;
}

interface AccountRow {
  platform: string;
  credentials_json: string | null;
  tokens_json: string | null;
  status: string;
  account_json: string | null;
  updated_at: string;
}

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toRecord(row: AccountRow): PlatformAccountRecord {
  return {
    platform: row.platform,
    credentials: parse<PlatformCredentials>(row.credentials_json),
    tokens: parse<PlatformTokens>(row.tokens_json),
    status: row.status as PlatformAccountState,
    account: parse<{ id: string; name: string }>(row.account_json),
    updatedAt: row.updated_at,
  };
}

export function getPlatformAccount(db: SqliteDatabase, platform: string): PlatformAccountRecord | null {
  const row = db.prepare<AccountRow>("SELECT * FROM platform_accounts WHERE platform = ?").get(platform);
  return row ? toRecord(row) : null;
}

export function upsertPlatformAccount(db: SqliteDatabase, record: PlatformAccountRecord): void {
  db.prepare(
    `INSERT INTO platform_accounts (platform, credentials_json, tokens_json, status, account_json, updated_at)
     VALUES (@platform, @credentials, @tokens, @status, @account, @updatedAt)
     ON CONFLICT(platform) DO UPDATE SET
       credentials_json = excluded.credentials_json,
       tokens_json      = excluded.tokens_json,
       status           = excluded.status,
       account_json     = excluded.account_json,
       updated_at       = excluded.updated_at`,
  ).run({
    platform: record.platform,
    credentials: record.credentials ? JSON.stringify(record.credentials) : null,
    tokens: record.tokens ? JSON.stringify(record.tokens) : null,
    status: record.status,
    account: record.account ? JSON.stringify(record.account) : null,
    updatedAt: record.updatedAt,
  });
}

export function deletePlatformAccount(db: SqliteDatabase, platform: string): void {
  db.prepare("DELETE FROM platform_accounts WHERE platform = ?").run(platform);
}