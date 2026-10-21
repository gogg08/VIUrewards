/**
 * Compuerta de inicio global (Modo Chill).
 *
 * Representa la **espera mínima entre el FIN de una alerta y el INICIO de la
 * siguiente**. Es un único objeto compartido por la cola y el despachador, así
 * que hay una sola espera global: no se duplican cooldowns.
 *
 * - `markEnd(at)`: una alerta terminó (o se cortó). **Desde acá** empieza a contar
 *   la espera. Lo sella el servidor al recibir `ended`, al saltar o vaciar la cola
 *   y al terminar un audio superpuesto (`audioEnded`).
 * - `markStart(at)`: una alerta empezó a sonar (la usa el modo «Superponer»).
 * - `remainingMs()`: cuánto falta desde el fin más reciente para poder arrancar
 *   otra alerta.
 *
 * En «Esperar turno» la espera va del FIN de una alerta al INICIO de la siguiente.
 * En «Superponer» varias alertas pueden sonar a la vez, así que además se respeta
 * el intervalo entre INICIOS: si ya hay algo sonando que empezó después del último
 * fin, la espera corre desde ese inicio.
 *
 * No programa temporizadores: solo responde cuánto falta y registra los instantes.
 * Quien consume la compuerta decide cómo esperar (la cola reprograma su promoción;
 * el despachador superpuesto programa el envío).
 *
 * Con el Modo Chill apagado (`active() === false`) o con intervalo 0, `remainingMs`
 * siempre es 0: la compuerta no agrega ninguna espera.
 */

export interface StartGateOptions {
  /** Reloj inyectable (tests). Por defecto `Date.now`. */
  now?: () => number;
  /** ¿El Modo Chill está activo ahora? Por defecto, siempre inactivo. */
  active?: () => boolean;
  /** Espera mínima tras el fin de una alerta, en ms (0 = sin espera). Por defecto 0. */
  intervalMs?: () => number;
}

/** Lo mínimo que la cola y el despachador necesitan de la compuerta. */
export interface StartGateLike {
  /** Milisegundos que faltan para poder arrancar otra alerta (0 = ya se puede). */
  remainingMs(): number;
  /** Registra el inicio de una reproducción en el instante `at` (o ahora). */
  markStart(at?: number): void;
  /** Registra el fin de una reproducción: desde acá cuenta la espera. */
  markEnd(at?: number): void;
}

export class StartGate implements StartGateLike {
  private readonly now: () => number;
  private readonly isActive: () => boolean;
  private readonly interval: () => number;
  /** Instante del último FIN registrado; null = todavía no terminó ninguna alerta. */
  private lastEndAt: number | null = null;
  /** Instante del último INICIO registrado (lo sella el modo «Superponer»). */
  private lastStartAt: number | null = null;

  constructor(options: StartGateOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.isActive = options.active ?? (() => false);
    this.interval = options.intervalMs ?? (() => 0);
  }

  remainingMs(): number {
    if (!this.isActive()) return 0;
    const interval = Math.max(0, this.interval());
    if (interval === 0 || this.lastEndAt === null) return 0;
    const now = this.now();
    const sinceEnd = Math.max(0, now - this.lastEndAt);
    // Si hay algo sonando que empezó DESPUÉS del último fin (p. ej. en «Superponer»),
    // la espera corre desde ese inicio: la alerta anterior no terminó, así que el
    // fin que cuenta es el suyo cuando acabe.
    const sinceStart = this.lastStartAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - this.lastStartAt);
    const elapsed = Math.min(sinceEnd, sinceStart);
    return Math.max(0, interval - elapsed);
  }

  /** Una alerta empezó a sonar. Marca la ventana del intervalo entre inicios. */
  markStart(at?: number): void {
    this.lastStartAt = at ?? this.now();
  }

  markEnd(at?: number): void {
    this.lastEndAt = at ?? this.now();
  }
}
