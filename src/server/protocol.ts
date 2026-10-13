/**
 * Protocolo WebSocket entre el servidor y el overlay (Fase 2).
 *
 * Mensajes tipados y mínimos: el overlay no conoce la cola ni las plataformas,
 * solo reproduce lo que se le indica.
 */

import type { QueueItem, QueueState } from "../queue/index.ts";

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
  | { type: "state"; state: QueueState }
  | { type: "play"; item: QueueItem; url: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "playAudio"; audio: AudioPlayback }
  | { type: "stopAudio" };

export type OverlayMessage =
  | { type: "ready" }
  | { type: "ended"; itemId: string; reason?: string }
  | { type: "error"; itemId?: string; message: string };

/** URL de reproducción de un clip servido por /media. */
export function clipUrl(clipId: string): string {
  return `/media/${encodeURIComponent(clipId)}.mp4`;
}

/** URL de reproducción con la clave del overlay (para el Browser Source de OBS). */
export function clipUrlWithKey(clipId: string, key: string): string {
  return `${clipUrl(clipId)}?key=${encodeURIComponent(key)}`;
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
    default:
      return null;
  }
}
