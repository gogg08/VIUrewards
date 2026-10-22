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
}

export interface ShutdownController {
  /** Pide el cierre. Devuelve la promesa del cierre ordenado. */
  shutdown(signal: string): Promise<void>;
  /** ¿Hay un cierre en curso? */
  isClosing(): boolean;
}

/**
 * Crea el controlador: una sola secuencia de cierre, plazo duro y salida
 * forzada deliberada (segunda señal o vencimiento del plazo).
 *
 * `shutdown()` nunca lanza: los fallos de `stop`, la base o el log se reportan y
 * el proceso igual sale, para no dejar nunca un cierre a medias colgado.
 */
export function createShutdownController(deps: ShutdownDeps): ShutdownController {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.log(message));
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  let closing = false;
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> | null = null;

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
    exit(code);
  };

  const shutdown = (signal: string): Promise<void> => {
    if (pending) {
      // Segunda señal: el cierre ya está en curso, así que no se repite ni se
      // espera. Se fuerza la salida para no dejar el proceso colgado.
      log("Segunda interrupción: forzando la salida sin esperar el cierre ordenado.");
      forceExit("segunda señal", 1);
      return pending;
    }

    closing = true;
    log(`Cierre: recibida la señal ${signal}; cerrando VIUrewards…`);
    timer = setTimer(() => {
      forceExit(`sin terminar en ${Math.round(timeoutMs / 1000)} s`, 1);
    }, timeoutMs);

    pending = (async () => {
      try {
        await deps.stop();
      } catch (error) {
        log(`Cierre: error al detener el servidor: ${describe(error)}`);
      }
      // Orden: primero lo que usa la base, después la base, y el log al final
      // (para que quede escrito el resultado del cierre).
      try {
        deps.closeDb?.();
      } catch (error) {
        log(`Cierre: error al cerrar la base: ${describe(error)}`);
      }
      log("VIUrewards se cerró correctamente.");
      try {
        deps.closeLog?.();
      } catch {
        // Un fallo del log no debe impedir salir.
      }
      if (timer) clearTimer(timer);
      timer = null;
      if (forced) return;
      exit(0);
    })();

    return pending;
  };

  return { shutdown, isClosing: () => closing };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
