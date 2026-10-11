/**
 * Tests de las rutas de plataformas (Fase 4B) con una integración falsa inyectada.
 *
 * Cubren: el callback OAuth público (/callback), las rutas /api/platforms/* con y
 * sin sesión, y que ningún secreto salga en las respuestas. No se toca la red real
 * ni se conoce ninguna plataforma concreta.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../db/index.ts";
import type {
  AccountLinkState,
  PlatformAccount,
  PlatformIntegration,
  RewardInput,
  RewardView,
} from "../platforms/integration.ts";
import type { EventSource } from "../events/index.ts";
import { SESSION_COOKIE } from "./auth.ts";
import { createServer, type AppServer } from "./server.ts";

const SECRET = "SUPER-SECRET-MUST-NOT-LEAK";
const ORIGIN = "http://127.0.0.1:8787";

const created: AppServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (created.length > 0) await (created.pop() as AppServer).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeMediaDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "platforms-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return mediaDir;
}

/** Integración falsa, genérica: no conoce ninguna plataforma real. */
function fakeIntegration() {
  const calls: string[] = [];
  let state: AccountLinkState = "unlinked";
  let clientId: string | null = null;
  let secret: string | null = null;
  const rewards = new Map<string, RewardView>();
  let nextId = 1;

  const source: EventSource = {
    id: "fake-source",
    platform: "fake",
    capabilities: { types: [], resolve: false },
    start: () => {},
    stop: () => {},
    onEvent: () => () => {},
  };

  const integration: PlatformIntegration = {
    id: "fake",
    platform: "fake",
    name: "Fake",
    source,
    status(): PlatformAccount {
      return {
        id: "fake",
        platform: "fake",
        name: "Fake",
        state,
        accountId: state === "connected" ? "u-1" : null,
        accountName: state === "connected" ? "streamer" : null,
        capabilities: source.capabilities,
        hasCredentials: clientId !== null,
        clientId,
        lastError: null,
      };
    },
    async setCredentials(input) {
      clientId = input.clientId;
      if (input.clientSecret) secret = input.clientSecret;
      return { ok: true, value: integration.status() };
    },
    async clearCredentials() {
      clientId = null;
      secret = null;
      state = "unlinked";
    },
    async beginLink(redirectUri) {
      calls.push(`beginLink:${redirectUri}`);
      return { ok: true, value: { authorizeUrl: "https://auth.test/?state=s1", expiresAt: 1 } };
    },
    async completeLink(query) {
      calls.push(`completeLink:${query.toString()}`);
      if (query.get("code")) {
        state = "connected";
        return { ok: true };
      }
      return { ok: false, message: "sin code" };
    },
    async unlink() {
      state = "unlinked";
    },
    async test() {
      return { ok: true, message: "Conexión correcta", accountName: "streamer", rewards: rewards.size };
    },
    diagnostics() {
      return {
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
      };
    },
    async listRewards() {
      return { ok: true, value: [...rewards.values()] };
    },
    async createReward(input: RewardInput) {
      const id = `rw-${nextId++}`;
      const view: RewardView = {
        id,
        title: input.title,
        cost: input.cost,
        description: input.description ?? "",
        color: input.color ?? "#00e701",
        enabled: input.enabled ?? true,
        paused: false,
        userInputRequired: input.userInputRequired ?? false,
        skipRequestQueue: input.skipRequestQueue ?? false,
        managed: true,
      };
      rewards.set(id, view);
      return { ok: true, value: view };
    },
    async updateReward(id, input) {
      const current = rewards.get(id);
      if (!current) return { ok: false, reason: "HTTP_404", message: "No existe." };
      const updated = { ...current, ...input } as RewardView;
      rewards.set(id, updated);
      return { ok: true, value: updated };
    },
    async deleteReward(id) {
      rewards.delete(id);
      return { ok: true, value: { id } };
    },
    async start() {},
    async stop() {},
  };

  return { integration, calls, getSecret: () => secret };
}

interface Ctx {
  server: AppServer;
  fake: ReturnType<typeof fakeIntegration>;
  cookie: string;
}

