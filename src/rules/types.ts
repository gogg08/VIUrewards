/**
 * Tipos del motor de reglas (Fase 4A).
 *
 * El motor trabaja SOLO con eventos normalizados y con estas estructuras. No
 * conoce ninguna plataforma ni ninguna acción concreta: las acciones se ejecutan
 * a través de la interfaz `RuleAction`.
 */

import type { EventType, NormalizedEvent } from "../events/index.ts";
import type { AnimationName, EnqueueSink, OverlayPosition } from "../queue/index.ts";

/** Criterio de disparo de una regla: tipo de evento + filtros opcionales. */
export interface RuleTrigger {
  type: EventType;
  /** Para `chat_command`: nombre del comando (con o sin `!`). */
  command?: string;
  /** Para `reward_redeemed`: id de la recompensa. */
  rewardId?: string;
  /** Monto mínimo (gift subs, bits, etc.). */
  minAmount?: number;
}

export type Permission = "everyone" | "subs" | "mods";

/**
 * Condiciones de una regla. El cooldown NO vive acá: desde el rework (Parte B)
 * es un atributo de la recompensa (global, persistido), aplicado por el
 * despachador de recompensas del servidor. Se eliminó el cooldown por usuario.
 */
export interface RuleConditions {
  /** Quién puede dispararla. */
  permission: Permission;
}

export interface PlayClipActionConfig {
  kind: "play_clip";
  clipId: string;
  priority?: number;
  volume?: number;
  maxDurationSec?: number;
  trimStart?: number;
  trimEnd?: number | null;
  position?: OverlayPosition;
  enterAnimation?: AnimationName;
  exitAnimation?: AnimationName;
}

export type RuleActionConfig = PlayClipActionConfig;

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleConditions;
  action: RuleActionConfig;
}

/** Lo que recibe una acción al ejecutarse. */
export interface RuleActionContext {
  event: NormalizedEvent;
  queue: EnqueueSink;
  /** Resuelve el evento de origen (accept/reject) si la plataforma lo soporta. */
  resolveEvent(outcome: "accept" | "reject"): Promise<void>;
}

/**
 * Resultado de una acción. `fired: false` significa que la acción no disparó y
 * el motor debe tratarla como "skipped" con ese motivo (p. ej. un audio
 * superpuesto sin overlay conectado). Devolver `void` equivale a "disparó".
 */
export interface RuleActionOutcome {
  fired: boolean;
  reason?: string;
}

/**
 * Interfaz de acción del motor. `PlayClip` (de la cola) la satisface
 * estructuralmente; el motor no depende de esa acción concreta.
 */
export interface RuleAction {
  readonly kind: string;
  execute(context: RuleActionContext): void | RuleActionOutcome | Promise<void | RuleActionOutcome>;
}

/** Construye una acción a partir de su configuración. */
export type ActionResolver = (config: RuleActionConfig) => RuleAction;