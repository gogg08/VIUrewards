/**
 * Constantes y parseo estricto del mensaje `diag` del overlay.
 *
 * Vive aparte de `protocol.ts` para que el overlay pueda importar las claves
 * sin arrastrar los tipos del servidor. Nunca transporta la clave del overlay.
 */

/** Eventos del reproductor que el overlay reporta en el diagnóstico. */
export const DIAG_EVENTS = ["loadedmetadata", "canplay", "playing", "ended", "error"] as const;
export type DiagEvent = (typeof DIAG_EVENTS)[number];

/** Formatos cuyo soporte reporta el overlay al conectarse (`canPlayType`). */
export const DIAG_FORMATS = ["audio/mp4; codecs=\"mp4a.40.2\"", "video/mp4; codecs=\"avc1.42E01E, mp4a.40.2\"", "audio/x-m4a"] as const;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Valida un objeto `diag` recibido del overlay. Devuelve `null` si no cumple el
 * esquema (el servidor lo descarta en vez de confiar en el contenido).
 */
export function parseDiag(value: unknown): {
  kind: "connection" | "playback";
  version: string;
  userAgent?: string;
  canPlay?: Record<string, string>;
  url?: string;
  readyState?: number;
  networkState?: number;
  errorCode?: number | null;
  errorMessage?: string | null;
  events?: Partial<Record<DiagEvent, number>>;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const d = value as Record<string, unknown>;
  if (d.kind !== "connection" && d.kind !== "playback") return null;
  if (typeof d.version !== "string") return null;

  const result: {
    kind: "connection" | "playback";
    version: string;
    userAgent?: string;
    canPlay?: Record<string, string>;
    url?: string;
    readyState?: number;
    networkState?: number;
    errorCode?: number | null;
    errorMessage?: string | null;
    events?: Partial<Record<DiagEvent, number>>;
  } = { kind: d.kind, version: d.version };

  if (typeof d.userAgent === "string") result.userAgent = d.userAgent;
  if (typeof d.url === "string") result.url = d.url;
  if (isFiniteNumber(d.readyState)) result.readyState = d.readyState;
  if (isFiniteNumber(d.networkState)) result.networkState = d.networkState;
  if (d.errorCode === null || isFiniteNumber(d.errorCode)) result.errorCode = d.errorCode;
  if (d.errorMessage === null || typeof d.errorMessage === "string") result.errorMessage = d.errorMessage;

  if (typeof d.canPlay === "object" && d.canPlay !== null) {
    const canPlay: Record<string, string> = {};
    for (const [key, val] of Object.entries(d.canPlay as Record<string, unknown>)) {
      if (typeof val === "string") canPlay[key] = val;
    }
    result.canPlay = canPlay;
  }

  if (typeof d.events === "object" && d.events !== null) {
    const events: Partial<Record<DiagEvent, number>> = {};
    for (const name of DIAG_EVENTS) {
      const at = (d.events as Record<string, unknown>)[name];
      if (isFiniteNumber(at)) events[name] = at;
    }
    result.events = events;
  }

  return result;
}

/** Quita el parámetro `key` de una URL de medio, para no filtrarla en el log. */
export function urlWithoutKey(url: string): string {
  const [path] = url.split("?");
  return path ?? url;
}
