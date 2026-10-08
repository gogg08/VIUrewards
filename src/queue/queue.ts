/**
 * Cola de alertas (Fase 2).
 *
 * Independiente del servidor y de cualquier plataforma: solo entiende de ítems
 * de clip. Un clip a la vez; el resto espera ordenado por prioridad (mayor
 * primero, FIFO entre iguales). La cola no sabe cómo se reproduce un clip ni
 * quién lo pidió: eso lo resuelve el overlay vía WebSocket.
 */

import { randomUUID } from "node:crypto";

export type AnimationName = "none" | "fade" | "slide-up" | "slide-down" | "zoom";

export interface OverlayPosition {
  /** Fracción del ancho del viewport (0 = izquierda, 1 = derecha). */
  x: number;
  /** Fracción del alto del viewport (0 = arriba, 1 = abajo). */
  y: number;
}

export interface ClipPlaybackParams {
  /** Volumen de 0 a 1. */
  volume: number;
  /** Duración máxima en segundos; se corta el video aunque no haya terminado. */
  maxDurationSec: number;
  position: OverlayPosition;
  enterAnimation: AnimationName;
  exitAnimation: AnimationName;
}

export interface QueueItem {
  /** Id único del ítem en la cola (distinto del id del clip). */
  id: string;
  /** Id del clip descargado en /media (archivo `<clipId>.mp4`). */
  clipId: string;
  /** Prioridad: mayor primero. */
  priority: number;
  params: ClipPlaybackParams;
  enqueuedAt: number;
  /** Orden de inserción, para desempatar FIFO. */
  seq: number;
  /** Texto opcional para mostrar (p. ej. quién lo pidió). */
  label?: string;
}

export interface EnqueueInput {
  clipId: string;
  priority?: number;
  volume?: number;
  maxDurationSec?: number;
  position?: OverlayPosition;
  enterAnimation?: AnimationName;
  exitAnimation?: AnimationName;
  label?: string;
}

export type QueueStatus = "idle" | "playing" | "paused";

export interface QueueState {
  status: QueueStatus;
  current: QueueItem | null;
  /** Ítems en espera, ya ordenados (el próximo a reproducir primero). */
  pending: QueueItem[];
  size: number;
}

export const DEFAULT_PLAYBACK_PARAMS: ClipPlaybackParams = {
  volume: 1,
  maxDurationSec: 30,
  position: { x: 0.5, y: 0.5 },
  enterAnimation: "fade",
  exitAnimation: "fade",
};

export class QueueInputError extends Error {
  readonly code: "INVALID_CLIP_ID";
  constructor(message: string) {
    super(message);
    this.name = "QueueInputError";
    this.code = "INVALID_CLIP_ID";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normaliza los parámetros opcionales de un ítem sobre los valores por defecto. */
function resolveParams(input: EnqueueInput): ClipPlaybackParams {
  return {
    volume: clamp(input.volume ?? DEFAULT_PLAYBACK_PARAMS.volume, 0, 1),
    maxDurationSec: Math.max(1, input.maxDurationSec ?? DEFAULT_PLAYBACK_PARAMS.maxDurationSec),
    position: {
      x: clamp(input.position?.x ?? DEFAULT_PLAYBACK_PARAMS.position.x, 0, 1),
      y: clamp(input.position?.y ?? DEFAULT_PLAYBACK_PARAMS.position.y, 0, 1),
    },
    enterAnimation: input.enterAnimation ?? DEFAULT_PLAYBACK_PARAMS.enterAnimation,
    exitAnimation: input.exitAnimation ?? DEFAULT_PLAYBACK_PARAMS.exitAnimation,
  };
}

/** Ordena por prioridad descendente y, a igual prioridad, por orden de llegada. */
function orderItems(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
}

export class AlertQueue {
  private pending: QueueItem[] = [];
  private current: QueueItem | null = null;
  private paused = false;
  private seq = 0;
  private readonly listeners = new Set<(state: QueueState) => void>();

  /** Agrega un clip. Si no hay nada reproduciéndose y no está pausada, arranca ya. */
  enqueue(input: EnqueueInput): QueueItem {
    if (typeof input.clipId !== "string" || input.clipId.trim() === "") {
      throw new QueueInputError("clipId es obligatorio y no puede estar vacío.");
    }

    const item: QueueItem = {
      id: randomUUID(),
      clipId: input.clipId,
      priority: input.priority ?? 0,
      params: resolveParams(input),
      enqueuedAt: Date.now(),
      seq: this.seq++,
      label: input.label,
    };

    if (this.paused || this.current) {
      this.pending.push(item);
    } else {
      this.current = item;
    }
    this.emit();
    return item;
  }

  /** Descarta el clip actual y avanza al siguiente. Devuelve el nuevo actual. */
  skip(): QueueItem | null {
    if (!this.current) return null;
    this.current = this.takeNext();
    this.emit();
    return this.current;
  }

  /**
   * Marca el clip actual como terminado y avanza. Si se pasa `itemId` y no
   * coincide con el actual (mensaje tardío), no hace nada.
   */
  complete(itemId?: string): QueueItem | null {
    if (!this.current) return null;
    if (itemId !== undefined && itemId !== this.current.id) return this.current;
    this.current = this.takeNext();
    this.emit();
    return this.current;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emit();
  }

  resume(): void {
    if (!this.paused && this.current) return;
    this.paused = false;
    if (!this.current) this.current = this.takeNext();
    this.emit();
  }

  /** Vacía los ítems en espera. El clip actual (si hay) sigue reproduciéndose. */
  clear(): number {
    const removed = this.pending.length;
    this.pending = [];
    if (removed > 0) this.emit();
    return removed;
  }

  getState(): QueueState {
    const pending = orderItems(this.pending);
    return {
      status: this.current ? (this.paused ? "paused" : "playing") : "idle",
      current: this.current,
      pending,
      size: pending.length,
    };
  }

  /** Notifica en cada cambio de estado. Devuelve una función para desuscribirse. */
  onChange(listener: (state: QueueState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private takeNext(): QueueItem | null {
    if (this.pending.length === 0) return null;
    const ordered = orderItems(this.pending);
    const [next, ...rest] = ordered;
    this.pending = rest;
    return next;
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
