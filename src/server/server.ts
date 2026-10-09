/**
 * Servidor local (Fase 2 + Fase 3).
 *
 * Fastify escuchando solo en 127.0.0.1. Sirve:
 * - la página del overlay para OBS (autenticada con token en la URL),
 * - los clips de /media (solo lectura),
 * - el dashboard (/web) protegido por sesión,
 * - una API protegida por sesión para el dashboard.
 *
 * Nada de esto asume una plataforma: la cola y el overlay son agnósticos.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { AlertQueue, QueueInputError, validateTrim } from "../queue/index.ts";
import {
  deleteClip as deleteClipRow,
  getClip,
  getOrCreateSecret,
  listClips,
  openMemoryDatabase,
  renameClip,
  setClipTrim,
  setSetting,
  SETTING_OVERLAY_KEY,
  upsertClip,
  type SqliteDatabase,
} from "../db/index.ts";
import {
  AuthManager,
  isTrustedRequest,
  MIN_PASSWORD_LENGTH,
  safeEqual,
  SESSION_COOKIE,
  type AuthOptions,
  type RateLimitStatus,
} from "./auth.ts";
import { parseCookies, serializeCookie } from "./cookies.ts";
import { DownloadJobManager, type MediaPassthroughOptions } from "./jobs.ts";
import { DEFAULT_PORT, readSettings, validateSettingsPatch, writeSettings } from "./settings.ts";
import type { Clip, MediaOptions } from "../media/index.ts";
import { attachWebSocket } from "./ws.ts";

export type { MediaPassthroughOptions } from "./jobs.ts";

const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));
const DEFAULT_OVERLAY_HTML = fileURLToPath(new URL("../../overlay/index.html", import.meta.url));

export const DEFAULT_SERVER_PORT = DEFAULT_PORT;
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

export interface ServerOptions {
  /** Carpeta desde donde se sirven los clips en /media. */
  mediaDir: string;
  /** Base local. Si no se pasa, se usa una en memoria (tests). */
  db?: SqliteDatabase;
  port?: number;
  host?: string;
  queue?: AlertQueue;
  /** Límites y configuración usados al descargar por URL. */
  media?: MediaPassthroughOptions;
  webDir?: string;
  overlayHtml?: string;
  auth?: AuthOptions;
  /** Clave del overlay; si no se pasa, se genera y guarda la primera vez. */
  overlayKey?: string;
  /** Ejecutor de procesos, inyectable en tests. */
  run?: MediaOptions["run"];
  /**
   * Si es `true` (por defecto), la cola no arranca un ítem hasta que haya un
   * overlay conectado. En tests headless (sin socket) se pasa `false`.
   */
  requireOverlay?: boolean;
}

export interface OverlayInfo {
  key: string;
  url: string;
}

export interface AppServer {
  app: FastifyInstance;
  queue: AlertQueue;
  auth: AuthManager;
  jobs: DownloadJobManager;
  db: SqliteDatabase;
  getOverlayKey(): string;
  start(): Promise<{ port: number; host: string; url: string; overlayUrl: string; dashboardUrl: string }>;
  stop(): Promise<void>;
}

interface EnqueueBody {
  clipId?: string;
  priority?: number;
  volume?: number;
  maxDurationSec?: number;
  label?: string;
}

interface PlayBody {
  priority?: number;
  volume?: number;
  maxDurationSec?: number;
  trimStart?: number | null;
  trimEnd?: number | null;
}

const enqueueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    clipId: { type: "string", minLength: 1, maxLength: 128 },
    priority: { type: "number" },
    volume: { type: "number", minimum: 0, maximum: 1 },
    maxDurationSec: { type: "number", minimum: 1 },
    label: { type: "string", maxLength: 200 },
  },
  required: ["clipId"],
} as const;

const playSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    priority: { type: "number" },
    volume: { type: "number", minimum: 0, maximum: 1 },
    maxDurationSec: { type: "number", minimum: 1 },
    trimStart: { type: ["number", "null"], minimum: 0 },
    trimEnd: { type: ["number", "null"], minimum: 0 },
  },
} as const;

