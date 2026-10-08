/**
 * Protocolo WebSocket entre el servidor y el overlay (Fase 2).
 *
 * Mensajes tipados y mínimos: el overlay no conoce la cola ni las plataformas,
 * solo reproduce lo que se le indica.
 */

import type { QueueItem, QueueState } from "../queue/index.ts";

export type ServerMessage =
  | { type: "state"; state: QueueState }
  | { type: "play"; item: QueueItem; url: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" };

export type OverlayMessage =
  | { type: "ready" }
  | { type: "ended"; itemId: string }
  | { type: "error"; itemId?: string; message: string };

/** URL de reproducción de un clip servido por /media. */
export function clipUrl(clipId: string): string {
  return `/media/${encodeURIComponent(clipId)}.mp4`;
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
        ? { type: "ended", itemId: message.itemId }
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
