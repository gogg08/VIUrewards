/**
 * Rutas de plataformas (Fase 4B): el callback OAuth público y la API protegida
 * que consume el dashboard.
 *
 * Este módulo vive fuera de `src/platforms/<nombre>/`: solo conoce la interfaz
 * genérica `PlatformIntegration`, así que no menciona ninguna plataforma concreta
 * (AGENTS.md: aislamiento de plataformas).
 *
 * Nada de tokens ni secretos sale hacia el frontend: el estado (`status()`) solo
 * informa `hasCredentials` y el `clientId` (que no es secreto).
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  deleteRule,
  getRuleRecord,
  listRules,
  upsertRule,
  type RuleRecord,
  type SqliteDatabase,
} from "../db/index.ts";
import type { PlatformIntegration, RewardInput, RewardView } from "../platforms/integration.ts";
import { redemptionStatusLabel, type RedemptionStatus } from "../redemptions/index.ts";
import type { RedemptionCoordinator } from "../redemptions/index.ts";
import { validateRuleInput } from "../rules/index.ts";

export interface PlatformRoutesContext {
  integrations: PlatformIntegration[];
  coordinator: RedemptionCoordinator;
  db: SqliteDatabase;
  /** Puerto donde corre el servidor (para el `redirect_uri` de OAuth). */
  port: number;
  /** Recarga las reglas del motor tras crear o borrar una regla. */
  refreshRules: () => void;
  debug: boolean;
}

/** Contexto mínimo que necesita el callback OAuth público. */
export interface OAuthCallbackContext {
  integrations: PlatformIntegration[];
  port: number;
  debug: boolean;
}

interface RewardRuleBody {
  mode: "play_clip";
  clipId?: string;
  volume?: number;
  maxDurationSec?: number;
  cooldownSec?: number;
}

interface RewardBody {
  title: string;
  cost: number;
  description?: string;
  color?: string;
  enabled?: boolean;
  userInputRequired?: boolean;
  skipRequestQueue?: boolean;
  rule?: RewardRuleBody;
}

const rewardProperties = {
  title: { type: "string", minLength: 1, maxLength: 50 },
  cost: { type: "integer", minimum: 1, maximum: 1_000_000 },
  description: { type: "string", maxLength: 200 },
  color: { type: "string", maxLength: 32 },
  enabled: { type: "boolean" },
  userInputRequired: { type: "boolean" },
  skipRequestQueue: { type: "boolean" },
  rule: {
    type: "object",
    additionalProperties: false,
    required: ["mode"],
    properties: {
      mode: { type: "string", enum: ["play_clip"] },
      clipId: { type: "string", maxLength: 128 },
      volume: { type: "number", minimum: 0, maximum: 1 },
      maxDurationSec: { type: "number", minimum: 1 },
      cooldownSec: { type: "integer", minimum: 0, maximum: 86400 },
    },
  },
} as const;

const createRewardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "cost"],
  properties: rewardProperties,
} as const;

const updateRewardSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: rewardProperties.title,
    cost: rewardProperties.cost,
    description: rewardProperties.description,
    color: rewardProperties.color,
    enabled: rewardProperties.enabled,
    userInputRequired: rewardProperties.userInputRequired,
    skipRequestQueue: rewardProperties.skipRequestQueue,
  },
} as const;

const credentialsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["clientId"],
  properties: {
    clientId: { type: "string", minLength: 1, maxLength: 256 },
    // Solo escritura: se guarda y nunca se devuelve.
    clientSecret: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

function redirectUri(port: number): string {
  // Debe coincidir EXACTAMENTE con la registrada en la app de Kick. Se usa
  // `localhost` (no `127.0.0.1`, por un problema conocido del alta de apps).
  return `http://localhost:${port}/callback`;
}

function httpStatusFor(reason: string): number {
  if (reason === "HTTP_401") return 401;
  if (reason === "HTTP_404") return 404;
  if (reason === "NOT_MANAGED") return 403;
  if (reason === "NO_CREDENTIALS") return 409;
  return 400;
}

export function findIntegration(
  integrations: PlatformIntegration[],
  id: string,
): PlatformIntegration | undefined {
  return integrations.find((integration) => integration.id === id);
}

/** Registra el callback OAuth público (`/callback`), sin cookie de sesión. */
export function registerOAuthCallback(app: FastifyInstance, ctx: OAuthCallbackContext): void {
  app.get("/callback", async (request, reply) => {
    const url = new URL(request.url ?? "/callback", `http://localhost:${ctx.port}`);
    const query = url.searchParams;

    // No se envía ningún parámetro sensible al dashboard; el estado del vínculo
    // se consulta por /api/platforms. Se prueba cada integración: solo la que
    // inició el intento reconoce el `state` y completa el intercambio con PKCE.
    for (const integration of ctx.integrations) {
      try {
        await integration.completeLink(query);
      } catch (error) {
        if (ctx.debug) {
          console.warn(`[platform] callback: ${error instanceof Error ? error.message : "error"}`);
        }
      }
    }

    return reply
      .code(302)
      .header("location", `http://127.0.0.1:${ctx.port}/`)
      .send();
  });
}

/** Registra la API protegida de plataformas (requiere sesión del dashboard). */
export function registerPlatformApiRoutes(app: FastifyInstance, ctx: PlatformRoutesContext): void {
  const requireIntegration = (
    id: string,
    reply: FastifyReply,
  ): PlatformIntegration | undefined => {
    const integration = findIntegration(ctx.integrations, id);
    if (!integration) reply.code(404).send({ ok: false, reason: "NOT_FOUND" });
    return integration;
  };

  app.get("/api/platforms", async () => ({
    ok: true,
    platforms: ctx.integrations.map((integration) => integration.status()),
  }));

  app.post<{ Params: { id: string }; Body: { clientId: string; clientSecret?: string } }>(
    "/api/platforms/:id/credentials",
    { schema: { params: idParamSchema, body: credentialsSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await integration.setCredentials({
        clientId: request.body.clientId,
        clientSecret: request.body.clientSecret,
      });
      if (!result.ok) return reply.code(httpStatusFor(result.reason)).send({ ok: false, reason: result.reason, message: result.message });
      return { ok: true, platform: result.value };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/platforms/:id/credentials",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      await integration.clearCredentials();
      return { ok: true, platform: integration.status() };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/platforms/:id/link",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await integration.beginLink(redirectUri(ctx.port));
      if (!result.ok) return reply.code(httpStatusFor(result.reason)).send({ ok: false, reason: result.reason, message: result.message });
      return { ok: true, authorizeUrl: result.value.authorizeUrl, expiresAt: result.value.expiresAt };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/platforms/:id/unlink",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      await integration.unlink();
      return { ok: true, platform: integration.status() };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/platforms/:id/test",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await integration.test();
      return { ok: result.ok, message: result.message, accountName: result.accountName ?? null, rewards: result.rewards ?? null };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/platforms/:id/diagnostics",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      return { ok: true, diagnostics: integration.diagnostics(), platform: integration.status() };
    },
  );

  // --- Recompensas -----------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/platforms/:id/rewards",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await integration.listRewards();
      if (!result.ok) return reply.code(httpStatusFor(result.reason)).send({ ok: false, reason: result.reason, message: result.message });
      return { ok: true, rewards: result.value };
    },
  );

  app.post<{ Params: { id: string }; Body: RewardBody }>(
    "/api/platforms/:id/rewards",
    { schema: { params: idParamSchema, body: createRewardSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;

      const input: RewardInput = {
        title: request.body.title,
        cost: request.body.cost,
        description: request.body.description,
        color: request.body.color,
        enabled: request.body.enabled,
        userInputRequired: request.body.userInputRequired,
        skipRequestQueue: request.body.skipRequestQueue,
      };
      const created = await integration.createReward(input);
      if (!created.ok) return reply.code(httpStatusFor(created.reason)).send({ ok: false, reason: created.reason, message: created.message });

      // Regla asociada en el mismo formulario (reproduce un clip fijo).
      const ruleSpec = request.body.rule;
      if (ruleSpec) {
        const built = buildRewardRule(ruleSpec, created.value);
        if (!built.ok) return { ok: true, reward: created.value, rule: null, ruleWarning: built.message };
        upsertRule(ctx.db, built.rule);
        ctx.refreshRules();
        return { ok: true, reward: created.value, rule: getRuleRecord(ctx.db, built.rule.id) };
      }

      return { ok: true, reward: created.value, rule: null };
    },
  );

  app.patch<{ Params: { id: string; rewardId: string }; Body: Partial<RewardBody> }>(
    "/api/platforms/:id/rewards/:rewardId",
    { schema: { params: { type: "object", required: ["id", "rewardId"], properties: { id: { type: "string" }, rewardId: { type: "string", minLength: 1 } } }, body: updateRewardSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await integration.updateReward(request.params.rewardId, request.body as Partial<RewardInput>);
      if (!result.ok) return reply.code(httpStatusFor(result.reason)).send({ ok: false, reason: result.reason, message: result.message });
      // Borrar una recompensa no borra el clip ni la regla (decisión documentada).
      return { ok: true, reward: result.value };
    },
  );

  app.delete<{ Params: { id: string; rewardId: string } }>(
    "/api/platforms/:id/rewards/:rewardId",
    { schema: { params: { type: "object", required: ["id", "rewardId"], properties: { id: { type: "string" }, rewardId: { type: "string", minLength: 1 } } } } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const result = await integration.deleteReward(request.params.rewardId);
      if (!result.ok) return reply.code(httpStatusFor(result.reason)).send({ ok: false, reason: result.reason, message: result.message });
      // Se limpian las reglas que apuntaban a esa recompensa; el clip NO se toca
      // (decisión documentada en docs/kick-setup.md).
      let rulesRemoved = 0;
      for (const rule of listRules(ctx.db)) {
        if (rule.trigger.type === "reward_redeemed" && rule.trigger.rewardId === request.params.rewardId) {
          if (deleteRule(ctx.db, rule.id)) rulesRemoved += 1;
        }
      }
      if (rulesRemoved > 0) ctx.refreshRules();
      return { ok: true, id: result.value.id, rulesRemoved };
    },
  );

  // --- Canjes pendientes antiguos (ignored) ----------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/platforms/:id/redemptions",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const items = ctx.coordinator.listIgnored(integration.platform).map((row) => ({
        eventId: row.eventId,
        rewardId: row.rewardId,
        rewardTitle: row.rewardTitle,
        userName: row.userName,
        userInput: row.userInput,
        status: row.status,
        statusLabel: redemptionStatusLabel(row.status as RedemptionStatus),
        reason: row.reason,
        redeemedAt: row.redeemedAt,
      }));
      return { ok: true, redemptions: items, count: items.length };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/platforms/:id/redemptions/reject-all",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const rejected = await ctx.coordinator.rejectAllIgnored(integration.platform);
      return { ok: true, rejected, remaining: ctx.coordinator.listIgnored(integration.platform).length };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/platforms/:id/redemptions/process-now",
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const integration = requireIntegration(request.params.id, reply);
      if (!integration) return;
      const processed = await ctx.coordinator.reprocessAll(integration.platform);
      return { ok: true, processed, remaining: ctx.coordinator.listIgnored(integration.platform).length };
    },
  );
}

