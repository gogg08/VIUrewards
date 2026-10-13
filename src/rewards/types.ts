/**
 * Tipos del módulo de recompensas (rediseño, Etapa 4A).
 *
 * Es genérico: describe la vista unificada y las operaciones sobre recompensas de
 * canal sin conocer ninguna plataforma (AGENTS.md: aislamiento). El adaptador de
 * cada plataforma se consume a través de `PlatformIntegration`.
 */

import type { RewardRepetition } from "../db/rewards.ts";

export type { RewardRepetition };

/** Estado visible de una recompensa en el dashboard. */
export type RewardState =
  | "enabled" // Habilitada
  | "disabled" // Deshabilitada
  | "missing" // Falta en Kick (la borraron en la plataforma)
  | "foreign" // De otra app (no la administra esta app)
  | "offline" // Sin conexión: no se pudo consultar la plataforma
  | "apply_failed"; // No se pudo aplicar la última operación

/** Una recompensa tal como la ve el dashboard (vista unificada). */
export interface RewardListItem {
  /** Id local; para "de otra app" es el id remoto (no hay fila local). */
  id: string;
  localId: string | null;
  remoteId: string | null;
  title: string;
  cost: number;
  description: string;
  color: string;
  enabled: boolean;
  managed: boolean;
  /** Siempre `false` en esta app (el público no envía texto). */
  userInputRequired: boolean;
  skipRequestQueue: boolean;
  clipId: string | null;
  clipTitle: string | null;
  /** Volumen 0 a 1. */
  volume: number;
  maxDurationSec: number | null;
  cooldownSec: number;
  /** Modo de repetición: "queue" (esperar turno) u "overlap" (superponer audios). */
  repetition: RewardRepetition;
  position: { x: number; y: number } | null;
  enterAnimation: string | null;
  exitAnimation: string | null;
  state: RewardState;
  /** Mensaje de "No se pudo aplicar", si lo hay. */
  error: string | null;
  /**
   * `false` cuando la fila es provisoria (importada y todavía sin sincronizar con la
   * plataforma): la UI la muestra como "Sincronizando..." y bloquea Editar.
   */
  synced: boolean;
}

/** Resultado de `GET` de recompensas: la vista unificada con el estado del vínculo. */
export interface RewardsSnapshot {
  platformState: "unlinked" | "connected" | "requires_relink";
  /** La plataforma está vinculada y respondió. */
  connected: boolean;
  /** No se pudo consultar la plataforma: se devuelven las guardadas. */
  offline: boolean;
  message: string | null;
  rewards: RewardListItem[];
}

/** Opciones de reproducción de una recompensa (solo locales). */
export interface RewardPlaybackInput {
  clipId?: string;
  volume?: number;
  maxDurationSec?: number | null;
  cooldownSec?: number;
  repetition?: RewardRepetition;
  position?: { x: number; y: number } | null;
  enterAnimation?: string | null;
  exitAnimation?: string | null;
}

/** Entrada para crear una recompensa. */
export interface RewardCreateInput extends RewardPlaybackInput {
  title: string;
  cost: number;
  description?: string;
  color?: string;
  enabled?: boolean;
}

/** Entrada para editar una recompensa (parcial). */
export type RewardUpdateInput = Partial<RewardCreateInput>;

export type RewardOperationError = {
  ok: false;
  reason: string;
  message: string;
};

export type RewardOperationResult<T> = { ok: true; value: T } | RewardOperationError;

/** Resultado de desactivar o borrar, con el flujo de canjes pendientes. */
export interface RewardPendingResult {
  ok: boolean;
  reason?: string;
  message?: string;
  /** Pide confirmación porque hay N canjes pendientes. */
  needsConfirm?: boolean;
  /** Cantidad de canjes pendientes a rechazar. */
  pending?: number;
  /** Rechazos que fallaron por un motivo real (no `benign`). */
  failed?: Array<{ id: string; reason: string }>;
  /** Advertencia cuando igual se aplicó la operación (con `force`). */
  warning?: string | null;
  reward?: RewardListItem;
}