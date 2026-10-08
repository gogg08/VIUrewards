import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createServer, type AppServer } from "./server.ts";

const created: AppServer[] = [];
const dirs: string[] = [];

const SECRET = "TOPSECRET_CONTENT_SHOULD_NOT_LEAK";

function makeMediaDir(): { mediaDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "server-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return { mediaDir, parent };
}

function writeSecret(parent: string): void {
  writeFileSync(join(parent, "secret.txt"), SECRET, "utf8");
}

afterEach(async () => {
  while (created.length > 0) await (created.pop() as AppServer).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

async function withServer(): Promise<AppServer> {
  const { mediaDir } = makeMediaDir();
  const server = await createServer({ mediaDir });
  created.push(server);
  await server.app.ready();
  return server;
}

describe("GET /overlay", () => {
  it("devuelve la página del Browser Source", async () => {
    const server = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/overlay" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<video");
  });
});

describe("/media - solo lectura y sin path traversal", () => {
  it("no escapa de la carpeta media con ../", async () => {
    const { mediaDir, parent } = makeMediaDir();
    writeFileSync(join(mediaDir, "ok.mp4"), "mp4-bytes", "utf8");
    writeSecret(parent);
    const server = await createServer({ mediaDir });
    created.push(server);
    await server.app.ready();

    const ok = await server.app.inject({ method: "GET", url: "/media/ok.mp4" });
    expect(ok.statusCode).toBe(200);

    for (const url of [
      "/media/../secret.txt",
      "/media/..%2fsecret.txt",
      "/media/%2e%2e/secret.txt",
      "/media/..%5csecret.txt",
      "/media/....//secret.txt",
      "/media/../../secret.txt",
    ]) {
      const response = await server.app.inject({ method: "GET", url });
      expect(response.statusCode).not.toBe(200);
      expect(response.body).not.toContain(SECRET);
    }
  });

  it("no sirve archivos que no sean mp4", async () => {
    const { mediaDir } = makeMediaDir();
    writeFileSync(join(mediaDir, "notes.txt"), "no soy un clip", "utf8");
    const server = await createServer({ mediaDir });
    created.push(server);
    await server.app.ready();

    const response = await server.app.inject({ method: "GET", url: "/media/notes.txt" });
    expect(response.statusCode).not.toBe(200);
  });
});

describe("API de la cola", () => {
  it("encola por clipId y refleja el estado", async () => {
    const server = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/enqueue",
      payload: { clipId: "abc", priority: 1, volume: 0.5 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.item.clipId).toBe("abc");
    expect(body.state.current.clipId).toBe("abc");

    const state = await server.app.inject({ method: "GET", url: "/api/state" });
    expect(state.json().current.clipId).toBe("abc");
  });

  it("rechaza un body sin clipId ni url", async () => {
    const server = await withServer();
    const response = await server.app.inject({ method: "POST", url: "/api/enqueue", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rechaza una URL de un dominio no permitido", async () => {
    const server = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/enqueue",
      payload: { url: "https://evil.example.com/video" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason).toBe("DOMAIN_NOT_ALLOWED");
  });

  it("pausa, reanuda y saltea", async () => {
    const server = await withServer();
    await server.app.inject({ method: "POST", url: "/api/enqueue", payload: { clipId: "a" } });
    await server.app.inject({ method: "POST", url: "/api/enqueue", payload: { clipId: "b" } });

    const paused = await server.app.inject({ method: "POST", url: "/api/pause" });
    expect(paused.json().state.status).toBe("paused");

    const resumed = await server.app.inject({ method: "POST", url: "/api/resume" });
    expect(resumed.json().state.status).toBe("playing");

    const skipped = await server.app.inject({ method: "POST", url: "/api/skip" });
    expect(skipped.json().state.current.clipId).toBe("b");
  });
});

describe("WebSocket /ws", () => {
  it("manda play cuando entra un clip a la cola", async () => {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({ mediaDir, port: 0 });
    created.push(server);
    const info = await server.start();

    const client = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    client.on("message", (data) => messages.push(JSON.parse(data.toString())));

    server.queue.enqueue({ clipId: "abc" });

    const deadline = Date.now() + 2000;
    while (!messages.some((m) => m.type === "play") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const play = messages.find((m) => m.type === "play");
    expect(play).toBeDefined();
    expect((play?.item as { clipId: string }).clipId).toBe("abc");
    expect(play?.url).toBe("/media/abc.mp4");

    client.close();
  });
});
