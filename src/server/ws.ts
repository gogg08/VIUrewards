/**
 * Hub WebSocket del overlay (Fase 2).
 *
 * Se engancha al servidor HTTP de Fastify en la ruta `/ws`. Traduce los cambios
 * de la cola a mensajes tipados para el overlay y reenvía al servidor cuándo
 * termina un clip, para que avance la cola.
 */

import type { Server as HttpServer } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import type { AlertQueue, QueueState } from "../queue/index.ts";
import { clipUrl, parseOverlayMessage, type ServerMessage } from "./protocol.ts";

export interface WebSocketHub {
  broadcast(message: ServerMessage): void;
  close(): Promise<void>;
}

const WS_PATH = "/ws";

export function attachWebSocket(server: HttpServer, queue: AlertQueue): WebSocketHub {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  const broadcast = (message: ServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  server.on("upgrade", (request, socket, head) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== WS_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);

    // Al conectarse, el overlay recibe el estado actual para ponerse al día.
    ws.send(JSON.stringify({ type: "state", state: queue.getState() } satisfies ServerMessage));

    ws.on("message", (raw) => {
      const message = parseOverlayMessage(raw.toString());
      if (!message) return;
      if (message.type === "ready") {
        ws.send(JSON.stringify({ type: "state", state: queue.getState() } satisfies ServerMessage));
      } else if (message.type === "ended") {
        queue.complete(message.itemId);
      }
    });

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  // Difunde solo lo que cambió: nuevo clip, fin de clip, pausa o reanudación.
  let previous: QueueState = queue.getState();
  const unsubscribe = queue.onChange((state) => {
    const prev = previous;
    previous = state;

    const prevId = prev.current?.id ?? null;
    const nextId = state.current?.id ?? null;

    if (prevId !== nextId) {
      if (state.current) {
        broadcast({ type: "play", item: state.current, url: clipUrl(state.current.clipId) });
      } else {
        broadcast({ type: "stop" });
      }
      return;
    }

    if (prev.status !== state.status) {
      if (state.status === "paused") broadcast({ type: "pause" });
      else if (state.status === "playing") broadcast({ type: "resume" });
      else broadcast({ type: "stop" });
    }
  });

  return {
    broadcast,
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribe();
        for (const client of clients) client.terminate();
        clients.clear();
        wss.close(() => resolve());
      }),
  };
}
