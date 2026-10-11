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

export interface RuleConditions {
  /** Quién puede dispararla. */
  permission: Permission;
  /** Cooldown global de la regla, en segundos. */
  cooldownSec: number;
  /** Cooldown por usuario, en segundos. */
  userCooldownSec: number;
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
 * Interfaz de acción del motor. `PlayClip` (de la cola) la satisface
 * estructuralmente; el motor no depende de esa acción concreta.
 */
export interface RuleAction {
  readonly kind: string;
  execute(context: RuleActionContext): void | Promise<void>;
}

/** Construye una acción a partir de su configuración. */
export type ActionResolver = (config: RuleActionConfig) => RuleAction;