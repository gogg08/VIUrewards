/**
 * Configuración general de la app (Fase 3, parte B).
 *
 * Se guarda en la tabla `settings` (clave/valor) y se lee/valida en el servidor.
 * Valores por defecto derivados del módulo de media, para no duplicar límites.
 */

import {
  getSetting,
  setSetting,
  type SqliteDatabase,
} from "../db/index.ts";
import { DEFAULT_MEDIA_LIMITS } from "../media/index.ts";
import { DEFAULT_ALLOWED_DOMAINS } from "../media/validate-url.ts";

export const SETTING_GLOBAL_VOLUME = "playback.globalVolume";
export const SETTING_DEFAULT_MAX_DURATION = "playback.defaultMaxDurationSec";
export const SETTING_WATCHDOG_MARGIN = "playback.watchdogMarginSec";
export const SETTING_MAX_AUDIO_VOICES = "playback.maxAudioVoices";
export const SETTING_MEDIA_MAX_DURATION = "media.maxDurationSec";
export const SETTING_MEDIA_MAX_BYTES = "media.maxBytes";
export const SETTING_ALLOWED_DOMAINS = "media.allowedDomains";
export const SETTING_PORT = "server.port";
export const SETTING_EVENT_HISTORY_MAX = "events.historyMax";
export const SETTING_REDEMPTIONS_POLL_INTERVAL = "redemptions.pollIntervalMs";
export const SETTING_REDEMPTIONS_ON_SKIP = "redemptions.onSkip";
export const SETTING_REDEMPTIONS_OLD_MINUTES = "redemptions.oldMinutes";
export const SETTING_REDEMPTIONS_OLD_ACTION = "redemptions.oldAction";

export const DEFAULT_PORT = 8787;

/** Política al omitir un canje (sin regla, cooldown o sin permiso). */
export type OnSkipPolicy = "leave_pending" | "reject";
/** Qué hacer con canjes más viejos que `redemptionsOldMinutes` al iniciar. */
export type OldRedemptionAction = "ignore" | "reject" | "process";

export const ON_SKIP_POLICIES: readonly OnSkipPolicy[] = ["leave_pending", "reject"];
export const OLD_REDEMPTION_ACTIONS: readonly OldRedemptionAction[] = ["ignore", "reject", "process"];

/** Configuración resuelta, con todos los valores aplicados. */
export interface AppSettings {
  /** Volumen global en porcentaje (0-100); multiplica el de cada alerta. */
  globalVolume: number;
  /** Duración máxima por defecto de una alerta, en segundos. */
  defaultMaxDurationSec: number;
  /** Margen del watchdog sobre la duración efectiva de un clip, en segundos. */
  watchdogMarginSec: number;
  /** Máximo de audios superpuestos simultáneos (1 a 20) que toca el overlay. */
  maxAudioVoices: number;
  /** Duración máxima del video a descargar, en segundos. */
  maxVideoDurationSec: number;
  /** Tamaño máximo del archivo a descargar, en bytes. */
  maxVideoBytes: number;
  /** Dominios permitidos para descargar clips. */
  allowedDomains: string[];
  /** Puerto del servidor local (requiere reiniciar). */
  port: number;
  /** Máximo de eventos guardados en el historial. */
  eventHistoryMax: number;
  /** Intervalo de polling de canjes de recompensa, en ms (mínimo 1000). */
  redemptionsPollIntervalMs: number;
  /** Política al omitir un canje (sin regla, cooldown o sin permiso). */
  redemptionsOnSkip: OnSkipPolicy;
  /** Antigüedad (min) a partir de la cual un canje se considera "viejo". */
  redemptionsOldMinutes: number;
  /** Qué hacer con los canjes viejos al iniciar. */
  redemptionsOldAction: OldRedemptionAction;
}

/** Campos editables desde el dashboard. */
export interface SettingsPatch {
  globalVolume?: number;
  defaultMaxDurationSec?: number;
  watchdogMarginSec?: number;
  maxAudioVoices?: number;
  maxVideoDurationSec?: number;
  maxVideoBytes?: number;
  allowedDomains?: string[];
  port?: number;
  eventHistoryMax?: number;
  redemptionsPollIntervalMs?: number;
  redemptionsOnSkip?: OnSkipPolicy;
  redemptionsOldMinutes?: number;
  redemptionsOldAction?: OldRedemptionAction;
}

