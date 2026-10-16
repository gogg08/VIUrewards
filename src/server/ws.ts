/**
 * Hub WebSocket del overlay (Fase 2 + Fase 3).
 *
 * Se engancha al servidor HTTP de Fastify en la ruta `/ws`. Traduce los cambios
 * de la cola a mensajes tipados para el overlay y reenvía al servidor cuándo
 * termina un clip, para que avance la cola.
 *
 * Puntos clave para que la cola no se atasque:
 * - El overlay se autentica con el token secreto en la query (`/ws?key=...`).
 * - Ping/pong periódico: un socket que no responde se cierra, así el servidor no
 *   le sigue mandando mensajes a un socket muerto.
 * - Al (re)conectar, el overlay recibe el estado actual y se pone al día.
 * - Watchdog: si un clip supera su duración efectiva más un margen sin avisar
 *   el fin, la cola lo da por terminado y sigue.
 */

import type { Server as HttpServer } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { effectiveDurationSec, type AlertQueue, type QueueItem, type QueueState } from "../queue/index.ts";
import { safeEqual } from "./auth.ts";
import { parseOverlayMessage, type AudioPlayback, type OverlayDiag, type ServerMessage } from "./protocol.ts";
import { urlWithoutKey } from "./protocol-diag.ts";

export interface WebSocketHub {
  broadcast(message: ServerMessage): void;
  /** Envía un audio superpuesto y devuelve a cuántos overlays llegó (0 = ninguno). */
  broadcastAudio(audio: AudioPlayback): number;
  /** Corta todas las voces superpuestas de todos los overlays. */
  stopAudio(): void;
  /** Alerta de prueba: devuelve a cuántos overlays llegó (0 = ninguno). */
  testAlert(text: string): number;
  /** Cantidad de overlays conectados ahora mismo. */
  clientCount(): number;
  close(): Promise<void>;
}

export interface WebSocketOptions {
  /** Devuelve la clave vigente del overlay; las conexiones deben traerla en `?key=`. */
  getKey?: () => string;
  /** Intervalo de ping/pong; un cliente que no responde se cierra. Por defecto 30 s. */
  pingIntervalMs?: number;
  /** Margen del watchdog sobre la duración efectiva del clip. Por defecto 10 s. */
  resolveWatchdogMarginMs?: () => number;
  /** Se avisa cuando cambia la cantidad de overlays conectados. */
  onClientsChanged?: (count: number) => void;
  /**
   * Devuelve la URL de reproducción de un clip (mp4 o m4a) con la clave del
   * overlay. Es obligatorio: el servidor siempre conoce la extensión real del
   * archivo y el overlay no debe adivinarla (un `.mp4` fijo dejaba sin
   * reproducir los clips de audio).
   */
  resolveClipUrl: (clipId: string) => string;
  /** Versión del overlay; viaja en el mensaje `state` para que el overlay se recargue si quedó viejo. */
  overlayVersion?: string;
}

const WS_PATH = "/ws";
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_WATCHDOG_MARGIN_MS = 10_000;

const DEBUG = Boolean(process.env.CZERO_DEBUG);

/** Logs de depuración permanentes; nunca incluyen la clave del overlay. */
function debug(...args: unknown[]): void {
  if (DEBUG) console.log("[ws]", ...args);
}

/** Registra el diagnóstico del overlay (nivel debug). La URL va sin la clave. */
function logDiag(diag: OverlayDiag): void {
  if (!DEBUG) return;
  if (diag.kind === "connection") {
    debug(
      `diag conexión: overlay ${diag.version}; ua="${diag.userAgent ?? "?"}"; ` +
        `canPlay=${JSON.stringify(diag.canPlay ?? {})}`,
    );
    return;
  }
  const events = diag.events
    ? Object.entries(diag.events)
        .map(([name, at]) => `${name}@${at}ms`)
        .join(" ")
    : "";
  debug(
    `diag reproducción: ${diag.url ? urlWithoutKey(diag.url) : "?"}; ` +
      `readyState=${diag.readyState ?? "?"} networkState=${diag.networkState ?? "?"} ` +
      `error=${diag.errorCode ?? "-"}${diag.errorMessage ? ` (${diag.errorMessage})` : ""}; ${events}`,
  );
}

function queryKey(url: string | undefined): string | null {
  if (!url) return null;
  const query = url.split("?")[1];
  if (!query) return null;
  return new URLSearchParams(query).get("key");
}

