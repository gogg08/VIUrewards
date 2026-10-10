/**
 * Tests de la integración de Kick (Fase 4B) contra un servidor Kick falso.
 *
 * Cubren: el vínculo OAuth (beginLink/completeLink), la resolución del nombre de
 * cuenta vía `GET /public/v1/users` sin ids, el CRUD de recompensas con la marca
 * `managed`, la pérdida de acceso (401 → requires_relink) y que ni el token ni el
 * client secret aparezcan en el estado, el diagnóstico ni los logs.
 */

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../../db/index.ts";
import { KickIntegration } from "./integration.ts";

const ACCESS_TOKEN = "ACCESS-TOKEN-SECRET";
const REFRESH_TOKEN = "REFRESH-TOKEN-SECRET";
const CLIENT_SECRET = "CLIENT-SECRET-DO-NOT-LEAK";
const CLIENT_ID = "my-client-id";

interface FakeReward {
  id: string;
  title: string;
  cost: number;
  description: string;
  background_color: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_user_input_required: boolean;
  should_redemptions_skip_request_queue: boolean;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Servidor Kick falso con endpoints de OAuth, usuarios y recompensas. */
function fakeKick() {
  const calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = [];
  const rewards = new Map<string, FakeReward>();
  let rewardsStatus = 200;

  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.pathname + url.search,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers.get("authorization"),
    });

    if (url.hostname === "id.test" && url.pathname === "/oauth/token") {
      return json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, scope: "user:read" });
    }
    if (url.pathname === "/public/v1/users") {
      const ids = url.searchParams.getAll("id");
      if (ids.length === 0) return json({ data: [{ user_id: 42, name: "streamer" }] });
      const data = ids.map((id) => ({ user_id: Number(id), name: `user-${id}` }));
      return json({ data });
    }
    if (url.pathname === "/public/v1/channels/rewards") {
      if (rewardsStatus !== 200) return new Response("boom", { status: rewardsStatus });
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        const created: FakeReward = {
          id: "rw-new",
          title: String(body.title),
          cost: Number(body.cost),
          description: String(body.description ?? ""),
          background_color: String(body.background_color ?? "#00e701"),
          is_enabled: body.is_enabled !== false,
          is_paused: false,
          is_user_input_required: body.is_user_input_required === true,
          should_redemptions_skip_request_queue: body.should_redemptions_skip_request_queue === true,
        };
        rewards.set(created.id, created);
        return json({ data: created });
      }
      return json({ data: [...rewards.values()] });
    }
    const rewardMatch = url.pathname.match(/^\/public\/v1\/channels\/rewards\/([^/]+)$/);
    if (rewardMatch) {
      const id = decodeURIComponent(rewardMatch[1]);
      if (init?.method === "PATCH") {
        const patch = JSON.parse(init.body as string) as Record<string, unknown>;
        const current = rewards.get(id);
        if (!current) return new Response("not found", { status: 404 });
        const updated = { ...current, ...patch } as FakeReward;
        updated.id = current.id;
        rewards.set(id, updated);
        return json({ data: updated });
      }
      if (init?.method === "DELETE") {
        if (!rewards.has(id)) return new Response("not found", { status: 404 });
        rewards.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    return new Response("not found", { status: 404 });
  };

  return { fetchFn, calls, rewards, setRewardsStatus: (status: number) => (rewardsStatus = status) };
}

const running: KickIntegration[] = [];

function makeIntegration(fake: ReturnType<typeof fakeKick>, extra: { logger?: (m: string) => void } = {}) {
  const integration = new KickIntegration({
    db: openMemoryDatabase(),
    fetchFn: fake.fetchFn,
    apiBaseUrl: "https://api.test",
    idBaseUrl: "https://id.test",
    pollIntervalMs: () => 60_000,
    logger: extra.logger,
  });
  running.push(integration);
  return integration;
}

