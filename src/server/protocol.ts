/**
 * Protocolo WebSocket entre el servidor y el overlay (Fase 2).
 *
 * Mensajes tipados y mínimos: el overlay no conoce la cola ni las plataformas,
 * solo reproduce lo que se le indica.
 */

import type { QueueItem, QueueState } from "../queue/index.ts";

import { parseDiag, type DiagEvent } from "./protocol-diag.ts";

/** Un audio superpuesto (modo overlap): se reproduce sin entrar en la cola. */
export interface AudioPlayback {
  /** Id de la reproducción (el id del canje/evento). */
  id: string;
  /** URL del medio servido por /media, con la clave del overlay. */
  url: string;
  /** Volumen final (volumen de la recompensa por el global). */
  volume: number;
  trimStart: number;
  trimEnd: number | null;
  /** Duración máxima en segundos. */
  maxDurationSec: number;
  /** Máximo de voces simultáneas vigente. */
  maxVoices: number;
}

export type ServerMessage =
  | { type: "state"; state: QueueState; url: string | null; version?: string }
  | { type: "play"; item: QueueItem; url: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "playAudio"; audio: AudioPlayback }
  | { type: "stopAudio" }
  | { type: "version"; version: string }
  // Alerta de prueba: el overlay muestra un cartel breve para comprobar que la
  // fuente está conectada. No usa ningún clip.
  | { type: "test"; text: string };

/**
 * Diagnóstico del overlay (nivel debug). Nunca incluye la clave del overlay:
 * la URL se manda sin el parámetro `key`.
 */
export interface OverlayDiag {
  kind: "connection" | "playback";
  version: string;
  userAgent?: string;
  /** Resultado de `canPlayType` para formatos de audio/video relevantes. */
  canPlay?: Record<string, string>;
  /** URL del medio, sin la clave del overlay. */
  url?: string;
  readyState?: number;
  networkState?: number;
  errorCode?: number | null;
  errorMessage?: string | null;
  /** Momento (ms desde la carga) en que se disparó cada evento. */
  events?: Partial<Record<DiagEvent, number>>;
}

export type OverlayMessage =
  | { type: "ready" }
  | { type: "ended"; itemId: string; reason?: string }
  | { type: "error"; itemId?: string; message: string }
  | { type: "diag"; diag: OverlayDiag };

/** URL de reproducción de un clip servido por /media (mp4 por defecto). */
export function clipUrl(clipId: string, ext: "mp4" | "m4a" = "mp4"): string {
  return `/media/${encodeURIComponent(clipId)}.${ext}`;
}

/** URL de reproducción con la clave del overlay (para el Browser Source de OBS). */
export function clipUrlWithKey(clipId: string, key: string, ext: "mp4" | "m4a" = "mp4"): string {
  return `${clipUrl(clipId, ext)}?key=${encodeURIComponent(key)}`;
}

/** Parsea un mensaje del overlay. Devuelve `null` si no es un JSON válido. */
export function parseOverlayMessage(raw: string): OverlayMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;

  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "ended":
      return typeof message.itemId === "string"
        ? {
            type: "ended",
            itemId: message.itemId,
            reason: typeof message.reason === "string" ? message.reason : undefined,
          }
        : null;
    case "error":
      return {
        type: "error",
        itemId: typeof message.itemId === "string" ? message.itemId : undefined,
        message: typeof message.message === "string" ? message.message : "error desconocido",
      };
    case "diag": {
      const diag = parseDiag(message.diag);
      return diag ? { type: "diag", diag } : null;
    }
    default:
      return null;
  }
}
