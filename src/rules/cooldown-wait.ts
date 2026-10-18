/**
 * Cola de espera por cooldown (opt-in "poner en cola").
 *
 * Cuando una recompensa en modo `queue` con cooldown > 0 se canjea **dentro** de
 * su cooldown, en vez de omitirse el canje entra a la espera de ESA recompensa.
 * Los canjes en espera se procesan en orden de llegada (FIFO) y cada uno dispara
 * cuando se cumple el cooldown desde el **último fin de reproducción**
 * (`last_fired_at`, que el servidor sella al terminar el clip, no al encolarlo).
 *
 * Hay **un solo planificador** por recompensa (no un temporizador por canje): al
 * vaciarse la espera se detiene y no quedan temporizadores colgados. El reloj se
 * inyecta para poder testear con tiempo falso y sin acumular desfase.
 *
 * Módulo puro: no conoce la base, ni el motor, ni la plataforma. La decisión de
 * disparar vive acá; los efectos (encolar, aceptar, omitir) los ejecuta el
 * servidor a través de los callbacks inyectados.
 */

export interface WaitEntry {
  /** Id del evento de canje (idempotencia: un mismo evento no espera dos veces). */
  eventId: string;
  /** Momento en que entró a la espera (ms). */
  enqueuedAtMs: number;
  /** Payload opaco que el servidor necesita para dispararlo (el evento normalizado). */
  payload: unknown;
}

/** Resultado de intentar encolar un canje en la espera. */
export type WaitAdmitResult =
  | { admitted: true; position: number }
  | { admitted: false; reason: "full" | "duplicate" };

export interface CooldownWaiterOptions {
  /** Reloj inyectable (ms). */
  now: () => number;
  /** Máximo de canjes en espera por recompensa. */
  maxWaiting: () => number;
  /** Espera máxima por canje, en ms. */
  maxWaitMs: () => number;
  /** Cooldown vigente de la recompensa, en ms (0 = sin cooldown). */
  cooldownMs: (rewardId: string) => number;
  /** `last_fired_at` persistido de la recompensa (ms), o null. */
  lastFiredAt: (rewardId: string) => number | null;
  /**
   * ¿La recompensa tiene una reproducción pendiente (encolada o sonando) sin
   * terminar? Mientras sea `true` no se puede disparar el siguiente canje en
   * espera: se arma cuando el servidor selle el fin y llame a `kick`.
   */
  isBusy?: (rewardId: string) => boolean;
  /** Encola el canje (al dispararse). Debe aceptar el canje en la plataforma. */
  dispatch: (rewardId: string, entry: WaitEntry) => void | Promise<void>;
  /** Se llama cuando un canje en espera se descarta por tope o por espera máxima. */
  onDrop: (rewardId: string, entry: WaitEntry, reason: "full" | "expired") => void | Promise<void>;
}

interface RewardWaitState {
  /** Canjes en espera, en orden de llegada. */
  entries: WaitEntry[];
  /** Temporizador único del planificador (o null si está detenido). */
  timer: ReturnType<typeof setTimeout> | null;
}

export class CooldownWaiter {
  private readonly options: CooldownWaiterOptions;
  private readonly states = new Map<string, RewardWaitState>();

  constructor(options: CooldownWaiterOptions) {
    this.options = options;
  }

  /**
   * Intenta admitir un canje en la espera de su recompensa. Rechaza si el evento
   * ya está en la espera (idempotencia) o si se superó el tope de cantidad.
   */
  admit(rewardId: string, entry: WaitEntry): WaitAdmitResult {
    const state = this.state(rewardId);
    if (state.entries.some((item) => item.eventId === entry.eventId)) {
      return { admitted: false, reason: "duplicate" };
    }
    if (state.entries.length >= this.options.maxWaiting()) {
      return { admitted: false, reason: "full" };
    }
    state.entries.push(entry);
    this.schedule(rewardId);
    return { admitted: true, position: state.entries.length };
  }

  /** Canjes en espera de una recompensa (para la UI y los tests). */
  waiting(rewardId: string): readonly WaitEntry[] {
    return this.states.get(rewardId)?.entries ?? [];
  }

  /** Ids de recompensas con al menos un canje en espera (para la UI). */
  rewardIds(): string[] {
    const out: string[] = [];
    for (const [rewardId, state] of this.states) {
      if (state.entries.length > 0) out.push(rewardId);
    }
    return out;
  }

  /** Cantidad total de canjes en espera (todas las recompensas). */
  totalWaiting(): number {
    let total = 0;
    for (const state of this.states.values()) total += state.entries.length;
    return total;
  }

