/**
 * Cola de alertas (Fase 2).
 *
 * Independiente del servidor y de cualquier plataforma: solo entiende de ítems
 * de clip. Un clip a la vez; el resto espera ordenado por prioridad (mayor
 * primero, FIFO entre iguales). La cola no sabe cómo se reproduce un clip ni
 * quién lo pidió: eso lo resuelve el overlay vía WebSocket.
 */

import { randomUUID } from "node:crypto";

import { validateTrim } from "./trim.ts";

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
  /** Segundo donde arranca la reproducción (recorte no destructivo). */
  trimStart: number;
  /** Segundo donde termina (recorte no destructivo); null = hasta el final. */
  trimEnd: number | null;
  position: OverlayPosition;
  enterAnimation: AnimationName;
  exitAnimation: AnimationName;
  /** La alerta suena sin mostrar imagen (clip de solo audio). */
  audioOnly: boolean;
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
  trimStart?: number;
  trimEnd?: number | null;
  position?: OverlayPosition;
  enterAnimation?: AnimationName;
  exitAnimation?: AnimationName;
  /** Suena sin mostrar imagen (clip de solo audio). */
  audioOnly?: boolean;
  label?: string;
}

export type QueueStatus = "idle" | "playing" | "paused";

/**
 * Compuerta de inicio global (Modo Chill). La cola solo necesita saber cuánto
 * falta para poder arrancar otra alerta. Es un contrato estructural: `StartGate`
 * (en `src/server/start-gate.ts`) lo cumple sin que la cola dependa del servidor.
 * La espera cuenta desde el FIN de la alerta anterior; el fin y los inicios reales
 * (los que llegan a un overlay) los sella el servidor, no la cola.
 */
export interface StartGate {
  /** Milisegundos que faltan para poder arrancar otra alerta (0 = ya se puede). */
  remainingMs(): number;
}

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
  trimStart: 0,
  trimEnd: null,
  position: { x: 0.5, y: 0.5 },
  enterAnimation: "fade",
  exitAnimation: "fade",
  audioOnly: false,
};

/** Códigos de error de entrada de la cola. */
export type QueueInputErrorCode = "INVALID_CLIP_ID" | "INVALID_TRIM";

