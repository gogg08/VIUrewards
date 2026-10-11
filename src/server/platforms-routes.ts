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

import type { FastifyInstance, FastifyReply } from "fastify";

import type { SqliteDatabase } from "../db/index.ts";
import type { PlatformIntegration } from "../platforms/integration.ts";
import { redemptionStatusLabel, type RedemptionStatus } from "../redemptions/index.ts";
import type { RedemptionCoordinator } from "../redemptions/index.ts";
import type { RewardPendingResult } from "../rewards/index.ts";

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

/** Estado HTTP para un motivo de error de una operación de plataforma. */
export function httpStatusForPlatformReason(reason: string): number {
  if (reason === "HTTP_401") return 401;
  if (reason === "HTTP_403" || reason === "NOT_MANAGED") return 403;
  if (reason === "HTTP_404" || reason === "NOT_FOUND") return 404;
  if (reason === "NO_CREDENTIALS" || reason === "NOT_LINKED" || reason === "MISSING" || reason === "NOT_SYNCED") return 409;
  return 400;
}

/** Normaliza un error de operación para la respuesta de la API. */
export function operationError(result: { reason: string; message: string }): {
  ok: false;
  reason: string;
  message: string;
} {
  return { ok: false, reason: result.reason, message: result.message };
}

/** Respuesta de un resultado de desactivar/borrar que no pide confirmación. */
export function pendingResponse(result: RewardPendingResult): {
  ok: false;
  reason: string;
  message: string;
  failed?: Array<{ id: string; reason: string }>;
} {
  return {
    ok: false,
    reason: result.reason ?? "UNKNOWN",
    message: result.message ?? "La operación no se pudo completar.",
    failed: result.failed,
  };
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
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send({ ok: false, reason: result.reason, message: result.message });
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
      if (!result.ok) return reply.code(httpStatusForPlatformReason(result.reason)).send({ ok: false, reason: result.reason, message: result.message });
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