  /** Segundos que faltan para el próximo disparo de una recompensa (0 si ya toca). */
  remainingSec(rewardId: string): number {
    const last = this.options.lastFiredAt(rewardId);
    const cooldown = this.options.cooldownMs(rewardId);
    if (cooldown <= 0 || last === null) return 0;
    const remainingMs = cooldown - (this.options.now() - last);
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  /**
   * Reprograma el planificador de una recompensa (p. ej. tras sellar el fin de
   * un clip o al acortar su cooldown). Si la espera está vacía no hace nada.
   */
  kick(rewardId: string): void {
    const state = this.states.get(rewardId);
    if (!state || state.entries.length === 0) return;
    this.stopTimer(state);
    this.schedule(rewardId);
  }

  /** Descarta toda la espera de una recompensa (desactivar, borrar, cambiar de modo…). */
  discard(rewardId: string): WaitEntry[] {
    const state = this.states.get(rewardId);
    if (!state) return [];
    this.stopTimer(state);
    this.states.delete(rewardId);
    return state.entries;
  }

  /** Descarta TODAS las esperas (vaciar la cola de reproducción, apagado). */
  discardAll(): Array<{ rewardId: string; entries: WaitEntry[] }> {
    const out: Array<{ rewardId: string; entries: WaitEntry[] }> = [];
    for (const rewardId of [...this.states.keys()]) {
      out.push({ rewardId, entries: this.discard(rewardId) });
    }
    return out;
  }

  /** Detiene todos los temporizadores (apagado limpio). */
  stop(): void {
    for (const state of this.states.values()) this.stopTimer(state);
  }

  private state(rewardId: string): RewardWaitState {
    let state = this.states.get(rewardId);
    if (!state) {
      state = { entries: [], timer: null };
      this.states.set(rewardId, state);
    }
    return state;
  }

  private stopTimer(state: RewardWaitState): void {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
  }

  /**
   * Reprograma el temporizador único de la recompensa. Se arma para disparar el
   * primer canje cuando se cumpla el cooldown; al vaciarse la espera no se vuelve
   * a armar (no quedan temporizadores colgados).
   */
  private schedule(rewardId: string): void {
    const state = this.states.get(rewardId);
    if (!state || state.timer !== null) return;
    if (state.entries.length === 0) return;

    // Si la recompensa está ocupada (su clip actual sigue encolado o sonando) no
    // se arma nada: el servidor llamará a `kick` cuando selle el fin y recién ahí
    // empieza a correr el cooldown. Armar un timer ahora dispararía el siguiente
    // pegado (el `last_fired_at` viejo ya está vencido).
    if (this.options.isBusy?.(rewardId)) return;

    const cooldown = this.options.cooldownMs(rewardId);
    const last = this.options.lastFiredAt(rewardId);
    const now = this.options.now();

    // Sin cooldown no habría espera (nunca se admite un canje en cooldown con
    // cooldown <= 0). Se dispara ya para no quedarse colgado.
    const delayMs = cooldown <= 0 || last === null ? 0 : Math.max(0, cooldown - (now - last));

    if (delayMs === 0) {
      // Disparo inmediato en el próximo tick, para no reentrar en `dispatch`.
      state.timer = setTimeout(() => this.fire(rewardId), 0);
    } else {
      state.timer = setTimeout(() => this.fire(rewardId), delayMs);
    }
    state.timer.unref?.();
  }

  /**
   * Dispara el primer canje de la espera si el cooldown ya se cumplió. Antes de
   * disparar descarta los que excedieron la espera máxima.
   */
  private fire(rewardId: string): void {
    const state = this.states.get(rewardId);
    if (!state) return;
    state.timer = null;

    const now = this.options.now();
    const maxWaitMs = this.options.maxWaitMs();

    // Descarta los que esperaron de más (por antigüedad, respetando el orden).
    while (state.entries.length > 0 && now - state.entries[0].enqueuedAtMs > maxWaitMs) {
      const expired = state.entries.shift();
      if (expired) void this.options.onDrop(rewardId, expired, "expired");
    }
    if (state.entries.length === 0) {
      this.states.delete(rewardId);
      return;
    }

    // ¿Ya se cumplió el cooldown? Si no (p. ej. se editó y se alargó), reprograma.
    // Si la recompensa sigue ocupada, tampoco se dispara: se espera al `kick`.
    const cooldown = this.options.cooldownMs(rewardId);
    const last = this.options.lastFiredAt(rewardId);
    if (this.options.isBusy?.(rewardId) || (cooldown > 0 && last !== null && now - last < cooldown)) {
      this.schedule(rewardId);
      return;
    }

    const entry = state.entries.shift();
    if (!entry) {
      this.states.delete(rewardId);
      return;
    }
    void this.options.dispatch(rewardId, entry);
    // El siguiente NO se programa acá: recién cuando el servidor selle el fin de
    // reproducción (nuevo `last_fired_at`) y llame a `kick` empieza a correr el
    // cooldown. Reprogramar en este punto dispararía el siguiente back-to-back.
    if (state.entries.length === 0) this.states.delete(rewardId);
  }
}
