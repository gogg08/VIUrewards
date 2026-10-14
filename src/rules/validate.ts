/**
 * Validación de una regla que llega desde el dashboard (Fase 4A).
 *
 * Función pura, sin excepciones: devuelve un resultado tipado. El servidor la usa
 * además del esquema de Fastify para normalizar y comprobar rangos.
 */

import { isEventType, type EventType } from "../events/index.ts";
import type {
  Permission,
  PlayClipActionConfig,
  Rule,
  RuleActionConfig,
  RuleConditions,
  RuleTrigger,
} from "./types.ts";

export const PERMISSIONS: readonly Permission[] = ["everyone", "subs", "mods"];
export const RULE_ACTIONS = ["play_clip"] as const;

export const MAX_RULE_NAME_LENGTH = 100;
export const MAX_COOLDOWN_SEC = 86_400;
export const MAX_MIN_AMOUNT = 1_000_000;

export type RuleValidation =
  | { ok: true; value: Omit<Rule, "id"> }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): RuleValidation {
  return { ok: false, message };
}

function optionalString(value: unknown, field: string, max: number): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function validateTrigger(raw: unknown): RuleTrigger | string {
  if (!isPlainObject(raw)) return "El trigger es obligatorio.";
  if (!isEventType(raw.type)) return "El tipo de evento del trigger no es válido.";

  const trigger: RuleTrigger = { type: raw.type as EventType };

  const command = optionalString(raw.command, "command", 100);
  if (command === null) return "El comando del trigger no es válido.";
  if (command !== undefined) trigger.command = command;

  const rewardId = optionalString(raw.rewardId, "rewardId", 200);
  if (rewardId === null) return "El id de recompensa del trigger no es válido.";
  if (rewardId !== undefined) trigger.rewardId = rewardId;

  if (raw.minAmount !== undefined && raw.minAmount !== null) {
    if (typeof raw.minAmount !== "number" || !Number.isFinite(raw.minAmount) || raw.minAmount < 0) {
      return "El monto mínimo debe ser un número mayor o igual a 0.";
    }
    if (raw.minAmount > MAX_MIN_AMOUNT) return "El monto mínimo es demasiado grande.";
    trigger.minAmount = raw.minAmount;
  }

  if (trigger.type === "chat_command" && trigger.command === undefined) {
    return "Una regla de comando de chat necesita el nombre del comando.";
  }
  if (trigger.type === "reward_redeemed" && trigger.rewardId === undefined) {
    return "Una regla de canje necesita el id de la recompensa.";
  }

  return trigger;
}

function validateConditions(raw: unknown): RuleConditions | string {
  const conditions: RuleConditions = { permission: "everyone" };
  if (raw === undefined || raw === null) return conditions;
  if (!isPlainObject(raw)) return "Las condiciones no son válidas.";

  if (raw.permission !== undefined) {
    if (!PERMISSIONS.includes(raw.permission as Permission)) return "El permiso no es válido.";
    conditions.permission = raw.permission as Permission;
  }

  return conditions;
}

function validateAction(raw: unknown): RuleActionConfig | string {
  if (!isPlainObject(raw)) return "La acción es obligatoria.";
  if (raw.kind === "play_clip") {
    const clipId = optionalString(raw.clipId, "clipId", 128);
    if (clipId === null || clipId === undefined) return "Hay que elegir un clip para la acción.";
    const action: PlayClipActionConfig = { kind: "play_clip", clipId };
    if (raw.priority !== undefined) {
      if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) return "La prioridad no es válida.";
      action.priority = raw.priority;
    }
    if (raw.volume !== undefined) {
      if (typeof raw.volume !== "number" || raw.volume < 0 || raw.volume > 1) {
        return "El volumen debe estar entre 0 y 1.";
      }
      action.volume = raw.volume;
    }
    if (raw.maxDurationSec !== undefined) {
      if (typeof raw.maxDurationSec !== "number" || raw.maxDurationSec < 1) {
        return "La duración máxima debe ser mayor o igual a 1 segundo.";
      }
      action.maxDurationSec = raw.maxDurationSec;
    }
    if (raw.audioOnly !== undefined) {
      if (typeof raw.audioOnly !== "boolean") return "La opción de solo audio no es válida.";
      action.audioOnly = raw.audioOnly;
    }
    if (raw.label !== undefined) {
      const label = optionalString(raw.label, "label", 200);
      if (label === null) return "El texto de contexto no es válido.";
      if (label !== undefined) action.label = label;
    }
    return action;
  }

  return "El tipo de acción no es válido.";
}

export function validateRuleInput(input: unknown): RuleValidation {
  if (!isPlainObject(input)) return fail("La regla no es válida.");

  const name = optionalString(input.name, "name", MAX_RULE_NAME_LENGTH);
  if (name === null || name === undefined) return fail("La regla necesita un nombre.");

  const trigger = validateTrigger(input.trigger);
  if (typeof trigger === "string") return fail(trigger);

  const conditions = validateConditions(input.conditions);
  if (typeof conditions === "string") return fail(conditions);

  const action = validateAction(input.action);
  if (typeof action === "string") return fail(action);

  const enabled = input.enabled === undefined ? true : input.enabled === true;

  return { ok: true, value: { name, enabled, trigger, conditions, action } };
}