/**
 * Tests del KickEventSource contra un servidor Kick falso (sin red real).
 *
 * Cubren: idempotencia persistente tras reinicio, paginación por cursor, backoff
 * con Retry-After ante 429, detención ante 401 (sin bucle), lotes de 25 en
 * accept/reject, y que los tokens no aparezcan en logs.
 */

import { describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../../db/index.ts";
import type { NormalizedEvent } from "../../events/index.ts";
import { KickApi } from "./api.ts";
import { KickEventSource, PollingStats } from "./source.ts";

const SECRET_TOKEN = "SUPER-SECRET-ACCESS-TOKEN";

interface FakeRedemption {
  id: string;
  user_input: string;
  redeemed_at: string;
  status: "pending";
  redeemer: { user_id: number };
}

/** Servidor Kick falso: responde según una cola de respuestas programables. */
function fakeKick(options: { pages?: FakeRedemption[][]; users?: Record<number, string> } = {}) {
  const calls: Array<{ url: string; method: string; body: string | null; auth: string | null }> = [];
  const pages = options.pages ?? [];
  let pageIndex = 0;
  const queued: Array<() => Response> = [];

  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url: url.pathname + url.search,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      auth: headers.get("authorization"),
    });
    const next = queued.shift();
    if (next) return next();

    if (url.pathname === "/public/v1/channels/rewards/redemptions") {
      const page = pages[pageIndex] ?? [];
      const hasNext = pageIndex + 1 < pages.length;
      pageIndex += 1;
      const body = {
        data: page.length ? [{ reward: { id: "rw-1", title: "Alerta" }, redemptions: page }] : [],
        pagination: { next_cursor: hasNext ? `c${pageIndex}` : "" },
      };
      return json(body);
    }
    if (url.pathname === "/public/v1/users") {
      const ids = url.searchParams.getAll("id").map(Number);
      const data = ids.filter((id) => options.users?.[id]).map((id) => ({ user_id: id, name: options.users![id] }));
      return json({ data });
    }
    if (url.pathname.endsWith("/accept") || url.pathname.endsWith("/reject")) {
      return json({ data: [] });
    }
    return new Response("not found", { status: 404 });
  };

  return { fetchFn, calls, queue: (factory: () => Response) => queued.push(factory) };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function redemption(id: string, userId = 7, input = "https://www.youtube.com/watch?v=abc"): FakeRedemption {
  return { id, user_input: input, redeemed_at: new Date().toISOString(), status: "pending", redeemer: { user_id: userId } };
}

function makeSource(fake: ReturnType<typeof fakeKick>, db = openMemoryDatabase(), extra: { random?: () => number } = {}) {
  const stats = new PollingStats();
  const api = new KickApi({
    apiBaseUrl: "https://api.test",
    fetchFn: fake.fetchFn,
    accessToken: async () => SECRET_TOKEN,
    onRateLimit: stats.observeRateLimit,
  });
  const source = new KickEventSource({ api, db, stats, random: extra.random ?? (() => 0), intervalMs: () => 1000 });
  const events: NormalizedEvent[] = [];
  source.onEvent((event) => {
    events.push(event);
  });
  return { source, db, stats, events, api };
}

describe("KickEventSource: detección y emisión", () => {
  it("emite cada canje pendiente como reward_redeemed con el nombre resuelto", async () => {
    const fake = fakeKick({ pages: [[redemption("r1", 7, "hola")]], users: { 7: "viewer" } });
    const h = makeSource(fake);
    await h.source.pollOnce();
    expect(h.events).toHaveLength(1);
    const [event] = h.events;
    expect(event.id).toBe("r1");
    expect(event.platform).toBe("kick");
    expect(event.type).toBe("reward_redeemed");
    expect(event.user.name).toBe("viewer");
    expect(event.payload).toMatchObject({ rewardId: "rw-1", rewardTitle: "Alerta", userInput: "hola" });
  });

  it("no vuelve a emitir un canje ya procesado, aunque se reinicie la fuente", async () => {
    const db = openMemoryDatabase();
    const fake = fakeKick({ pages: [[redemption("r1")], [redemption("r1")]], users: { 7: "viewer" } });
    const first = makeSource(fake, db);
    await first.source.pollOnce();
    expect(first.events).toHaveLength(1);

    // "Reinicio": nueva instancia, misma base de datos.
    const second = makeSource(fake, db);
    await second.source.pollOnce();
    expect(second.events).toHaveLength(0);
  });

  it("sigue la paginación por cursor hasta agotar las páginas", async () => {
    const fake = fakeKick({ pages: [[redemption("a")], [redemption("b")]], users: { 7: "viewer" } });
    const h = makeSource(fake);
    await h.source.pollOnce();
    expect(h.events.map((e) => e.id)).toEqual(["a", "b"]);
    const listCalls = fake.calls.filter((c) => c.url.startsWith("/public/v1/channels/rewards/redemptions"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].url).toContain("cursor=");
  });

  it("resuelve el nombre de usuario una sola vez gracias a la caché", async () => {
    const fake = fakeKick({ pages: [[redemption("a", 7)], [redemption("b", 7)]], users: { 7: "viewer" } });
    const h = makeSource(fake);
    await h.source.pollOnce();
    await h.source.pollOnce();
    const userCalls = fake.calls.filter((c) => c.url.startsWith("/public/v1/users"));
    expect(userCalls.length).toBeLessThanOrEqual(1);
  });

  it("el texto del espectador llega como texto, sin validarlo (la validación es aguas abajo)", async () => {
    const hostile = "; rm -rf / && --exec evil";
    const fake = fakeKick({ pages: [[redemption("h", 7, hostile)]], users: { 7: "viewer" } });
    const h = makeSource(fake);
    await h.source.pollOnce();
    expect(h.events[0].payload).toMatchObject({ userInput: hostile });
  });
});

