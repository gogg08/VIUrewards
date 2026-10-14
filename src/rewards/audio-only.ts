/**
 * Regla "solo audio" de una recompensa (rediseño, Etapa 2B del rework).
 *
 * "Solo audio" pasa a ser una opción de CADA recompensa (antes era una marca del
 * clip, que afectaba a todas las recompensas que lo usaban). La regla es pura y
 * la comparten el servidor (para persistir) y la UI (para mostrar el interruptor
 * bloqueado). Genérica: no menciona ninguna plataforma.
 *
 * - El modo overlap siempre es solo audio (no hay imagen que superponer).
 * - Un clip sin imagen (por ejemplo un audio de la Etapa 3B) también fuerza solo
 *   audio: no tiene sentido mostrar un cuadro vacío.
 */

import type { RewardRepetition } from "../db/rewards.ts";

export interface AudioOnlyInput {
  /** Modo de repetición elegido. */
  repetition: RewardRepetition;
  /** Lo que pidió el creador (solo cuenta si nada lo fuerza). */
  requested: boolean;
  /** ¿El clip elegido tiene imagen? `true` si no hay clip o si no se conoce. */
  clipHasVideo: boolean;
}

export interface AudioOnlyResult {
  /** Valor efectivo que se guarda. */
  value: boolean;
  /** Qué lo forzó, para explicarlo en la UI. `null` si no hay forzado. */
  forcedBy: "overlap" | "no-video" | null;
}

export function resolveAudioOnly(input: AudioOnlyInput): AudioOnlyResult {
  if (input.repetition === "overlap") return { value: true, forcedBy: "overlap" };
  if (!input.clipHasVideo) return { value: true, forcedBy: "no-video" };
  return { value: input.requested, forcedBy: null };
}
