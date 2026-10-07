#!/usr/bin/env node
/**
 * Prototipo Fase 0 — flujo de recompensas de canal de Kick por REST (local-first).
 *
 * Sin base de datos, dashboard ni overlay. Solo:
 *   1. login OAuth (redirect a localhost), tokens guardados en un archivo ignorado
 *      por git, y refresh automático del access token.
 *   2. creación de una recompensa de prueba con is_user_input_required = true.
 *   3. polling de canjes pendientes, resolviendo el username vía /public/v1/users.
 *   4. aceptar / rechazar canjes.
 *
 * Todo lo que usa está verificado en docs/kick-research.md (Secciones 1 y 8).
 *
 * Uso (Node 22.6+ ejecuta .ts directamente; alternativa: npx tsx):
 *   node scripts/kick-rewards.ts login
 *   node scripts/kick-rewards.ts create-reward
 *   node scripts/kick-rewards.ts watch
 *   node scripts/kick-rewards.ts accept <redemptionId> [<redemptionId> ...]
 *   node scripts/kick-rewards.ts reject <redemptionId> [<redemptionId> ...]
 *   node scripts/kick-rewards.ts delete-reward [<rewardId>]
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AUTHORIZE_URL = "https://id.kick.com/oauth/authorize";
const TOKEN_URL = "https://id.kick.com/oauth/token";
const API_BASE = "https://api.kick.com";
const TOKENS_PATH = join(process.cwd(), ".kick-tokens.json");
const REWARD_PATH = join(process.cwd(), ".kick-reward.json");

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch en ms en que vence el access token. */
  expires_at: number;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

interface Redemption {
  id: string;
  redeemed_at: string;
  status: "pending" | "accepted" | "rejected";
  user_input: string;
  redeemer: { user_id: number };
}

interface RedemptionGroup {
  reward: { id: string; title: string };
  redemptions: Redemption[];
}

interface PaginatedRedemptions {
  data: RedemptionGroup[];
  pagination: { next_cursor: string };
}

interface ApiEnvelope<T> {
  data: T;
  message?: string;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function redirectUri(): string {
  // localhost, no 127.0.0.1 (bug de Next.js documentado; ver Sección 7.1).
  return process.env.KICK_REDIRECT_URI ?? "http://localhost:8787/callback";
}

function scopes(): string {
  return process.env.KICK_SCOPES ?? "user:read channel:rewards:read channel:rewards:write";
}

function pollIntervalMs(): number {
  const raw = Number(process.env.KICK_POLL_INTERVAL_MS ?? "5000");
  return Number.isFinite(raw) && raw >= 1000 ? raw : 5000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Si falla, el usuario puede abrir la URL a mano (también la imprimimos).
  }
}

function saveTokens(tokens: StoredTokens): void {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

function loadTokens(): StoredTokens | null {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token endpoint respondió ${res.status}: ${text}`);
  return JSON.parse(text) as TokenResponse;
}

async function loginFlow(): Promise<void> {
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("hex");
  const uri = redirectUri();
  const port = Number(new URL(uri).port || "80");

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env("KICK_CLIENT_ID"));
  authUrl.searchParams.set("redirect_uri", uri);
  authUrl.searchParams.set("scope", scopes());
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", uri);
      if (requestUrl.pathname !== new URL(uri).pathname) {
        res.writeHead(404).end();
        return;
      }
      if (requestUrl.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("state inválido");
        server.close();
        reject(new Error("OAuth: el state no coincide"));
        return;
      }
      const received = requestUrl.searchParams.get("code");
      if (!received) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("falta el code");
        server.close();
        reject(new Error("OAuth: falta el parámetro code"));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<h2>Autorizado</h2><p>Podés cerrar esta pestaña y volver a la terminal.</p>");
      server.close();
      resolve(received);
    });
    server.on("error", reject);
    // El callback escucha SOLO en 127.0.0.1 (AGENTS.md #5).
    server.listen(port, "127.0.0.1", () => {
      console.log("\nAbrí esta URL en el navegador para autorizar:\n");
      console.log(`  ${authUrl.toString()}\n`);
      openBrowser(authUrl.toString());
    });
  });

  const tokens = await requestToken({
    grant_type: "authorization_code",
    client_id: env("KICK_CLIENT_ID"),
    client_secret: env("KICK_CLIENT_SECRET"),
    redirect_uri: uri,
    code_verifier: verifier,
    code,
  });

  saveTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? "",
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope ?? scopes(),
  });
  console.log(`Tokens guardados en ${TOKENS_PATH} (ignorado por git).`);
}

async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error("No hay tokens guardados. Corré primero: login");
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;

  console.log("Access token vencido; renovando con refresh_token...");
  const refreshed = await requestToken({
    grant_type: "refresh_token",
    client_id: env("KICK_CLIENT_ID"),
    client_secret: env("KICK_CLIENT_SECRET"),
    refresh_token: tokens.refresh_token,
  });
  const updated: StoredTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + refreshed.expires_in * 1000,
    scope: refreshed.scope ?? tokens.scope,
  };
  saveTokens(updated);
  return updated.access_token;
}

function logRateLimitHeaders(res: Response): void {
  const rows: string[] = [];
  res.headers.forEach((value, key) => {
    if (/ratelimit|retry-after/i.test(key)) rows.push(`${key}=${value}`);
  });
  if (rows.length > 0) console.log(`  [rate-limit] ${rows.join("  ")}`);
  if (res.status === 429) console.warn("  [rate-limit] 429 Too Many Requests");
}

async function kickFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  logRateLimitHeaders(res);
  return res;
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\n${text}`);
  return JSON.parse(text) as T;
}

