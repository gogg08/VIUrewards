import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../db/index.ts";
import type { EventSource } from "../events/index.ts";
import type { PlatformIntegration } from "../platforms/integration.ts";
import { SESSION_COOKIE } from "./auth.ts";
import { createServer, type AppServer } from "./server.ts";

/**
 * Cierre ordenado del `AppServer` (`stop()`): idempotencia, rechazo de trabajo
 * nuevo y propiedad de la base y el logger.
 *
 * Lo que NO se prueba acá: que los procesos externos (yt-dlp/ffmpeg) mueran
 * (eso está en `jobs-stop.test.ts` y `run-process.test.ts`) y el cierre del
 * proceso real ante SIGINT/SIGTERM (eso está en `tests/e2e/shutdown.test.ts`).
 */

const created: AppServer[] = [];
const dirs: string[] = [];

function makeMediaDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "shutdown-server-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return mediaDir;
}

afterEach(async () => {
  while (created.length > 0) await (created.pop() as AppServer).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Integración mínima: solo lo que el servidor usa al arrancar y cerrar. */
function fakeIntegration(onStop: () => void): PlatformIntegration {
  const source: EventSource = {
    id: "fake-source",
    platform: "fake",
    capabilities: { types: [], resolve: false },
    start: () => {},
    stop: () => {},
    onEvent: () => () => {},
  };
  const notImplemented = async () => ({ ok: false as const, reason: "NOT_CONFIGURED", message: "No." });
  return {
    id: "fake",
    platform: "fake",
    name: "Fake",
    source,
    status: () => ({
      id: "fake",
      platform: "fake",
      name: "Fake",
      state: "unlinked",
      accountId: null,
      accountName: null,
      capabilities: source.capabilities,
      hasCredentials: false,
      clientId: null,
      lastError: null,
    }),
    setCredentials: notImplemented,
    clearCredentials: async () => {},
    beginLink: notImplemented,
    completeLink: async () => ({ ok: false, reason: "INVALID_STATE", message: "No." }),
    unlink: async () => {},
    test: async () => ({ ok: false, message: "No." }),
    diagnostics: () => ({
      enabled: false,
      intervalMs: 5000,
      lastCheckAt: null,
      lastResult: null,
      lastError: null,
      latencyLastMs: null,
      latencyMinMs: null,
      latencyTypicalMs: null,
      latencyMaxMs: null,
      rateLimit429Count: 0,
      lastRateLimitHeaders: {},
    }),
    listRewards: notImplemented,
    createReward: notImplemented,
    updateReward: notImplemented,
    deleteReward: notImplemented,
    listPendingRedemptions: notImplemented,
    rejectRedemptions: notImplemented,
    start: async () => {},
    stop: async () => onStop(),
  };
}

async function withServer(platforms: PlatformIntegration[] = []) {
  const mediaDir = makeMediaDir();
  const db = openMemoryDatabase();
  const server = await createServer({ mediaDir, db, requireOverlay: false, platforms });
  created.push(server);
  await server.app.ready();
  await server.auth.setPassword("password123");
  const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;
  return { server, db, cookie };
}

describe("AppServer.stop(): cierre ordenado", () => {
  it("es idempotente: dos stop() comparten la misma secuencia y no fallan", async () => {
    const { server } = await withServer();
    const first = server.stop({ timeoutMs: 5000 });
    const second = server.stop({ timeoutMs: 5000 });
    // La misma promesa: no se ejecutan dos secuencias destructivas en paralelo.
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(server.isShuttingDown()).toBe(true);
    // Un tercer stop() después de terminar tampoco rompe ni vuelve a cerrar.
    await server.stop({ timeoutMs: 5000 });
  });

  it("durante el cierre las rutas protegidas responden 503 SHUTTING_DOWN", async () => {
    const { server, cookie } = await withServer();
    const during = server.stop({ timeoutMs: 5000 });
    const response = await server.app.inject({
      method: "GET",
      url: "/api/state",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, reason: "SHUTTING_DOWN" });
    await during;
  });

  it("no acepta descargas nuevas durante el cierre", async () => {
    const { server, cookie } = await withServer();
    const during = server.stop({ timeoutMs: 5000 });
    const response = await server.app.inject({
      method: "POST",
      url: "/api/download",
      headers: { cookie, origin: "http://localhost" },
      payload: { url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ reason: "SHUTTING_DOWN" });
    await during;
  });

  it("no cierra la base de datos ni el logger: son del dueño del proceso", async () => {
    const { server, db } = await withServer();
    await server.stop({ timeoutMs: 5000 });
    // La base sigue usable después de stop() (el arranque real la cierra al final).
    expect(() => db.prepare("SELECT 1 AS uno").get()).not.toThrow();
    // El logger sigue aceptando escritura (cierra `scripts/start.ts` al final).
    expect(() => server.logger.info("cierre: prueba de test")).not.toThrow();
  });

  it("detiene las integraciones y cierra el servidor HTTP", async () => {
    const stopped: string[] = [];
    const { server } = await withServer([fakeIntegration(() => stopped.push("fake"))]);

    await server.stop({ timeoutMs: 5000 });
    expect(stopped).toEqual(["fake"]);
    // Fastify ya no atiende: inyectar después del cierre falla.
    await expect(server.app.inject({ method: "GET", url: "/login" })).rejects.toThrow();
  });

  it("un fallo al detener una integración no impide terminar el cierre", async () => {
    const { server } = await withServer([
      fakeIntegration(() => {
        throw new Error("falló");
      }),
    ]);

    await expect(server.stop({ timeoutMs: 5000 })).resolves.toBeUndefined();
    expect(server.isShuttingDown()).toBe(true);
  });
});