export class QueueInputError extends Error {
  readonly code: QueueInputErrorCode;
  constructor(code: QueueInputErrorCode, message: string) {
    super(message);
    this.name = "QueueInputError";
    this.code = code;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normaliza los parámetros opcionales de un ítem sobre los valores por defecto. */
function resolveParams(input: EnqueueInput): ClipPlaybackParams {
  const trim = validateTrim(input.trimStart, input.trimEnd);
  if (!trim.ok) throw new QueueInputError("INVALID_TRIM", trim.message);

  return {
    volume: clamp(input.volume ?? DEFAULT_PLAYBACK_PARAMS.volume, 0, 1),
    maxDurationSec: Math.max(1, input.maxDurationSec ?? DEFAULT_PLAYBACK_PARAMS.maxDurationSec),
    trimStart: trim.trimStart,
    trimEnd: trim.trimEnd,
    position: {
      x: clamp(input.position?.x ?? DEFAULT_PLAYBACK_PARAMS.position.x, 0, 1),
      y: clamp(input.position?.y ?? DEFAULT_PLAYBACK_PARAMS.position.y, 0, 1),
    },
    enterAnimation: input.enterAnimation ?? DEFAULT_PLAYBACK_PARAMS.enterAnimation,
    exitAnimation: input.exitAnimation ?? DEFAULT_PLAYBACK_PARAMS.exitAnimation,
    audioOnly: input.audioOnly === true,
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
  /**
   * ¿Hay un reproductor disponible (el overlay conectado)? Si no, los ítems
   * quedan en espera en vez de pasar a "reproduciendo": una alerta que nadie
   * reproduce nunca termina, y la cola no puede quedar atascada por eso.
   */
  private playerReady = true;
  private seq = 0;
  private readonly listeners = new Set<(state: QueueState) => void>();
  /** Compuerta de inicio global (Modo Chill); null = sin restricción global. */
  private gate: StartGate | null = null;
  private gateTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Define (o quita) la compuerta de inicio global. Al cambiarla se reevalúa la
   * promoción: si la compuerta se apaga, un pendiente puede arrancar enseguida;
   * si se enciende, se reprograma el arranque para respetar el intervalo.
   */
  setStartGate(gate: StartGate | null): void {
    this.gate = gate;
    this.clearGateTimer();
    this.stabilize();
    this.emit();
  }

  /** Agrega un clip. Si no hay nada reproduciéndose, no está pausada y hay un
   * reproductor listo, arranca ya; si no, queda en espera. */
  enqueue(input: EnqueueInput): QueueItem {
    if (typeof input.clipId !== "string" || input.clipId.trim() === "") {
      throw new QueueInputError("INVALID_CLIP_ID", "clipId es obligatorio y no puede estar vacío.");
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

    this.pending.push(item);
    // `stabilize` promueve el ítem si no hay nada reproduciéndose y la compuerta
    // global lo permite (equivalente al arranque directo de antes sin compuerta).
    this.stabilize();
    this.emit();
    return item;
  }

  /**
   * Descarta el clip actual y avanza al siguiente. Si la cola está pausada, el
   * siguiente queda en espera hasta reanudar (no se arranca nada en pausa).
   */
  skip(): QueueItem | null {
    if (!this.current) return null;
    this.current = null;
    // `stabilize` promueve el siguiente respetando la compuerta global (en pausa
    // no arranca nada).
    this.stabilize();
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
    this.current = null;
    this.stabilize();
    this.emit();
    return this.current;
  }

  /**
   * Avisa que el clip actual empezó a sonar de verdad (llegó a un overlay). Con el
   * Modo Chill, la compuerta puede necesitar reprogramar la promoción del próximo
   * (en «Superponer» el intervalo también cuenta desde este inicio).
   */
  notifyStarted(): void {
    this.stabilize();
    this.emit();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emit();
  }

  resume(): void {
    if (!this.paused && this.current) return;
    this.paused = false;
    this.stabilize();
    this.emit();
  }

  /**
   * Informa si hay un reproductor (overlay) disponible. Con `false`, los ítems
   * nuevos quedan en espera; con `true` se arranca el próximo pendiente, salvo
   * que la cola esté pausada.
   */
  setPlayerReady(ready: boolean): void {
    if (this.playerReady === ready) return;
    this.playerReady = ready;
    this.stabilize();
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
      // El estado refleja la pausa aunque no haya un ítem actual: así el
      // dashboard siempre ofrece "Reanudar" y la cola nunca se ve "idle" con
      // ítems en espera sin forma de destrabarla.
      status: this.paused ? "paused" : this.current ? "playing" : "idle",
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

  /**
   * Restaura la invariante: si hay pendientes, no está pausada, hay reproductor
   * y no hay ítem actual, arranca el siguiente **si la compuerta global lo
   * permite**. Si todavía falta el intervalo mínimo (Modo Chill), programa el
   * arranque para cuando se cumpla. Se llama tras cada mutación para que la cola
   * nunca quede con ítems en espera sin nada reproduciéndose.
   */
  private stabilize(): void {
    if (this.paused || !this.playerReady || this.current || this.pending.length === 0) {
      this.clearGateTimer();
      return;
    }
    const remaining = this.gate ? this.gate.remainingMs() : 0;
    if (remaining > 0) {
      this.scheduleGate(remaining);
      return;
    }
    this.clearGateTimer();
    this.current = this.takeNext();
    // La cola NO marca el inicio: el servidor lo sella cuando el mensaje `play`
    // llega a un overlay. Si lo marcara acá, una alerta sin overlay visible
    // contaría como «sonando» y dejaría la compuerta abierta para la siguiente.
  }

  /**
   * Cierre: limpia el temporizador de la compuerta y deja de promocionar. No
   * borra el estado (los ítems pendientes quedan visibles), solo garantiza que no
   * quede ningún timer vivo después de cerrar.
   */
  dispose(): void {
    this.clearGateTimer();
  }

  /** Programa el próximo intento de arranque para cuando se cumpla el intervalo. */
  private scheduleGate(ms: number): void {
    this.clearGateTimer();
    this.gateTimer = setTimeout(() => {
      this.gateTimer = null;
      this.stabilize();
      this.emit();
    }, ms);
    this.gateTimer.unref?.();
  }

  private clearGateTimer(): void {
    if (this.gateTimer !== null) clearTimeout(this.gateTimer);
    this.gateTimer = null;
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
