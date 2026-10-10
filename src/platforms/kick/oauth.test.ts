/**
 * Tests del vínculo OAuth de Kick (authorization code + PKCE) contra un servidor
 * de identidad falso. No toca la red real.
 *
 * Cubren: state desconocido/vencido/reutilizado, intercambio de código con PKCE,
 * refresh single-flight, token revocado (requires_relink) y que el secreto no
 * aparezca en logs.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../../db/index.ts";
import { buildAuthorizeUrl, createPkce, KickOAuth } from "./oauth.ts";

const TOKEN_ENDPOINT = "https://id.test/oauth/token";
const CLIENT_SECRET = "CLIENT-SECRET-DO-NOT-LEAK";

interface FakeId {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ path: string; body: string; auth: string | null }>;
  respond(status: number, body: unknown): void;
}

function fakeId(): FakeId {
  const calls: FakeId["calls"] = [];
  const queued: Array<() => Response> = [];
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    calls.push({ path: url.pathname, body: String(init?.body ?? ""), auth: headers.get("authorization") });
    const next = queued.shift();
    if (next) return next();
    return new Response("{}", { status: 200 });
  };
  return { fetchFn, calls, respond: (status, body) => queued.push(() => json(body, status)) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokens(overrides: Record<string, unknown> = {}): Response {
  return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "user:read", ...overrides });
}

function makeOAuth(fake: FakeId, now: () => number = () => 1_000_000) {
  const oauth = new KickOAuth({
    db: openMemoryDatabase(),
    platform: "kick",
    idBaseUrl: "https://id.test",
    fetchFn: fake.fetchFn,
    now,
  });
  return oauth;
}

describe("PKCE", () => {
  it("el challenge es base64url(sha256(verifier))", () => {
    const { verifier, challenge } = createPkce();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(verifier).not.toBe(challenge);
  });

  it("la URL de autorización lleva scope, PKCE S256 y state", () => {
    const url = new URL(
      buildAuthorizeUrl("https://id.kick.com", {
        clientId: "app-1",
        redirectUri: "http://localhost:8787/callback",
        state: "st-1",
        challenge: "ch-1",
      }),
    );
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("channel:rewards:write");
    expect(url.searchParams.get("state")).toBe("st-1");
  });
});

describe("KickOAuth: vínculo", () => {
  it("completa el intercambio de código con PKCE y guarda los tokens", async () => {
    const fake = fakeId();
    const oauth = makeOAuth(fake);
    oauth.saveCredentials("app-1", CLIENT_SECRET);
    fake.respond(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "user:read" });

    const { authorizeUrl } = oauth.beginLink("http://localhost:8787/callback");
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    const result = await oauth.completeLink(new URLSearchParams({ state, code: "code-1" }));

    expect(result.ok).toBe(true);
    expect(oauth.isLinked()).toBe(true);
    const call = fake.calls.find((c) => c.path === "/oauth/token");
    expect(call?.body).toContain("grant_type=authorization_code");
    expect(call?.body).toContain("code_verifier=");
    expect(call?.body).toContain("code=code-1");
  });

  it("rechaza un state desconocido", async () => {
    const fake = fakeId();
    const oauth = makeOAuth(fake);
    oauth.saveCredentials("app-1", CLIENT_SECRET);
    const result = await oauth.completeLink(new URLSearchParams({ state: "nope", code: "c" }));
    expect(result.ok).toBe(false);
    expect(oauth.isLinked()).toBe(false);
  });

  it("rechaza un state vencido", async () => {
    const fake = fakeId();
    let clock = 1_000_000;
    const oauth = makeOAuth(fake, () => clock);
    oauth.saveCredentials("app-1", CLIENT_SECRET);
    const { authorizeUrl } = oauth.beginLink("http://localhost:8787/callback");
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    clock += 11 * 60 * 1000; // supera el TTL de 10 min
    const result = await oauth.completeLink(new URLSearchParams({ state, code: "c" }));
    expect(result.ok).toBe(false);
  });

  it("el state es de un solo uso (reutilizarlo falla)", async () => {
    const fake = fakeId();
    const oauth = makeOAuth(fake);
    oauth.saveCredentials("app-1", CLIENT_SECRET);
    fake.respond(200, { access_token: "a", refresh_token: "r", expires_in: 3600 });
    const { authorizeUrl } = oauth.beginLink("http://localhost:8787/callback");
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    expect((await oauth.completeLink(new URLSearchParams({ state, code: "c" }))).ok).toBe(true);
    expect((await oauth.completeLink(new URLSearchParams({ state, code: "c" }))).ok).toBe(false);
  });
});

describe("KickOAuth: refresh", () => {
  it("refresca con un único intercambio en curso (single-flight)", async () => {
    const fake = fakeId();
    let clock = 1_000_000;
    const oauth = makeOAuth(fake, () => clock);
    oauth.saveCredentials("app-1", CLIENT_SECRET);
    oauth.saveTokens({ accessToken: "old", refreshToken: "refresh-1", expiresAt: clock - 1, scope: "user:read" });
    fake.respond(200, { access_token: "new", refresh_token: "refresh-2", expires_in: 3600 });

    const [a, b] = await Promise.all([oauth.accessToken(), oauth.accessToken()]);
    expect(a).toBe("new");
    expect(b).toBe("new");
    const refreshCalls = fake.calls.filter((c) => c.body.includes("grant_type=refresh_token"));
    expect(refreshCalls).toHaveLength(1);
  });

  it("si el refresh es rechazado, pasa a requires_relink", async () => {
    const fake = fakeId();
    let clock = 1_000_000;
    const oauth = makeOAuth(fake, () => clock);
    oauth.saveCredentials("app-1", CLIENT_SECRET);
    oauth.saveTokens({ accessToken: "old", refreshToken: "refresh-1", expiresAt: clock - 1, scope: "user:read" });
    fake.respond(401, { error: "invalid_grant" });

    const token = await oauth.accessToken();
    expect(token).toBeNull();
    expect(oauth.getAccount()?.status).toBe("requires_relink");
  });

  it("el Client Secret nunca aparece en los logs", async () => {
    const fake = fakeId();
    const logs: string[] = [];
    const oauth = new KickOAuth({
      db: openMemoryDatabase(),
      platform: "kick",
      idBaseUrl: "https://id.test",
      fetchFn: fake.fetchFn,
      now: () => 1_000_000,
      logger: (message) => logs.push(message),
    });
    oauth.saveCredentials("app-1", CLIENT_SECRET);
    fake.respond(500, { error: "boom" });
    const { authorizeUrl } = oauth.beginLink("http://localhost:8787/callback");
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    await oauth.completeLink(new URLSearchParams({ state, code: "c" }));
    expect(JSON.stringify(logs)).not.toContain(CLIENT_SECRET);
  });
});
