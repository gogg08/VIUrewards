/**
 * Validación y normalización de URLs de entrada (Fase 1, núcleo de media).
 *
 * Toda URL que venga del usuario pasa por acá antes de tocar yt-dlp. Nunca
 * lanza excepción por input inválido: devuelve un resultado tipado.
 */

/** Códigos de error del módulo de media (unión de literales, no `enum`). */
export const MEDIA_ERROR_CODES = [
  "URL_INVALID",
  "DOMAIN_NOT_ALLOWED",
  "TOO_LONG",
  "TOO_BIG",
  "DOWNLOAD_FAILED",
  "CONVERT_FAILED",
  "BINARY_MISSING",
  "TIMEOUT",
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "clips.twitch.tv",
  "kick.com",
];

export const DEFAULT_MAX_URL_LENGTH = 2048;

export interface UrlValidationOptions {
  /** Dominios permitidos. Un host coincide si es igual al dominio o un subdominio suyo. */
  allowedDomains?: readonly string[];
  maxUrlLength?: number;
}

/** Error acotado a lo que puede fallar en la validación de URL. */
export type UrlValidationErrorCode = Extract<
  MediaErrorCode,
  "URL_INVALID" | "DOMAIN_NOT_ALLOWED" | "TOO_LONG"
>;

export type UrlValidation =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: UrlValidationErrorCode };

/**
 * Comprueba que `host` sea el dominio o un subdominio suyo.
 * Evita el bypass `youtube.com.evil.com` y `evil-youtube.com`.
 */
function hostMatches(host: string, domain: string): boolean {
  const base = domain.toLowerCase().replace(/^\./, "");
  if (base === "") return false;
  return host === base || host.endsWith(`.${base}`);
}

/** Normaliza la URL para usarla como clave de caché: sin fragmento ni puerto por defecto. */
function normalize(parsed: URL): string {
  // `origin` ya devuelve el host en minúsculas y omite el puerto por defecto.
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

export function validateUrl(input: string, options: UrlValidationOptions = {}): UrlValidation {
  const allowedDomains = options.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;
  const maxUrlLength = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;

  const raw = input.trim();
  if (raw.length === 0) return { ok: false, reason: "URL_INVALID" };
  if (raw.length > maxUrlLength) return { ok: false, reason: "TOO_LONG" };

  // Un input como "--exec" o "-flag" no parsea como URL: cae en URL_INVALID.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "URL_INVALID" };
  }

  if (parsed.protocol !== "https:") return { ok: false, reason: "URL_INVALID" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "URL_INVALID" };

  const host = parsed.hostname.toLowerCase();
  if (!allowedDomains.some((domain) => hostMatches(host, domain))) {
    return { ok: false, reason: "DOMAIN_NOT_ALLOWED" };
  }

  return { ok: true, url: normalize(parsed), host };
}