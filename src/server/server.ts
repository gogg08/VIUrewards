/**
 * Servidor local (Fase 2).
 *
 * Fastify escuchando solo en 127.0.0.1. Sirve la página del overlay para OBS,
 * los clips de /media (solo lectura) y una API mínima y temporal para probar la
 * cola a mano (el dashboard llega en la Fase 3). El overlay se comunica por
 * WebSocket en /ws.
 *
 * Nada de esto asume una plataforma: la cola y el overlay son agnósticos.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import { AlertQueue, QueueInputError } from "../queue/index.ts";
import { processVideo, type MediaOptions } from "../media/index.ts";
import { attachWebSocket, type WebSocketHub } from "./ws.ts";

const OVERLAY_HTML_PATH = fileURLToPath(new URL("../../overlay/index.html", import.meta.url));

export const DEFAULT_SERVER_PORT = 8787;

/** Recorte de las opciones de media que el servidor reenvía al descargar por URL. */
export type MediaPassthroughOptions = Partial<
  Pick<
    MediaOptions,
    | "allowedDomains"
    | "maxUrlLength"
    | "maxDurationSec"
    | "maxBytes"
    | "timeoutMs"
    | "maxHeight"
    | "logsDir"
    | "binarySearch"
  >
>;

export interface ServerOptions {
  /** Carpeta desde donde se sirven los clips en /media. */
  mediaDir: string;
  port?: number;
  host?: string;
  queue?: AlertQueue;
  /** Límites y configuración usados al encolar por URL. */
  media?: MediaPassthroughOptions;
}

export interface AppServer {
  app: FastifyInstance;
  queue: AlertQueue;
  start(): Promise<{ port: number; host: string; url: string; overlayUrl: string }>;
  stop(): Promise<void>;
}

interface EnqueueBody {
  clipId?: string;
  url?: string;
  priority?: number;
  volume?: number;
  maxDurationSec?: number;
  label?: string;
}

const enqueueSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    clipId: { type: "string", minLength: 1, maxLength: 128 },
    url: { type: "string", minLength: 1, maxLength: 2048 },
    priority: { type: "number" },
    volume: { type: "number", minimum: 0, maximum: 1 },
    maxDurationSec: { type: "number", minimum: 1 },
    label: { type: "string", maxLength: 200 },
  },
  anyOf: [{ required: ["clipId"] }, { required: ["url"] }],
} as const;

export async function createServer(options: ServerOptions): Promise<AppServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const queue = options.queue ?? new AlertQueue();
  // @fastify/static exige una raíz absoluta.
  const mediaDir = resolve(options.mediaDir);
  const mediaOptions: MediaPassthroughOptions = options.media ?? {};

  // @fastify/static falla si la raíz no existe todavía.
  mkdirSync(mediaDir, { recursive: true });

  const app = Fastify({ logger: false });

  // /media es solo lectura y solo sirve archivos dentro de la carpeta media.
  // @fastify/static resuelve y valida el path, así que `../` no puede escapar;
  // además restringimos a .mp4 para no exponer otros archivos.
  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: "/media/",
    index: false,
    list: false,
    allowedPath: (pathname: string) => pathname.toLowerCase().endsWith(".mp4"),
  });

  app.get("/overlay", async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(readFileSync(OVERLAY_HTML_PATH, "utf8"));
  });

  app.get("/api/state", async () => queue.getState());

  app.post("/api/enqueue", { schema: { body: enqueueSchema } }, async (request, reply) => {
    const body = request.body as EnqueueBody;
    let clipId = body.clipId;

    if (!clipId && body.url) {
      const result = await processVideo(body.url, { mediaDir, ...mediaOptions });
      if (!result.ok) {
        return reply.code(400).send({ ok: false, reason: result.reason, message: result.message });
      }
      clipId = result.clip.id;
    }

    try {
      const item = queue.enqueue({
        clipId: clipId as string,
        priority: body.priority,
        volume: body.volume,
        maxDurationSec: body.maxDurationSec,
        label: body.label,
      });
      return { ok: true, item, state: queue.getState() };
    } catch (error) {
      if (error instanceof QueueInputError) {
        return reply.code(400).send({ ok: false, reason: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/api/skip", async () => {
    const next = queue.skip();
    return { ok: true, state: queue.getState(), next };
  });
  app.post("/api/pause", async () => {
    queue.pause();
    return { ok: true, state: queue.getState() };
  });
  app.post("/api/resume", async () => {
    queue.resume();
    return { ok: true, state: queue.getState() };
  });

  let hub: WebSocketHub | null = null;

  return {
    app,
    queue,
    async start() {
      await app.listen({ port, host });
      if (!hub) hub = attachWebSocket(app.server, queue);

      const address = app.server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      return { port: actualPort, host, url, overlayUrl: `${url}/overlay` };
    },
    async stop() {
      if (hub) {
        await hub.close();
        hub = null;
      }
      await app.close();
    },
  };
}