/** Rangos aceptados para cada valor numérico. */
export const SETTINGS_LIMITS = {
  globalVolume: { min: 0, max: 100 },
  defaultMaxDurationSec: { min: 1, max: 600 },
  watchdogMarginSec: { min: 1, max: 120 },
  maxAudioVoices: { min: 1, max: 20 },
  maxVideoDurationSec: { min: 1, max: 3600 },
  maxVideoBytes: { min: 1 * 1024 * 1024, max: 2 * 1024 * 1024 * 1024 },
  port: { min: 1024, max: 65535 },
  eventHistoryMax: { min: 10, max: 5000 },
  redemptionsPollIntervalMs: { min: 1000, max: 60000 },
  redemptionsOldMinutes: { min: 0, max: 1440 },
} as const;

const MAX_DOMAINS = 50;

export const DEFAULT_SETTINGS: AppSettings = {
  globalVolume: 100,
  defaultMaxDurationSec: 30,
  watchdogMarginSec: 10,
  maxAudioVoices: 8,
  maxVideoDurationSec: DEFAULT_MEDIA_LIMITS.maxDurationSec,
  maxVideoBytes: DEFAULT_MEDIA_LIMITS.maxBytes,
  allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
  port: DEFAULT_PORT,
  eventHistoryMax: 500,
  // El valor por defecto del polling vive acá (no se importa de la plataforma:
  // el adaptador lo lee desde settings, así el aislamiento de AGENTS.md se mantiene).
  redemptionsPollIntervalMs: 5000,
  redemptionsOnSkip: "leave_pending",
  redemptionsOldMinutes: 10,
  redemptionsOldAction: "ignore",
};

export type SettingsValidation =
  | { ok: true; value: SettingsPatch }
  | { ok: false; reason: "INVALID_SETTINGS"; message: string };

const NUMERIC_KEYS = [
  "globalVolume",
  "defaultMaxDurationSec",
  "watchdogMarginSec",
  "maxAudioVoices",
  "maxVideoDurationSec",
  "maxVideoBytes",
  "port",
  "eventHistoryMax",
  "redemptionsPollIntervalMs",
  "redemptionsOldMinutes",
] as const;

const ENUM_KEYS = ["redemptionsOnSkip", "redemptionsOldAction"] as const;

const KNOWN_KEYS = new Set<string>([...NUMERIC_KEYS, ...ENUM_KEYS, "allowedDomains"]);

function isIpv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split(".").every((part) => {
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

/** Rangos IPv4 que nunca deben usarse como dominio (internos o especiales). */
export function isPrivateIpv4(host: string): boolean {
  if (!isIpv4(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 || // multicast / reservado
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

/** ¿Es un literal IP (v4 o v6)? Nunca se acepta como dominio. */
export function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true; // IPv6 (con o sin corchetes)
  return isIpv4(host);
}

/**
 * Valida un dominio editable. Rechaza IPs (y por lo tanto rangos privados),
 * `localhost`, nombres sin punto, caracteres inválidos y labels mal formados.
 * No resuelve DNS: solo acepta forma de dominio público.
 */
export function isValidDomainName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const host = value.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIpLiteral(host)) return false;
  if (!host.includes(".")) return false;
  if (!/^[a-z0-9.-]+$/.test(host)) return false;

  const labels = host.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63)) return false;
  if (labels.some((label) => label.startsWith("-") || label.endsWith("-"))) return false;

  const tld = labels[labels.length - 1];
  return /^[a-z]{2,}$/.test(tld);
}