export function attachWebSocket(
  server: HttpServer,
  queue: AlertQueue,
  options: WebSocketOptions,
): WebSocketHub {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, { alive: boolean }>();

  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogItemId: string | null = null;
  let closed = false;

  const sendToAll = (message: ServerMessage): number => {
    const payload = JSON.stringify(message);
    let sent = 0;
    for (const client of clients.keys()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sent += 1;
      }
    }
    return sent;
  };

  const broadcast = (message: ServerMessage): void => {
    sendToAll(message);
  };

  const notifyClients = (): void => {
    options.onClientsChanged?.(clients.size);
  };

  function disarmWatchdog(): void {
    if (watchdogTimer !== null) clearTimeout(watchdogTimer);
    watchdogTimer = null;
    watchdogItemId = null;
  }

  function armWatchdog(item: QueueItem): void {
    disarmWatchdog();
    const marginMs = options.resolveWatchdogMarginMs?.() ?? DEFAULT_WATCHDOG_MARGIN_MS;
    const durationSec = effectiveDurationSec(
      item.params.trimStart,
      item.params.trimEnd,
      item.params.maxDurationSec,
    );
    watchdogItemId = item.id;
    watchdogTimer = setTimeout(() => {
      const state = queue.getState();
      if (state.current?.id !== watchdogItemId) return;
      debug(`watchdog: "${watchdogItemId}" superó ${durationSec}s + ${marginMs}ms sin fin; avanzo la cola`);
      queue.complete(watchdogItemId ?? undefined);
    }, durationSec * 1000 + Math.max(0, marginMs));
    watchdogTimer.unref?.();
  }

  // Difunde solo lo que cambió, respetando la pausa. Un "play" nuevo reemplaza
  // siempre al anterior; un ítem que entra en pausa no arranca.
  let previous: QueueState = queue.getState();
  const unsubscribe = queue.onChange((state) => {
    const prev = previous;
    previous = state;

    const prevId = prev.current?.id ?? null;
    const nextId = state.current?.id ?? null;
    const currentChanged = prevId !== nextId;
    const statusChanged = prev.status !== state.status;

    debug(
      `transición: ${prev.status}(${prevId ?? "-"}) -> ${state.status}(${nextId ?? "-"}) ` +
        `espera=${state.pending.length}`,
    );

    if (state.status === "paused") {
      if (statusChanged || currentChanged) {
        disarmWatchdog();
        // En pausa no se reproduce nada. Si el ítem cambió (p. ej. skip en
        // pausa), se apaga; si solo se pausó, se pausa el clip actual.
        if (currentChanged && state.current === null) broadcast({ type: "stop" });
        else broadcast({ type: "pause" });
      }
      return;
    }

    if (currentChanged) {
      if (state.current) {
        const sent = sendToAll({
          type: "play",
          item: state.current,
          url: options.resolveClipUrl(state.current.clipId),
        });
        debug(`play "${state.current.clipId}" (${state.current.id}) a ${sent} overlay(s)`);
        armWatchdog(state.current);
      } else {
        disarmWatchdog();
        broadcast({ type: "stop" });
        debug("stop (cola sin ítem actual)");
      }
      return;
    }

    // Mismo ítem, cambia el estado: reanudar tras una pausa.
    if (statusChanged && state.status === "playing" && state.current) {
      broadcast({ type: "resume" });
      armWatchdog(state.current);
      debug(`resume "${state.current.clipId}" (${state.current.id})`);
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== WS_PATH) {
      socket.destroy();
      return;
    }

    // El overlay debe presentar la clave correcta; si no, se corta el socket.
    const expected = options.getKey?.();
    if (expected !== undefined) {
      const key = queryKey(request.url);
      if (!key || !safeEqual(key, expected)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  /** Arma el mensaje `state` con la URL resuelta del ítem actual (o `null`). */
  const stateMessage = (): ServerMessage => {
    const state = queue.getState();
    return {
      type: "state",
      state,
      url: state.current ? options.resolveClipUrl(state.current.clipId) : null,
      version: options.overlayVersion,
    };
  };

  wss.on("connection", (ws: WebSocket) => {
    clients.set(ws, { alive: true });
    debug(`overlay conectado (total ${clients.size})`);

    // Primero el estado actual (para ponerse al día), y recién después se avisa
    // que cambió la cantidad de overlays: si eso arranca un pendiente, el nuevo
    // overlay ya recibió su `state` y recibe luego el `play`.
    ws.send(JSON.stringify(stateMessage()));
    notifyClients();

    ws.on("pong", () => {
      const record = clients.get(ws);
      if (record) record.alive = true;
    });

    ws.on("message", (raw) => {
      const message = parseOverlayMessage(raw.toString());
      if (!message) {
        debug("mensaje del overlay descartado (no reconocido)");
        return;
      }
      if (message.type === "ready") {
        ws.send(JSON.stringify(stateMessage()));
      } else if (message.type === "ended") {
        debug(`overlay avisó fin de "${message.itemId}"${message.reason ? ` (${message.reason})` : ""}`);
        queue.complete(message.itemId);
      } else if (message.type === "diag") {
        logDiag(message.diag);
      } else if (message.type === "error") {
        // El overlay reintenta y avisa el fin por su cuenta; el watchdog cubre
        // cualquier fallo silencioso.
        console.warn(
          `[ws] el overlay reportó un error${message.itemId ? ` en "${message.itemId}"` : ""}: ${message.message}`,
        );
      }
    });

    const remove = (): void => {
      if (clients.delete(ws)) {
        notifyClients();
        debug(`overlay desconectado (total ${clients.size})`);
      }
    };
    ws.on("close", remove);
    ws.on("error", remove);
  });

  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimer = setInterval(() => {
    for (const [client, record] of clients) {
      if (!record.alive) {
        debug("overlay no respondió al ping: cierro el socket");
        client.terminate();
        continue;
      }
      record.alive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }, pingIntervalMs);
  pingTimer.unref?.();

  return {
    broadcast,
    broadcastAudio: (audio) => sendToAll({ type: "playAudio", audio }),
    stopAudio: () => {
      broadcast({ type: "stopAudio" });
    },
    testAlert: (text) => sendToAll({ type: "test", text }),
    clientCount: () => clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        clearInterval(pingTimer);
        disarmWatchdog();
        unsubscribe();
        for (const client of clients.keys()) client.terminate();
        clients.clear();
        wss.close(() => resolve());
      }),
  };
}