/**
 * Registro de plataformas. Es el ÚNICO archivo fuera de `src/platforms/<nombre>/`
 * autorizado a importar un adaptador concreto (AGENTS.md: aislamiento de
 * plataformas). El servidor y el dashboard solo ven `PlatformIntegration`.
 *
 * Para agregar una plataforma: crear su carpeta, implementar la interfaz y
 * sumarla a `createPlatformIntegrations`.
 */

import type { SqliteDatabase } from "../db/index.ts";
import { createKickIntegration, type KickIntegrationOptions } from "./kick/index.ts";
import type { PlatformIntegration } from "./integration.ts";

export type { PlatformIntegration, PlatformAccount, RewardView, RewardInput, PollingDiagnostics } from "./integration.ts";

export interface PlatformRegistryOptions {
  db: SqliteDatabase;
  pollIntervalMs?: () => number;
  logger?: (message: string) => void;
  onStateChange?: () => void;
  /** Opciones extra para el adaptador de Kick (p. ej. URLs de prueba). */
  kick?: Partial<KickIntegrationOptions>;
}

export function createPlatformIntegrations(options: PlatformRegistryOptions): PlatformIntegration[] {
  return [
    createKickIntegration({
      db: options.db,
      pollIntervalMs: options.pollIntervalMs,
      logger: options.logger,
      onStateChange: options.onStateChange,
      ...options.kick,
    }),
  ];
}
