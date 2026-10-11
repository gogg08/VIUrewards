/**
 * Rutas de recompensas del canal (rediseño, Etapa 4A).
 *
 * Vive fuera de `src/platforms/<nombre>/`: solo conoce la interfaz genérica
 * `PlatformIntegration` y el `RewardService`, así que no menciona ninguna
 * plataforma concreta (AGENTS.md: aislamiento de plataformas).
 *
 * Reemplaza a las rutas de recompensas que antes vivían en `platforms-routes.ts`.
 * La vista (`GET`) combina las filas locales con la lista de la plataforma y
 * calcula el estado de cada recompensa. Las operaciones (crear, editar, activar,
 * desactivar, borrar, recrear, quitar) viven acá con su manejo de fallos explícito.
 */

import type { FastifyInstance, FastifyReply } from "fastify";

import type { SqliteDatabase } from "../db/index.ts";
import type { PlatformIntegration } from "../platforms/integration.ts";
import { ANIMATION_NAMES, RewardService, type RewardPendingResult } from "../rewards/index.ts";
import { findIntegration } from "./platforms-routes.ts";
import { httpStatusForPlatformReason, operationError, pendingResponse } from "./platforms-routes.ts";

export interface RewardRoutesContext {
  integrations: PlatformIntegration[];
  db: SqliteDatabase;
  refreshRules: () => void;
  debug: boolean;
}

const animationEnum = [...ANIMATION_NAMES, null];

const playbackProperties = {
  clipId: { type: "string", minLength: 1, maxLength: 128 },
  volume: { type: "number", minimum: 0, maximum: 1 },
  maxDurationSec: { type: ["number", "null"], minimum: 1 },
  cooldownSec: { type: "integer", minimum: 0, maximum: 86400 },
  userCooldownSec: { type: "integer", minimum: 0, maximum: 86400 },
  position: {
    type: ["object", "null"],
    additionalProperties: false,
    required: ["x", "y"],
    properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } },
  },
  enterAnimation: { type: ["string", "null"], enum: animationEnum },
  exitAnimation: { type: ["string", "null"], enum: animationEnum },
} as const;

const createRewardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "cost", "clipId"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 50 },
    cost: { type: "integer", minimum: 1, maximum: 1_000_000 },
    description: { type: "string", maxLength: 200 },
    color: { type: "string", maxLength: 7 },
    enabled: { type: "boolean" },
    ...playbackProperties,
  },
} as const;

const updateRewardSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 50 },
    cost: { type: "integer", minimum: 1, maximum: 1_000_000 },
    description: { type: "string", maxLength: 200 },
    color: { type: "string", maxLength: 7 },
    ...playbackProperties,
  },
} as const;

const pendingSchema = {
  type: "object",
  additionalProperties: false,
  properties: { confirm: { type: "boolean" }, force: { type: "boolean" } },
} as const;

const idParamSchema = {
  type: "object",
  required: ["id", "localId"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    localId: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

const platformParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

/** Cuerpo de una operación sobre canjes pendientes (confirmación / forzar). */
interface PendingBody {
  confirm?: boolean;
  force?: boolean;
}

export function registerRewardApiRoutes(app: FastifyInstance, ctx: RewardRoutesContext): void {
  const serviceFor = (integration: PlatformIntegration): RewardService =>
    new RewardService({
      db: ctx.db,
      integration,
      onRulesChanged: ctx.refreshRules,
      logger: ctx.debug ? (message) => console.log(`[rewards] ${message}`) : undefined,
    });

  const withIntegration = (
    id: string,
    reply: FastifyReply,
  ): PlatformIntegration | undefined => {
    const integration = findIntegration(ctx.integrations, id);
    if (!integration) reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    return integration;
  };

  // --- Vista unificada -------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/platforms/:id/rewards",
    { schema: { params: platformParamSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const snapshot = await serviceFor(integration).list();
      return {
        ok: true,
        platformState: snapshot.platformState,
        connected: snapshot.connected,
        offline: snapshot.offline,
        message: snapshot.message,
        rewards: snapshot.rewards,
      };
    },
  );

  // --- Crear y editar --------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    "/api/platforms/:id/rewards",
    { schema: { params: platformParamSchema, body: createRewardSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).create(request.body as never);
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send(operationError(result));
      return { ok: true, reward: result.value };
    },
  );

  app.patch<{ Params: { id: string; localId: string } }>(
    "/api/platforms/:id/rewards/:localId",
    { schema: { params: idParamSchema, body: updateRewardSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).update(request.params.localId, request.body as never);
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send(operationError(result));
      return { ok: true, reward: result.value };
    },
  );

  // --- Activar / desactivar / recrear / quitar -------------------------------

  app.post<{ Params: { id: string; localId: string } }>(
    "/api/platforms/:id/rewards/:localId/enable",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).enable(request.params.localId);
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send(operationError(result));
      return { ok: true, reward: result.value };
    },
  );

  app.post<{ Params: { id: string; localId: string }; Body: PendingBody }>(
    "/api/platforms/:id/rewards/:localId/disable",
    { schema: { params: idParamSchema, body: pendingSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).disable(request.params.localId, request.body ?? {});
      return sendPending(reply, result, httpStatusForPlatformReason);
    },
  );

  app.post<{ Params: { id: string; localId: string } }>(
    "/api/platforms/:id/rewards/:localId/recreate",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).recreate(request.params.localId);
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send(operationError(result));
      return { ok: true, reward: result.value };
    },
  );

  app.post<{ Params: { id: string; localId: string } }>(
    "/api/platforms/:id/rewards/:localId/detach",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).detach(request.params.localId);
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send(operationError(result));
      return { ok: true, id: result.value.id };
    },
  );

  // --- Borrar ----------------------------------------------------------------

  app.delete<{ Params: { id: string; localId: string }; Body: PendingBody }>(
    "/api/platforms/:id/rewards/:localId",
    { schema: { params: idParamSchema, body: pendingSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).remove(request.params.localId, request.body ?? {});
      return sendPending(reply, result, httpStatusForPlatformReason);
    },
  );

  // --- Canjes pendientes (para el texto de confirmación) ---------------------

  app.get<{ Params: { id: string; localId: string } }>(
    "/api/platforms/:id/rewards/:localId/pending",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = withIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await serviceFor(integration).pendingCount(request.params.localId);
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send(operationError(result));
      return { ok: true, count: result.value };
    },
  );
}

/** Responde un resultado de desactivar/borrar (con el flujo de pendientes). */
function sendPending(
  reply: FastifyReply,
  result: RewardPendingResult,
  statusFor: (reason: string) => number,
): unknown {
  if (result.ok) return { ok: true, reward: result.reward ?? null, warning: result.warning ?? null };
  if (result.needsConfirm) {
    return reply.code(409).send({ ok: false, needsConfirm: true, pending: result.pending, message: result.message });
  }
  return reply.code(statusFor(result.reason ?? "UNKNOWN")).send(pendingResponse(result));
}