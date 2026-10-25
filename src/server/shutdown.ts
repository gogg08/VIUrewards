/**
 * Controlador del cierre ordenado (compartido por el arranque y los tests).
 *
 * Vive en `src/` y no en `scripts/start.ts` para que los tests lo importen sin
 * ejecutar el arranque real: `scripts/start.ts` tiene efectos (abre la base,
 * levanta el servidor) y NUNCA debe correr al importarse.
 *
 * Es puro respecto del proceso: todo lo que hace (salir, matar procesos,
 * loguear, temporizadores) se inyecta.
 */

/** Plazo por defecto del cierre ordenado, en ms. Después se fuerza la salida. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDeps {
  /** Cierre ordenado del servidor (idempotente). */
  stop: () => Promise<void>;
  /** Dueño de la base: se cierra al final del cierre ordenado. */
  closeDb?: () => void;
  /** Dueño del log: se cierra al final (después de escribir el resultado). */
  closeLog?: () => void;
  /** Mata los procesos externos vivos sin esperar (salida forzada). */
  killProcesses?: () => void;
  /** Registra el resultado. */
  log?: (message: string) => void;
  /** Salida del proceso (inyectable en tests). */
  exit?: (code: number) => void;
  /** Timers inyectables en tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  timeoutMs?: number;
  /** Procesos vivos, para reportar cuántos se terminan al forzar la salida. */
  runningProcesses?: () => number;
  /**
   * Aviso justo antes de cada `exit()`. Puede ser asíncrono: el controlador
   * ESPERA a que termine (el canal del launcher necesita que `finished` llegue
   * antes de salir). Un `await` después de `shutdown()` no serviría porque la
   * salida ocurre dentro de su propia promesa.
   */
  onBeforeExit?: (outcome: ShutdownOutcome) => void | Promise<void>;
}

export interface ShutdownController {
  /**
   * Pide el cierre. Devuelve la promesa del cierre ordenado, que se resuelve
   * con el resultado (`code: 0` bien; `code: 1` si se forzó) justo antes de
   * llamar a `exit`. Ese resultado es lo que el canal del launcher informa con
   * `finished` (Etapa 3A).
   */
  shutdown(signal: string): Promise<ShutdownOutcome>;
  /** ¿Hay un cierre en curso? */
  isClosing(): boolean;
}

export interface ShutdownOutcome {
  code: 0 | 1;
  /** Mensaje en español del resultado (el mismo que se registra). */
  message: string;
}

const CLOSED_MESSAGE = "VIUrewards se cerró correctamente.";

/**
 * Crea el controlador: una sola secuencia de cierre, plazo duro y salida
 * forzada deliberada (segunda señal o vencimiento del plazo).
 *
 * `shutdown()` nunca lanza: los fallos de `stop`, la base o el log se reportan y
 * el proceso igual sale, para no dejar nunca un cierre a medias colgado.
 */
export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  const exit =
    deps.exit ??
    ((code: number) => {
      process.exit(code);
    });
  const log = deps.log ?? ((message: string) => console.log(message));
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  let closing = false;
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<ShutdownOutcome> | null = null;

  /** Avisa antes de salir (el canal del launcher manda `finished`). */
  const notify = (outcome: ShutdownOutcome): Promise<void> | void => {
    try {
      return deps.onBeforeExit?.(outcome);
    } catch {
      // Un aviso que falla no puede impedir la salida.
      return undefined;
    }
  };

  /**
   * Salida ordenada: espera el aviso (el canal del launcher necesita que
   * `finished` salga antes de que el proceso termine) y recién ahí sale.
   */
  const exitWith = async (code: number, outcome: ShutdownOutcome): Promise<void> => {
    try {
      await notify(outcome);
    } catch {
      // Un aviso que falla no puede impedir la salida.
    }
    exit(code);
  };

  /** Salida forzada: no espera a que termine la misma operación bloqueada. */
  const forceExit = (reason: string, code: number): void => {
    if (forced) return;
    forced = true;
    if (timer) clearTimer(timer);
    timer = null;
    try {
      const running = deps.runningProcesses?.() ?? 0;
      deps.killProcesses?.();
      if (running > 0) log(`Cierre: ${running} proceso(s) externos terminados a la fuerza.`);
    } catch {
      // La salida forzada no puede fallar por la limpieza.
    }
    log(`Cierre forzado (${reason}).`);
    // Forzar es justamente NO esperar: el aviso se intenta y se sale ya.
    void notify({ code: 1, message: `Cierre forzado (${reason}).` });
    exit(code);
  };

  const shutdown = (signal: string): Promise<ShutdownOutcome> => {
    if (pending) {
      // Ya hay un cierre en curso: no se repite. Si la petición llegó por otro
      // camino (p. ej. el launcher pide cerrar y la consola recibe Ctrl+C, o al
      // revés), NO se fuerza la salida: el cierre sigue y termina bien. Solo una
      // señal REPETIDA (segunda interrupción de la consola) fuerza la salida.
      if (!isSignal(signal)) {
        log(`Cierre: ya está en curso (pedido repetido: ${signal}); se ignora.`);
        return pending;
      }
      log("Segunda interrupción: forzando la salida sin esperar el cierre ordenado.");
      forceExit("segunda señal", 1);
      return pending;
    }

    closing = true;
    log(`Cierre: recibida la orden ${signal}; cerrando VIUrewards…`);
    timer = setTimer(() => {
      forceExit(`sin terminar en ${Math.round(timeoutMs / 1000)} s`, 1);
    }, timeoutMs);

    pending = (async (): Promise<ShutdownOutcome> => {
      let message = CLOSED_MESSAGE;
      try {
        await deps.stop();
      } catch (error) {
        message = `Cierre: error al detener el servidor: ${describe(error)}`;
        log(message);
      }
      // Orden: primero lo que usa la base, después la base, y el log al final
      // (para que quede escrito el resultado del cierre).
      try {
        deps.closeDb?.();
      } catch (error) {
        message = `Cierre: error al cerrar la base: ${describe(error)}`;
        log(message);
      }
      log(CLOSED_MESSAGE);
      try {
        deps.closeLog?.();
      } catch {
        // Un fallo del log no debe impedir salir.
      }
      if (timer) clearTimer(timer);
      timer = null;
      if (forced) return { code: 1, message: "Cierre forzado: no terminó a tiempo." };
      await exitWith(0, { code: 0, message: CLOSED_MESSAGE });
      return { code: 0, message: CLOSED_MESSAGE };
    })();

    return pending;
  };

  return { shutdown, isClosing: () => closing };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Las señales del sistema operativo son las únicas que fuerzan al repetirse. */
function isSignal(source: string): boolean {
  return source === "SIGINT" || source === "SIGTERM" || source === "SIGBREAK";
}
