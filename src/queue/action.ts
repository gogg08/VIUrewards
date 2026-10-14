/**
 * Acciones (Fase 2).
 *
 * Una `Action` es lo que hace el motor de reglas cuando se cumple un trigger.
 * El motor depende solo de esta interfaz, nunca de una acción concreta: la
 * primera implementación es `PlayClip`, pero podrían sumarse otras (TTS,
 * mostrar texto, etc.) sin tocar el motor (ver AGENTS.md).
 */

import type { AnimationName, EnqueueInput, OverlayPosition, QueueItem } from "./queue.ts";

/** Lo mínimo que necesita una acción para encolar: no conoce la clase AlertQueue. */
export interface EnqueueSink {
  enqueue(input: EnqueueInput): QueueItem;
}

export interface ActionContext {
  readonly queue: EnqueueSink;
}

export interface Action {
  readonly kind: string;
  execute(context: ActionContext): QueueItem | null;
}

export interface PlayClipOptions {
  clipId: string;
  priority?: number;
  volume?: number;
  maxDurationSec?: number;
  trimStart?: number;
  trimEnd?: number | null;
  position?: OverlayPosition;
  enterAnimation?: AnimationName;
  exitAnimation?: AnimationName;
  /** Suena sin mostrar imagen (clip de solo audio). */
  audioOnly?: boolean;
  label?: string;
}

/** Acción que encola un clip en la cola de alertas. */
export class PlayClip implements Action {
  readonly kind = "play_clip";
  private readonly options: PlayClipOptions;

  constructor(options: PlayClipOptions) {
    this.options = options;
  }

  execute(context: ActionContext): QueueItem {
    return context.queue.enqueue({
      clipId: this.options.clipId,
      priority: this.options.priority,
      volume: this.options.volume,
      maxDurationSec: this.options.maxDurationSec,
      trimStart: this.options.trimStart,
      trimEnd: this.options.trimEnd,
      position: this.options.position,
      enterAnimation: this.options.enterAnimation,
      exitAnimation: this.options.exitAnimation,
      audioOnly: this.options.audioOnly,
      label: this.options.label,
    });
  }
}