const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    globalVolume: { type: "integer", minimum: 0, maximum: 100 },
    defaultMaxDurationSec: { type: "integer", minimum: 1, maximum: 600 },
    maxVideoDurationSec: { type: "integer", minimum: 1, maximum: 3600 },
    maxVideoBytes: { type: "integer", minimum: 1048576, maximum: 2147483648 },
    watchdogMarginSec: { type: "integer", minimum: 1, maximum: 120 },
    allowedDomains: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 253 },
    },
    port: { type: "integer", minimum: 1024, maximum: 65535 },
  },
} as const;

export async function createServer(options: ServerOptions): Promise<AppServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const queue = options.queue ?? new AlertQueue();
  // @fastify/static exige una raíz absoluta.
  const mediaDir = resolve(options.mediaDir);
  const webDir = resolve(options.webDir ?? DEFAULT_WEB_DIR);
  const overlayHtmlPath = options.overlayHtml ?? DEFAULT_OVERLAY_HTML;
  const mediaOptions: MediaPassthroughOptions = options.media ?? {};
  const db = options.db ?? openMemoryDatabase();

  // @fastify/static falla si la raíz no existe todavía.
  mkdirSync(mediaDir, { recursive: true });

  const auth = new AuthManager(db, options.auth);
  let overlayKey =
    options.overlayKey ??
    getOrCreateSecret(db, SETTING_OVERLAY_KEY, () => randomBytes(24).toString("base64url"));

  const jobs = new DownloadJobManager({
    mediaDir,
    media: mediaOptions,
    // Los límites se releen en cada descarga (no solo al arrancar).
    resolve: () => {
      const settings = readSettings(db);
      return {
        maxDurationSec: settings.maxVideoDurationSec,
        maxBytes: settings.maxVideoBytes,
        allowedDomains: settings.allowedDomains,
      };
    },
    run: options.run,
    onReady: (clip: Clip, job) => {
      upsertClip(db, {
        id: clip.id,
        sourceUrl: job.url,
        title: clip.title,
        durationSec: clip.durationSec,
        sizeBytes: clip.sizeBytes,
        file: `${clip.id}.mp4`,
        createdAt: new Date().toISOString(),
        trimStart: null,
        trimEnd: null,
      });
    },
  });

  const app = Fastify({ logger: false });

  // El hub del overlay se crea ya: así puede informar en todo momento cuántos
  // overlays hay conectados y la cola no arranca clips que nadie reproduce.
  const requireOverlay = options.requireOverlay ?? true;
  const hub = attachWebSocket(app.server, queue, {
    getKey: () => overlayKey,
    resolveWatchdogMarginMs: () => readSettings(db).watchdogMarginSec * 1000,
    onClientsChanged: (count) => {
      if (requireOverlay) queue.setPlayerReady(count > 0);
    },
  });
  if (requireOverlay) queue.setPlayerReady(hub.clientCount() > 0);

  // --- Helpers de autenticación del overlay ---------------------------------

  const keyFromRequest = (request: FastifyRequest): string | null => {
    const query = (request.url ?? "").split("?")[1];
    return query ? new URLSearchParams(query).get("key") : null;
  };

  const hasValidOverlayKey = (request: FastifyRequest): boolean => {
    const key = keyFromRequest(request);
    return key !== null && safeEqual(key, overlayKey);
  };

  const sessionToken = (request: FastifyRequest): string | null => {
    const cookie = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return cookie ?? null;
  };

  const hasValidSession = (request: FastifyRequest): boolean => {
    const token = sessionToken(request);
    return token !== null && auth.validateSession(token);
  };

  const overlayUrlFrom = (request: FastifyRequest): string => {
    const hostHeader = request.headers.host ?? `${host}:${port}`;
    return `http://${hostHeader}/overlay?key=${encodeURIComponent(overlayKey)}`;
  };

  // --- Hooks globales -------------------------------------------------------

  app.addHook("onRequest", async (request, reply) => {
    const path = (request.url ?? "").split("?")[0];

    // El overlay se protege con el token en la URL, no con la cookie.
    if (path === "/overlay") {
      if (!hasValidOverlayKey(request)) {
        return reply
          .code(403)
          .type("text/plain; charset=utf-8")
          .send("Falta la clave del overlay (?key=...).");
      }
      return;
    }
    // Los clips también se sirven al overlay por token; el dashboard entra con
    // su cookie de sesión (misma máquina).
    if (path.startsWith("/media/")) {
      if (!hasValidOverlayKey(request) && !hasValidSession(request)) {
        return reply.code(401).send({ ok: false, reason: "UNAUTHORIZED" });
      }
      return;
    }

    // CSRF: las requests que modifican estado deben venir del host local.
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      if (!isTrustedRequest(request.headers.origin, request.headers.host)) {
        return reply.code(403).send({ ok: false, reason: "BAD_ORIGIN" });
      }
    }
  });

  // --- Estáticos ------------------------------------------------------------

  // /web: assets del dashboard (HTML, Alpine local, CSS/JS). Son públicos; los
  // datos salen por /api, que sí está protegida.
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: "/web/",
    index: false,
    list: false,
    decorateReply: false,
  });

  // /media es solo lectura y solo sirve archivos dentro de la carpeta media.
  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: "/media/",
    index: false,
    list: false,
    allowedPath: (pathname: string) => pathname.toLowerCase().endsWith(".mp4"),
    decorateReply: false,
  });

  // --- Páginas --------------------------------------------------------------

  const sendHtml = (reply: FastifyReply, path: string): FastifyReply =>
    reply.type("text/html; charset=utf-8").send(readFileSync(path, "utf8"));

  app.get("/login", async (_request, reply) => sendHtml(reply, join(webDir, "login.html")));

  app.get("/", async (request, reply) => {
    if (hasValidSession(request)) return sendHtml(reply, join(webDir, "index.html"));
    return reply.code(302).header("location", "/login").send();
  });

  app.get("/overlay", async (_request, reply) => sendHtml(reply, overlayHtmlPath));

  // --- Autenticación (público) ----------------------------------------------

  app.post<{ Body: { password: string } }>(
    "/api/auth/setup",
    { schema: { body: { type: "object", additionalProperties: false, required: ["password"], properties: { password: { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: 256 } } } } },
    async (request, reply) => {
      if (auth.isConfigured()) {
        return reply.code(409).send({ ok: false, reason: "ALREADY_CONFIGURED" });
      }
      await auth.setPassword(request.body.password);
      const token = auth.createSession();
      reply.header("set-cookie", serializeCookie(SESSION_COOKIE, token, { maxAgeSec: SESSION_TTL_SEC }));
      return { ok: true };
    },
  );

  app.post<{ Body: { password: string } }>(
    "/api/auth/login",
    { schema: { body: { type: "object", additionalProperties: false, required: ["password"], properties: { password: { type: "string", minLength: 1, maxLength: 256 } } } } },
    async (request, reply) => {
      const ip = request.ip;
      const limit: RateLimitStatus = auth.checkRateLimit(ip);
      if (!limit.allowed) {
        return reply
          .code(429)
          .header("retry-after", String(limit.retryAfterSec ?? 0))
          .send({ ok: false, reason: "RATE_LIMITED" });
      }
      const valid = await auth.verifyPassword(request.body.password);
      if (!valid) {
        auth.recordFailure(ip);
        return reply.code(401).send({ ok: false, reason: "INVALID_CREDENTIALS" });
      }
      auth.recordSuccess(ip);
      const token = auth.createSession();
      reply.header("set-cookie", serializeCookie(SESSION_COOKIE, token, { maxAgeSec: SESSION_TTL_SEC }));
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = sessionToken(request);
    if (token) auth.destroySession(token);
    reply.header("set-cookie", serializeCookie(SESSION_COOKIE, "", { maxAgeSec: 0 }));
    return { ok: true };
  });

  app.get("/api/auth/status", async (request) => ({
    configured: auth.isConfigured(),
    authenticated: hasValidSession(request),
  }));

  // --- API protegida (requiere sesión) --------------------------------------

  await app.register(async (api) => {
    const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!hasValidSession(request)) {
        reply.code(401).send({ ok: false, reason: "UNAUTHENTICATED" });
      }
    };
    api.addHook("preHandler", requireSession);

    api.get("/api/state", async () => ({
      ...queue.getState(),
      overlay: { connected: hub.clientCount() > 0, clients: hub.clientCount() },
    }));

    api.post<{ Body: EnqueueBody }>(
      "/api/enqueue",
      { schema: { body: enqueueSchema } },
      async (request, reply) => {
        try {
          const settings = readSettings(db);
          const item = queue.enqueue({
            clipId: request.body.clipId as string,
            priority: request.body.priority,
            volume: (request.body.volume ?? 1) * (settings.globalVolume / 100),
            maxDurationSec: request.body.maxDurationSec ?? settings.defaultMaxDurationSec,
            label: request.body.label,
          });
          return { ok: true, item, state: queue.getState() };
        } catch (error) {
          if (error instanceof QueueInputError) {
            return reply.code(400).send({ ok: false, reason: error.code, message: error.message });
          }
          throw error;
        }
      },
    );

    api.post("/api/skip", async () => {
      const next = queue.skip();
      return { ok: true, state: queue.getState(), next };
    });
    api.post("/api/pause", async () => {
      queue.pause();
      return { ok: true, state: queue.getState() };
    });
    api.post("/api/resume", async () => {
      queue.resume();
      return { ok: true, state: queue.getState() };
    });
    api.post("/api/clear", async () => ({
      ok: true,
      removed: queue.clear(),
      state: queue.getState(),
    }));

    // Descarga en segundo plano (reemplaza el enqueue por URL).
    api.post<{ Body: { url: string } }>(
      "/api/download",
      { schema: { body: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1, maxLength: 2048 } } } } },
      async (request) => ({ ok: true, job: jobs.create(request.body.url) }),
    );

    api.get("/api/jobs", async () => ({ jobs: jobs.list() }));
    api.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
      const job = jobs.get(request.params.id);
      if (!job) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      return { ok: true, job };
    });

    api.get("/api/clips", async () => ({ clips: listClips(db) }));

    api.post<{ Params: { id: string }; Body: { title: string } }>(
      "/api/clips/:id/rename",
      { schema: { body: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", minLength: 1, maxLength: 200 } } } } },
      async (request, reply) => {
        const title = request.body.title.trim();
        if (title.length === 0) return reply.code(400).send({ ok: false, reason: "INVALID_TITLE" });
        if (!renameClip(db, request.params.id, title)) {
          return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
        }
        return { ok: true, clip: getClip(db, request.params.id) };
      },
    );

    api.delete<{ Params: { id: string } }>("/api/clips/:id", async (request, reply) => {
      const clip = getClip(db, request.params.id);
      if (!clip) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });

      const filePath = resolve(mediaDir, clip.file);
      if (filePath.startsWith(mediaDir + sep)) {
        rmSync(filePath, { force: true });
        rmSync(join(mediaDir, `${clip.id}.json`), { force: true });
      }
      deleteClipRow(db, clip.id);
      return { ok: true };
    });

    api.post<{ Params: { id: string }; Body: PlayBody }>(
      "/api/clips/:id/play",
      { schema: { body: playSchema } },
      async (request, reply) => {
        const clip = getClip(db, request.params.id);
        if (!clip) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });

        // "Probar alerta" usa el recorte del body; si no viene, cae al guardado
        // del clip. `null` explícito significa "sin recorte" (no el guardado).
        const body = request.body ?? {};
        const trim = validateTrim(
          body.trimStart !== undefined ? body.trimStart : clip.trimStart,
          body.trimEnd !== undefined ? body.trimEnd : clip.trimEnd,
          clip.durationSec,
        );
        if (!trim.ok) {
          return reply.code(400).send({ ok: false, reason: trim.reason, message: trim.message });
        }

        const settings = readSettings(db);
        const item = queue.enqueue({
          clipId: clip.id,
          priority: request.body?.priority,
          volume: (request.body?.volume ?? 1) * (settings.globalVolume / 100),
          maxDurationSec: request.body?.maxDurationSec ?? settings.defaultMaxDurationSec,
          trimStart: trim.trimStart,
          trimEnd: trim.trimEnd,
          label: clip.title,
        });
        return { ok: true, item, state: queue.getState() };
      },
    );

    // Recorte no destructivo del clip (no toca el mp4).
    api.post<{ Params: { id: string }; Body: { trimStart: number | null; trimEnd: number | null } }>(
      "/api/clips/:id/trim",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["trimStart", "trimEnd"],
            properties: {
              trimStart: { type: ["number", "null"], minimum: 0 },
              trimEnd: { type: ["number", "null"], minimum: 0 },
            },
          },
        },
      },
      async (request, reply) => {
        const clip = getClip(db, request.params.id);
        if (!clip) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });

        const trim = validateTrim(request.body.trimStart, request.body.trimEnd, clip.durationSec);
        if (!trim.ok) {
          return reply.code(400).send({ ok: false, reason: trim.reason, message: trim.message });
        }
        // Sin recorte (inicio 0 y sin fin) se limpia; si hay solo inicio,
        // se guarda igual (reproduce desde ahí hasta el final).
        const hasTrim = trim.trimStart !== 0 || trim.trimEnd !== null;
        setClipTrim(db, clip.id, hasTrim ? trim.trimStart : null, trim.trimEnd);
        return { ok: true, clip: getClip(db, clip.id) };
      },
    );

    // Configuración general.
    api.get("/api/settings", async () => ({ ok: true, settings: readSettings(db) }));

    api.post<{ Body: unknown }>(
      "/api/settings",
      { schema: { body: settingsSchema } },
      async (request, reply) => {
        const validation = validateSettingsPatch(request.body);
        if (!validation.ok) {
          return reply
            .code(400)
            .send({ ok: false, reason: validation.reason, message: validation.message });
        }
        const before = readSettings(db);
        writeSettings(db, validation.value);
        const settings = readSettings(db);
        return { ok: true, settings, restartRequired: settings.port !== before.port };
      },
    );

    // Cambio de contraseña: pide la actual e invalida las demás sesiones.
    api.post<{ Body: { currentPassword: string; newPassword: string } }>(
      "/api/auth/change-password",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["currentPassword", "newPassword"],
            properties: {
              currentPassword: { type: "string", minLength: 1, maxLength: 256 },
              newPassword: { type: "string", minLength: MIN_PASSWORD_LENGTH, maxLength: 256 },
            },
          },
        },
      },
      async (request, reply) => {
        const changed = await auth.changePassword(request.body.currentPassword, request.body.newPassword);
        if (!changed) return reply.code(401).send({ ok: false, reason: "INVALID_CREDENTIALS" });
        auth.invalidateOtherSessions(sessionToken(request));
        return { ok: true };
      },
    );

    api.get("/api/overlay", async (request) => ({
      ok: true,
      overlay: { key: overlayKey, url: overlayUrlFrom(request) } satisfies OverlayInfo,
    }));

    api.post("/api/overlay/regenerate", async (request) => {
      overlayKey = randomBytes(24).toString("base64url");
      setSetting(db, SETTING_OVERLAY_KEY, overlayKey);
      return { ok: true, overlay: { key: overlayKey, url: overlayUrlFrom(request) } satisfies OverlayInfo };
    });
  });

  // --- Arranque / parada ----------------------------------------------------

  return {
    app,
    queue,
    auth,
    jobs,
    db,
    getOverlayKey: () => overlayKey,
    async start() {
      await app.listen({ port, host });

      const address = app.server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      return {
        port: actualPort,
        host,
        url,
        overlayUrl: `${url}/overlay?key=${encodeURIComponent(overlayKey)}`,
        dashboardUrl: `${url}/`,
      };
    },
    async stop() {
      await hub.close();
      await app.close();
    },
  };
}