/** Vincula la cuenta de punta a punta con el servidor falso. */
async function link(integration: KickIntegration) {
  await integration.setCredentials({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const start = await integration.beginLink("http://localhost:8787/callback");
  if (!start.ok) throw new Error("beginLink falló");
  const state = new URL(start.value.authorizeUrl).searchParams.get("state");
  if (!state) throw new Error("sin state");
  return integration.completeLink(new URLSearchParams({ state, code: "auth-code" }));
}

afterEach(async () => {
  while (running.length > 0) await (running.pop() as KickIntegration).stop();
});

describe("KickIntegration: vínculo OAuth", () => {
  it("guarda las credenciales sin exponer el secreto", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    const result = await integration.setCredentials({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(result.ok).toBe(true);
    const status = integration.status();
    expect(status.hasCredentials).toBe(true);
    expect(status.clientId).toBe(CLIENT_ID);
    expect(JSON.stringify(status)).not.toContain(CLIENT_SECRET);
  });

  it("arma la URL de autorización con PKCE S256 y completa el vínculo resolviendo la cuenta", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    await integration.setCredentials({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const start = await integration.beginLink("http://localhost:8787/callback");
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const url = new URL(start.value.authorizeUrl);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")).toContain("channel:rewards:read");

    const state = url.searchParams.get("state") as string;
    const complete = await integration.completeLink(new URLSearchParams({ state, code: "auth-code" }));
    expect(complete.ok).toBe(true);
    const status = integration.status();
    expect(status.state).toBe("connected");
    expect(status.accountName).toBe("streamer");
    expect(status.accountId).toBe("42");
  });

  it("rechaza un state desconocido y no cambia el estado del vínculo", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    await integration.setCredentials({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const complete = await integration.completeLink(new URLSearchParams({ state: "inventado", code: "x" }));
    expect(complete.ok).toBe(false);
    expect(integration.status().state).toBe("unlinked");
  });

  it("no devuelve tokens ni secretos en el estado, el diagnóstico ni los logs", async () => {
    const logs: string[] = [];
    const fake = fakeKick();
    const integration = makeIntegration(fake, { logger: (m) => logs.push(m) });
    await link(integration);
    const status = integration.status();
    const diagnostics = integration.diagnostics();
    const everything = JSON.stringify({ status, diagnostics, logs });
    expect(everything).not.toContain(ACCESS_TOKEN);
    expect(everything).not.toContain(REFRESH_TOKEN);
    expect(everything).not.toContain(CLIENT_SECRET);
  });
});

describe("KickIntegration: recompensas", () => {
  it("crea una recompensa y la marca como administrada por la app", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    await link(integration);
    const created = await integration.createReward({
      title: "Alerta",
      cost: 100,
      description: "desc",
      userInputRequired: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.id).toBe("rw-new");
    expect(created.value.managed).toBe(true);
    expect(created.value.userInputRequired).toBe(true);

    const list = await integration.listRewards();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.find((r) => r.id === "rw-new")?.managed).toBe(true);
  });

  it("solo deja editar o borrar las recompensas creadas por la app", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    await link(integration);
    const update = await integration.updateReward("rw-ajena", { title: "x" });
    expect(update).toMatchObject({ ok: false, reason: "NOT_MANAGED" });
    const remove = await integration.deleteReward("rw-ajena");
    expect(remove).toMatchObject({ ok: false, reason: "NOT_MANAGED" });
  });

  it("edita y borra una recompensa administrada, y deja de marcarla", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    await link(integration);
    const created = await integration.createReward({ title: "Alerta", cost: 10 });
    if (!created.ok) throw new Error("no se creó");
    const updated = await integration.updateReward(created.value.id, { cost: 20 });
    expect(updated).toMatchObject({ ok: true, value: { cost: 20 } });
    const removed = await integration.deleteReward(created.value.id);
    expect(removed.ok).toBe(true);
    const list = await integration.listRewards();
    if (!list.ok) throw new Error("no listó");
    expect(list.value.some((r) => r.id === created.value.id)).toBe(false);
  });
});

describe("KickIntegration: pérdida de acceso", () => {
  it("un 401 en la API marca el vínculo como 'requires_relink'", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    await link(integration);
    fake.setRewardsStatus(401);
    const result = await integration.test();
    expect(result.ok).toBe(false);
    expect(integration.status().state).toBe("requires_relink");
  });

  it("'Probar conexión' devuelve el nombre de la cuenta y el total de recompensas", async () => {
    const fake = fakeKick();
    const integration = makeIntegration(fake);
    await link(integration);
    await integration.createReward({ title: "Alerta", cost: 10 });
    const result = await integration.test();
    expect(result).toMatchObject({ ok: true, accountName: "streamer", rewards: 1 });
  });
});