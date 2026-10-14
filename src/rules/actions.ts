/**
 * Acciones del motor de reglas (Fase 4A).
 *
 * `PlayClip` ya existe en la cola y satisface `RuleAction`. El motor no la conoce:
 * recibe una fábrica (`ActionResolver`). El rediseño eliminó `SubmitUserUrl`: el
 * público ya no envía links.
 */

import { PlayClip } from "../queue/index.ts";
import type { ActionResolver, RuleAction, RuleActionConfig } from "./types.ts";

/** Construye la acción concreta a partir de su configuración. */
export function defaultActionResolver(config: RuleActionConfig): RuleAction {
  const clip = new PlayClip({
    clipId: config.clipId,
    priority: config.priority,
    volume: config.volume,
    maxDurationSec: config.maxDurationSec,
    trimStart: config.trimStart,
    trimEnd: config.trimEnd,
    position: config.position,
    enterAnimation: config.enterAnimation,
    exitAnimation: config.exitAnimation,
    audioOnly: config.audioOnly,
    label: config.label,
  });
  // `PlayClip` encola; el motor solo ve esta interfaz. Adaptamos el retorno
  // (QueueItem) a `void` para satisfacer `RuleAction`.
  // Un canje con alerta fija se acepta al encolar la alerta (ver docs/kick-setup.md).
  return {
    kind: "play_clip",
    execute: async (context) => {
      clip.execute({ queue: context.queue });
      await context.resolveEvent("accept");
    },
  };
}