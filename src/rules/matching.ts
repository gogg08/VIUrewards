/**
 * Coincidencia de triggers y permisos (Fase 4A). Funciones puras.
 */

import {
  payloadAmount,
  payloadCommand,
  payloadRewardId,
  type EventUser,
  type NormalizedEvent,
} from "../events/index.ts";
import type { Permission, Rule, RuleTrigger } from "./types.ts";

/** Normaliza un nombre de comando: sin `!`, en minúsculas. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/^!/, "").toLowerCase();
}

/** ¿El trigger de la regla coincide con el evento? */
export function matchesTrigger(trigger: RuleTrigger, event: NormalizedEvent): boolean {
  if (trigger.type !== event.type) return false;

  if (trigger.command !== undefined) {
    const command = payloadCommand(event.payload);
    if (command === null) return false;
    if (normalizeCommand(command) !== normalizeCommand(trigger.command)) return false;
  }

  if (trigger.rewardId !== undefined) {
    const rewardId = payloadRewardId(event.payload);
    if (rewardId !== trigger.rewardId) return false;
  }

  if (trigger.minAmount !== undefined) {
    const amount = payloadAmount(event.payload);
    if (amount === null || amount < trigger.minAmount) return false;
  }

  return true;
}

/** ¿El usuario cumple el permiso pedido? */
export function hasPermission(permission: Permission, user: EventUser): boolean {
  const roles = user.roles;
  const isBroadcaster = roles.includes("broadcaster") || roles.includes("owner");
  const isMod = roles.includes("moderator") || roles.includes("mod");
  const isSub = roles.includes("subscriber") || roles.includes("sub") || roles.includes("founder");

  switch (permission) {
    case "everyone":
      return true;
    case "subs":
      return isSub || isMod || isBroadcaster;
    case "mods":
      return isMod || isBroadcaster;
  }
}

/** ¿La regla (trigger + permiso) aplica a este evento? El cooldown va aparte. */
export function ruleMatches(rule: Rule, event: NormalizedEvent): boolean {
  if (!matchesTrigger(rule.trigger, event)) return false;
  return hasPermission(rule.conditions.permission, event.user);
}