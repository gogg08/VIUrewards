/**
 * Integración de la API de reglas, historial y moderación (Fase 4A).
 *
 * Usa `app.inject` (sin socket) y una fuente simulada; el motor se ejercita de
 * punta a punta. Cubre: sesión requerida, alta/edición/baja de reglas, simulación
 * de eventos, historial y el flujo aprobar -> descargar -> encolar con `resolve`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase, upsertClip } from "../db/index.ts";
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
    conditions: { permission: "everyone", cooldownSec: 0, userCooldownSec: 0 },
    action: { kind: "play_clip", clipId: "clip-1" },
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
    await postJson(ctx, "/api/rules", playRuleBody({ conditions: { permission: "mods", cooldownSec: 0, userCooldownSec: 0 } }));

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

describe("moderación de punta a punta", () => {
  it("propone, lista, aprueba, descarga, encola y resuelve", async () => {
    const ctx = await withServer();
    await postJson(ctx, "/api/rules", playRuleBody({
      name: "Propuestas",
      trigger: { type: "chat_command", command: "alerta" },
      action: { kind: "submit_url", autoApprove: false },
    }));

    // El público propone una URL por el chat.
    await postJson(ctx, "/api/simulate", {
      type: "chat_command",
      command: "alerta",
      args: ["https://www.youtube.com/watch?v=abc12345678"],
      userName: "Ana",
      userId: "u1",
    });

    const pending = await waitFor(async () => {
      const response = await ctx.server.app.inject({ method: "GET", url: "/api/moderation?status=pending", headers: { cookie: ctx.cookie } });
      const proposals = response.json().proposals;
      return proposals.length > 0 ? proposals : null;
    });
    const proposalId = pending[0].id as string;

    // Rechazar/aceptar por API.
    const approved = await postJson(ctx, `/api/moderation/${proposalId}/approve`, {});
    expect(approved.statusCode).toBe(200);

    // La descarga (fake) corre en segundo plano y la propuesta queda lista.
    const ready = await waitFor(async () => {
      const response = await ctx.server.app.inject({ method: "GET", url: "/api/moderation", headers: { cookie: ctx.cookie } });
      const proposal = response.json().proposals.find((p: { id: string }) => p.id === proposalId);
      return proposal && proposal.status === "ready" ? proposal : null;
    });
    expect(ready.clipId).toBeTruthy();

    // El clip aprobado se encola para el overlay.
    const state = await waitFor(async () => {
      const response = await ctx.server.app.inject({ method: "GET", url: "/api/state", headers: { cookie: ctx.cookie } });
      const state = response.json();
      return state.current && state.current.clipId === ready.clipId ? state : null;
    });
    expect(state.current.label).toBe("Ana");

    // La plataforma simulada registró el resolve "accept".
    expect(ctx.server.simulatedSource.getResolutions().some((r) => r.outcome === "accept")).toBe(true);
  });

  it("rechazar no dispara descarga", async () => {
    const ctx = await withServer();
    await postJson(ctx, "/api/rules", playRuleBody({
      trigger: { type: "chat_command", command: "alerta" },
      action: { kind: "submit_url", autoApprove: false },
    }));
    await postJson(ctx, "/api/simulate", {
      type: "chat_command",
      command: "alerta",
      args: ["https://youtu.be/xyz"],
      userName: "Ana",
      userId: "u1",
    });

    const pending = await waitFor(async () => {
      const response = await ctx.server.app.inject({ method: "GET", url: "/api/moderation?status=pending", headers: { cookie: ctx.cookie } });
      const proposals = response.json().proposals;
      return proposals.length > 0 ? proposals : null;
    });

    const rejected = await postJson(ctx, `/api/moderation/${pending[0].id}/reject`, {});
    expect(rejected.statusCode).toBe(200);
    expect(ctx.server.jobs.list()).toHaveLength(0);
  });

  it("plantilla de clip en la base para referencias de la UI", async () => {
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
    });
    const clips = (await ctx.server.app.inject({ method: "GET", url: "/api/clips", headers: { cookie: ctx.cookie } })).json();
    expect(clips.clips[0].id).toBe("clip-x");
  });
});