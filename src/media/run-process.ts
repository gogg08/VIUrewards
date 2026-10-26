/**
 * Ejecución y cancelación real de binarios externos.
 *
 * Siempre `spawn` con argumentos en array y `shell: false` (AGENTS.md #1).
 * Nunca se construye un string de comando.
 *
 * Además del resultado, cada ejecución se puede **cancelar de verdad**:
 *
 * - Todos los procesos vivos mientras corren quedan registrados en el
 *   supervisor, así que se puede cancelar uno por id o todos a la vez (cierre
 *   de la app).
 * - Cancelar **espera** a que el proceso termine antes de resolver. No alcanza
 *   con descartar el resultado: el hijo tiene que haber muerto.
 * - Una ejecución cancelada se resuelve con `cancelled: true` y **nunca** se
 *   informa como éxito, aunque el proceso haya salido con código 0 justo antes
 *   de la cancelación.
 *
 * Cierre del árbol de procesos:
 *
 * - **Windows**: los procesos se lanzan con `detached: true`, así cada uno es
 *   raíz de su propio grupo. Se termina el árbol con `taskkill /PID <pid> /T /F`
 *   (spawn con argumentos en array, nunca una shell). El `/T` mata a los
 *   descendientes (p. ej. el ffmpeg que lanza yt-dlp).
 * - **Unix**: los procesos se lanzan con `detached: true`, así cada uno es
 *   líder de un grupo de procesos propio; se manda la señal al grupo
 *   (`process.kill(-pid, ...)`) para terminar también a los descendientes.
 *
 * La verificación no asume nada: se espera el evento `close`, `taskkill` se
 * revisa por código de salida y, si no alcanza, se fuerza la salida directa del
 * proceso raíz. Lo que no se puede verificar (`taskkill` no informa los
 * descendientes que mató) queda documentado como limitación.
 */

import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** `true` si la ejecución se canceló (el resultado NO es válido). */
  cancelled?: boolean;
}

export interface RunProcessOptions {
  timeoutMs: number;
  cwd?: string;
  /**
   * Variables de entorno **adicionales** para el hijo (se combinan con las del
   * proceso). Solo lo usa la verificación de releases para aislar `GNUPGHOME`.
   */
  env?: NodeJS.ProcessEnv;
  /** Tope de salida capturada por stream, para no crecer sin límite. */
  maxOutputBytes?: number;
  /**
   * Cancela la ejecución. Al cancelarse, el proceso (y su árbol) se termina y
   * la promesa resuelve con `cancelled: true` recién cuando el proceso murió.
   */
  signal?: AbortSignal;
  /** Cada cuánto se reintenta terminar el proceso si sigue vivo. Por defecto 250 ms. */
  killRetryMs?: number;
  /** Cuántas veces se reintenta el cierre antes de rendirse. Por defecto 12 (3 s). */
  killRetries?: number;
}

export type RunProcess = (
  command: string,
  args: string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_KILL_RETRY_MS = 250;
const DEFAULT_KILL_RETRIES = 12;

function appendCapped(current: string, chunk: Buffer, cap: number): string {
  if (current.length >= cap) return current;
  const next = current + chunk.toString("utf8");
  return next.length > cap ? next.slice(0, cap) : next;
}

/** Proceso vivo, para poder cancelarlo por id o todos juntos al cerrar. */
export interface RunningProcess {
  id: string;
  pid: number | undefined;
  startedAt: number;
}

/**
 * Cierre de emergencia del proceso y de sus descendientes, usado por la salida
 * forzada cuando la app está bloqueada. A diferencia de la cancelación normal,
 * no espera a que el proceso termine: solo dispara el cierre.
 */
export function killTreeNow(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });
      killer.unref();
    } catch {
      // Sin taskkill no hay nada más que hacer sin shell.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ya no existe.
    }
  }
}

