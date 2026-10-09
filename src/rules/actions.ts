/**
 * Acciones del motor de reglas (Fase 4A).
 *
 * `PlayClip` ya existe en la cola y satisface `RuleAction`. Acá se agrega
 * `SubmitUserUrl`, que manda la URL del texto del usuario a la cola de moderación
 * (nunca directo a descargar). El motor no conoce ninguna de las dos: recibe una
 * fábrica (`ActionResolver`).
 */

import { payloadArgs, payloadUserInput } from "../events/index.ts";
import { PlayClip } from "../queue/index.ts";
import type { ActionResolver, RuleAction, RuleActionConfig, RuleActionContext } from "./types.ts";

/**
 * Toma una URL del texto del usuario y la manda a moderación. La validación, la
 * deduplicación y los límites los aplica el servicio de moderación; acá nunca se
 * toca un proceso.
 */
export class SubmitUserUrl implements RuleAction {
  readonly kind = "submit_url";
  private readonly autoApprove: boolean;

  constructor(options: { autoApprove?: boolean } = {}) {
    this.autoApprove = options.autoApprove ?? false;
  }

  execute(context: RuleActionContext): void {
    // Para un canje el texto está en `userInput`; para un comando, en los args.
    const userInput = payloadUserInput(context.event.payload) || payloadArgs(context.event.payload).join(" ");
    context.moderation.submit({
      platform: context.event.platform,
      userId: context.event.user.id,
      userName: context.event.user.name,
      eventId: context.event.id,
      userInput,
      autoApprove: this.autoApprove,
      resolve: (outcome) => context.resolveEvent(outcome),
    });
  }
}

/** Construye la acción concreta a partir de su configuración. */
export function defaultActionResolver(config: RuleActionConfig): RuleAction {
  if (config.kind === "play_clip") {
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
  return new SubmitUserUrl({ autoApprove: config.autoApprove });
}