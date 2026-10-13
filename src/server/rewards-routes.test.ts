/**
 * Tests de las rutas de recompensas (rediseño, Etapa 4A) con una integración
 * falsa inyectada. Cubren sesión, origen (CSRF), la vista unificada, crear,
 * desactivar con canjes pendientes y borrar. No se toca la red real.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase, upsertClip } from "../db/index.ts";
import type { EventSource } from "../events/index.ts";
import type {
  AccountLinkState,
  PlatformIntegration,
  RedemptionRejectFailure,
  RewardView,
} from "../platforms/integration.ts";
import { SESSION_COOKIE } from "./auth.ts";
import { createServer, type AppServer } from "./server.ts";

const CLIP_ID = "clip-1";
const ORIGIN = "http://127.0.0.1:8787";

const created: AppServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (created.length > 0) await (created.pop() as AppServer).stop();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeMediaDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "rewards-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return mediaDir;
}

function fakeIntegration() {
  const remote = new Map<string, RewardView>();
  const pending = new Map<string, string[]>();
  let state: AccountLinkState = "connected";
  let nextId = 1;
  const rejected: string[][] = [];

  const source: EventSource = {
    id: "fake-source",
    platform: "fake",
    capabilities: { types: ["reward_redeemed"], resolve: true },
    start: () => {},
    stop: () => {},
    onEvent: () => () => {},
  };

  const integration: PlatformIntegration = {
    id: "fake",
    platform: "fake",
    name: "Fake",
    source,
    status() {
      return {
        id: "fake",
        platform: "fake",
        name: "Fake",
        state,
        accountId: state === "connected" ? "u-1" : null,
        accountName: state === "connected" ? "streamer" : null,
        capabilities: source.capabilities,
        hasCredentials: true,
        clientId: "cid",
        lastError: null,
      };
    },
    async setCredentials() {
      return { ok: true, value: integration.status() };
    },
    async clearCredentials() {},
    async beginLink() {
      return { ok: true, value: { authorizeUrl: "https://auth.test", expiresAt: 0 } };
    },
    async completeLink() {
      return { ok: true };
    },
    async unlink() {
      state = "unlinked";
    },
    async test() {
      return { ok: true, message: "ok", rewards: remote.size };
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
      return { ok: true, value: [...remote.values()] };
    },
    async createReward(input) {
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
        skipRequestQueue: false,
        managed: true,
      };
      remote.set(id, view);
      return { ok: true, value: view };
    },
    async updateReward(id, input) {
      const current = remote.get(id);
      if (!current) return { ok: false, reason: "HTTP_404", message: "No existe." };
      const updated = { ...current, ...input, id } as RewardView;
      remote.set(id, updated);
      return { ok: true, value: updated };
    },
    async deleteReward(id) {
      remote.delete(id);
      return { ok: true, value: { id } };
    },
    async listPendingRedemptions(rewardId) {
      return { ok: true, value: [...(pending.get(rewardId) ?? [])] };
    },
    async rejectRedemptions(ids) {
      rejected.push([...ids]);
      for (const [rewardId, list] of pending) pending.set(rewardId, list.filter((id) => !ids.includes(id)));
      return { ok: true, value: [] as RedemptionRejectFailure[] };
    },
    async start() {},
    async stop() {},
  };

  return { integration, remote, pending, rejected, setState: (s: AccountLinkState) => (state = s) };
}

async function withServer() {
  const fake = fakeIntegration();
  const server = await createServer({
    mediaDir: makeMediaDir(),
    db: openMemoryDatabase(),
    requireOverlay: false,
    platforms: [fake.integration],
  });
  created.push(server);
  upsertClip(server.db, {
    id: CLIP_ID,
    sourceUrl: "https://youtube.com/watch?v=x",
    title: "Mi clip",
    durationSec: 10,
    sizeBytes: 1,
    file: `${CLIP_ID}.mp4`,
    createdAt: new Date().toISOString(),
    trimStart: null,
    trimEnd: null,
    audioOnly: false,
  });
  await server.app.ready();
  await server.auth.setPassword("password123");
  const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;
  return { server, fake, cookie };
}

describe("/api/platforms/:id/rewards requiere sesión y origen", () => {
  it("sin sesión devuelve 401", async () => {
    const { server } = await withServer();
    const response = await server.app.inject({ method: "GET", url: "/api/platforms/fake/rewards" });
    expect(response.statusCode).toBe(401);
  });

  it("rechaza una mutación con Origin de otro sitio", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: "http://evil.example" },
      payload: { title: "Alerta", cost: 100, clipId: CLIP_ID },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("vista unificada y operaciones", () => {
  it("devuelve una vista vacía al inicio", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/platforms/fake/rewards",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, connected: true, rewards: [] });
  });

  it("crea una recompensa con clip y la muestra habilitada", async () => {
    const { server, cookie } = await withServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 100, clipId: CLIP_ID },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { ok: boolean; reward: { localId: string; remoteId: string; state: string } };
    expect(body.reward.state).toBe("enabled");
    expect(body.reward.localId).toBeTruthy();

    const list = await server.app.inject({ method: "GET", url: "/api/platforms/fake/rewards", headers: { cookie } });
    const listed = list.json() as { rewards: Array<{ title: string; state: string; clipTitle: string }> };
    expect(listed.rewards[0]).toMatchObject({ title: "Alerta", state: "enabled", clipTitle: "Mi clip" });
  });

  it("exige un clip al crear", async () => {
    const { server, cookie } = await withServer();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 100 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("desactivar pide confirmación con la cantidad de pendientes y luego deshabilita", async () => {
    const { server, fake, cookie } = await withServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 100, clipId: CLIP_ID },
    });
    const localId = (created.json() as { reward: { localId: string } }).reward.localId;
    fake.pending.set("rw-1", ["red-1", "red-2"]);

    const confirm = await server.app.inject({
      method: "POST",
      url: `/api/platforms/fake/rewards/${localId}/disable`,
      headers: { cookie, origin: ORIGIN },
      payload: {},
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json()).toMatchObject({ needsConfirm: true, pending: 2 });

    const done = await server.app.inject({
      method: "POST",
      url: `/api/platforms/fake/rewards/${localId}/disable`,
      headers: { cookie, origin: ORIGIN },
      payload: { confirm: true },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ ok: true });
    expect(fake.rejected[0]).toEqual(["red-1", "red-2"]);
  });

  it("borra una recompensa y deja de aparecer", async () => {
    const { server, cookie } = await withServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/platforms/fake/rewards",
      headers: { cookie, origin: ORIGIN },
      payload: { title: "Alerta", cost: 100, clipId: CLIP_ID },
    });
    const localId = (created.json() as { reward: { localId: string } }).reward.localId;
    const removed = await server.app.inject({
      method: "DELETE",
      url: `/api/platforms/fake/rewards/${localId}`,
      headers: { cookie, origin: ORIGIN },
      payload: {},
    });
    expect(removed.statusCode).toBe(200);
    const list = await server.app.inject({ method: "GET", url: "/api/platforms/fake/rewards", headers: { cookie } });
    expect((list.json() as { rewards: unknown[] }).rewards).toHaveLength(0);
  });
});