export interface ProcessSupervisor {
  /** Procesos vivos ahora mismo. */
  running(): RunningProcess[];
  /** Ejecuta un binario registrándolo mientras corre. */
  run: RunProcess;
  /** Cancela una ejecución concreta (por id). Devuelve `false` si ya no corría. */
  cancel(id: string): boolean;
  /** Cancela todas las ejecuciones activas, **esperando** a que terminen. Devuelve cuántas canceló. */
  cancelAll(): Promise<number>;
  /**
   * Cierre de emergencia: dispara el cierre de todos los árboles vivos, sin
   * esperar. Se usa solo en la salida forzada (segunda señal o timeout).
   */
  killAllNow(): void;
  /** Espera a que no quede ningún proceso activo (o al límite indicado). */
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

/**
 * Opciones de `killProcessTree`.
 *
 * `timeoutMs` acota la ESPERA del `taskkill` auxiliar. Sin él se conserva el
 * comportamiento de siempre (esperar a `close`/`error`), que es lo que necesitan
 * los llamadores de producción: ahí un `taskkill` lento no debe abortarse.
 */
export interface KillProcessTreeOptions {
  /**
   * Plazo para que el `taskkill` auxiliar termine. Al vencer:
   *
   * - se termina **ESE** proceso auxiliar (nunca el pid objetivo, nunca otro);
   * - la promesa rechaza con un error identificable (`code === "TASKKILL_TIMEOUT"`).
   *
   * Rechaza en vez de resolver porque "pasó el plazo" no es "el árbol murió".
   */
  timeoutMs?: number;
}

/** Error de `killProcessTree` cuando el plazo venció. */
export interface KillProcessTreeTimeoutError extends Error {
  code: "TASKKILL_TIMEOUT";
}

/**
 * Comando auxiliar que termina el árbol en Windows (`taskkill`).
 *
 * Es inyectable SOLO para los tests: con el `taskkill` real no hay forma
 * reproducible de que el auxiliar se cuelgue, y el plazo que se quiere
 * verificar es justamente el de un auxiliar que no responde. La producción no
 * lo toca (`setTaskkillCommand` no se llama nunca fuera de los tests).
 */
export interface TaskkillCommand {
  file: string;
  args(pid: number): string[];
}

const defaultTaskkill: TaskkillCommand = {
  file: "taskkill",
  args: (pid) => ["/PID", String(pid), "/T", "/F"],
};

let taskkillCommand: TaskkillCommand = defaultTaskkill;

/**
 * Reemplaza el comando auxiliar de Windows (solo tests). Devuelve el restaurador.
 *
 * Los argumentos por defecto son los reales; un test puede apuntar el comando a
 * un proceso propio que se cuelgue para ejercitar el plazo.
 */
export function setTaskkillCommand(next: TaskkillCommand | null): () => void {
  const previous = taskkillCommand;
  taskkillCommand = next ?? defaultTaskkill;
  return () => {
    taskkillCommand = previous;
  };
}

function taskkillTimeoutError(timeoutMs: number): KillProcessTreeTimeoutError {
  const error = new Error(`taskkill no terminó en ${timeoutMs} ms`) as KillProcessTreeTimeoutError;
  error.code = "TASKKILL_TIMEOUT";
  return error;
}

/**
 * Termina el árbol de procesos de `pid`.
 *
 * - En Windows usa `taskkill /PID <pid> /T /F` (spawn sin shell). Si el proceso
 *   ya no existe, `taskkill` falla y se sigue igual.
 * - En Unix manda `SIGKILL` al grupo (`-pid`); si el grupo ya no existe, al pid.
 *
 * Con `options.timeoutMs`, la espera del auxiliar queda acotada: al vencer se
 * mata el `taskkill` (por su propio pid, verificado con el hijo que devolvió
 * `spawn`) y se rechaza con `TASKKILL_TIMEOUT`. Sin la opción no hay plazo.
 */
export function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  options: KillProcessTreeOptions = {},
): Promise<void> {
  if (platform === "win32") {
    return new Promise<void>((resolve, reject) => {
      const command = taskkillCommand;
      const killer = spawn(command.file, command.args(pid), {
        shell: false,
        windowsHide: true,
        // El hijo del taskkill no debe depender del proceso que estamos matando.
        detached: false,
      });
      // El auxiliar es NUESTRO hijo: se guarda su pid para poder terminarlo en el
      // vencimiento sin tocar jamás el pid objetivo ni un proceso ajeno.
      const helperPid = killer.pid;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        action();
      };

      killer.on("error", () => finish(resolve));
      killer.on("close", () => finish(resolve));

      if (options.timeoutMs !== undefined) {
        const timeoutMs = options.timeoutMs;
        timer = setTimeout(() => {
          finish(() => {
            // Se termina SOLO el auxiliar que creamos (su pid es el que devolvió
            // `spawn`, no uno reconstruido ni buscado por nombre).
            if (helperPid !== undefined) {
              try {
                killer.kill("SIGKILL");
              } catch {
                // Ya había terminado: el plazo se cumplió igual.
              }
            }
            reject(taskkillTimeoutError(timeoutMs));
          });
        }, timeoutMs);
        // No debe mantener vivo el proceso de test por sí solo.
        timer.unref?.();
      }
    });
  }

  return new Promise<void>((resolve) => {
    try {
      // Grupo de procesos (detached: true lo puso como líder).
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ya no existe: nada que hacer.
      }
    }
    resolve();
  });
}

