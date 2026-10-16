/**
 * Integración de la API de reglas e historial (Fase 4A).
 *
 * Usa `app.inject` (sin socket) y una fuente simulada; el motor se ejercita de
 * punta a punta. Cubre: sesión requerida, alta/edición/baja de reglas, simulación
 * de eventos e historial.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase, upsertClip, upsertReward, type ClipRecord, type RewardRecord } from "../db/index.ts";
import type { ProcessResult, RunProcess } from "../media/run-process.ts";
import type { RuleRecord } from "../db/index.ts";
import { createServer, type AppServer } from "./server.ts";
import { SESSION_COOKIE } from "./auth.ts";

const created: AppServer[] = [];
const dirs: string[] = [];

const PASSWORD = "password123";

function makeMediaDir(): { mediaDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "rules-api-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return { mediaDir, parent };
}

afterEach(async () => {
  while (created.length > 0) await (created.pop() as AppServer).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const binarySearch = {
  pathEnv: "/fake/bin",
  extraDirs: [] as string[],
  platform: "linux" as NodeJS.Platform,
  exists: () => true,
};

/** yt-dlp y ffmpeg "tienen éxito": crean los archivos esperados. */
function successRun(): RunProcess {
  return async (command, args): Promise<ProcessResult> => {
    if (command.includes("yt-dlp")) {
      const template = args[args.indexOf("-o") + 1];
      const source = template.replace("%(ext)s", "mp4");
      writeFileSync(source, "video-bytes");
      writeFileSync(
        source.replace(/\.src\.mp4$/, ".src.info.json"),
        JSON.stringify({ title: "Clip propuesto", duration: 10, vcodec: "avc1", acodec: "mp4a" }),
      );
    } else {
      writeFileSync(args[args.length - 1], "mp4-bytes");
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}

interface Ctx {
  server: AppServer;
  mediaDir: string;
  cookie: string;
}

async function withServer(): Promise<Ctx> {
  const { mediaDir } = makeMediaDir();
  const server = await createServer({
    mediaDir,
    db: openMemoryDatabase(),
    requireOverlay: false,
    media: { binarySearch },
    run: successRun(),
  });
  created.push(server);
  await server.app.ready();
  await server.auth.setPassword(PASSWORD);
  const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;
  return { server, mediaDir, cookie };
}

async function postJson(
  ctx: Ctx,
  url: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const response = await ctx.server.app.inject({
    method: "POST",
    url,
    headers: { cookie: ctx.cookie, origin: "http://127.0.0.1:8787" },
    payload: body,
  });
  return { statusCode: response.statusCode, json: response.json() };
}

function playRuleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Alerta de comando",
    enabled: true,
    trigger: { type: "chat_command", command: "alerta" },
    conditions: { permission: "everyone" },
    action: { kind: "play_clip", clipId: "clip-1" },
    ...overrides,
  };
}

function clipRecord(id: string, hasVideo = true): ClipRecord {
  return {
    id,
    sourceUrl: "https://www.youtube.com/watch?v=x",
    title: id,
    durationSec: 10,
    sizeBytes: 1,
    file: `${id}.mp4`,
    createdAt: new Date().toISOString(),
    trimStart: null,
    trimEnd: null,
    hasVideo,
    missing: false,
  };
}

