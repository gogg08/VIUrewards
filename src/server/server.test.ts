import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openMemoryDatabase } from "../db/index.ts";
import { createServer, type AppServer } from "./server.ts";
import { SESSION_COOKIE } from "./auth.ts";

const created: AppServer[] = [];
const dirs: string[] = [];

const SECRET = "TOPSECRET_CONTENT_SHOULD_NOT_LEAK";
const PASSWORD = "password123";

function makeMediaDir(): { mediaDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "server-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return { mediaDir, parent };
}

afterEach(async () => {
  while (created.length > 0) await (created.pop() as AppServer).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Ctx {
  server: AppServer;
  mediaDir: string;
  cookie: string;
}

async function withServer(): Promise<Ctx> {
  const { mediaDir } = makeMediaDir();
  const server = await createServer({ mediaDir, db: openMemoryDatabase(), requireOverlay: false });
  created.push(server);
  await server.app.ready();
  await server.auth.setPassword(PASSWORD);
  const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;
  return { server, mediaDir, cookie };
}

describe("GET /overlay con token", () => {
  it("rechaza sin la clave", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/overlay" });
    expect(response.statusCode).toBe(403);
  });

  it("sirve la página del Browser Source con la clave correcta", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({
      method: "GET",
      url: `/overlay?key=${encodeURIComponent(server.getOverlayKey())}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<video");
  });
});

describe("/media - solo lectura, sin traversal y protegido", () => {
  it("exige sesión o clave", async () => {
    const { server, mediaDir, cookie } = await withServer();
    writeFileSync(join(mediaDir, "ok.mp4"), "mp4-bytes", "utf8");

    const withoutAuth = await server.app.inject({ method: "GET", url: "/media/ok.mp4" });
    expect(withoutAuth.statusCode).toBe(401);

    const withSession = await server.app.inject({
      method: "GET",
      url: "/media/ok.mp4",
      headers: { cookie },
    });
    expect(withSession.statusCode).toBe(200);

    const withKey = await server.app.inject({
      method: "GET",
      url: `/media/ok.mp4?key=${encodeURIComponent(server.getOverlayKey())}`,
    });
    expect(withKey.statusCode).toBe(200);
  });

  it("no escapa de la carpeta media con ../", async () => {
    const { mediaDir, parent } = makeMediaDir();
    const server = await createServer({ mediaDir, db: openMemoryDatabase() });
    created.push(server);
    await server.app.ready();
    const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;

    writeFileSync(join(mediaDir, "ok.mp4"), "mp4-bytes", "utf8");
    writeFileSync(join(parent, "secret.txt"), SECRET, "utf8");

    for (const url of [
      "/media/../secret.txt",
      "/media/..%2fsecret.txt",
      "/media/%2e%2e/secret.txt",
      "/media/..%5csecret.txt",
      "/media/....//secret.txt",
      "/media/../../secret.txt",
    ]) {
      const response = await server.app.inject({ method: "GET", url, headers: { cookie } });
      expect(response.statusCode).not.toBe(200);
      expect(response.body).not.toContain(SECRET);
    }
  });

  it("no sirve archivos que no sean mp4", async () => {
    const { server, mediaDir, cookie } = await withServer();
    writeFileSync(join(mediaDir, "notes.txt"), "no soy un clip", "utf8");
    const response = await server.app.inject({
      method: "GET",
      url: "/media/notes.txt",
      headers: { cookie },
    });
    expect(response.statusCode).not.toBe(200);
  });
});

describe("autenticación", () => {
  it("protege /api sin sesión", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/api/clips" });
    expect(response.statusCode).toBe(401);
    expect(response.json().reason).toBe("UNAUTHENTICATED");
  });

  it("configura la contraseña la primera vez y deja la sesión abierta", async () => {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({ mediaDir, db: openMemoryDatabase() });
    created.push(server);
    await server.app.ready();

    const status = await server.app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.json()).toEqual({ configured: false, authenticated: false });

    const setup = await server.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { password: PASSWORD },
    });
    expect(setup.statusCode).toBe(200);
    expect(String(setup.headers["set-cookie"])).toContain(SESSION_COOKIE);

    const second = await server.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { password: PASSWORD },
    });
    expect(second.statusCode).toBe(409);
  });

  it("login correcto e incorrecto", async () => {
    const { server } = await withServer();

    const wrong = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "incorrecta" },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers["set-cookie"])).toContain(SESSION_COOKIE);
  });

  it("rate limit tras varios intentos fallidos", async () => {
    const { server } = await withServer();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const response = await server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "mala" },
      });
      last = response.statusCode;
    }
    expect(last).toBe(429);
  });

  it("rechaza requests que modifican estado con Origin ajeno", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/skip",
      headers: { cookie, origin: "http://evil.example.com" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().reason).toBe("BAD_ORIGIN");
  });

  it("acepta requests de estado con Origin local", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/skip",
      headers: { cookie, origin: "http://127.0.0.1:8787" },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("páginas del dashboard", () => {
  it("redirige a /login sin sesión", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/login");
  });

  it("sirve el dashboard con sesión y el login siempre", async () => {
    const { server, cookie } = await withServer();
    const dashboard = await server.app.inject({ method: "GET", url: "/", headers: { cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("dashboardApp");

    const login = await server.app.inject({ method: "GET", url: "/login" });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain("authApp");
  });
});

describe("API de la cola", () => {
  it("encola por clipId y refleja el estado", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/enqueue",
      headers: { cookie },
      payload: { clipId: "abc", priority: 1, volume: 0.5 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state.current.clipId).toBe("abc");
  });

  it("rechaza un body sin clipId", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/enqueue",
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("pausa, reanuda y saltea", async () => {
    const { server, cookie } = await withServer();
    await server.app.inject({ method: "POST", url: "/api/enqueue", headers: { cookie }, payload: { clipId: "a" } });
    await server.app.inject({ method: "POST", url: "/api/enqueue", headers: { cookie }, payload: { clipId: "b" } });

    const paused = await server.app.inject({ method: "POST", url: "/api/pause", headers: { cookie } });
    expect(paused.json().state.status).toBe("paused");

    const resumed = await server.app.inject({ method: "POST", url: "/api/resume", headers: { cookie } });
    expect(resumed.json().state.status).toBe("playing");

    const skipped = await server.app.inject({ method: "POST", url: "/api/skip", headers: { cookie } });
    expect(skipped.json().state.current.clipId).toBe("b");
  });
});

describe("biblioteca y overlay (API)", () => {
  it("devuelve la URL del overlay con clave y la regenera", async () => {
    const { server, cookie } = await withServer();
    const info = await server.app.inject({ method: "GET", url: "/api/overlay", headers: { cookie } });
    const firstKey = info.json().overlay.key;
    expect(info.json().overlay.url).toContain("?key=");

    const regenerate = await server.app.inject({
      method: "POST",
      url: "/api/overlay/regenerate",
      headers: { cookie },
    });
    expect(regenerate.json().overlay.key).not.toBe(firstKey);
  });

  it("renombra y borra un clip del disco y la base", async () => {
    const { server, mediaDir, cookie } = await withServer();
    writeFileSync(join(mediaDir, "vid.mp4"), "mp4", "utf8");
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES ('vid','https://x/y','Original',1,4,'vid.mp4','2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const renamed = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/rename",
      headers: { cookie },
      payload: { title: "Renombrado" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().clip.title).toBe("Renombrado");

    const deleted = await server.app.inject({
      method: "DELETE",
      url: "/api/clips/vid",
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(200);

    const clips = await server.app.inject({ method: "GET", url: "/api/clips", headers: { cookie } });
    expect(clips.json().clips).toHaveLength(0);
  });
});

describe("configuración, recorte y contraseña (parte B)", () => {
  function insertClip(server: AppServer, id = "vid", durationSec = 10): void {
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES (?, 'https://x/y', 'Original', ?, 4, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, durationSec, `${id}.mp4`);
  }

  it("protege /api/state sin sesión", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(401);
  });

  it("valida y guarda el recorte, y lo rechaza fuera del clip", async () => {
    const { server, cookie } = await withServer();
    insertClip(server);

    const invalid = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/trim",
      headers: { cookie },
      payload: { trimStart: 6, trimEnd: 3 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().reason).toBe("INVALID_TRIM");

    const tooLong = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/trim",
      headers: { cookie },
      payload: { trimStart: 0, trimEnd: 11 },
    });
    expect(tooLong.statusCode).toBe(400);

    const ok = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/trim",
      headers: { cookie },
      payload: { trimStart: 2, trimEnd: 5 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().clip.trimStart).toBe(2);
    expect(ok.json().clip.trimEnd).toBe(5);

    // Solo inicio (fin = final): se guarda igual.
    const startOnly = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/trim",
      headers: { cookie },
      payload: { trimStart: 3, trimEnd: null },
    });
    expect(startOnly.json().clip.trimStart).toBe(3);
    expect(startOnly.json().clip.trimEnd).toBeNull();

    const reset = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/trim",
      headers: { cookie },
      payload: { trimStart: null, trimEnd: null },
    });
    expect(reset.json().clip.trimStart).toBeNull();
    expect(reset.json().clip.trimEnd).toBeNull();
  });

  it("Probar alerta usa el recorte y aplica volumen global y duración por defecto", async () => {
    const { server, cookie } = await withServer();
    insertClip(server);
    await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/trim",
      headers: { cookie },
      payload: { trimStart: 2, trimEnd: 5 },
    });
    await server.app.inject({
      method: "POST",
      url: "/api/settings",
      headers: { cookie },
      payload: { globalVolume: 50, defaultMaxDurationSec: 7 },
    });

    const play = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/play",
      headers: { cookie },
      payload: {},
    });
    expect(play.statusCode).toBe(200);
    const params = play.json().item.params;
    expect(params.trimStart).toBe(2);
    expect(params.trimEnd).toBe(5);
    expect(params.volume).toBeCloseTo(0.5);
    expect(params.maxDurationSec).toBe(7);
  });

  it("GET/POST /api/settings y aviso de reinicio al cambiar el puerto", async () => {
    const { server, cookie } = await withServer();
    const info = await server.app.inject({ method: "GET", url: "/api/settings", headers: { cookie } });
    expect(info.json().settings.globalVolume).toBe(100);
    expect(info.json().settings.port).toBe(8787);

    const bad = await server.app.inject({
      method: "POST",
      url: "/api/settings",
      headers: { cookie },
      payload: { allowedDomains: ["192.168.1.1"] },
    });
    expect(bad.statusCode).toBe(400);

    const good = await server.app.inject({
      method: "POST",
      url: "/api/settings",
      headers: { cookie },
      payload: { globalVolume: 50, port: 9000 },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().settings.globalVolume).toBe(50);
    expect(good.json().restartRequired).toBe(true);
  });

  it("vacía la cola con /api/clear dejando el clip actual", async () => {
    const { server, cookie } = await withServer();
    await server.app.inject({ method: "POST", url: "/api/enqueue", headers: { cookie }, payload: { clipId: "a" } });
    await server.app.inject({ method: "POST", url: "/api/enqueue", headers: { cookie }, payload: { clipId: "b" } });

    const cleared = await server.app.inject({ method: "POST", url: "/api/clear", headers: { cookie } });
    expect(cleared.json().removed).toBe(1);
    expect(cleared.json().state.current.clipId).toBe("a");
    expect(cleared.json().state.pending).toHaveLength(0);
  });

  it("cambia la contraseña pidiendo la actual e invalida las demás sesiones", async () => {
    const { server, cookie } = await withServer();
    const otherToken = server.auth.createSession();
    const currentToken = cookie.slice(cookie.indexOf("=") + 1);

    const wrong = await server.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: "incorrecta", newPassword: "nuevaclave1" },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await server.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "nuevaclave1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(server.auth.validateSession(otherToken)).toBe(false);
    expect(server.auth.validateSession(currentToken)).toBe(true);
    expect(await server.auth.verifyPassword("nuevaclave1")).toBe(true);
  });
});

describe("WebSocket /ws del overlay", () => {
  function tryOpen(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new WebSocket(url);
      client.on("open", () => {
        client.close();
        resolve(true);
      });
      client.on("error", () => resolve(false));
      client.on("close", () => resolve(false));
    });
  }

  it("rechaza sin la clave", async () => {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({ mediaDir, db: openMemoryDatabase(), port: 0 });
    created.push(server);
    const info = await server.start();

    const client = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
    const failed = await new Promise<boolean>((resolve) => {
      client.on("open", () => resolve(false));
      client.on("error", () => resolve(true));
      client.on("close", () => resolve(true));
    });
    expect(failed).toBe(true);
  });

  it("acepta la clave regenerada y rechaza la vieja", async () => {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({ mediaDir, db: openMemoryDatabase(), port: 0 });
    created.push(server);
    const info = await server.start();
    const oldKey = server.getOverlayKey();
    const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;

    await server.app.inject({ method: "POST", url: "/api/overlay/regenerate", headers: { cookie } });
    const newKey = server.getOverlayKey();
    expect(newKey).not.toBe(oldKey);

    expect(await tryOpen(`ws://127.0.0.1:${info.port}/ws?key=${encodeURIComponent(newKey)}`)).toBe(true);
    expect(await tryOpen(`ws://127.0.0.1:${info.port}/ws?key=${encodeURIComponent(oldKey)}`)).toBe(false);
  });

  it("manda play cuando entra un clip a la cola", async () => {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({ mediaDir, db: openMemoryDatabase(), port: 0 });
    created.push(server);
    const info = await server.start();

    const client = new WebSocket(
      `ws://127.0.0.1:${info.port}/ws?key=${encodeURIComponent(server.getOverlayKey())}`,
    );
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
    expect(play?.url).toBe("/media/abc.mp4");

    client.close();
  });
});