async function withServer(): Promise<Ctx> {
  const fake = fakeIntegration();
  const server = await createServer({
    mediaDir: makeMediaDir(),
    db: openMemoryDatabase(),
    requireOverlay: false,
    platforms: [fake.integration],
  });
  created.push(server);
  await server.app.ready();
  await server.auth.setPassword("password123");
  const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;
  return { server, fake, cookie };
}

describe("GET /callback (público, sin cookie)", () => {
  it("procesa el callback y redirige al dashboard sin parámetros sensibles", async () => {
    const { server, fake } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/callback?state=s1&code=xyz" });
    expect(response.statusCode).toBe(302);
    expect(response.headers["location"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(response.headers["location"]).not.toContain("code");
    expect(fake.calls.some((call) => call.includes("code=xyz"))).toBe(true);
  });

  it("no requiere sesión y responde igual ante un error de autorización", async () => {
    const { server, fake } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/callback?error=access_denied" });
    expect(response.statusCode).toBe(302);
    expect(fake.calls.some((call) => call.includes("error=access_denied"))).toBe(true);
  });
});

describe("/api/platforms requiere sesión", () => {
  it("sin sesión devuelve 401", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/api/platforms" });
    expect(response.statusCode).toBe(401);
  });

  it("con sesión lista las plataformas de forma genérica", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/api/platforms", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; platforms: Array<{ name: string; state: string }> };
    expect(body.ok).toBe(true);
    expect(body.platforms[0]).toMatchObject({ name: "Fake", state: "unlinked" });
  });
});

describe("/api/platforms/* : flujo de vínculo y credenciales", () => {
  it("rechaza un POST con Origin de otro sitio (CSRF)", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/link",
      headers: { cookie, origin: "http://evil.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ reason: "BAD_ORIGIN" });
  });

  it("guarda credenciales sin devolver el secreto, e inicia el vínculo", async () => {
    const { server, fake, cookie } = await withServer();
    const saved = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/credentials",
      headers: { cookie, origin: ORIGIN },
      payload: { clientId: "cid", clientSecret: SECRET },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(SECRET);
    expect(fake.getSecret()).toBe(SECRET);

    const link = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/link",
      headers: { cookie, origin: ORIGIN },
    });
    expect(link.statusCode).toBe(200);
    expect(link.json()).toMatchObject({ ok: true, authorizeUrl: "https://auth.test/?state=s1" });
    // El redirect_uri se arma con localhost (bug conocido del alta de apps de Kick).
    expect(fake.calls.some((call) => call === "beginLink:http://localhost:8787/callback")).toBe(true);
  });

  it("'Probar conexión' y diagnóstico responden sin secretos", async () => {
    const { server, cookie } = await withServer();
    const test = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/test",
      headers: { cookie, origin: ORIGIN },
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({ ok: true, accountName: "streamer" });

    const diagnostics = await server.app.inject({
      method: "GET",
      url: "/api/platforms/fake/diagnostics",
      headers: { cookie },
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.body).not.toContain(SECRET);
  });

  it("una plataforma desconocida devuelve 404", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/api/platforms/nope", headers: { cookie } });
    expect(response.statusCode).toBe(404);
  });
});

describe("/api/platforms/* : recompensas y regla asociada", () => {
  it("crea una recompensa sin regla", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 100 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, rule: null });
  });

  it("crea una recompensa con una regla de clip fijo en el mismo formulario", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 50, rule: { mode: "play_clip", clipId: "clip-1" } },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { rule: { trigger: { rewardId: string } } | null };
    expect(body.rule?.trigger.rewardId).toBe("rw-1");
  });

  it("avisa si a la regla le falta el clip, sin romper", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 50, rule: { mode: "play_clip" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, rule: null });
    expect((response.json() as { ruleWarning?: string }).ruleWarning).toBeTruthy();
  });

  it("borra una recompensa y limpia sus reglas (sin tocar clips)", async () => {
    const { server, cookie } = await withServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 50, rule: { mode: "play_clip", clipId: "clip-1" } },
    });
    expect(created.statusCode).toBe(200);

    const removed = await server.app.inject({
      method: "DELETE",
      url: "/api/platforms/fake/rewards/rw-1",
      headers: { cookie, origin: ORIGIN },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, id: "rw-1", rulesRemoved: 1 });
  });
});