/** Normaliza una lista de dominios: minúsculas, sin repetidos. */
function normalizeDomains(domains: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const domain of domains) {
    const host = domain.trim().toLowerCase();
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

export function validateSettingsPatch(patch: unknown): SettingsValidation {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { ok: false, reason: "INVALID_SETTINGS", message: "La configuración enviada no es válida." };
  }
  const record = patch as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, reason: "INVALID_SETTINGS", message: `Campo desconocido: ${key}.` };
    }
  }

  const value: SettingsPatch = {};

  for (const key of NUMERIC_KEYS) {
    if (!(key in record)) continue;
    const raw = record[key];
    const limits = SETTINGS_LIMITS[key];
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return { ok: false, reason: "INVALID_SETTINGS", message: `${key} debe ser un número entero.` };
    }
    if (raw < limits.min || raw > limits.max) {
      return {
        ok: false,
        reason: "INVALID_SETTINGS",
        message: `${key} debe estar entre ${limits.min} y ${limits.max}.`,
      };
    }
    value[key] = raw;
  }

  if ("redemptionsOnSkip" in record) {
    const raw = record.redemptionsOnSkip;
    if (typeof raw !== "string" || !ON_SKIP_POLICIES.includes(raw as OnSkipPolicy)) {
      return { ok: false, reason: "INVALID_SETTINGS", message: "redemptionsOnSkip debe ser 'leave_pending' o 'reject'." };
    }
    value.redemptionsOnSkip = raw as OnSkipPolicy;
  }
  if ("redemptionsOldAction" in record) {
    const raw = record.redemptionsOldAction;
    if (typeof raw !== "string" || !OLD_REDEMPTION_ACTIONS.includes(raw as OldRedemptionAction)) {
      return {
        ok: false,
        reason: "INVALID_SETTINGS",
        message: "redemptionsOldAction debe ser 'ignore', 'reject' o 'process'.",
      };
    }
    value.redemptionsOldAction = raw as OldRedemptionAction;
  }

  if ("allowedDomains" in record) {
    const raw = record.allowedDomains;
    if (!Array.isArray(raw)) {
      return { ok: false, reason: "INVALID_SETTINGS", message: "allowedDomains debe ser una lista." };
    }
    const domains = normalizeDomains(raw.filter((item): item is string => typeof item === "string"));
    if (domains.length === 0) {
      return { ok: false, reason: "INVALID_SETTINGS", message: "La whitelist no puede quedar vacía." };
    }
    if (domains.length > MAX_DOMAINS) {
      return { ok: false, reason: "INVALID_SETTINGS", message: `Máximo ${MAX_DOMAINS} dominios.` };
    }
    const invalidDomain = domains.find((domain) => !isValidDomainName(domain));
    if (invalidDomain) {
      return {
        ok: false,
        reason: "INVALID_SETTINGS",
        message: `Dominio no permitido: ${invalidDomain}. No se aceptan IPs ni nombres internos.`,
      };
    }
    value.allowedDomains = domains;
  }

  return { ok: true, value };
}

function readNumber(
  db: SqliteDatabase,
  key: string,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const raw = getSetting(db, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < limits.min || value > limits.max) return fallback;
  return value;
}