function rewardRecord(overrides: Partial<RewardRecord> = {}): RewardRecord {
  return {
    id: "reward-1",
    platform: "fake",
    remoteRewardId: "rw-1",
    title: "Mi recompensa",
    cost: 100,
    color: "#00e701",
    description: "",
    clipId: "clip-1",
    volume: 1,
    maxDurationSec: null,
    cooldownSec: 0,
    repetition: "queue",
    audioOnly: false,
    lastFiredAt: null,
    position: null,
    enterAnimation: null,
    exitAnimation: null,
    desiredEnabled: true,
    managed: true,
    synced: true,
    ruleId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function waitFor<T>(produce: () => Promise<T | null>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("se agotó el tiempo de espera");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("API de reglas - requiere sesión", () => {
  it("GET /api/rules sin sesión devuelve 401", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/api/rules" });
    expect(response.statusCode).toBe(401);
  });

  it("rechaza un POST con Origin ajeno (CSRF)", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/rules",
      headers: { cookie, origin: "http://evil.example" },
      payload: playRuleBody(),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("API de reglas - CRUD", () => {
  it("crea, lista, edita, activa/desactiva y borra", async () => {
    const ctx = await withServer();

    const created = await postJson(ctx, "/api/rules", playRuleBody());
    expect(created.statusCode).toBe(200);
    const rule = created.json.rule as RuleRecord;
    expect(rule.name).toBe("Alerta de comando");

    const list = await ctx.server.app.inject({ method: "GET", url: "/api/rules", headers: { cookie: ctx.cookie } });
    expect(list.json().rules).toHaveLength(1);
    expect(list.json().sources.map((s: { id: string }) => s.id)).toContain("simulated");

    const toggled = await postJson(ctx, `/api/rules/${rule.id}/toggle`, { enabled: false });
    expect((toggled.json.rule as RuleRecord).enabled).toBe(false);

    const deleted = await ctx.server.app.inject({
      method: "DELETE",
      url: `/api/rules/${rule.id}`,
      headers: { cookie: ctx.cookie, origin: "http://127.0.0.1:8787" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().ok).toBe(true);
  });

  it("rechaza una regla de comando sin nombre de comando", async () => {
    const ctx = await withServer();
    const response = await postJson(ctx, "/api/rules", {
      name: "Sin comando",
      trigger: { type: "chat_command" },
      action: { kind: "play_clip", clipId: "clip-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json.reason).toBe("INVALID_RULE");
  });

  it("rechaza un clip vacío en la acción", async () => {
    const ctx = await withServer();
    const response = await postJson(ctx, "/api/rules", {
      name: "Sin clip",
      trigger: { type: "follow" },
      action: { kind: "play_clip", clipId: "" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("disparo de reglas por eventos simulados", () => {
  it("un comando de chat dispara el clip y queda en el historial", async () => {
    const ctx = await withServer();
    await postJson(ctx, "/api/rules", playRuleBody());

    const sim = await postJson(ctx, "/api/simulate", {
      type: "chat_command",
      userName: "Ana",
      userId: "u1",
      command: "alerta",
      args: [],
    });
    expect(sim.statusCode).toBe(200);

    const state = await waitFor(async () => {
      const response = await ctx.server.app.inject({ method: "GET", url: "/api/state", headers: { cookie: ctx.cookie } });
      const state = response.json();
      return state.current?.clipId === "clip-1" ? state : null;
    });
    expect(state.current.clipId).toBe("clip-1");

    const history = (await ctx.server.app.inject({ method: "GET", url: "/api/events", headers: { cookie: ctx.cookie } })).json();
    expect(history.events[0].outcome).toBe("fired");
  });

  it("respeta el permiso: un evento sin roles no dispara", async () => {
    const ctx = await withServer();
    await postJson(ctx, "/api/rules", playRuleBody({ conditions: { permission: "mods" } }));

    await postJson(ctx, "/api/simulate", { type: "chat_command", command: "alerta", userName: "Ana", userId: "u1" });

    const history = await waitFor(async () => {
      const response = await ctx.server.app.inject({ method: "GET", url: "/api/events", headers: { cookie: ctx.cookie } });
      const events = response.json().events;
      return events.length > 0 ? events : null;
    });
    expect(history[0]).toMatchObject({ outcome: "skipped", reason: "sin permiso" });
  });

  it("el botón manual emite un evento manual", async () => {
    const ctx = await withServer();
    await postJson(ctx, "/api/rules", {
      name: "Manual",
      trigger: { type: "manual" },
      action: { kind: "play_clip", clipId: "clip-manual" },
    });
    await postJson(ctx, "/api/manual", { userName: "Operador" });

    const state = await waitFor(async () => {
      const response = await ctx.server.app.inject({ method: "GET", url: "/api/state", headers: { cookie: ctx.cookie } });
      const state = response.json();
      return state.current?.clipId === "clip-manual" ? state : null;
    });
    expect(state.current.clipId).toBe("clip-manual");
  });
});

describe("API de clips", () => {
  it("lista un clip cargado en la base", async () => {
    const ctx = await withServer();
    upsertClip(ctx.server.db, {
      id: "clip-x",
      sourceUrl: "https://www.youtube.com/watch?v=x",
      title: "Un clip",
      durationSec: 10,
      sizeBytes: 1000,
      file: "clip-x.mp4",
      createdAt: new Date().toISOString(),
      trimStart: null,
      trimEnd: null,
      hasVideo: true,
      missing: false,
    });
    const clips = (await ctx.server.app.inject({ method: "GET", url: "/api/clips", headers: { cookie: ctx.cookie } })).json();
    expect(clips.clips[0].id).toBe("clip-x");
  });

  it("la marca de solo audio del clip ya no existe (se movió a la recompensa)", async () => {
    const ctx = await withServer();
    upsertClip(ctx.server.db, clipRecord("clip-a"));
    const response = await postJson(ctx, "/api/clips/clip-a/audio-only", { audioOnly: false });
    expect(response.statusCode).toBe(404);
  });
});