async function createReward(): Promise<void> {
  const body = {
    title: "Alerta de prueba (Fase 0)",
    cost: 1,
    description: "Recompensa de prueba del prototipo. user_input = URL del clip.",
    is_user_input_required: true,
  };
  const res = await kickFetch("/public/v1/channels/rewards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await readJson<ApiEnvelope<{ id: string; title: string }>>(res);
  writeFileSync(REWARD_PATH, JSON.stringify(json.data, null, 2), "utf8");
  console.log("Recompensa creada:");
  console.log(JSON.stringify(json.data, null, 2));
  console.log(`ID guardado en ${REWARD_PATH} (ignorado por git) para poder borrarla luego.`);
}

function loadRewardId(): string | null {
  if (!existsSync(REWARD_PATH)) return null;
  try {
    return (JSON.parse(readFileSync(REWARD_PATH, "utf8")) as { id?: string }).id ?? null;
  } catch {
    return null;
  }
}

async function deleteReward(rewardId?: string): Promise<void> {
  const id = rewardId ?? loadRewardId();
  if (!id) throw new Error("Falta el rewardId y no hay ninguno guardado. Uso: delete-reward <rewardId>");
  const res = await kickFetch(`/public/v1/channels/rewards/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (res.status !== 204) {
    throw new Error(`HTTP ${res.status} ${res.statusText}\n${await res.text()}`);
  }
  if (existsSync(REWARD_PATH)) unlinkSync(REWARD_PATH);
  console.log(`Recompensa ${id} borrada.`);
}

async function listPendingRedemptions(): Promise<{ id: string; rewardTitle: string; redemption: Redemption }[]> {
  const res = await kickFetch("/public/v1/channels/rewards/redemptions?status=pending");
  const json = await readJson<PaginatedRedemptions>(res);
  return json.data.flatMap((group) =>
    group.redemptions.map((redemption) => ({ id: redemption.id, rewardTitle: group.reward.title, redemption })),
  );
}

async function resolveUsernames(userIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return map;
  const query = unique.map((id) => `id=${id}`).join("&");
  const res = await kickFetch(`/public/v1/users?${query}`);
  const json = await readJson<ApiEnvelope<{ user_id: number; name: string }[]>>(res);
  for (const user of json.data) map.set(user.user_id, user.name);
  return map;
}

async function watch(): Promise<void> {
  const interval = pollIntervalMs();
  console.log(`Polling de canjes pendientes cada ${interval} ms. Ctrl+C para salir.\n`);
  const seen = new Set<string>();
  for (;;) {
    const pending = await listPendingRedemptions();
    const fresh = pending.filter((item) => !seen.has(item.id));
    if (fresh.length > 0) {
      const names = await resolveUsernames(fresh.map((item) => item.redemption.redeemer.user_id));
      for (const item of fresh) {
        seen.add(item.id);
        const { redemption } = item;
        const latency = Date.now() - Date.parse(redemption.redeemed_at);
        console.log(`\n[canje] id=${item.id}  reward="${item.rewardTitle}"`);
        console.log(`  usuario:     ${names.get(redemption.redeemer.user_id) ?? redemption.redeemer.user_id}`);
        console.log(`  user_input:  ${JSON.stringify(redemption.user_input)}`);
        console.log(`               ^ input NO confiable: validar como URL (whitelist) antes de yt-dlp.`);
        console.log(`  redeemed_at: ${redemption.redeemed_at}  (latencia de detección ≈ ${latency} ms)`);
        console.log(`  aceptar:  node scripts/kick-rewards.ts accept ${item.id}`);
        console.log(`  rechazar: node scripts/kick-rewards.ts reject ${item.id}`);
      }
    }
    await sleep(interval);
  }
}

async function decide(kind: "accept" | "reject", ids: string[]): Promise<void> {
  if (ids.length === 0) throw new Error(`Faltan IDs. Uso: ${kind} <redemptionId> [<redemptionId> ...]`);
  const res = await kickFetch(`/public/v1/channels/rewards/redemptions/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const json = await readJson<ApiEnvelope<{ id: string; reason: string }[]>>(res);
  const failed = Array.isArray(json.data) ? json.data : [];
  const verb = kind === "accept" ? "aceptado(s)" : "rechazado(s)";
  console.log(`${ids.length - failed.length} canje(s) ${verb}.`);
  if (failed.length > 0) console.log("Fallidos:", JSON.stringify(failed, null, 2));
}

function printUsage(): void {
  console.log(`Uso: node scripts/kick-rewards.ts <comando>

  login           Flujo OAuth; guarda tokens en ${TOKENS_PATH}
  create-reward   Crea una recompensa de prueba (is_user_input_required = true)
  watch           Polling de canjes pendientes (cada KICK_POLL_INTERVAL_MS ms)
  accept <id...>  Acepta canjes
  reject <id...>  Rechaza canjes
  delete-reward [<rewardId>]
                  Borra una recompensa (usa el ID guardado, o el que pases)

Variables de entorno:
  KICK_CLIENT_ID (requerida), KICK_CLIENT_SECRET (requerida),
  KICK_REDIRECT_URI (default http://localhost:8787/callback),
  KICK_SCOPES (default "user:read channel:rewards:read channel:rewards:write"),
  KICK_POLL_INTERVAL_MS (default 5000)`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case "login":
      await loginFlow();
      break;
    case "create-reward":
      await createReward();
      break;
    case "watch":
      await watch();
      break;
    case "accept":
      await decide("accept", rest);
      break;
    case "reject":
      await decide("reject", rest);
      break;
    case "delete-reward":
      await deleteReward(rest[0]);
      break;
    default:
      printUsage();
  }
}

main().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});