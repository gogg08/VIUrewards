/**
 * Validación de los datos de una recompensa (rediseño, Etapa 4A).
 *
 * Función pura, sin excepciones: devuelve un resultado tipado. El servidor la usa
 * sobre el cuerpo ya validado por el esquema de Fastify para normalizar y
 * comprobar rangos. Los campos ausentes quedan fuera del resultado (edición
 * parcial).
 */

export const MAX_REWARD_TITLE = 50;
export const MAX_REWARD_DESCRIPTION = 200;
export const MAX_REWARD_COST = 1_000_000;

/** Color en formato `#RRGGBB`. */
export const REWARD_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const ANIMATION_NAMES = ["none", "fade", "slide-up", "slide-down", "zoom"] as const;
export type AnimationName = (typeof ANIMATION_NAMES)[number];

import { isRewardRepetition, type RewardRepetition } from "../db/rewards.ts";

export interface NormalizedRewardInput {
  title?: string;
  cost?: number;
  description?: string;
  color?: string;
  enabled?: boolean;
  clipId?: string;
  volume?: number;
  maxDurationSec?: number | null;
  cooldownSec?: number;
  repetition?: RewardRepetition;
  position?: { x: number; y: number } | null;
  enterAnimation?: AnimationName | null;
  exitAnimation?: AnimationName | null;
}

export type RewardValidation =
  | { ok: true; value: NormalizedRewardInput }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): RewardValidation {
  return { ok: false, message };
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function validateAnimation(value: unknown): AnimationName | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return (ANIMATION_NAMES as readonly string[]).includes(value as string)
    ? (value as AnimationName)
    : undefined;
}

export function normalizeRewardInput(input: unknown): RewardValidation {
  if (!isPlainObject(input)) return fail("La recompensa enviada no es válida.");
  const out: NormalizedRewardInput = {};

  if (input.title !== undefined) {
    if (typeof input.title !== "string") return fail("El título no es válido.");
    const title = input.title.trim();
    if (title.length < 1 || title.length > MAX_REWARD_TITLE) {
      return fail(`El título debe tener entre 1 y ${MAX_REWARD_TITLE} caracteres.`);
    }
    out.title = title;
  }

  if (input.cost !== undefined) {
    if (!isIntegerInRange(input.cost, 1, MAX_REWARD_COST)) {
      return fail(`El costo debe ser un entero entre 1 y ${MAX_REWARD_COST}.`);
    }
    out.cost = input.cost;
  }

  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length > MAX_REWARD_DESCRIPTION) {
      return fail(`La descripción no puede superar los ${MAX_REWARD_DESCRIPTION} caracteres.`);
    }
    out.description = input.description.trim();
  }

  if (input.color !== undefined) {
    if (typeof input.color !== "string" || !REWARD_COLOR_RE.test(input.color)) {
      return fail("El color debe tener el formato #RRGGBB.");
    }
    out.color = input.color.toLowerCase();
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return fail("El estado de la recompensa no es válido.");
    out.enabled = input.enabled;
  }

  if (input.clipId !== undefined) {
    if (typeof input.clipId !== "string" || input.clipId.trim().length < 1) {
      return fail("Elegí un clip de la biblioteca.");
    }
    out.clipId = input.clipId.trim();
  }

  if (input.volume !== undefined) {
    if (typeof input.volume !== "number" || input.volume < 0 || input.volume > 1) {
      return fail("El volumen debe estar entre 0 y 1.");
    }
    out.volume = input.volume;
  }

  if (input.maxDurationSec !== undefined) {
    if (input.maxDurationSec === null) out.maxDurationSec = null;
    else if (typeof input.maxDurationSec !== "number" || input.maxDurationSec < 1) {
      return fail("La duración máxima debe ser mayor o igual a 1 segundo.");
    } else out.maxDurationSec = input.maxDurationSec;
  }

  for (const key of ["cooldownSec"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!isIntegerInRange(value, 0, 86_400)) {
      return fail("El cooldown debe ser un entero entre 0 y 86400 segundos.");
    }
    out[key] = value;
  }

  if (input.repetition !== undefined) {
    if (!isRewardRepetition(input.repetition)) {
      return fail("El modo de repetición no es válido.");
    }
    out.repetition = input.repetition;
  }

  if (input.position !== undefined) {
    if (input.position === null) out.position = null;
    else {
      const position = input.position;
      if (
        !isPlainObject(position) ||
        typeof position.x !== "number" ||
        typeof position.y !== "number" ||
        position.x < 0 ||
        position.x > 1 ||
        position.y < 0 ||
        position.y > 1
      ) {
        return fail("La posición debe estar entre 0 y 1 en ambos ejes.");
      }
      out.position = { x: position.x, y: position.y };
    }
  }

  for (const key of ["enterAnimation", "exitAnimation"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const animation = validateAnimation(value);
    if (animation === undefined) return fail("La animación no es válida.");
    out[key] = animation;
  }

  return { ok: true, value: out };
}