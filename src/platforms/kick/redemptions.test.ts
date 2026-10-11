/**
 * Tests de la lectura y el rechazo de canjes por recompensa (rediseño, Etapa 4A)
 * contra un servidor Kick falso. Cubren la paginación por cursor, el filtro por
 * `reward_id`, los lotes de 25 y el mapeo de motivos de fallo a `benign`.
 */

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../../db/index.ts";
import { KickIntegration } from "./integration.ts";

const ACCESS_TOKEN = "ACCESS-TOKEN-SECRET";
const REFRESH_TOKEN = "REFRESH-TOKEN-SECRET";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Page {
  rewardId: string;
  ids: string[];
  nextCursor: string;
}

function fakeKick(pages: Page[]) {
  const calls: Array<{ path: string; method: string; body: string | null }> = [];
  const rejectBodies: string[][] = [];

  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    if (url.hostname === "id.test" && url.pathname === "/oauth/token") {
      return json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, scope: "user:read" });
    }
    if (url.pathname === "/public/v1/users") {
      return json({ data: [{ user_id: 42, name: "streamer" }] });
    }
    if (url.pathname === "/public/v1/channels/rewards/redemptions" && method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const rewardId = url.searchParams.get("reward_id");
      calls.push({ path: url.pathname + url.search, method, body: null });
      const page = cursor === null ? pages[0] : pages.find((item) => item.nextCursor === cursor) ?? pages.find((item) => item.ids.length > 0 && !pages.includes(item));
      const match = cursor === null ? pages[0] : pages.find((item) => item.nextCursor !== "" && item !== pages[0] && !pages.slice(0, pages.indexOf(item)).some((p) => p.nextCursor === item.nextCursor));
      void page;
      void match;
      const index = cursor === null ? 0 : pages.findIndex((item) => item.nextCursor === cursor) + 1;
      const current = pages[index];
      if (!current) return json({ data: [], pagination: { next_cursor: "" } });
      return json({
        data: [
          {
            reward: { id: rewardId ?? current.rewardId, title: "Alerta" },
            redemptions: current.ids.map((id) => ({
              id,
              redeemed_at: "2026-01-01T00:00:00.000Z",
              status: "pending",
              user_input: "",
              redeemer: { user_id: 42 },
            })),
          },
        ],
        pagination: { next_cursor: index + 1 < pages.length ? current.nextCursor : "" },
      });
    }
    if (url.pathname === "/public/v1/channels/rewards/redemptions/reject" && method === "POST") {
      const body = JSON.parse(init?.body as string) as { ids: string[] };
      rejectBodies.push(body.ids);
      calls.push({ path: url.pathname, method, body: init?.body as string });
      // Devuelve solo los fallidos: r-1 "ya no pendiente", r-2 error real.
      const failures = body.ids
        .filter((id) => id === "r-1" || id === "r-2")
        .map((id) => ({ id, reason: id === "r-1" ? "NOT_PENDING" : "UNKNOWN" }));
      return json({ data: failures });
    }
    return new Response("not found", { status: 404 });
  };

  return { fetchFn, calls, rejectBodies };
}

const running: KickIntegration[] = [];

function makeIntegration(fake: ReturnType<typeof fakeKick>) {
  const integration = new KickIntegration({
    db: openMemoryDatabase(),
    fetchFn: fake.fetchFn,
    apiBaseUrl: "https://api.test",
    idBaseUrl: "https://id.test",
    pollIntervalMs: () => 60_000,
  });
  running.push(integration);
  return integration;
}

async function link(integration: KickIntegration) {
  await integration.setCredentials({ clientId: "cid", clientSecret: "secret" });
  const start = await integration.beginLink("http://localhost:8787/callback");
  if (!start.ok) throw new Error("beginLink falló");
  const state = new URL(start.value.authorizeUrl).searchParams.get("state") as string;
  await integration.completeLink(new URLSearchParams({ state, code: "auth-code" }));
}

afterEach(async () => {
  while (running.length > 0) await (running.pop() as KickIntegration).stop();
});

describe("KickIntegration: canjes pendientes por recompensa", () => {
  it("pagina por cursor y filtra por reward_id", async () => {
    const fake = fakeKick([
      { rewardId: "rw-1", ids: ["r-1", "r-2"], nextCursor: "c2" },
      { rewardId: "rw-1", ids: ["r-3"], nextCursor: "" },
    ]);
    const integration = makeIntegration(fake);
    await link(integration);

    const result = await integration.listPendingRedemptions("rw-1");
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value).toEqual(["r-1", "r-2", "r-3"]);
    expect(fake.calls[0].path).toContain("reward_id=rw-1");
    expect(fake.calls[0].path).toContain("status=pending");
    expect(fake.calls).toHaveLength(2);
  });

  it("separa los ids en lotes de 25 y mapea los motivos a benign", async () => {
    const fake = fakeKick([{ rewardId: "rw-1", ids: [], nextCursor: "" }]);
    const integration = makeIntegration(fake);
    await link(integration);

    const ids = Array.from({ length: 30 }, (_, index) => `x-${index}`);
    ids[0] = "r-1"; // NOT_PENDING (benigno)
    ids[1] = "r-2"; // UNKNOWN (no benigno)
    const result = await integration.rejectRedemptions(ids);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Dos POST: 25 + 5.
    expect(fake.rejectBodies.map((batch) => batch.length)).toEqual([25, 5]);
    const byId = new Map(result.value.map((failure) => [failure.id, failure]));
    expect(byId.get("r-1")).toMatchObject({ benign: true });
    expect(byId.get("r-2")).toMatchObject({ benign: false });
  });

  it("sin vínculo devuelve NO_CREDENTIALS", async () => {
    const fake = fakeKick([{ rewardId: "rw-1", ids: [], nextCursor: "" }]);
    const integration = makeIntegration(fake);
    const result = await integration.listPendingRedemptions("rw-1");
    expect(result).toMatchObject({ ok: false, reason: "NO_CREDENTIALS" });
  });
});