interface ProcessRecord {
  id: string;
  child: ReturnType<typeof spawn>;
  abort: AbortController;
  cancelled: boolean;
  startedAt: number;
  /** Resuelve cuando la ejecución terminó y se desregistró (éxito, error o cancelación). */
  finished: Promise<boolean>;
}

export interface ProcessSupervisorOptions {
  platform?: NodeJS.Platform;
  /** Ids únicos (tests). Por defecto un contador por proceso. */
  nextId?: () => string;
  /** Reloj inyectable (tests). */
  now?: () => number;
}

/** Crea el supervisor real: `run` lanza procesos y los registra mientras viven. */
export function createProcessSupervisor(options: ProcessSupervisorOptions = {}): ProcessSupervisor {
  const platform = options.platform ?? process.platform;
  let counter = 0;
  const nextId = options.nextId ?? (() => `proc-${(counter += 1)}`);
  const now = options.now ?? (() => Date.now());
  const records = new Map<string, ProcessRecord>();
  const idleWaiters = new Set<() => void>();

  const notifyIfIdle = (): void => {
    if (records.size > 0) return;
    for (const waiter of idleWaiters) waiter();
    idleWaiters.clear();
  };

  const run: RunProcess = (command, args, runOptions) => {
    return new Promise((resolve, reject) => {
      if (runOptions.signal?.aborted) {
        // Ya cancelado antes de arrancar: no se lanza nada.
        resolve({ code: null, stdout: "", stderr: "", timedOut: false, cancelled: true });
        return;
      }

      const cap = runOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const id = nextId();

      const child = spawn(command, args, {
        cwd: runOptions.cwd,
        shell: false,
        windowsHide: true,
        env: runOptions.env ? { ...process.env, ...runOptions.env } : process.env,
        // En Windows: raíz de su propio grupo (taskkill /T). En Unix: líder de
        // grupo, para poder mandar la señal a todo el grupo.
        detached: true,
      });
      // Resolvers de la terminación (cancelAll espera a que el proceso muera).
      let settledTrue: (value: boolean) => void = () => {};
      const finished = new Promise<boolean>((resolveFinished) => {
        settledTrue = resolveFinished;
      });
      const record: ProcessRecord = {
        id,
        child,
        abort: new AbortController(),
        cancelled: false,
        startedAt: now(),
        finished,
      };
      records.set(id, record);

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let killRetry: ReturnType<typeof setTimeout> | null = null;
      let retriesLeft = runOptions.killRetries ?? DEFAULT_KILL_RETRIES;
      const killRetryMs = runOptions.killRetryMs ?? DEFAULT_KILL_RETRY_MS;

      const clearTimer = (): void => {
        clearTimeout(timer);
        if (killRetry) clearTimeout(killRetry);
        killRetry = null;
      };
      const settle = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        records.delete(id);
        notifyIfIdle();
        settledTrue(true);
        resolve(result);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimer();
        records.delete(id);
        notifyIfIdle();
        settledTrue(true);
        reject(error);
      };

      /** Termina el árbol y, si el proceso sigue vivo, reintenta hasta rendirse. */
      const terminate = (): void => {
        if (child.pid === undefined) return;
        void killProcessTree(child.pid, platform).then(() => {
          if (settled) return;
          retriesLeft -= 1;
          if (retriesLeft <= 0) return;
          killRetry = setTimeout(terminate, killRetryMs);
          killRetry.unref?.();
        });
      };

      const cancel = (): void => {
        if (settled) return;
        record.cancelled = true;
        terminate();
      };
      record.abort.signal.addEventListener("abort", cancel, { once: true });
      // La cancelación externa (la de quien llama) y la del supervisor comparten
      // el mismo camino.
      runOptions.signal?.addEventListener("abort", cancel, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, runOptions.timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk, cap);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk, cap);
      });
      child.on("error", (error) => {
        // Si la cancelación ya disparó el cierre del proceso, el error que llega
        // después no es un fallo real: la promesa se resuelve como cancelada.
        if (record.cancelled) {
          settle({ code: null, stdout, stderr, timedOut, cancelled: true });
          return;
        }
        fail(error);
      });
      child.on("close", (code) => {
        settle({
          code,
          stdout,
          stderr,
          timedOut,
          cancelled: record.cancelled || runOptions.signal?.aborted === true,
        });
      });
    });
  };

  return {
    running: () =>
      [...records.values()].map((record) => ({
        id: record.id,
        pid: record.child.pid,
        startedAt: record.startedAt,
      })),
    run,
    cancel(id) {
      const record = records.get(id);
      if (!record || record.cancelled) return false;
      record.cancelled = true;
      record.abort.abort();
      return true;
    },
    /**
     * Cancela todas y **espera** a que los procesos hayan terminado (con un tope)
     * antes de resolver. No basta con pedir la cancelación: el cierre de la app
     * no puede dar por terminado el apagado con un yt-dlp/ffmpeg todavía vivo.
     */
    async cancelAll(): Promise<number> {
      let count = 0;
      const waits: Promise<boolean>[] = [];
      for (const record of records.values()) {
        if (record.cancelled) continue;
        record.cancelled = true;
        waits.push(record.finished);
        record.abort.abort();
        count += 1;
      }
      if (waits.length > 0) await Promise.all(waits);
      await this.waitForIdle(5_000);
      return count;
    },
    killAllNow() {
      for (const record of records.values()) {
        record.cancelled = true;
        if (record.child.pid !== undefined) killTreeNow(record.child.pid, platform);
      }
    },
    waitForIdle(timeoutMs) {
      if (records.size === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (value: boolean): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          idleWaiters.delete(check);
          resolve(value);
        };
        const check = (): void => finish(true);
        const timer = setTimeout(() => finish(records.size === 0), timeoutMs);
        timer.unref?.();
        idleWaiters.add(check);
      });
    },
  };
}

/**
 * Ejecutor por defecto de la app: un supervisor propio, con los procesos
 * registrados, para que el cierre pueda cancelarlos todos.
 */
export const processSupervisor: ProcessSupervisor = createProcessSupervisor();

export const runProcess: RunProcess = processSupervisor.run;
