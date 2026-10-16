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

import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { AlertQueue, QueueInputError, validateTrim, type AnimationName } from "../queue/index.ts";
import type { QueueItem, QueueState } from "../queue/index.ts";
import {
  addHistory,
  deleteClip as deleteClipRow,
  deleteRule,
  getClip,
  getOrCreateSecret,
  getRuleRecord,
  listClips,
  listHistory,
  listRewardsUsingClip,
  listRules,
  openMemoryDatabase,
  renameClip,
  setClipTrim,
  setSetting,
  SETTING_OVERLAY_KEY,
  toRule,
  upsertClip,
  upsertRule,
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
import {
  EVENT_TYPES,
  ManualEventSource,
  SimulatedEventSource,
  type EventSource,
  type EventType,
  type NormalizedEvent,
} from "../events/index.ts";
import { RuleEngine, validateRuleInput, type EngineResult } from "../rules/index.ts";
import type { Clip, MediaOptions } from "../media/index.ts";
import { createPlatformIntegrations, type PlatformIntegration } from "../platforms/index.ts";
import { RedemptionCoordinator, type ProcessOutcome } from "../redemptions/index.ts";
import { ANIMATION_NAMES, RewardService, suggestedTitle } from "../rewards/index.ts";
import { httpStatusForPlatformReason, registerOAuthCallback, registerPlatformApiRoutes } from "./platforms-routes.ts";
import { registerRewardApiRoutes } from "./rewards-routes.ts";
import { clipUrl } from "./protocol.ts";
import { computeOverlayVersion } from "./build-version.ts";
import { removeThumb, thumbExists, thumbsDir } from "../media/thumbs.ts";
import { hasMediaExtension, mediaExtensionOf } from "../media/formats.ts";
import { RewardDispatcher } from "./reward-dispatch.ts";
import { attachWebSocket } from "./ws.ts";

export type { MediaPassthroughOptions } from "./jobs.ts";

const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));
const DEFAULT_OVERLAY_HTML = fileURLToPath(new URL("../../overlay/index.html", import.meta.url));
const OVERLAY_DIR = fileURLToPath(new URL("../../overlay", import.meta.url));

export const DEFAULT_SERVER_PORT = DEFAULT_PORT;
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

/** Fecha de inicio del proceso: entra en el hash de la versión del overlay. */
const processStartMs = Date.now();

export interface ServerOptions {
  /** Carpeta desde donde se sirven los clips en /media. */
  mediaDir: string;
  /** Carpeta de temporales de las subidas de archivos locales (Etapa 3B). */
  uploadsDir?: string;
  /** Base local. Si no se pasa, se usa una en memoria (tests). */
  db?: SqliteDatabase;
  port?: number;
  host?: string;
  queue?: AlertQueue;
  /** Límites y configuración usados al descargar por URL. */
  media?: MediaPassthroughOptions;
  webDir?: string;
  overlayHtml?: string;
  /** Sobreescribe la versión del overlay (tests). Por defecto se calcula del contenido. */
  overlayVersion?: string;
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
  /** Reloj inyectable (cooldowns del motor de reglas), para tests. */
  now?: () => number;
  /**
   * Integraciones de plataforma. En producción se crean solas (registro en
   * `src/platforms/index.ts`); en tests se pueden inyectar (p. ej. con un
   * servidor de plataforma falso).
   */
  platforms?: PlatformIntegration[];
  /**
   * Resultado de la reconciliación de arranque, para el aviso descartable del
   * dashboard ("Se recuperaron N clips" / "N clips sin archivo"). Lo pasa
   * `scripts/start.ts`; en tests no se usa.
   */
  libraryNotice?: LibraryNotice;
}

/** Aviso de arranque sobre la biblioteca (reconciliación con /media). */
export interface LibraryNotice {
  /** Clips nuevos recuperados desde /media. */
  recovered: number;
  /** Clips marcados como "falta el archivo". */
  missing: number;
  /** Clips de un archivo que reapareció (se les quitó la marca). */
  restored: number;
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
  engine: RuleEngine;
  sources: EventSource[];
  manualSource: ManualEventSource;
  simulatedSource: SimulatedEventSource;
  integrations: PlatformIntegration[];
  coordinator: RedemptionCoordinator;
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
  position?: { x: number; y: number } | null;
  enterAnimation?: AnimationName | null;
  exitAnimation?: AnimationName | null;
  repetition?: "queue" | "overlap";
  audioOnly?: boolean;
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
    // "Probar alerta" reproduce con la configuración actual sin guardar.
    position: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["x", "y"],
      properties: {
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    enterAnimation: { type: ["string", "null"], enum: [...ANIMATION_NAMES, null] },
    exitAnimation: { type: ["string", "null"], enum: [...ANIMATION_NAMES, null] },
    repetition: { type: "string", enum: ["queue", "overlap"] },
    audioOnly: { type: "boolean" },
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
    maxAudioVoices: { type: "integer", minimum: 1, maximum: 20 },
    allowedDomains: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 253 },
    },
    port: { type: "integer", minimum: 1024, maximum: 65535 },
    eventHistoryMax: { type: "integer", minimum: 10, maximum: 5000 },
  },
} as const;

const ruleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "trigger", "action"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    enabled: { type: "boolean" },
    trigger: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { type: "string", enum: [...EVENT_TYPES] },
        command: { type: "string", minLength: 1, maxLength: 100 },
        rewardId: { type: "string", minLength: 1, maxLength: 200 },
        minAmount: { type: "number", minimum: 0 },
      },
    },
    conditions: {
      type: "object",
      additionalProperties: false,
      properties: {
        permission: { type: "string", enum: ["everyone", "subs", "mods"] },
      },
    },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["play_clip"] },
        clipId: { type: "string", maxLength: 128 },
        priority: { type: "number" },
        volume: { type: "number", minimum: 0, maximum: 1 },
        maxDurationSec: { type: "number", minimum: 1 },
      },
    },
  },
} as const;

const simulateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: { type: "string", enum: [...EVENT_TYPES] },
    userId: { type: "string", maxLength: 100 },
    userName: { type: "string", maxLength: 100 },
    roles: { type: "array", maxItems: 10, items: { type: "string", maxLength: 30 } },
    command: { type: "string", maxLength: 100 },
    args: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } },
    rewardId: { type: "string", maxLength: 200 },
    rewardTitle: { type: "string", maxLength: 200 },
    userInput: { type: "string", maxLength: 2048 },
    amount: { type: "number", minimum: 0 },
  },
} as const;

const manualSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    userId: { type: "string", maxLength: 100 },
    userName: { type: "string", maxLength: 100 },
    roles: { type: "array", maxItems: 10, items: { type: "string", maxLength: 30 } },
  },
} as const;

interface SimulateBody {
  type: EventType;
  userId?: string;
  userName?: string;
  roles?: string[];
  command?: string;
  args?: string[];
  rewardId?: string;
  rewardTitle?: string;
  userInput?: string;
  amount?: number;
}

/** Arma el payload de un evento simulado según su tipo (fuente local, sin plataforma). */
function buildSimulatedPayload(body: SimulateBody): Record<string, unknown> {
  if (body.type === "chat_command") {
    return { command: body.command ?? "", args: body.args ?? [] };
  }
  if (body.type === "reward_redeemed") {
    return {
      rewardId: body.rewardId ?? "",
      rewardTitle: body.rewardTitle ?? "",
      userInput: body.userInput ?? "",
    };
  }
  const payload: Record<string, unknown> = {};
  if (body.amount !== undefined) payload.amount = body.amount;
  if (body.userInput !== undefined) payload.userInput = body.userInput;
  return payload;
}

