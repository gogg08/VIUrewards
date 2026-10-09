/**
 * Parseo y serialización mínima de cookies (Fase 3).
 *
 * No se agrega `@fastify/cookie`: hacerlo a mano es corto y evita una
 * dependencia nueva (la regla del proyecto pide preguntar antes de sumarlas).
 */

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

export interface CookieOptions {
  maxAgeSec?: number;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSec)}`);
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite ?? "Strict"}`);
  return parts.join("; ");
}