type BuiltRule = { ok: true; rule: RuleRecord } | { ok: false; message: string };

/**
 * Arma la regla asociada a una recompensa. La única acción es reproducir un clip
 * fijo (`PlayClip`); el público no envía links.
 */
function buildRewardRule(spec: RewardRuleBody, reward: RewardView): BuiltRule {
  const id = randomUUID();
  const trigger = { type: "reward_redeemed" as const, rewardId: reward.id };
  const conditions = {
    permission: "everyone" as const,
    cooldownSec: spec.cooldownSec ?? 0,
    userCooldownSec: 0,
  };

  if (!spec.clipId) return { ok: false, message: "Elegí un clip de la biblioteca." };
  const action: Record<string, unknown> = { kind: "play_clip", clipId: spec.clipId };
  if (spec.volume !== undefined) action.volume = spec.volume;
  if (spec.maxDurationSec !== undefined) action.maxDurationSec = spec.maxDurationSec;

  const candidate = {
    id,
    name: `Recompensa: ${reward.title}`.slice(0, 100),
    enabled: true,
    trigger,
    conditions,
    action,
  };
  const validation = validateRuleInput(candidate);
  if (!validation.ok) return { ok: false, message: validation.message };

  const now = new Date().toISOString();
  const rule = {
    id,
    name: validation.value.name,
    enabled: validation.value.enabled,
    trigger: validation.value.trigger,
    conditions: validation.value.conditions,
    action: validation.value.action,
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, rule };
}