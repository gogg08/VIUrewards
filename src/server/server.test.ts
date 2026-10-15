import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { listRules, openMemoryDatabase, toRule } from "../db/index.ts";
import { createEvent, EmitterEventSource } from "../events/index.ts";
import type { PlatformIntegration } from "../platforms/index.ts";
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

  it("no sirve archivos que no sean mp4 ni m4a", async () => {
    const { server, mediaDir, cookie } = await withServer();
    writeFileSync(join(mediaDir, "notes.txt"), "no soy un clip", "utf8");
    const response = await server.app.inject({
      method: "GET",
      url: "/media/notes.txt",
      headers: { cookie },
    });
    expect(response.statusCode).not.toBe(200);
  });

  it("sirve los m4a locales (audios) además de los mp4", async () => {
    const { server, mediaDir, cookie } = await withServer();
    writeFileSync(join(mediaDir, "clipa.m4a"), "m4a-bytes", "utf8");
    const response = await server.app.inject({
      method: "GET",
      url: "/media/clipa.m4a",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("m4a-bytes");
  });
});

/** Arma un cuerpo multipart/form-data simple con un solo archivo. */
function multipartBody(
  filename: string,
  content: Buffer,
): { body: Buffer; contentType: string } {
  const boundary = "----VIUrewardsTestBoundary";
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head, "utf8"), content, Buffer.from(tail, "utf8")]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("subidas de archivos locales (Etapa 3B)", () => {
  // Ejecutor falso: ffprobe responde un audio; ffmpeg crea la salida m4a.
  function fakeRun() {
    return async (command: string, args: string[]) => {
      if (command.includes("ffprobe")) {
        return {
          code: 0,
          stdout: JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "9" } }),
          stderr: "",
          timedOut: false,
        };
      }
      writeFileSync(args[args.length - 1], "m4a-out", "utf8");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
  }

  const binarySearch = {
    pathEnv: "/fake/bin",
    extraDirs: [] as string[],
    platform: "linux" as NodeJS.Platform,
    exists: () => true,
  };

  async function withUploadServer(): Promise<Ctx> {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({
      mediaDir,
      db: openMemoryDatabase(),
      requireOverlay: false,
      media: { binarySearch },
      run: fakeRun(),
    });
    created.push(server);
    await server.app.ready();
    await server.auth.setPassword(PASSWORD);
    const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;
    return { server, mediaDir, cookie };
  }

  async function waitForJob(server: AppServer, id: string, cookie: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const response = await server.app.inject({
        method: "GET",
        url: `/api/jobs/${id}`,
        headers: { cookie },
      });
      const job = response.json().job;
      if (job && (job.status === "ready" || job.status === "error")) return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("el trabajo no terminó a tiempo");
  }

  it("sube un archivo local, lo convierte a m4a y lo registra sin imagen", async () => {
    const { server, cookie } = await withUploadServer();
    const { body, contentType } = multipartBody("cancion.mp3", Buffer.from("audio-bytes"));

    const response = await server.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    const job = response.json().job;
    expect(job.kind).toBe("local");

    const done = await waitForJob(server, job.id, cookie);
    expect(done.status).toBe("ready");
    expect(done.title).toBe("cancion");

    const clips = server.db.prepare("SELECT file, has_video, source_url FROM clips").all() as Array<{
      file: string;
      has_video: number;
      source_url: string;
    }>;
    expect(clips).toHaveLength(1);
    expect(clips[0].file.endsWith(".m4a")).toBe(true);
    expect(clips[0].has_video).toBe(0);
    expect(clips[0].source_url).toBe("");
  });

  it("rechaza un archivo que no es audio ni video sin crear un clip", async () => {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({
      mediaDir,
      db: openMemoryDatabase(),
      requireOverlay: false,
      media: { binarySearch },
      run: async (command: string) => {
        if (command.includes("ffprobe")) {
          return { code: 0, stdout: JSON.stringify({ streams: [], format: {} }), stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    created.push(server);
    await server.app.ready();
    await server.auth.setPassword(PASSWORD);
    const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;

    const { body, contentType } = multipartBody("trampa.mp4", Buffer.from("no-es-media"));
    const response = await server.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    const done = await waitForJob(server, response.json().job.id, cookie);
    expect(done.status).toBe("error");
    expect(String(done.message)).toContain("audio");
    const count = server.db.prepare("SELECT COUNT(*) AS n FROM clips").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("requiere sesión", async () => {
    const { server } = await withUploadServer();
    const { body, contentType } = multipartBody("x.mp3", Buffer.from("a"));
    const response = await server.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "content-type": contentType },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });

  it("cancela un trabajo en curso", async () => {
    const { server, cookie } = await withUploadServer();
    const { body, contentType } = multipartBody("x.mp3", Buffer.from("a"));
    const response = await server.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { cookie, "content-type": contentType },
      payload: body,
    });

    // Puede haber terminado ya; cancelar debe seguir siendo seguro.
    const cancel = await server.app.inject({
      method: "POST",
      url: `/api/jobs/${response.json().job.id}/cancel`,
      headers: { cookie },
    });
    expect(cancel.statusCode).toBe(200);

    const missing = await server.app.inject({
      method: "POST",
      url: "/api/jobs/no-existe/cancel",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("limpieza de caché (Etapa 3B)", () => {
  function insertClip(server: AppServer, id: string, file: string, sourceUrl: string): void {
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at, has_video)
         VALUES (?, ?, 'clip', 5, 4, ?, '2026-01-01T00:00:00.000Z', 1)`,
      )
      .run(id, sourceUrl, file);
  }

  it("borra solo los clips de link sin recompensas y respeta los locales y en uso", async () => {
    const { server, mediaDir, cookie } = await withServer();
    writeFileSync(join(mediaDir, "link.mp4"), "x", "utf8");
    writeFileSync(join(mediaDir, "local.m4a"), "y", "utf8");
    writeFileSync(join(mediaDir, "usado.mp4"), "z", "utf8");
    insertClip(server, "link", "link.mp4", "https://youtu.be/aaaa");
    insertClip(server, "local", "local.m4a", "");
    insertClip(server, "usado", "usado.mp4", "https://youtu.be/bbbb");

    // Una recompensa (desactivada) usa "usado": no debe borrarse.
    server.db
      .prepare(
        `INSERT INTO rewards (id, platform, title, cost, color, description, clip_id, desired_enabled, managed, synced, created_at, updated_at)
         VALUES ('r1', 'kick', 'test', 1, '#64f7d9', '', 'usado', 0, 1, 1, '2026-01-01', '2026-01-01')`,
      )
      .run();

    const response = await server.app.inject({
      method: "POST",
      url: "/api/clips/cleanup",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().removed).toEqual(["link"]);

    const remaining = server.db.prepare("SELECT id FROM clips ORDER BY id").all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id).sort()).toEqual(["local", "usado"]);
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

  it("no borra un clip que una recompensa usa, ni siquiera desactivada", async () => {
    const { server, mediaDir, cookie } = await withServer();
    writeFileSync(join(mediaDir, "in-use.mp4"), "mp4", "utf8");
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES ('in-use','https://x/y','En uso',1,4,'in-use.mp4','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    // Recompensa desactivada: igual tiene que bloquear el borrado.
    server.db
      .prepare(
        `INSERT INTO rewards (id, platform, title, clip_id, desired_enabled, managed, synced, created_at, updated_at)
         VALUES ('rw-1','kick','Fiesta','in-use',0,1,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const response = await server.app.inject({ method: "DELETE", url: "/api/clips/in-use", headers: { cookie } });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.reason).toBe("CLIP_IN_USE");
    expect(body.message).toContain("Fiesta");

    // El clip sigue existiendo (fila y archivo).
    const clips = await server.app.inject({ method: "GET", url: "/api/clips", headers: { cookie } });
    expect(clips.json().clips.map((clip: { id: string }) => clip.id)).toContain("in-use");
  });
});

describe("borrado de clip con recompensas que lo usan (Etapa 3A)", () => {
  function insertClip(server: AppServer, id = "clip-1"): void {
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES (?, 'https://x/y', 'Clip uno', 5, 4, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, `${id}.mp4`);
  }

  function insertReward(
    server: AppServer,
    id: string,
    clipId: string,
    options: { enabled?: boolean } = {},
  ): void {
    server.db
      .prepare(
        `INSERT INTO rewards (id, platform, remote_reward_id, title, clip_id, desired_enabled, managed, synced, created_at, updated_at)
         VALUES (?, 'kick', ?, ?, ?, ?, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, `kick-${id}`, `Alerta ${id}`, clipId, options.enabled === false ? 0 : 1);
  }

  /** Integración falsa que registra los borrados y no tiene canjes pendientes. */
  function fakeIntegration(): { integration: PlatformIntegration; deleted: string[] } {
    const deleted: string[] = [];
    class FakeSource extends EmitterEventSource {
      async resolve(): Promise<void> {}
    }
    const source = new FakeSource({
      id: "kick",
      platform: "kick",
      capabilities: { types: ["reward_redeemed"], resolve: true },
    });
    const account = {
      id: "kick",
      platform: "kick",
      name: "Kick",
      state: "connected" as const,
      accountId: "u1",
      accountName: "Canal",
      capabilities: source.capabilities,
      hasCredentials: true,
      clientId: "cid",
      lastError: null,
    };
    const notImplemented = async (): Promise<never> => {
      throw new Error("no implementado en el test");
    };
    const integration: PlatformIntegration = {
      id: "kick",
      platform: "kick",
      name: "Kick",
      source,
      status: () => account,
      setCredentials: notImplemented,
      clearCredentials: async () => {},
      beginLink: notImplemented,
      completeLink: notImplemented,
      unlink: async () => {},
      test: notImplemented,
      diagnostics: () => ({
        enabled: true,
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
      deleteReward: async (rewardId: string) => {
        deleted.push(rewardId);
        return { ok: true, value: { id: rewardId } };
      },
      listPendingRedemptions: async () => ({ ok: true, value: [] }),
      rejectRedemptions: async () => ({ ok: true, value: [] }),
      start: async () => {},
      stop: async () => {},
    };
    return { integration, deleted };
  }

  async function withKick(): Promise<Ctx & { deleted: string[] }> {
    const { mediaDir } = makeMediaDir();
    const { integration, deleted } = fakeIntegration();
    const server = await createServer({
      mediaDir,
      db: openMemoryDatabase(),
      requireOverlay: false,
      platforms: [integration],
    });
    created.push(server);
    await server.app.ready();
    await server.auth.setPassword(PASSWORD);
    const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;
    return { server, mediaDir, cookie, deleted };
  }

  it("GET /api/clips/:id/usage lista las recompensas que lo usan (también desactivadas)", async () => {
    const { server, cookie } = await withKick();
    insertClip(server);
    insertReward(server, "rw-on", "clip-1", { enabled: true });
    insertReward(server, "rw-off", "clip-1", { enabled: false });
    insertReward(server, "rw-other", "otro-clip");

    const response = await server.app.inject({ method: "GET", url: "/api/clips/clip-1/usage", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { rewards: Array<{ id: string; enabled: boolean }> };
    expect(body.rewards.map((reward) => reward.id).sort()).toEqual(["rw-off", "rw-on"]);
    expect(body.rewards.find((reward) => reward.id === "rw-off")?.enabled).toBe(false);
  });

  it("GET /api/clips/:id/usage devuelve 404 si el clip no existe", async () => {
    const { server, cookie } = await withKick();
    const response = await server.app.inject({ method: "GET", url: "/api/clips/nope/usage", headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });

  it("rechazar el borrado con CLIP_IN_USE por defecto (sin confirmar)", async () => {
    const { server, cookie } = await withKick();
    insertClip(server);
    insertReward(server, "rw-1", "clip-1");

    const response = await server.app.inject({ method: "DELETE", url: "/api/clips/clip-1", headers: { cookie } });
    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe("CLIP_IN_USE");
  });

  it("borra las recompensas que lo usan y luego el clip con deleteUsingRewards", async () => {
    const { server, cookie, deleted } = await withKick();
    insertClip(server);
    insertReward(server, "rw-1", "clip-1");
    insertReward(server, "rw-2", "clip-1");

    const response = await server.app.inject({
      method: "DELETE",
      url: "/api/clips/clip-1",
      headers: { cookie, "content-type": "application/json" },
      payload: { deleteUsingRewards: true },
    });
    expect(response.statusCode).toBe(200);

    // Las recompensas se borraron en la plataforma y localmente, y el clip también.
    expect(deleted.sort()).toEqual(["kick-rw-1", "kick-rw-2"]);
    const rewards = server.db.prepare("SELECT COUNT(*) AS n FROM rewards").get() as { n: number };
    expect(rewards.n).toBe(0);
    const clips = await server.app.inject({ method: "GET", url: "/api/clips", headers: { cookie } });
    expect(clips.json().clips).toHaveLength(0);
  });

  it("valida el body (esquema estricto: tipo incorrecto rechazado)", async () => {
    const { server, cookie } = await withKick();
    insertClip(server);
    // `deleteUsingRewards` tiene que ser booleano.
    const response = await server.app.inject({
      method: "DELETE",
      url: "/api/clips/clip-1",
      headers: { cookie, "content-type": "application/json" },
      payload: { deleteUsingRewards: "sí" },
    });
    expect(response.statusCode).toBe(400);
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

  it("cambiar el recorte de un clip encolado no altera el ítem ya en la cola", async () => {
    // B5: el recorte viaja en los parámetros del ítem al encolar, así que
    // cambiarlo después no interrumpe ni altera lo que ya está sonando/en cola.
    const { server, cookie } = await withServer();
    insertClip(server);
    const enqueued = await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/play",
      headers: { cookie },
      payload: { trimStart: 1, trimEnd: 3 },
    });
    expect(enqueued.statusCode).toBe(200);

    // Se cambia el recorte guardado del clip.
    await server.app.inject({
      method: "POST",
      url: "/api/clips/vid/trim",
      headers: { cookie },
      payload: { trimStart: null, trimEnd: null },
    });

    // El ítem en la cola conserva el recorte con el que se encoló.
    const state = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    const current = state.json().current;
    expect(current.params.trimStart).toBe(1);
    expect(current.params.trimEnd).toBe(3);
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
    // El mensaje lleva la URL del archivo (mp4 para videos) con la clave del
    // overlay, igual que los audios superpuestos.
    expect(play?.url).toContain("/media/abc.mp4");

    client.close();
  });
});

describe("nombre del clip en la cola (camino de canje real)", () => {
  // Integración falsa de plataforma: una fuente `kick` cuyo `resolve` no toca la
  // red. Así el camino real (coordinador de canjes -> despacho -> motor -> cola)
  // funciona sin vincular una cuenta de verdad, sin saltarse ninguna capa.
  function makeFakeIntegration(): PlatformIntegration {
    class FakeKickSource extends EmitterEventSource {
      async resolve(): Promise<void> {
        /* El adaptador real habla con la API; acá no hace falta. */
      }
    }
    const source = new FakeKickSource({
      id: "kick",
      platform: "kick",
      capabilities: { types: ["reward_redeemed"], resolve: true },
    });
    const account = {
      id: "kick",
      platform: "kick",
      name: "Kick",
      state: "connected" as const,
      accountId: "u1",
      accountName: "Canal",
      capabilities: source.capabilities,
      hasCredentials: true,
      clientId: "cid",
      lastError: null,
    };
    const notImplemented = async (): Promise<never> => {
      throw new Error("no implementado en el test");
    };
    return {
      id: "kick",
      platform: "kick",
      name: "Kick",
      source,
      status: () => account,
      setCredentials: notImplemented,
      clearCredentials: async () => {},
      beginLink: notImplemented,
      completeLink: notImplemented,
      unlink: async () => {},
      test: notImplemented,
      diagnostics: () => ({
        enabled: true,
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
      stop: async () => {},
    };
  }

  async function setup(): Promise<Ctx> {
    const { mediaDir } = makeMediaDir();
    const server = await createServer({
      mediaDir,
      db: openMemoryDatabase(),
      requireOverlay: false,
      platforms: [makeFakeIntegration()],
    });
    created.push(server);
    await server.app.ready();
    await server.auth.setPassword(PASSWORD);
    const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;

    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES ('clip-1','https://x/y','Goku Ahhh!',4,4,'clip-1.mp4','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    // Recompensa local con su regla interna 1:1 (trigger reward_redeemed).
    server.db
      .prepare(
        `INSERT INTO rewards (id, platform, remote_reward_id, title, cost, color, description,
           clip_id, volume, max_duration_sec, cooldown_sec, repetition, audio_only, desired_enabled,
           managed, synced, rule_id, created_at, updated_at)
         VALUES ('local-1','kick','rw-1','test123',100,'#64f7d9','', 'clip-1',1,30,0,'queue',0,1,1,1,'rule-1',
           '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    server.db
      .prepare(
        `INSERT INTO rules (id, name, enabled, trigger_json, conditions_json, action_json, created_at, updated_at)
         VALUES ('rule-1','Recompensa: test123',1,
           '{"type":"reward_redeemed","rewardId":"rw-1"}',
           '{"permission":"everyone"}',
           '{"kind":"play_clip","clipId":"clip-1","label":"test123"}',
           '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    // El motor lee las reglas de la base al arrancar: replicamos ese paso.
    server.engine.setRules(listRules(server.db).map(toRule));
    return { server, mediaDir, cookie };
  }

  it("un canje real llega a /api/state con el nombre del clip", async () => {
    const { server, cookie } = await setup();
    const event = createEvent({
      id: "c1",
      platform: "kick",
      type: "reward_redeemed",
      user: { id: "u1", name: "Ana", roles: [] },
      payload: { rewardId: "rw-1", rewardTitle: "test123", userInput: "" },
    });

    const received = await server.coordinator.receive(event);
    expect(received.status).toBe("accepted");

    const state = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    const body = state.json();
    // `title` es el nombre del clip resuelto; `label` el de la recompensa.
    expect(body.current.title).toBe("Goku Ahhh!");
    expect(body.current.label).toBe("test123");
  });

  it("el simulador (mismo camino del motor) también trae el nombre", async () => {
    const { server, cookie } = await setup();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/simulate",
      headers: { cookie },
      payload: { type: "reward_redeemed", rewardId: "rw-1", rewardTitle: "test123", userInput: "" },
    });
    expect(response.statusCode).toBe(200);
    const state = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    const body = state.json();
    expect(body.current.title).toBe("Goku Ahhh!");
    expect(body.current.label).toBe("test123");
  });

  it("si el clip se borra, el nombre pasa a 'Clip no disponible' (nunca el id)", async () => {
    const { server, cookie } = await setup();
    const event = createEvent({
      id: "c2",
      platform: "kick",
      type: "reward_redeemed",
      user: { id: "u1", name: "Ana", roles: [] },
      payload: { rewardId: "rw-1", rewardTitle: "test123", userInput: "" },
    });
    await server.coordinator.receive(event);

    // Borramos la fila del clip (simula un clip desaparecido).
    server.db.prepare("DELETE FROM clips WHERE id = 'clip-1'").run();

    const state = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    const body = state.json();
    expect(body.current.title).toBe("Clip no disponible");
    expect(body.current.title).not.toContain("clip-1");
  });
});

describe("audioOnly en todos los caminos que encolan", () => {
  async function withServer2(): Promise<Ctx> {
    const { server, mediaDir, cookie } = await withServer();
    return { server, mediaDir, cookie };
  }

  it("la acción del motor (canje real/simulador) propaga audioOnly a params", async () => {
    const { server, cookie } = await withServer2();
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES ('clip-1','https://x/y','Goku',4,4,'clip-1.mp4','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    server.db
      .prepare(
        `INSERT INTO rules (id, name, enabled, trigger_json, conditions_json, action_json, created_at, updated_at)
         VALUES ('rule-1','R',1, '{"type":"reward_redeemed","rewardId":"rw-1"}',
           '{"permission":"everyone"}',
           '{"kind":"play_clip","clipId":"clip-1","audioOnly":true}',
           '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      )
      .run();
    server.engine.setRules(listRules(server.db).map(toRule));

    const response = await server.app.inject({
      method: "POST",
      url: "/api/simulate",
      headers: { cookie },
      payload: { type: "reward_redeemed", rewardId: "rw-1", rewardTitle: "R", userInput: "" },
    });
    expect(response.statusCode).toBe(200);

    const state = await server.app.inject({ method: "GET", url: "/api/state", headers: { cookie } });
    // Sin overlay, el ítem queda pendiente, pero con sus params ya resueltos.
    const item = state.json().current ?? state.json().pending[0];
    expect(item.params.audioOnly).toBe(true);
  });

  it("Probar alerta de la recompensa propaga audioOnly (config sin guardar)", async () => {
    const { server, cookie } = await withServer2();
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES ('clip-1','https://x/y','Goku',4,4,'clip-1.mp4','2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const response = await server.app.inject({
      method: "POST",
      url: "/api/clips/clip-1/play",
      headers: { cookie },
      payload: { repetition: "queue", audioOnly: true, trimStart: 0, trimEnd: 2 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.item.params.audioOnly).toBe(true);
    expect(body.item.params.trimEnd).toBe(2);
  });

  it("Probar alerta de la biblioteca (el clip solo) siempre es con imagen", async () => {
    const { server, cookie } = await withServer2();
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at)
         VALUES ('clip-1','https://x/y','Goku',4,4,'clip-1.mp4','2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const response = await server.app.inject({
      method: "POST",
      url: "/api/clips/clip-1/play",
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().item.params.audioOnly).toBe(false);
  });

  it("Probar alerta de la biblioteca de un clip sin imagen fuerza audioOnly", async () => {
    const { server, cookie } = await withServer2();
    server.db
      .prepare(
        `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, has_video, created_at)
         VALUES ('clip-a','local','Tema',10,10,'clip-a.m4a',0,'2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const response = await server.app.inject({
      method: "POST",
      url: "/api/clips/clip-a/play",
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    // Un clip que es un archivo de audio se reproduce sin mostrar imagen.
    expect(response.json().item.params.audioOnly).toBe(true);
  });
});