export async function createServer(options: ServerOptions): Promise<AppServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const queue = options.queue ?? new AlertQueue();
  // @fastify/static exige una raíz absoluta.
  const mediaDir = resolve(options.mediaDir);
  const webDir = resolve(options.webDir ?? DEFAULT_WEB_DIR);
  const overlayHtmlPath = options.overlayHtml ?? DEFAULT_OVERLAY_HTML;
  // Versión del overlay: hash del contenido de sus archivos + fecha de inicio.
  // Cambia al reiniciar la app o al editar el overlay, y fuerza la recarga del
  // Browser Source sin tocar la fuente en OBS. En tests se puede inyectar.
  const overlayVersion =
    options.overlayVersion ??
    computeOverlayVersion({
      paths: options.overlayHtml ? [options.overlayHtml] : [OVERLAY_DIR],
      seed: String(processStartMs),
    });
  const mediaOptions: MediaPassthroughOptions = options.media ?? {};
  const db = options.db ?? openMemoryDatabase();
  // Temporales de las subidas de archivos locales. Viven fuera de /media para no
  // servirse ni aparecer en la biblioteca; cada trabajo los borra al terminar.
  const uploadsDir = resolve(options.uploadsDir ?? join(mediaDir, "..", ".uploads"));

  // @fastify/static falla si la raíz no existe todavía.
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });

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
    localResolve: () => {
      const settings = readSettings(db);
      return {
        maxDurationSec: settings.maxVideoDurationSec,
        maxBytes: settings.maxVideoBytes,
        timeoutMs: mediaOptions.timeoutMs,
        maxHeight: mediaOptions.maxHeight,
        binarySearch: mediaOptions.binarySearch,
        logsDir: mediaOptions.logsDir,
      };
    },
    // Los temporales de subida viven acá; el trabajo los borra al terminar.
    onReady: (clip: Clip, job) => {
      const hasVideo = clip.hasVideo !== false;
      upsertClip(db, {
        id: clip.id,
        // Un archivo local no tiene URL de origen.
        sourceUrl: job.kind === "local" ? "" : job.url,
        title: clip.title,
        durationSec: clip.durationSec,
        sizeBytes: clip.sizeBytes,
        file: `${clip.id}.${hasVideo ? "mp4" : "m4a"}`,
        createdAt: new Date().toISOString(),
        trimStart: null,
        trimEnd: null,
        hasVideo,
        missing: false,
      });
    },
  });

  const app = Fastify({ logger: false });

  // URL de reproducción de un clip servido por /media, con la clave del overlay.
  // El archivo puede ser mp4 (video) o m4a (audio local); se resuelve por la
  // extensión guardada en la base. Si el clip no existe, se asume mp4 (el overlay
  // informará el error de carga).
  const mediaUrlWithKey = (clipId: string): string => {
    const clip = getClip(db, clipId);
    const ext: "mp4" | "m4a" = clip && mediaExtensionOf(clip.file) === ".m4a" ? "m4a" : "mp4";
    return `${clipUrl(clipId, ext)}?key=${encodeURIComponent(overlayKey)}`;
  };

  // El hub del overlay se crea ya: así puede informar en todo momento cuántos
  // overlays hay conectados y la cola no arranca clips que nadie reproduce.
  const requireOverlay = options.requireOverlay ?? true;
  const hub = attachWebSocket(app.server, queue, {
    getKey: () => overlayKey,
    resolveWatchdogMarginMs: () => readSettings(db).watchdogMarginSec * 1000,
    resolveClipUrl: (clipId) => mediaUrlWithKey(clipId),
    overlayVersion,
    onClientsChanged: (count) => {
      if (requireOverlay) queue.setPlayerReady(count > 0);
    },
  });
  if (requireOverlay) queue.setPlayerReady(hub.clientCount() > 0);

  // --- Motor de reglas y fuentes locales (Fase 4A) ---------------------------

  const debug = process.env.CZERO_DEBUG === "1";

  const manualSource = new ManualEventSource();
  const simulatedSource = new SimulatedEventSource();

  // Integraciones reales de plataforma (Fase 4B). En tests se pueden inyectar.
  const integrations =
    options.platforms ??
    createPlatformIntegrations({
      db,
      pollIntervalMs: () => readSettings(db).redemptionsPollIntervalMs,
      logger: debug ? (message) => console.log(`[platform] ${message}`) : undefined,
    });

  const sources: EventSource[] = [manualSource, simulatedSource];
  for (const integration of integrations) sources.push(integration.source);

  // La resolución del evento de origen (accept/reject) es la misma para el motor
  // (PlayClip acepta al encolar) y para el despachador (overlap acepta al enviar).
  const resolveSource = async (event: NormalizedEvent, outcome: "accept" | "reject"): Promise<void> => {
    const source = sources.find(
      (item) => item.platform === event.platform && typeof item.resolve === "function",
    );
    if (source?.resolve) await source.resolve(event.id, outcome);
  };

  const engine = new RuleEngine({
    queue,
    resolveEvent: resolveSource,
    logger: debug
      ? (entry) =>
          console.log(
            `[rules] ${entry.kind} ${entry.eventId}${entry.ruleId ? ` (${entry.ruleId})` : ""}${
              entry.detail ? `: ${entry.detail}` : ""
            }`,
          )
      : undefined,
  });
  engine.setRules(listRules(db).map(toRule));

  const recordHistory = async (
    event: NormalizedEvent,
    result: EngineResult & { overlap?: boolean },
  ): Promise<void> => {
    const settings = readSettings(db);
    addHistory(
      db,
      {
        eventId: event.id,
        platform: event.platform,
        type: event.type,
        userId: event.user.id,
        userName: event.user.name,
        payloadJson: JSON.stringify(event.payload),
        eventTs: event.timestamp,
        ruleId: result.ruleId ?? null,
        outcome: result.outcome,
        // En modo superpuesto, un "fired" se marca en `reason` para que el
        // historial muestre "Disparó · superpuesto" (no hay columna extra).
        reason: result.reason ?? (result.outcome === "fired" && result.overlap ? "superpuesto" : null),
        createdAt: new Date().toISOString(),
      },
      settings.eventHistoryMax,
    );
  };

  const recordEvent = async (event: NormalizedEvent): Promise<void> => {
    const result = await engine.handle(event);
    await recordHistory(event, result);
  };

  // Coordinador del ciclo de vida de los canjes (Fase 4B). Solo se usa para
  // fuentes que soportan `resolve` (canjes que quedan pendientes hasta resolverlos).
  // El procesamiento pasa por el despachador de recompensas (Parte B): aplica el
  // cooldown global de la recompensa y el modo superpuesto antes del motor.
  const dispatcher = new RewardDispatcher({
    db,
    engine,
    now: () => options.now?.() ?? Date.now(),
    broadcastAudio: (audio) => hub.broadcastAudio(audio),
    resolveEvent: resolveSource,
    mediaUrl: (clipId) => mediaUrlWithKey(clipId),
    globalVolume: () => readSettings(db).globalVolume,
    defaultMaxDuration: () => readSettings(db).defaultMaxDurationSec,
    maxVoices: () => readSettings(db).maxAudioVoices,
    logger: debug ? (message) => console.log(`[dispatch] ${message}`) : undefined,
  });

  const coordinator = new RedemptionCoordinator({
    db,
    policy: () => {
      const settings = readSettings(db);
      return {
        onSkip: settings.redemptionsOnSkip,
        oldMinutes: settings.redemptionsOldMinutes,
        oldAction: settings.redemptionsOldAction,
      };
    },
    resolve: resolveSource,
    process: async (event): Promise<ProcessOutcome> => {
      // Un canje puede reprocesarse a mano: el despachador olvida el id del motor
      // para volver a evaluarlo (la idempotencia persistente ya se aplica en la fuente).
      const result = await dispatcher.process(event);
      await recordHistory(event, result);
      switch (result.outcome) {
        case "fired":
          return { outcome: "fired" };
        case "skipped":
          return { outcome: "skipped", reason: result.reason };
        case "error":
          return { outcome: "error", reason: result.reason };
        default:
          return { outcome: "no_match", reason: result.reason };
      }
    },
    logger: debug ? (message) => console.log(`[redemptions] ${message}`) : undefined,
  });

  for (const source of sources) {
    // Los canjes que la plataforma deja pendientes pasan por el coordinador; el
    // resto de los eventos (locales) van directo al motor. Se devuelve la promesa
    // para que la fuente pueda procesar los canjes de un mismo ciclo de a uno.
    const resolvable = typeof source.resolve === "function";
    source.onEvent((event) => {
      if (event.type === "reward_redeemed" && resolvable) {
        return coordinator.receive(event).then(() => undefined);
      }
      return recordEvent(event);
    });
  }

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
  // datos salen por /api, que sí está protegida. `no-cache` (con ETag): el
  // navegador revalida en cada carga, así una actualización de la app no exige
  // Ctrl+F5, pero sin re-descargar lo que no cambió.
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: "/web/",
    index: false,
    list: false,
    decorateReply: false,
    setHeaders: (reply) => {
      reply.header("cache-control", "no-cache");
    },
  });

  // Miniaturas de los clips (sección 2.4). Viven en `<mediaDir>/thumbs` y se
  // sirven ANTES que /media para que su prefijo no las capture. Solo .jpg: el
  // resto de la carpeta (que no tiene nada más) queda fuera. La misma
  // autenticación que /media la aplica el hook global (`/media/` incluye este
  // prefijo).
  await app.register(fastifyStatic, {
    root: thumbsDir(mediaDir),
    prefix: "/media/thumbs/",
    index: false,
    list: false,
    allowedPath: (pathname: string) => pathname.toLowerCase().endsWith(".jpg"),
    decorateReply: false,
  });

  // /media es solo lectura y solo sirve archivos dentro de la carpeta media.
  // Sirve cualquier extensión de clip permitida (mp4 y m4a hoy), desde la lista
  // compartida: no hay extensiones fijas acá.
  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: "/media/",
    index: false,
    list: false,
    allowedPath: (pathname: string) => hasMediaExtension(pathname),
    decorateReply: false,
  });

  // Subidas de archivos locales (Etapa 3B). Streaming a disco, con el límite de
  // tamaño vigente; nunca se carga todo el archivo en memoria. El límite real se
  // aplica por request (lee la configuración); acá se fija el máximo permitido
  // para no aceptar nada fuera de rango ni siquiera antes de la ruta.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024,
      files: 1,
      fields: 4,
    },
    throwFileSizeLimit: true,
  });

  // --- Páginas --------------------------------------------------------------

  const sendHtml = (reply: FastifyReply, path: string): FastifyReply =>
    reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(readFileSync(path, "utf8"));

  app.get("/login", async (_request, reply) => sendHtml(reply, join(webDir, "login.html")));

  app.get("/", async (request, reply) => {
    if (hasValidSession(request)) return sendHtml(reply, join(webDir, "index.html"));
    return reply.code(302).header("location", "/login").send();
  });

  // El overlay se sirve SIN caché (es un Browser Source de OBS: siempre debe
  // ejecutar el código actual) y con la versión embebida, para que el propio
  // overlay detecte que quedó viejo y se recargue.
  app.get("/overlay", async (_request, reply) => {
    const html = readFileSync(overlayHtmlPath, "utf8").replace(
      "/*__OVERLAY_VERSION__*/",
      JSON.stringify(overlayVersion),
    );
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(html);
  });

  // Callback OAuth de plataformas (Fase 4B). Es público a propósito: la
  // navegación desde la plataforma no lleva la cookie de sesión; se valida solo
  // con state + PKCE. Al terminar redirige al dashboard de loopback.
  registerOAuthCallback(app, {
    integrations,
    port,
    debug,
  });

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

  /**
   * Vista de la cola para el dashboard: resuelve el NOMBRE del clip en un solo
   * lugar, para todos los caminos (canje real, simulador, probar alerta,
   * reencolado). La cola guarda `clipId`; acá se agrega `title` (nombre del clip)
   * y `audioOnly` para mostrarlos. Si el clip ya no existe, el nombre es
   * "Clip no disponible" (nunca el id). `label` sigue siendo el contexto (título
   * de la recompensa, o el nombre del clip en una prueba de biblioteca).
   */
  const queueDisplayState = (): QueueState & {
    current: (QueueItem & { title: string }) | null;
    pending: (QueueItem & { title: string })[];
  } => {
    const withTitle = (item: QueueItem): QueueItem & { title: string } => ({
      ...item,
      title: item.clipId ? getClip(db, item.clipId)?.title ?? "Clip no disponible" : "Clip no disponible",
    });
    const state = queue.getState();
    return {
      ...state,
      current: state.current ? withTitle(state.current) : null,
      pending: state.pending.map(withTitle),
    };
  };

  await app.register(async (api) => {
    const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!hasValidSession(request)) {
        reply.code(401).send({ ok: false, reason: "UNAUTHENTICATED" });
      }
    };
    api.addHook("preHandler", requireSession);

    // Borra las recompensas que usan un clip, una por una, reutilizando el flujo de
    // `RewardService.remove` (rechazo de canjes pendientes). Si alguna pide
    // confirmación o falla el rechazo de pendientes, se corta y se le devuelve al
    // cliente una respuesta ya formateada; el clip no se borra hasta que se resuelva.
    const removeRewardsForClip = async (
      using: ReturnType<typeof listRewardsUsingClip>,
    ): Promise<{ ok: true } | { ok: false; status: number; body: unknown }> => {
      for (const reward of using) {
        const integration = integrations.find((candidate) => candidate.id === reward.platform);
        if (!integration) {
          return {
            ok: false,
            status: 409,
            body: {
              ok: false,
              reason: "NO_PLATFORM",
              message: `No se puede borrar la recompensa ${reward.title}: su plataforma no está disponible.`,
              rewards: [{ id: reward.id, title: reward.title, enabled: reward.desiredEnabled }],
            },
          };
        }
        const service = new RewardService({
          db,
          integration,
          onRulesChanged: () => engine.setRules(listRules(db).map(toRule)),
          logger: debug ? (message) => console.log(`[rewards] ${message}`) : undefined,
        });
        const result = await service.remove(reward.id, {});
        if (result.ok) continue;
        if (result.needsConfirm) {
          return {
            ok: false,
            status: 409,
            body: {
              ok: false,
              needsConfirm: true,
              pending: result.pending,
              message: result.message,
              rewards: [{ id: reward.id, title: reward.title, enabled: reward.desiredEnabled }],
            },
          };
        }
        if (result.failed && result.failed.length > 0) {
          return {
            ok: false,
            status: 409,
            body: {
              ok: false,
              reason: "REJECT_FAILED",
              failed: result.failed,
              message: result.message,
              rewards: [{ id: reward.id, title: reward.title, enabled: reward.desiredEnabled }],
            },
          };
        }
        return {
          ok: false,
          status: httpStatusForPlatformReason(result.reason ?? "UNKNOWN"),
          body: {
            ok: false,
            reason: result.reason ?? "UNKNOWN",
            message: result.message ?? "No se pudo borrar una recompensa que usa el clip.",
            rewards: [{ id: reward.id, title: reward.title, enabled: reward.desiredEnabled }],
          },
        };
      }
      return { ok: true };
    };

    api.get("/api/state", async () => ({
      ...queueDisplayState(),
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
          return { ok: true, item, state: queueDisplayState() };
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
      return { ok: true, state: queueDisplayState(), next };
    });
    api.post("/api/pause", async () => {
      queue.pause();
      return { ok: true, state: queueDisplayState() };
    });
    api.post("/api/resume", async () => {
      queue.resume();
      return { ok: true, state: queueDisplayState() };
    });
    api.post("/api/clear", async () => ({
      ok: true,
      removed: queue.clear(),
      state: queueDisplayState(),
    }));

    // Corta todas las voces superpuestas de los overlays conectados.
    api.post("/api/audio/stop", async () => {
      hub.stopAudio();
      return { ok: true };
    });

    // Descarga en segundo plano (reemplaza el enqueue por URL).
    api.post<{ Body: { url: string } }>(
      "/api/download",
      { schema: { body: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", minLength: 1, maxLength: 2048 } } } } },
      async (request) => ({ ok: true, job: jobs.create(request.body.url) }),
    );

    // Subida de un archivo local (Etapa 3B). Se escribe con streaming a un
    // temporal y se crea un trabajo que lo valida por contenido (ffprobe) y lo
    // normaliza. Los errores inmediatos (sin archivo, demasiado grande) no crean
    // trabajo y se devuelven con un mensaje en español.
    api.post("/api/uploads", async (request, reply) => {
      let part;
      try {
        part = await request.file({ limits: { fileSize: readSettings(db).maxVideoBytes } });
      } catch (error) {
        const tooBig =
          typeof error === "object" && error !== null && (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE";
        return reply.code(413).send({
          ok: false,
          reason: tooBig ? "TOO_BIG" : "UPLOAD_FAILED",
          message: tooBig
            ? "El archivo supera el tamaño máximo configurado."
            : "No se pudo recibir el archivo.",
        });
      }
      if (!part) {
        return reply.code(400).send({ ok: false, reason: "NO_FILE", message: "No se recibió ningún archivo." });
      }

      const filename = typeof part.filename === "string" ? part.filename : "archivo";
      const tempPath = join(uploadsDir, `${randomUUID()}.upload`);
      try {
        await pipeline(part.file, createWriteStream(tempPath));
      } catch (error) {
        rmSync(tempPath, { force: true });
        const tooBig =
          typeof error === "object" && error !== null && (error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE";
        return reply.code(tooBig ? 413 : 400).send({
          ok: false,
          reason: tooBig ? "TOO_BIG" : "UPLOAD_FAILED",
          message: tooBig
            ? "El archivo supera el tamaño máximo configurado."
            : "No se pudo recibir el archivo.",
        });
      }
      if (part.file.truncated) {
        rmSync(tempPath, { force: true });
        return reply
          .code(413)
          .send({ ok: false, reason: "TOO_BIG", message: "El archivo supera el tamaño máximo configurado." });
      }
      return { ok: true, job: jobs.createLocal(tempPath, filename) };
    });

    api.get("/api/jobs", async () => ({ jobs: jobs.list() }));
    api.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
      const job = jobs.get(request.params.id);
      if (!job) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      return { ok: true, job };
    });

    // Cancela un trabajo en curso. Limpia los temporales y descarta el resultado.
    api.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
      if (!jobs.cancel(request.params.id)) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      return { ok: true };
    });

    // Quita un trabajo TERMINADO de la lista (listo o con error). Un trabajo en
    // curso o en cola no se quita: se rechaza con 409 y se usa Cancelar.
    api.delete<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
      const result = jobs.remove(request.params.id);
      if (result === "missing") return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      if (result === "active") {
        return reply.code(409).send({
          ok: false,
          reason: "ACTIVE",
          message: "Esa tarea todavía está en curso. Usá Cancelar para detenerla.",
        });
      }
      return { ok: true, jobs: jobs.list() };
    });

    // Quita TODOS los trabajos terminados. Devuelve cuántos quitó y la lista vigente.
    api.post("/api/jobs/clear-finished", async () => ({
      ok: true,
      removed: jobs.clearFinished(),
      jobs: jobs.list(),
    }));

    api.get("/api/clips", async () => ({
      // `suggestedTitle` es un nombre propuesto a partir del título del clip, para
      // el formulario de recompensas (rediseño, Etapa 4A).
      // `thumbUrl` es la miniatura real del clip (sección 2.4); viene `null` si
      // todavía no se generó (la tarjeta muestra el respaldo).
      clips: listClips(db).map((clip) => ({
        ...clip,
        suggestedTitle: suggestedTitle(clip.title),
        thumbUrl: thumbExists(mediaDir, clip.id) ? `/media/thumbs/${clip.id}.jpg` : null,
      })),
      // Aviso de arranque: se recuperaron o se marcaron clips en la reconciliación
      // con /media. Solo viene si hubo cambios; el dashboard lo muestra una vez.
      libraryNotice: options.libraryNotice ?? null,
    }));

    // Genera las miniaturas faltantes de la biblioteca, de a una en segundo
    // plano (solo por acción del usuario). No modifica ni regraba ningún clip.
    api.post("/api/clips/thumbs/backfill", async () => {
      const clips = listClips(db)
        .filter((clip) => clip.hasVideo !== false && !thumbExists(mediaDir, clip.id))
        .map((clip) => ({
          id: clip.id,
          file: clip.file,
          durationSec: clip.durationSec,
          hasVideo: clip.hasVideo !== false,
        }));
      if (clips.length === 0) {
        return { ok: true, job: null, remaining: 0 };
      }
      const job = jobs.createThumbBackfill(clips, { tag: "thumbs" });
      return { ok: true, job, remaining: clips.length };
    });

    // Limpieza de caché (Etapa 3B, sección 9): borra SOLO los clips de link que
    // se pueden volver a descargar. Nunca toca archivos locales, ni clips usados
    // por una recompensa (activa o desactivada), ni clips en la cola.
    api.post("/api/clips/cleanup", async () => {
      const state = queue.getState();
      const inQueue = new Set<string>();
      if (state.current) inQueue.add(state.current.clipId);
      for (const item of state.pending) inQueue.add(item.clipId);

      const removed: string[] = [];
      for (const clip of listClips(db)) {
        // Los archivos locales nunca se borran solos.
        if (clip.sourceUrl === "") continue;
        if (inQueue.has(clip.id)) continue;
        if (listRewardsUsingClip(db, clip.id).length > 0) continue;
        const filePath = resolve(mediaDir, clip.file);
        if (filePath.startsWith(mediaDir + sep)) {
          rmSync(filePath, { force: true });
          rmSync(join(mediaDir, `${clip.id}.json`), { force: true });
        }
        deleteClipRow(db, clip.id);
        removed.push(clip.id);
      }
      return { ok: true, removed };
    });

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

    // Recompensas que usan un clip (incluidas las desactivadas). La reutiliza la
    // ventana de detalle para advertir antes de borrar.
    api.get<{ Params: { id: string } }>("/api/clips/:id/usage", async (request, reply) => {
      if (!getClip(db, request.params.id)) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      return {
        ok: true,
        rewards: listRewardsUsingClip(db, request.params.id).map((reward) => ({
          id: reward.id,
          title: reward.title,
          enabled: reward.desiredEnabled,
        })),
      };
    });

    api.delete<{ Params: { id: string }; Body: { deleteUsingRewards?: boolean } | null }>(
      "/api/clips/:id",
      {
        schema: {
          body: {
            // `null` permite un DELETE sin cuerpo (el caso de borrar un clip que
            // ninguna recompensa usa), que antes era el único camino.
            type: ["object", "null"],
            additionalProperties: false,
            properties: { deleteUsingRewards: { type: "boolean" } },
          },
        },
      },
      async (request, reply) => {
        const clip = getClip(db, request.params.id);
        if (!clip) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });

        // Guarda (rediseño, Etapa 3A): no se borra un clip que alguna recompensa
        // use (incluidas las desactivadas). La ventana de detalle ofrece borrar
        // esas recompensas con una advertencia extra (`deleteUsingRewards`).
        const using = listRewardsUsingClip(db, clip.id);
        if (using.length > 0 && request.body?.deleteUsingRewards !== true) {
          const names = using.map((reward) => reward.title).join(", ");
          return reply.code(409).send({
            ok: false,
            reason: "CLIP_IN_USE",
            message:
              using.length === 1
                ? `No se puede borrar el clip: lo usa la recompensa ${names}.`
                : `No se puede borrar el clip: lo usan las recompensas ${names}.`,
            rewards: using.map((reward) => ({
              id: reward.id,
              title: reward.title,
              enabled: reward.desiredEnabled,
            })),
          });
        }

        if (using.length > 0) {
          // Borra las recompensas que usan el clip. Reutiliza el flujo de borrado
          // de recompensas (rechazo de canjes pendientes). Si alguna pide
          // confirmación por canjes pendientes, se corta y se le devuelve al
          // cliente para que confirme: el clip no se borra todavía.
          const pending = await removeRewardsForClip(using);
          if (!pending.ok) return reply.code(pending.status).send(pending.body);
        }

        const filePath = resolve(mediaDir, clip.file);
        if (filePath.startsWith(mediaDir + sep)) {
          rmSync(filePath, { force: true });
          rmSync(join(mediaDir, `${clip.id}.json`), { force: true });
        }
        removeThumb(mediaDir, clip.id);
        deleteClipRow(db, clip.id);
        return { ok: true };
      },
    );

    api.post<{ Params: { id: string }; Body: PlayBody }>(
      "/api/clips/:id/play",
      { schema: { body: playSchema } },
      async (request, reply) => {
        const clip = getClip(db, request.params.id);
        if (!clip) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
        if (clip.missing) {
          return reply
            .code(409)
            .send({ ok: false, reason: "CLIP_MISSING", message: "Falta el archivo del clip." });
        }

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

        // "Probar alerta" en modo superpuesto: un audio fire-and-forget al overlay.
        // El modo overlap ya no depende de una marca del clip: la recompensa decide.
        if (body.repetition === "overlap") {
          const sent = hub.broadcastAudio({
            id: `test-${Date.now().toString(36)}`,
            url: mediaUrlWithKey(clip.id),
            volume: (request.body?.volume ?? 1) * (settings.globalVolume / 100),
            trimStart: trim.trimStart,
            trimEnd: trim.trimEnd,
            maxDurationSec: request.body?.maxDurationSec ?? settings.defaultMaxDurationSec,
            maxVoices: settings.maxAudioVoices,
          });
          if (sent === 0) {
            return reply
              .code(409)
              .send({ ok: false, message: "No hay ningún overlay conectado. Revisá la fuente en OBS." });
          }
          return { ok: true, audio: true };
        }

        const item = queue.enqueue({
          clipId: clip.id,
          priority: request.body?.priority,
          volume: (request.body?.volume ?? 1) * (settings.globalVolume / 100),
          maxDurationSec: request.body?.maxDurationSec ?? settings.defaultMaxDurationSec,
          trimStart: trim.trimStart,
          trimEnd: trim.trimEnd,
          position: request.body?.position ?? undefined,
          enterAnimation: request.body?.enterAnimation ?? undefined,
          exitAnimation: request.body?.exitAnimation ?? undefined,
          // Un clip sin imagen (audio local) suena igual sin mostrar imagen.
          audioOnly: request.body?.audioOnly === true || clip.hasVideo === false,
          label: clip.title,
        });
        return { ok: true, item, state: queueDisplayState() };
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

    // --- Reglas (Fase 4A) ----------------------------------------------------

    const listSourceInfo = (): Array<{
      id: string;
      platform: string;
      capabilities: EventSource["capabilities"];
    }> => sources.map((source) => ({ id: source.id, platform: source.platform, capabilities: source.capabilities }));

    api.get("/api/rules", async () => ({ ok: true, rules: listRules(db), sources: listSourceInfo() }));

    api.post<{ Body: { id?: string } & Record<string, unknown> }>(
      "/api/rules",
      { schema: { body: ruleSchema } },
      async (request, reply) => {
        const validation = validateRuleInput(request.body);
        if (!validation.ok) {
          return reply.code(400).send({ ok: false, reason: "INVALID_RULE", message: validation.message });
        }
        const id =
          typeof request.body.id === "string" && request.body.id.length > 0 ? request.body.id : randomUUID();
        const existing = getRuleRecord(db, id);
        const timestamp = new Date().toISOString();
        upsertRule(db, {
          id,
          name: validation.value.name,
          enabled: validation.value.enabled,
          trigger: validation.value.trigger,
          conditions: validation.value.conditions,
          action: validation.value.action,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
        });
        engine.setRules(listRules(db).map(toRule));
        return { ok: true, rule: getRuleRecord(db, id) };
      },
    );

    api.delete<{ Params: { id: string } }>("/api/rules/:id", async (request, reply) => {
      if (!deleteRule(db, request.params.id)) {
        return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
      }
      engine.setRules(listRules(db).map(toRule));
      return { ok: true };
    });

    api.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
      "/api/rules/:id/toggle",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["enabled"],
            properties: { enabled: { type: "boolean" } },
          },
        },
      },
      async (request, reply) => {
        const record = getRuleRecord(db, request.params.id);
        if (!record) return reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
        upsertRule(db, { ...record, enabled: request.body.enabled, updatedAt: new Date().toISOString() });
        engine.setRules(listRules(db).map(toRule));
        return { ok: true, rule: getRuleRecord(db, request.params.id) };
      },
    );

    // --- Historial de eventos ------------------------------------------------

    api.get<{ Querystring: { limit?: string } }>("/api/events", async (request) => {
      const limit = Number(request.query.limit);
      return { ok: true, events: listHistory(db, Number.isInteger(limit) && limit > 0 ? limit : 200) };
    });

    // --- Simulación de eventos (sin plataforma) ------------------------------

    api.get("/api/sources", async () => ({
      ok: true,
      sources: listSourceInfo(),
      // Plataformas de forma genérica (nombre, estado, capabilities): este es el
      // único lugar del dashboard que las lista; no conoce nombres de plataforma.
      platforms: integrations.map((integration) => integration.status()),
    }));

    // --- Rutas de plataformas (Fase 4B) --------------------------------------
    registerPlatformApiRoutes(api, {
      integrations,
      coordinator,
      db,
      port,
      refreshRules: () => engine.setRules(listRules(db).map(toRule)),
      debug,
    });

    // --- Rutas de recompensas (rediseño, Etapa 4A) ---------------------------
    registerRewardApiRoutes(api, {
      integrations,
      db,
      refreshRules: () => engine.setRules(listRules(db).map(toRule)),
      debug,
    });

    api.post<{ Body: SimulateBody }>(
      "/api/simulate",
      { schema: { body: simulateSchema } },
      async (request) => {
        const body = request.body;
        const event = simulatedSource.trigger({
          type: body.type,
          user: {
            id: body.userId ?? "sim-user",
            name: body.userName ?? "Espectador",
            roles: body.roles ?? [],
          },
          payload: buildSimulatedPayload(body),
        });
        return { ok: true, eventId: event.id };
      },
    );

    api.post<{ Body: { userId?: string; userName?: string; roles?: string[] } }>(
      "/api/manual",
      { schema: { body: manualSchema } },
      async (request) => {
        const event = manualSource.trigger({
          user: {
            id: request.body.userId ?? "manual-user",
            name: request.body.userName ?? "Manual",
            roles: request.body.roles ?? [],
          },
        });
        return { ok: true, eventId: event.id };
      },
    );
  });

  // --- Arranque / parada ----------------------------------------------------

  return {
    app,
    queue,
    auth,
    jobs,
    db,
    engine,
    sources,
    manualSource,
    simulatedSource,
    integrations,
    coordinator,
    getOverlayKey: () => overlayKey,
    async start() {
      try {
        await app.listen({ port, host });
      } catch (error) {
        // Puerto ocupado: mensaje claro en español, sin stack trace crudo. El
        // caso más común es que ya haya otra copia de la app corriendo.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") {
          throw new Error(
            `El puerto ${port} ya está en uso. Probablemente ya hay otra copia de VIUrewards ` +
              `corriendo (quizá en otra terminal). Cerrá esa copia o elegí otro puerto. ` +
              `Si el puerto lo ocupa otro programa ajeno, cerralo o cambiá el puerto de la app.`,
          );
        }
        if (code === "EACCES") {
          throw new Error(`No hay permisos para escuchar en el puerto ${port}. Elegí otro puerto o corré como administrador.`);
        }
        throw error;
      }

      // Las integraciones arrancan su polling solo si la cuenta está vinculada.
      for (const integration of integrations) await integration.start();

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
      for (const integration of integrations) await integration.stop();
      await hub.close();
      await app.close();
    },
  };
}