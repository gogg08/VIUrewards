import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as httpCreateServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { AlertQueue } from "../queue/index.ts";
import { openMemoryDatabase } from "../db/index.ts";
import { createServer as createAppServer, type AppServer } from "./server.ts";
import { attachWebSocket, type WebSocketHub, type WebSocketOptions } from "./ws.ts";

const KEY = "overlay-key-para-tests";

const servers: AppServer[] = [];
const hubs: Array<{ hub: WebSocketHub; http: HttpServer }> = [];
const dirs: string[] = [];

afterEach(async () => {
  while (hubs.length > 0) {
    const { hub, http } = hubs.pop() as { hub: WebSocketHub; http: HttpServer };
    await hub.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
  while (servers.length > 0) await (servers.pop() as AppServer).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Connected {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
}

/** Conecta y deja el colector de mensajes listo ANTES de que llegue el `open`:
 * el servidor manda `state` (y puede mandar `play`) apenas acepta el socket. */
async function connectAndCollect(port: number, key = KEY): Promise<Connected> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?key=${encodeURIComponent(key)}`);
  const messages: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, messages };
}

async function connect(port: number, key = KEY): Promise<WebSocket> {
  return (await connectAndCollect(port, key)).ws;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error("timeout esperando la condición");
}

interface HubCtx {
  queue: AlertQueue;
  hub: WebSocketHub;
  port: number;
}

async function withHub(options: WebSocketOptions = {}): Promise<HubCtx> {
  const queue = new AlertQueue();
  const http = httpCreateServer();
  const hub = attachWebSocket(http, queue, { getKey: () => KEY, pingIntervalMs: 40, ...options });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  hubs.push({ hub, http });
  return { queue, hub, port };
}

describe("hub WebSocket - reproducción", () => {
  it("emite play, y un skip emite el play del siguiente", async () => {
    const { queue, port } = await withHub();
    const { ws, messages } = await connectAndCollect(port);

    queue.enqueue({ clipId: "a" });
    await waitFor(() => messages.some((m) => m.type === "play" && (m.item as { clipId: string }).clipId === "a"));

    queue.enqueue({ clipId: "b" });
    queue.skip();
    await waitFor(() => messages.some((m) => m.type === "play" && (m.item as { clipId: string }).clipId === "b"));

    ws.close();
  });

  it("al reconectar reenvía el estado actual", async () => {
    const { queue, hub, port } = await withHub();
    const { ws: first, messages: firstMessages } = await connectAndCollect(port);
    queue.enqueue({ clipId: "a" });
    await waitFor(() => firstMessages.some((m) => m.type === "play"));
    first.close();
    await waitFor(() => hub.clientCount() === 0);

    const { ws: second, messages: secondMessages } = await connectAndCollect(port);
    await waitFor(() => secondMessages.some((m) => m.type === "state"));
    const state = secondMessages.find((m) => m.type === "state") as {
      state: { status: string; current: { clipId: string } | null };
    };
    expect(state.state.status).toBe("playing");
    expect(state.state.current?.clipId).toBe("a");

    second.close();
  });

  it("cierra un socket que deja de responder al ping", async () => {
    const { hub, port } = await withHub();
    const client = await connect(port);
    expect(hub.clientCount()).toBe(1);

    // Simula un socket muerto: no responde a los ping.
    (client as unknown as { pong: () => void }).pong = () => {};

    await waitFor(() => hub.clientCount() === 0, 1500);
    expect(hub.clientCount()).toBe(0);
  });

  it("broadcastAudio manda playAudio a los overlays y devuelve el número de destinatarios", async () => {
    const { hub, port } = await withHub();
    const { ws, messages } = await connectAndCollect(port);

    const sent = hub.broadcastAudio({
      id: "a1",
      url: "/media/x.mp4?key=k",
      volume: 0.5,
      trimStart: 0,
      trimEnd: null,
      maxDurationSec: 5,
      maxVoices: 8,
    });
    expect(sent).toBe(1);
    await waitFor(() => messages.some((m) => m.type === "playAudio"));
    const message = messages.find((m) => m.type === "playAudio") as { audio: { id: string } };
    expect(message.audio.id).toBe("a1");

    hub.stopAudio();
    await waitFor(() => messages.some((m) => m.type === "stopAudio"));
    ws.close();
  });

  it("broadcastAudio devuelve 0 cuando no hay overlays conectados", async () => {
    const { hub } = await withHub();
    const sent = hub.broadcastAudio({
      id: "a1",
      url: "/media/x.mp4?key=k",
      volume: 1,
      trimStart: 0,
      trimEnd: null,
      maxDurationSec: 5,
      maxVoices: 8,
    });
    expect(sent).toBe(0);
  });

  it("el watchdog da por terminado un clip que nunca avisa el fin", async () => {
    const { queue, port } = await withHub({ resolveWatchdogMarginMs: () => 50 });
    const { ws, messages } = await connectAndCollect(port);

    // Clip muy corto (0.3 s de recorte) + margen 50 ms.
    queue.enqueue({ clipId: "a", trimStart: 0, trimEnd: 0.3, maxDurationSec: 30 });
    await waitFor(() => messages.some((m) => m.type === "play"));

    await waitFor(() => queue.getState().current === null, 2000);
    await waitFor(() => messages.some((m) => m.type === "stop"), 2000);
    expect(messages.some((m) => m.type === "stop")).toBe(true);

    ws.close();
  });
});

describe("servidor - gating del overlay", () => {
  function makeMediaDir(): string {
    const parent = mkdtempSync(join(tmpdir(), "ws-test-"));
    dirs.push(parent);
    const mediaDir = join(parent, "media");
    mkdirSync(mediaDir, { recursive: true });
    return mediaDir;
  }

  it("no arranca un clip hasta que hay un overlay conectado", async () => {
    const mediaDir = makeMediaDir();
    const server = await createAppServer({ mediaDir, db: openMemoryDatabase(), port: 0 });
    servers.push(server);
    const info = await server.start();

    // Sin overlay: el ítem queda en espera.
    server.queue.enqueue({ clipId: "a" });
    expect(server.queue.getState().status).toBe("idle");
    expect(server.queue.getState().current).toBeNull();
    expect(server.queue.getState().size).toBe(1);

    // Al conectarse el overlay, arranca.
    const { ws, messages } = await connectAndCollect(info.port, server.getOverlayKey());
    await waitFor(() => server.queue.getState().current?.clipId === "a");
    await waitFor(() => messages.some((m) => m.type === "play"));
    ws.close();
  });

  it("/api/state informa si hay overlay conectado", async () => {
    const mediaDir = makeMediaDir();
    const server = await createAppServer({ mediaDir, db: openMemoryDatabase(), port: 0 });
    servers.push(server);
    const info = await server.start();
    const cookie = `czero_session=${server.auth.createSession()}`;

    const before = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    expect(before.json().overlay.connected).toBe(false);

    const ws = await connect(info.port, server.getOverlayKey());
    // Sondea hasta que el servidor registre la conexión.
    let connected = false;
    const deadline = Date.now() + 2000;
    while (!connected && Date.now() < deadline) {
      const res = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
      connected = Boolean(res.json().overlay.connected);
      if (!connected) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connected).toBe(true);

    const after = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    expect(after.json().overlay.clients).toBe(1);
    ws.close();
  });
});