describe("KickEventSource: errores, backoff y parada", () => {
  it("ante 429 con Retry-After espera al menos ese tiempo y cuenta el 429", async () => {
    const fake = fakeKick({ pages: [[redemption("a")]], users: { 7: "viewer" } });
    fake.queue(() => new Response("slow", { status: 429, headers: { "retry-after": "7", "x-ratelimit-remaining": "0" } }));
    const h = makeSource(fake);
    await h.source.pollOnce();
    expect(h.events).toHaveLength(0);
    expect(h.stats.snapshot().rateLimit429Count).toBe(1);
    expect(h.stats.snapshot().lastRateLimitHeaders["retry-after"]).toBe("7");
    expect(h.source.backoffMs(1, 7000)).toBeGreaterThanOrEqual(7000);
  });

  it("el backoff crece exponencialmente, nunca es cero y respeta Retry-After", () => {
    const fake = fakeKick();
    const h = makeSource(fake);
    const first = h.source.backoffMs(0);
    expect(first).toBeGreaterThan(0);
    // Sin jitter (random = 0): cada intento duplica la espera base de 1000 ms.
    const delays = [1, 2, 3].map((attempt) => h.source.backoffMs(attempt));
    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
    // Retry-After manda cuando es mayor que el backoff.
    expect(h.source.backoffMs(1, 60_000)).toBeGreaterThanOrEqual(60_000);
  });

  it("ante 401 detiene el polling y avisa que hay que volver a vincular, sin reintentar en bucle", async () => {
    const fake = fakeKick();
    fake.queue(() => new Response("unauthorized", { status: 401 }));
    const stopped: string[] = [];
    const stats = new PollingStats();
    const api = new KickApi({ apiBaseUrl: "https://api.test", fetchFn: fake.fetchFn, accessToken: async () => SECRET_TOKEN });
    const source = new KickEventSource({
      api,
      db: openMemoryDatabase(),
      stats,
      onAuthLost: (message) => stopped.push(message),
      intervalMs: () => 1000,
    });
    source.start();
    await source.pollOnce();
    expect(stopped).toHaveLength(1);
    expect(source.isRunning()).toBe(false);
    const redemptionCalls = fake.calls.filter((c) => c.url.startsWith("/public/v1/channels/rewards/redemptions"));
    expect(redemptionCalls).toHaveLength(1);
    source.stop();
  });

  it("no hace polling si la fuente no está habilitada", async () => {
    const fake = fakeKick({ pages: [[redemption("a")]] });
    const stats = new PollingStats();
    const api = new KickApi({ apiBaseUrl: "https://api.test", fetchFn: fake.fetchFn, accessToken: async () => SECRET_TOKEN });
    const source = new KickEventSource({ api, db: openMemoryDatabase(), stats, enabled: () => false, intervalMs: () => 1000 });
    await source.pollOnce();
    expect(fake.calls).toHaveLength(0);
  });

  it("el token nunca aparece en el logger ni en las estadísticas", async () => {
    const fake = fakeKick({ pages: [[redemption("a")]], users: { 7: "viewer" } });
    fake.queue(() => new Response(`error ${SECRET_TOKEN}`, { status: 500 }));
    const logs: string[] = [];
    const stats = new PollingStats();
    const api = new KickApi({
      apiBaseUrl: "https://api.test",
      fetchFn: fake.fetchFn,
      accessToken: async () => SECRET_TOKEN,
      logger: (message) => logs.push(message),
    });
    const source = new KickEventSource({
      api,
      db: openMemoryDatabase(),
      stats,
      logger: (message) => logs.push(message),
      intervalMs: () => 1000,
    });
    await source.pollOnce();
    const everything = JSON.stringify({ logs, stats: stats.snapshot() });
    expect(everything).not.toContain(SECRET_TOKEN);
  });
});

describe("KickEventSource: resolve en lotes de 25", () => {
  it("accept divide en lotes de máximo 25 ids", async () => {
    const fake = fakeKick();
    const h = makeSource(fake);
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    await h.api.acceptRedemptions(ids);
    const posts = fake.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      const batch = JSON.parse(post.body ?? "{}").ids as string[];
      expect(batch.length).toBeLessThanOrEqual(25);
    }
    const total = posts.reduce((sum, post) => sum + (JSON.parse(post.body ?? "{}").ids as string[]).length, 0);
    expect(total).toBe(60);
  });

  it("resolve de un canje que Kick rechazó lanza un error con el motivo", async () => {
    const fake = fakeKick();
    fake.queue(() => json({ data: [{ id: "x", reason: "NOT_PENDING" }] }));
    const h = makeSource(fake);
    await expect(h.source.resolve("x", "accept")).rejects.toMatchObject({ reason: "NOT_PENDING" });
  });
});