function readEnum<T extends string>(
  db: SqliteDatabase,
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const raw = getSetting(db, key);
  if (raw === null) return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function readDomains(db: SqliteDatabase): string[] {
  const raw = getSetting(db, SETTING_ALLOWED_DOMAINS);
  if (raw === null) return [...DEFAULT_ALLOWED_DOMAINS];
  const domains = normalizeDomains(raw.split(","));
  const valid = domains.filter(isValidDomainName);
  return valid.length > 0 ? valid : [...DEFAULT_ALLOWED_DOMAINS];
}

/** Lee la configuración aplicada; cae a los valores por defecto si falta o es inválida. */
export function readSettings(db: SqliteDatabase): AppSettings {
  return {
    globalVolume: readNumber(db, SETTING_GLOBAL_VOLUME, DEFAULT_SETTINGS.globalVolume, SETTINGS_LIMITS.globalVolume),
    defaultMaxDurationSec: readNumber(
      db,
      SETTING_DEFAULT_MAX_DURATION,
      DEFAULT_SETTINGS.defaultMaxDurationSec,
      SETTINGS_LIMITS.defaultMaxDurationSec,
    ),
    watchdogMarginSec: readNumber(
      db,
      SETTING_WATCHDOG_MARGIN,
      DEFAULT_SETTINGS.watchdogMarginSec,
      SETTINGS_LIMITS.watchdogMarginSec,
    ),
    maxAudioVoices: readNumber(
      db,
      SETTING_MAX_AUDIO_VOICES,
      DEFAULT_SETTINGS.maxAudioVoices,
      SETTINGS_LIMITS.maxAudioVoices,
    ),
    maxVideoDurationSec: readNumber(
      db,
      SETTING_MEDIA_MAX_DURATION,
      DEFAULT_SETTINGS.maxVideoDurationSec,
      SETTINGS_LIMITS.maxVideoDurationSec,
    ),
    maxVideoBytes: readNumber(db, SETTING_MEDIA_MAX_BYTES, DEFAULT_SETTINGS.maxVideoBytes, SETTINGS_LIMITS.maxVideoBytes),
    allowedDomains: readDomains(db),
    port: readNumber(db, SETTING_PORT, DEFAULT_SETTINGS.port, SETTINGS_LIMITS.port),
    eventHistoryMax: readNumber(
      db,
      SETTING_EVENT_HISTORY_MAX,
      DEFAULT_SETTINGS.eventHistoryMax,
      SETTINGS_LIMITS.eventHistoryMax,
    ),
    redemptionsPollIntervalMs: readNumber(
      db,
      SETTING_REDEMPTIONS_POLL_INTERVAL,
      DEFAULT_SETTINGS.redemptionsPollIntervalMs,
      SETTINGS_LIMITS.redemptionsPollIntervalMs,
    ),
    redemptionsOnSkip: readEnum(db, SETTING_REDEMPTIONS_ON_SKIP, DEFAULT_SETTINGS.redemptionsOnSkip, ON_SKIP_POLICIES),
    redemptionsOldMinutes: readNumber(
      db,
      SETTING_REDEMPTIONS_OLD_MINUTES,
      DEFAULT_SETTINGS.redemptionsOldMinutes,
      SETTINGS_LIMITS.redemptionsOldMinutes,
    ),
    redemptionsOldAction: readEnum(
      db,
      SETTING_REDEMPTIONS_OLD_ACTION,
      DEFAULT_SETTINGS.redemptionsOldAction,
      OLD_REDEMPTION_ACTIONS,
    ),
  };
}

/** Guarda un parche ya validado. */
export function writeSettings(db: SqliteDatabase, patch: SettingsPatch): void {
  if (patch.globalVolume !== undefined) setSetting(db, SETTING_GLOBAL_VOLUME, String(patch.globalVolume));
  if (patch.defaultMaxDurationSec !== undefined) {
    setSetting(db, SETTING_DEFAULT_MAX_DURATION, String(patch.defaultMaxDurationSec));
  }
  if (patch.watchdogMarginSec !== undefined) {
    setSetting(db, SETTING_WATCHDOG_MARGIN, String(patch.watchdogMarginSec));
  }
  if (patch.maxAudioVoices !== undefined) {
    setSetting(db, SETTING_MAX_AUDIO_VOICES, String(patch.maxAudioVoices));
  }
  if (patch.maxVideoDurationSec !== undefined) {
    setSetting(db, SETTING_MEDIA_MAX_DURATION, String(patch.maxVideoDurationSec));
  }
  if (patch.maxVideoBytes !== undefined) setSetting(db, SETTING_MEDIA_MAX_BYTES, String(patch.maxVideoBytes));
  if (patch.allowedDomains !== undefined) {
    setSetting(db, SETTING_ALLOWED_DOMAINS, patch.allowedDomains.join(","));
  }
  if (patch.port !== undefined) setSetting(db, SETTING_PORT, String(patch.port));
  if (patch.eventHistoryMax !== undefined) {
    setSetting(db, SETTING_EVENT_HISTORY_MAX, String(patch.eventHistoryMax));
  }
  if (patch.redemptionsPollIntervalMs !== undefined) {
    setSetting(db, SETTING_REDEMPTIONS_POLL_INTERVAL, String(patch.redemptionsPollIntervalMs));
  }
  if (patch.redemptionsOnSkip !== undefined) {
    setSetting(db, SETTING_REDEMPTIONS_ON_SKIP, patch.redemptionsOnSkip);
  }
  if (patch.redemptionsOldMinutes !== undefined) {
    setSetting(db, SETTING_REDEMPTIONS_OLD_MINUTES, String(patch.redemptionsOldMinutes));
  }
  if (patch.redemptionsOldAction !== undefined) {
    setSetting(db, SETTING_REDEMPTIONS_OLD_ACTION, patch.redemptionsOldAction);
  }
}