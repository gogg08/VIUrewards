/**
 * Limpieza de los procesos que crean los tests e2e.
 *
 * ## Por qué existe
 *
 * `child.kill("SIGKILL")` termina **solo el proceso directo** (medido). Un
 * descendiente que el hijo lanzó sigue vivo, y si el test falla a mitad de
 * camino queda huérfano. Por eso el helper recorre el parentesco.
 *
 * ## Qué cambió respecto de la versión anterior (y por qué)
 *
 * La versión anterior terminaba procesos por **PID**:
 *
 * - `process.kill(pid)` sobre cada PID del árbol, con `isAlive(pid)` como única
 *   comprobación previa;
 * - `taskkill /PID <pid> /T /F` como escalada, que termina **descendientes por
 *   PID sin validar su identidad**.
 *
 * Eso es inseguro: entre `isAlive()` y `process.kill()` el PID puede reciclarse,
 * y `/T` mata hijos cuya identidad nunca se comprobó. Con la hipótesis (no
 * confirmada) de que la limpieza de los E2E pueda estar terminando al propio
 * runner o a un ancestro, el diseño nuevo es **conservador por construcción**:
 *
 * 1. **Solo se termina algo por su objeto `ChildProcess`**, y solo si ese objeto
 *    nació en este proceso de test y quedó **capturado durante el test actual**.
 * 2. **La tabla de procesos es solo diagnóstico.** Ni la pertenencia a la tabla,
 *    ni ser descendiente de una raíz, ni el parentesco autorizan a terminar
 *    nada. Se puede observar un árbol entero sin señalizar un solo proceso.
 * 3. **Nunca** `process.kill(pid)`, **nunca** `taskkill`, **nunca**
 *    `Stop-Process`, **nunca** terminación de árboles por PID.
 * 4. El estado de una entrada es **multidimensional**: creación, espera y
 *    terminación se registran por separado y se agregan por separado, así que
 *    ningún hecho se pierde por prioridad de clasificación.
 *
 * ## Regla temporal de la captura (única e irreversible)
 *
 * La fecha límite se fija **una vez** (`monoNow() + creationTimeoutMs`) al
 * empezar `awaitCreation()` y **no se recalcula**. La puntualidad se decide por
 * el **timestamp monotónico del evento**, nunca por qué promesa gane la carrera:
 *
 * - `eventMonoMs <  deadlineMonoMs`  ⇒ `settled-in-time`
 * - `eventMonoMs >= deadlineMonoMs`  ⇒ `timed-out`  (la igualdad es tardía)
 *
 * Un `timed-out` **no se revierte**. Si el evento llega después, se anotan
 * `lateCreationEventType` y `lateCreationEventAfterMs = eventMonoMs - deadline`
 * (contra la fecha límite original, no contra el instante de la decisión) y el
 * proceso queda como **superviviente tardío visible**; no se intenta terminarlo.
 *
 * ## Limitaciones explícitas de Node.js/libuv (leer antes de confiar)
 *
 * - La documentación de Node (`subprocess.kill()`, `process.kill(pid)`) advierte
 *   que una señal dirigida a un proceso **que ya terminó** puede alcanzar a
 *   **otro proceso** si el Sistema Operativo reasignó su PID. `child.kill()`
 *   opera sobre el objeto `ChildProcess` y es menos vulnerable que
 *   `process.kill(pid)`, pero la API no publica una garantía de identidad.
 * - libuv distingue `uv_process_kill()` (sobre un handle) de `uv_kill(pid)`
 *   (sobre un PID) y documenta comportamientos distintos ante reutilización de
 *   PID. **No** se extrapola ese detalle a una garantía para la versión exacta
 *   de Node/libuv de este proyecto (`24.22.1` en el paquete): queda **sin
 *   verificar**.
 * - Lo que este helper **sí** garantiza es **observacional**: una entrada se
 *   marca `exit-confirmed` **solo** cuando llegó un evento `exit` o `close` del
 *   `ChildProcess` (tras un `spawn` válido), nunca por el valor de retorno de
 *   `kill()` ni por su error.
 * - Entre la verificación y la señalización persiste una ventana de carrera que
 *   no se puede cerrar sin handles nativos (Job Objects / `TerminateProcess`
 *   sobre el handle), que **no** se usan aquí.
 */

import cp from "node:child_process";
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { killProcessTree } from "../../../src/media/run-process.ts";

export const IS_WINDOWS = process.platform === "win32";

/** Espera máxima, por proceso, antes de dar por vencida la terminación. */
export const KILL_WAIT_MS = 5_000;
/** Espera total, CONCURRENTE, de todas las terminaciones de una limpieza. */
export const FORCE_WAIT_MS = 10_000;

/**
 * Plazo de UNA consulta de procesos.
 *
 * Medido en esta PC: `Get-CimInstance Win32_Process` tarda ~1 s. En un runner de
 * CI cargado puede ser varias veces más lento, así que 15 s deja margen amplio y
 * sigue cortando mucho antes que el plazo de un test e2e (90 s). Los plazos son
 * INDEPENDIENTES: este acota la consulta, no el test.
 */
export const PROCESS_TABLE_TIMEOUT_MS = 15_000;

/**
 * Plazo por defecto de la ESPERA de los eventos de salida de un `ChildProcess`.
 *
 * Tiene que caber dentro del teardown de Vitest (`teardownTimeout` = 10 s por
 * defecto, verificado en la versión instalada): si la espera fuera mayor, un
 * `afterEach` podía quedarse esperando un evento que nunca llega y el worker se
 * quedaba sin recursos. Cada entrada cuenta una sola vez y la espera es
 * concurrente y global, no secuencial.
 */
export const CAPTURED_EXIT_WAIT_MS = 4_000;

/**
 * Plazo de UNA operación `killProcessTree`.
 *
 * Solo se usa en `killTreeForExperiment()` (helper de experimentos de tests). La
 * limpieza NORMAL no escala a `killProcessTree`: ese mecanismo termina el árbol
 * por PID (`taskkill /T`) y está prohibido por el diseño conservador.
 *
 * Medido: `taskkill /PID <inexistente> /T /F` cierra en ~57 ms; 5 s es ~90 veces
 * ese valor y sigue muy por debajo del plazo de un test e2e.
 */
export const KILL_PROCESS_TREE_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Enumerador inyectable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enumerador de procesos, inyectable en tests.
 *
 * Resuelve con la salida cruda del comando (CSV en Windows, texto en Unix).
 * Rechaza con el error de la ejecución, de un código de salida distinto de 0 o
 * del plazo. El llamador decide qué es cada cosa; aquí no se interpreta nada.
 */
export type ProcessEnumerator = (command: string, args: string[], timeoutMs: number) => Promise<string>;

/*
 * La consulta de procesos es ASÍNCRONA a propósito.
 *
 * Antes era `execFileSync` sin plazo: si `powershell.exe` o el servicio WMI no
 * respondían, la consulta esperaba para siempre y congelaba el bucle de eventos
 * del worker (medido: un timer de 1000 ms no llegó a dispararse). Con el bucle
 * congelado, ni el plazo del test ni el `timeout-minutes` del paso pueden actuar.
 *
 * Con `execFile` + `timeout` + `killSignal: SIGKILL` el bucle sigue libre, el
 * plazo se cumple y el enumerador se termina de verdad.
 */
const execFileEnumerator: ProcessEnumerator = (command, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        // Terminación fuerte: un `SIGTERM` en Windows no detiene de forma fiable
        // a un `powershell.exe` colgado dentro de una llamada CIM.
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) {
          const killed = (error as { killed?: unknown }).killed === true;
          const detail = killed
            ? `la consulta de procesos superó el plazo de ${timeoutMs} ms y se terminó`
            : `la consulta de procesos falló: ${error.message}`;
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      },
    );
  });

let enumerator: ProcessEnumerator = execFileEnumerator;

/**
 * Reemplaza el enumerador (tests). Devuelve una función para restaurarlo.
 *
 * El repo de tests lo usa para simular una consulta lenta o fallida sin
 * depender de que el WMI real se bloquee.
 */
export function setProcessEnumerator(next: ProcessEnumerator): () => void {
  const previous = enumerator;
  enumerator = next;
  return () => {
    enumerator = previous;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reloj monotónico y captura de eventos de creación
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Contexto de una limpieza: reloj monotónico y PIDs protegidos.
 *
 * `monoNow` es **el mismo** para `onCaptured()` y `awaitCreation()`: los
 * timestamps de los eventos y la fecha límite salen del mismo reloj. En
 * producción es `performance.now()` (monotónico, inmune a cambios de hora); en
 * los tests es un reloj falso controlado.
 */
export interface CleanupContext {
  monoNow: () => number;
  /** PIDs que NUNCA se terminan (proceso de test, ancestros, línea base). */
  protectedPids: Set<number>;
  /** Plazo máximo de espera de un evento de creación. */
  creationTimeoutMs: number;
  /** Plazo máximo (global y concurrente) de espera de los eventos de salida. */
  exitTimeoutMs: number;
}

/** Contexto por defecto: reloj monotónico real y sin PIDs protegidos aún. */
export function createCleanupContext(
  overrides: Partial<CleanupContext> = {},
): CleanupContext {
  return {
    monoNow: () => performance.now(),
    protectedPids: new Set<number>(),
    creationTimeoutMs: 5_000,
    exitTimeoutMs: CAPTURED_EXIT_WAIT_MS,
    ...overrides,
  };
}

/**
 * Evento de creación observado. Uno solo por entrada (`firstEvent`).
 *
 * Un `error` aquí es **siempre** de creación (el proceso no llegó a existir).
 * Los errores **posteriores** a un `spawn` válido van a `runtimeErrors`.
 */
export type CreationEvent =
  | { type: "spawn"; monoMs: number }
  | { type: "error"; monoMs: number; code: string | null };

/** Resultado de la espera por el PRIMER evento de creación. */
export type CreationWait = "pending" | "settled-in-time" | "timed-out";

/** Estado real de creación del proceso. */
export type CreationState = "pending" | "spawned" | "spawn-failed";

/** Una entrada capturada: un `ChildProcess` nacido en este test. */
export interface CapturedEntry {
  /** El objeto por el que se puede terminar (nunca un PID de la tabla). */
  child: cp.ChildProcess;
  /**
   * PID del hijo, o `null` hasta observar `spawn` o si no es válido.
   *
   * No se puede leer de `child.pid`: un doble de test (o un `spawn` con las
   * opciones de correlación de Node) puede exponer un PID que no es el del
   * proceso observado. La entrada es la fuente de verdad.
   */
  pid: number | null;
  creationState: CreationState;
  creationErrorCode: string | null;
  creationWait: CreationWait;
  /** Fecha límite diseñada (monoMs). `null` hasta que se inicia la espera. */
  creationDeadlineMonoMs: number | null;
  /** Instante en que se DECIDIÓ `creationWait` (puede ser > deadline). */
  creationDecidedAtMs: number | null;
  /** Primer evento de creación observado (inmutable). */
  firstEvent: CreationEvent | null;
  /** Copia del primer evento si llegó después de decidir `timed-out`. */
  lateCreationEventType: "spawn" | "error" | null;
  lateCreationEventAfterMs: number | null;
  /** Errores ocurridos DESPUÉS de un `spawn` válido (nunca de creación). */
  runtimeErrors: Array<{ code: string | null; monoMs: number }>;
  /** `exit` y `close` observados (independientes del código de salida). */
  exitSeen: boolean;
  closeSeen: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  /** Resuelve UNA vez con un evento de creación (lo consume `awaitCreation`). */
  creationSettled: Promise<void>;
  /** Intentos de terminación mediante el objeto `ChildProcess`. */
  killAttempts: Array<{ monoMs: number; returned: boolean | null; errorCode: string | null }>;
}

/**
 * Crea la entrada y **suscribe los listeners permanentes** (una sola vez).
 *
 * Los listeners de creación no se retiran nunca: un evento tardío tiene que
 * poder anotarse aunque `awaitCreation()` ya haya devuelto. `ctx` es el mismo que
 * usará `awaitCreation()`.
 */
export function onCaptured(child: cp.ChildProcess, ctx: CleanupContext): CapturedEntry {
  let resolveCreation: () => void = () => {};
  const creationSettled = new Promise<void>((resolve) => {
    resolveCreation = resolve;
  });
  const entry: CapturedEntry = {
    child,
    pid: null,
    creationState: "pending",
    creationErrorCode: null,
    creationWait: "pending",
    creationDeadlineMonoMs: null,
    creationDecidedAtMs: null,
    firstEvent: null,
    lateCreationEventType: null,
    lateCreationEventAfterMs: null,
    runtimeErrors: [],
    exitSeen: false,
    closeSeen: false,
    exitCode: null,
    exitSignal: null,
    creationSettled,
    killAttempts: [],
  };
  // `resolveCreation` se captura arriba; el listener lo usa por esta función.
  (entry as CapturedEntry & { resolveCreation?: () => void }).resolveCreation = resolveCreation;

  child.once("spawn", () => {
    // Solo la PRIMERA observación válida fija el PID: un `spawn-failed` no se
    // degrada y un PID ya asignado no se reescribe. Se lee el PID del OBJETO
    // que el espía capturó, no de `entry` (que en este momento es `null`).
    if (entry.creationState === "pending" && entry.firstEvent === null) {
      const spawnedPid: unknown = (child as { pid?: unknown }).pid;
      entry.pid = typeof spawnedPid === "number" && spawnedPid > 0 ? spawnedPid : null;
      entry.creationState = "spawned";
    }
    recordFirstCreationEvent(entry, { type: "spawn", monoMs: ctx.monoNow() }, ctx);
  });

  // Handler PERMANENTE de `error`: distingue error de creación del de runtime.
  child.on("error", (error: NodeJS.ErrnoException) => {
    const isCreationError = entry.creationState === "pending" && entry.firstEvent === null;
    if (isCreationError) {
      entry.creationState = "spawn-failed";
      entry.creationErrorCode = error.code ?? null;
      recordFirstCreationEvent(
        entry,
        { type: "error", monoMs: ctx.monoNow(), code: error.code ?? null },
        ctx,
      );
      return;
    }
    // Posterior a un `spawn` válido (p. ej. de `kill()`): NO es de creación.
    entry.runtimeErrors.push({ code: error.code ?? null, monoMs: ctx.monoNow() });
  });

  child.once("exit", (code, signal) => {
    entry.exitSeen = true;
    entry.exitCode = code;
    entry.exitSignal = signal;
  });
  child.once("close", () => {
    entry.closeSeen = true;
  });

  return entry;
}

/**
 * Único punto de observación del PRIMER evento de creación.
 *
 * - Conserva el primero con su `monoMs`; los siguientes se ignoran aquí.
 * - Resuelve `creationSettled` una sola vez.
 * - Si la decisión ya fue `timed-out`, anota inmediatamente el evento tardío
 *   contra la fecha límite guardada. **Nunca** revierte a `settled-in-time`.
 */
export function recordFirstCreationEvent(
  entry: CapturedEntry,
  event: CreationEvent,
  ctx: CleanupContext,
): void {
  if (entry.firstEvent !== null) return;
  entry.firstEvent = event;

  const resolver = (entry as CapturedEntry & { resolveCreation?: () => void }).resolveCreation;
  resolver?.();

  if (entry.creationWait === "timed-out") {
    const deadline = entry.creationDeadlineMonoMs;
    if (deadline !== null && entry.lateCreationEventType === null) {
      entry.lateCreationEventType = event.type;
      entry.lateCreationEventAfterMs = event.monoMs - deadline;
    }
  }
}

/**
 * Decide `creationWait` con la regla única, a partir del evento ya registrado.
 *
 * Idempotente: si ya hay decisión, la devuelve sin cambiarla (`timed-out` es
 * irreversible). No decide nada si todavía no hay evento.
 */
export function decideFromObservation(
  entry: CapturedEntry,
  ctx: CleanupContext,
): CreationWait {
  if (entry.creationWait !== "pending") return entry.creationWait;
  const deadline = entry.creationDeadlineMonoMs;
  const event = entry.firstEvent;
  if (event === null || deadline === null) return "pending";

  if (event.monoMs < deadline) {
    entry.creationWait = "settled-in-time";
    entry.creationDecidedAtMs = ctx.monoNow();
    return "settled-in-time";
  }

  entry.creationWait = "timed-out";
  entry.creationDecidedAtMs = ctx.monoNow();
  if (entry.lateCreationEventType === null) {
    entry.lateCreationEventType = event.type;
    entry.lateCreationEventAfterMs = event.monoMs - deadline;
  }
  return "timed-out";
}

/**
 * Adaptador de la carrera entre "llegó el evento" y "venció el plazo".
 *
 * SOLO coordina: quien la usa decide después consultando `firstEvent` y la fecha
 * límite. Inyectable para que los tests puedan forzar `timer-wake` aunque el
 * evento ya exista, sin depender del orden real del event loop.
 */
export type CreationRace = (
  settled: Promise<void>,
  remainingMs: number,
) => Promise<"settled" | "timer-wake">;

/** Carrera por defecto: `settled` o un temporizador que despierta al vencer. */
export const defaultCreationRace: CreationRace = (settled, remainingMs) =>
  new Promise<"settled" | "timer-wake">((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve("timer-wake");
    }, Math.max(0, remainingMs));
    timer.unref?.();
    void settled.then(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve("settled");
    });
  });

/**
 * Espera el primer evento de creación con una fecha límite **monotónica única**.
 *
 * Puntos del contrato:
 *
 * - La fecha límite se fija aquí, una vez, y se conserva en todo el bucle.
 * - El bucle es **iterativo**, nunca recursivo, y hay **una sola promesa** por
 *   entrada: no hay forma de esperarse a sí misma.
 * - Si el timer despierta, antes de declarar timeout se consulta `firstEvent`:
 *   un evento puntual ya registrado gana aunque el timer haya vencido.
 * - Solo se declara timeout **por ausencia de evento** cuando el registro sigue
 *   vacío y el reloj haya alcanzado la fecha límite.
 */
export async function awaitCreation(
  entry: CapturedEntry,
  ctx: CleanupContext,
  race: CreationRace = defaultCreationRace,
): Promise<CapturedEntry> {
  if (entry.creationWait !== "pending") return entry;

  if (entry.creationDeadlineMonoMs === null) {
    entry.creationDeadlineMonoMs = ctx.monoNow() + ctx.creationTimeoutMs;
  }
  const deadline = entry.creationDeadlineMonoMs;

  for (;;) {
    // 1) ¿Ya hay evento registrado? La regla única decide (puntual o tardío).
    if (entry.firstEvent !== null) {
      decideFromObservation(entry, ctx);
      return entry;
    }

    // 2) Sin evento: si el reloj alcanzó la fecha límite, timeout por ausencia.
    if (ctx.monoNow() >= deadline) {
      entry.creationWait = "timed-out";
      entry.creationDecidedAtMs = ctx.monoNow();
      return entry;
    }

    const remaining = deadline - ctx.monoNow();
    const outcome = await race(entry.creationSettled, remaining);

    // 3) La decisión SIEMPRE mira el registro: un `timer-wake` no declara
    //    timeout si hay un evento puntual observado antes de la fecha límite.
    if (entry.firstEvent !== null) {
      decideFromObservation(entry, ctx);
      return entry;
    }
    // Registro vacío: si el plazo ya venció se declara timeout; si el despertar
    // fue prematuro, el bucle rearma el temporizador con el MISMO deadline.
    if (outcome === "timer-wake" && ctx.monoNow() >= deadline) {
      entry.creationWait = "timed-out";
      entry.creationDecidedAtMs = ctx.monoNow();
      return entry;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registro de entradas del test actual (nunca se hereda al test siguiente)
// ─────────────────────────────────────────────────────────────────────────────

let captured = new Map<cp.ChildProcess, CapturedEntry>();
let originalSpawn: typeof cp.spawn | null = null;

export interface SpawnSpy {
  /** PIDs de las entradas capturadas en el test actual (diagnóstico). */
  spawned(): number[];
  /** Entradas capturadas (pendientes y terminadas) del test actual. */
  entries(): CapturedEntry[];
  /** Espera los eventos de creación de las entradas capturadas. */
  settle(ctx?: CleanupContext): Promise<CapturedEntry[]>;
  /** Termina las entradas capturadas del test actual. */
  cleanup(ctx: CleanupContext): Promise<CleanupResult>;
  /** Vacía el registro del test actual (sin tocar procesos). */
  clear(): void;
  restore(): void;
}

/**
 * Registra cada `ChildProcess` que se lance en este proceso de test.
 *
 * - Envuelve `spawn` con un Proxy sobre el módulo y `syncBuiltinESMExports()`;
 *   asignar `cp.spawn = fn` NO alcanza para las importaciones ESM con nombre
 *   (verificado). Hay que instalar esto ANTES de importar los módulos que crean
 *   procesos, o sus `spawn` quedarán sin capturar.
 * - Cada hijo entra en el registro **con su objeto**, no con su PID: la
 *   identidad de lo que se puede terminar es el objeto, no un número leído de la
 *   tabla de procesos.
 * - `clear()` (llamarlo en `beforeEach`/`afterEach`) borra el registro del test
 *   anterior: ninguna entrada sobrevive al test siguiente.
 */
export function spyOnChildProcess(ctx: CleanupContext = createCleanupContext()): SpawnSpy {
  captured = new Map();
  if (originalSpawn === null) {
    const original = cp.spawn;
    originalSpawn = original;
    const patched = ((...args: Parameters<typeof original>) => {
      const child = original(...args);
      // Se registra inmediatamente: los listeners de creación se instalan aquí,
      // de modo que un evento ocurrido antes de la primera consulta no se pierde.
      captured.set(child, onCaptured(child, ctx));
      return child;
    }) as typeof original;
    Object.defineProperty(cp, "spawn", {
      configurable: true,
      enumerable: true,
      get: () => patched,
    });
    syncBuiltinESMExports();
  }

  return {
    spawned: () =>
      [...captured.values()]
        .map((entry) => entry.pid)
        .filter((pid): pid is number => pid !== null),
    entries: () => [...captured.values()],
    async settle(settleCtx: CleanupContext = ctx): Promise<CapturedEntry[]> {
      // Concurrente: todas las entradas esperan a la vez con su propio plazo.
      return Promise.all([...captured.values()].map((entry) => awaitCreation(entry, settleCtx)));
    },
    async cleanup(cleanupCtx: CleanupContext = ctx): Promise<CleanupResult> {
      return cleanupCaptured(cleanupCtx);
    },
    clear: () => {
      captured = new Map();
    },
    restore: () => {
      restoreSpawn();
    },
  };
}

/** Vuelve `spawn` a la normalidad y olvida el registro del test actual. */
export function restoreSpawn(): void {
  if (originalSpawn !== null) {
    Object.defineProperty(cp, "spawn", {
      configurable: true,
      enumerable: true,
      value: originalSpawn,
      writable: true,
    });
    originalSpawn = null;
    syncBuiltinESMExports();
  }
  captured = new Map();
}

/** Entradas capturadas en el test actual (vista de solo lectura). */
export function capturedEntries(): CapturedEntry[] {
  return [...captured.values()];
}

/** Vacía el registro del test actual sin terminar nada (tests y `beforeEach`). */
export function clearCapturedEntries(): void {
  captured = new Map();
}

/** Añade una entrada YA construida (solo tests puros). */
export function registerCapturedEntry(
  child: cp.ChildProcess,
  ctx: CleanupContext,
): CapturedEntry {
  const entry = onCaptured(child, ctx);
  captured.set(child, entry);
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ciclo de vida del proceso de test (isAlive: SOLO diagnóstico)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ¿Existe el PID? **Solo diagnóstico**, nunca autorización.
 *
 * `isAlive()` no demuestra identidad: un PID reciclado también está "vivo".
 * Por eso este helper ya no lo usa para decidir qué terminar; solo para informar
 * de supervivientes y para experimentos de los tests (que los matan por su
 * propio objeto, no por este valor).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: existe pero es de otro usuario; se cuenta como vivo (conservador).
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabla de procesos (SOLO diagnóstico)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProcessRow {
  pid: number;
  ppid: number;
  cmd: string;
}

/**
 * Tabla de procesos (solo lectura).
 *
 * Windows: `Get-CimInstance Win32_Process` por `powershell.exe`. **No** se usa
 * `wmic`: Microsoft lo declaró obsoleto y ya no existe en `windows-latest`
 * (medido: el runner fallaba con `spawnSync wmic ENOENT`).
 *
 * Se piden solo tres propiedades y se re-emiten como objetos con nombres
 * propios: `Select-Object` sobre un `CimInstance` devuelve TODAS las propiedades
 * (44 columnas), y el CSV posicional se vuelve ilegible. Se usa CSV (no texto
 * libre) porque escapa comas y comillas de `CommandLine`; por eso se parsea con
 * un lector de CSV real y no con `split(",")`.
 *
 * IMPORTANTE: el orden de las columnas es `pid,ppid,cmd` y `cmd` es `cells[2]`.
 * Renumerar rompe el parseo en silencio.
 */
const WINDOWS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine -ErrorAction Stop |",
  "  ForEach-Object {",
  // `CommandLine` es null para los procesos protegidos: se normaliza a "" para
  // que la columna nunca cambie de cantidad y el CSV siga siendo posicional.
  "    $cmd = if ($null -eq $_.CommandLine) { '' } else { $_.CommandLine }",
  "    [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; cmd = $cmd }",
  "  } |",
  "  ConvertTo-Csv -NoTypeInformation",
].join("\n");

/**
 * Parser de CSV mínimo (RFC 4180) para la salida de `ConvertTo-Csv`.
 *
 * Soporta los campos entrecomillados y las comillas escapadas como `""`, que es
 * lo que produce PowerShell cuando `CommandLine` trae comas o comillas.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Convierte el CSV de la consulta de Windows en filas de proceso.
 *
 * Solo valida el FORMATO: encabezado presente y válido, y celdas con enteros
 * legibles. No conoce `process.pid` ni juzga si la tabla sirve para la limpieza
 * (eso lo hace `readProcessSnapshot()`).
 *
 * Un `pid` ilegible o `<= 0` descarta la fila (nunca se inventa como 0, porque 0
 * se confundiría con un proceso real). Un `ppid` ilegible NO se normaliza a 0 —
 * se usaría como "sin padre" y ocultaría un árbol roto — sino a `-1`, que ningún
 * proceso tiene como padre; además degrada la cobertura de los descendientes.
 *
 * Cada fila descartada queda contada en las incidencias de SU tabla: nunca
 * desaparece en silencio. Los diagnósticos no incluyen valores de fila, líneas de
 * comandos ni argumentos de procesos.
 */
export function rowsFromWindowsCsv(text: string): ProcessRow[] {
  return parseWindowsProcessCsv(text).rows;
}

/** Categoría de una incidencia de parseo (sin datos de la fila). */
type ParseIssueCategory =
  | "header-invalid"
  | "row-short"
  | "pid-invalid"
  | "pid-not-positive"
  | "ppid-invalid";

/** Incidencia de parseo: línea (1-based), categoría y conteo. Nada más. */
interface ParseIssue {
  line: number;
  category: ParseIssueCategory;
  count: number;
}

/**
 * Resultado interno de parsear la tabla.
 *
 * `error` distingue un error DURO de enumeración (no hay tabla utilizable) de
 * una tabla parcial: con `error` no nulo, `rows` va vacío. `counts` agrega las
 * incidencias por categoría para el diagnóstico.
 *
 * No se exporta: es un detalle de implementación que no amplía el contrato
 * público del helper.
 */
interface ProcessSnapshot {
  rows: ProcessRow[];
  parseIssues: ParseIssue[];
  counts: Record<string, number>;
  error: string | null;
}

/** Columnas esperadas, en orden posicional (`cmd` es `cells[2]`). */
const WINDOWS_CSV_COLUMNS = ["pid", "ppid", "cmd"] as const;

/**
 * ¿El encabezado es el esperado?
 *
 * Tolera el BOM inicial que agrega PowerShell, espacios alrededor y diferencias
 * de mayúsculas. El ORDEN importa: el parseo es posicional.
 */
function isExpectedWindowsHeader(cells: string[]): boolean {
  const normalized = cells
    .slice(0, WINDOWS_CSV_COLUMNS.length + 1)
    .map((cell) => cell.replace(/^\uFEFF/, "").trim().toLowerCase());
  if (normalized.length !== WINDOWS_CSV_COLUMNS.length) return false;
  return WINDOWS_CSV_COLUMNS.every((name, index) => normalized[index] === name);
}

/**
 * Entero de una celda, o `null` si la celda no lo representa.
 *
 * `Number("")` y `Number(" ")` valen 0: por eso se valida el TEXTO original
 * antes de convertir. Una celda vacía, en blanco, negativa donde no corresponde
 * o no numérica nunca se convierte en 0 por accidente.
 */
function parseIntegerCell(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const text = cell.replace(/^\uFEFF/, "").trim();
  if (text.length === 0) return null;
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/**
 * Parser ÚNICO de la tabla de procesos de Windows.
 *
 * Lo usan `rowsFromWindowsCsv()` (pruebas del formato) y
 * `readProcessSnapshot()` (producción). Así la validación del encabezado y de
 * las celdas vive en un solo lugar y ningún camino la salta.
 *
 * Contrato:
 *
 * - **Encabezado ausente o distinto** de `pid,ppid,cmd` ⇒ error duro
 *   (`rows: []`), nunca se parsea el encabezado como si fuera una fila.
 * - **Sin filas válidas** (solo encabezado, o todas descartadas) ⇒ error duro.
 * - **Filas descartadas con otras válidas** ⇒ tabla parcial: las incidencias se
 *   registran en el diagnóstico de ESA consulta y la cobertura de descendientes
 *   se degrada. No es un error duro por sí solo.
 * - Una fila necesita las TRES celdas (`pid`, `ppid`, `cmd`). Con menos se
 *   registra como incompleta y se descarta; una tercera celda vacía es válida.
 * - `pid` `<= 0` se descarta (el PID 0 no es un proceso real); el PID 4 (System)
 *   se CONSERVA.
 */
function parseWindowsProcessCsv(text: string): ProcessSnapshot {
  const lines = parseCsv(text);
  const parseIssues: ParseIssue[] = [];
  const counts: Record<string, number> = {};
  const note = (line: number, category: ParseIssueCategory): void => {
    parseIssues.push({ line, category, count: 1 });
    counts[category] = (counts[category] ?? 0) + 1;
  };

  const header = lines[0];
  if (lines.length === 0 || header === undefined || !isExpectedWindowsHeader(header)) {
    note(1, "header-invalid");
    return {
      rows: [],
      parseIssues,
      counts,
      error: "el CSV de procesos no tiene el encabezado esperado (pid,ppid,cmd)",
    };
  }

  const rows: ProcessRow[] = [];
  for (let index = 1; index < lines.length; index++) {
    const cells = lines[index];
    const line = index + 1;
    if (cells === undefined) continue;
    // Una línea vacía (fin de archivo) no es una fila: no es una anomalía.
    if (cells.length === 1 && cells[0].trim().length === 0) continue;
    if (cells.length < WINDOWS_CSV_COLUMNS.length) {
      // Las tres columnas son obligatorias: una fila corta no describe un
      // proceso. Una tercera celda vacía sí es válida (`"1900","4",""`).
      note(line, "row-short");
      continue;
    }
    const pid = parseIntegerCell(cells[0]);
    if (pid === null) {
      note(line, "pid-invalid");
      continue;
    }
    if (pid <= 0) {
      note(line, "pid-not-positive");
      continue;
    }
    const ppid = parseIntegerCell(cells[1]);
    if (ppid === null || ppid < 0) {
      // Centinela: NUNCA 0 (0 es una raíz legítima) y nunca se elige un padre.
      note(line, "ppid-invalid");
      rows.push({ pid, ppid: -1, cmd: (cells[2] ?? "").trim() });
      continue;
    }
    rows.push({ pid, ppid, cmd: (cells[2] ?? "").trim() });
  }

  if (rows.length === 0) {
    return {
      rows: [],
      parseIssues,
      counts,
      error:
        lines.length <= 1
          ? "Get-CimInstance no devolvió ningún proceso"
          : "el CSV de procesos no tenía filas válidas",
    };
  }

  return { rows, parseIssues, counts, error: null };
}

/** Resumen de incidencias para el log: categorías y conteos, sin valores. */
function formatParseIssues(snapshot: ProcessSnapshot): string {
  const categories = Object.entries(snapshot.counts)
    .map(([category, count]) => `${category}=${count}`)
    .join(",");
  return categories.length === 0 ? "ninguna" : categories;
}

/**
 * Mensajes de diagnóstico, SOLO con `CI` activo.
 *
 * Sin `CI` (uso local) no se imprime nada: la salida de los tests queda igual.
 * Con `CI`, se emite un evento ANTES de cada fase que puede quedarse esperando
 * (la consulta de procesos y la espera de terminación son las únicas llamadas
 * que pueden bloquearse), porque un mensaje posterior a un cuelgue no sirve
 * para localizarlo.
 *
 * No se imprimen líneas de comandos completas, variables de entorno, tokens,
 * rutas personales ni pids individuales: solo el archivo, el test, la fase y
 * los tiempos.
 */
export const CI_DIAGNOSTICS = process.env.CI === "true" || process.env.CI === "1";

let currentTest = "(sin nombre)";

/** Declara el test que arranca (aparece en los siguientes diagnósticos). */
export function noteTest(name: string): void {
  currentTest = name;
  if (CI_DIAGNOSTICS) diagStart("test");
}

/**
 * Diagnóstico `[ci-diag]` con test, fase y tiempo transcurrido.
 *
 * `elapsedMs` va solo cuando corresponde (fin de fase); los avisos de inicio no
 * llevan duración porque todavía no la hay.
 */
export function diag(phase: string, detail = "", elapsedMs?: number): void {
  if (!CI_DIAGNOSTICS) return;
  const elapsed = elapsedMs === undefined ? "" : ` ms=${elapsedMs}`;
  process.stdout.write(`[ci-diag] test="${currentTest}" fase=${phase}${elapsed} ${detail}\n`);
}

function diagStart(phase: string): void {
  diag(phase, "inicio");
}

/** Máximo de consultas de procesos hechas desde que arrancó el proceso. */
let tableQueries = 0;

/** Consultas de procesos hechas desde que arrancó este proceso de test. */
export function processTableQueryCount(): number {
  return tableQueries;
}

/** Reinicia el contador (tests). Devuelve cuántas se habían hecho. */
export function resetProcessTableQueryCount(): number {
  const previous = tableQueries;
  tableQueries = 0;
  return previous;
}

/**
 * Último error de enumeración, si lo hubo.
 *
 * `processTable()` devuelve `[]` ante un fallo para que los llamadores no
 * revienten, pero eso es indistinguible de "no hay procesos". La limpieza usa
 * este campo para **fallar** en vez de creer que no quedaba nada vivo.
 */
let lastTableError: string | null = null;

/** Error de la última llamada a `processTable()`, o `null` si funcionó. */
export function processTableError(): string | null {
  return lastTableError;
}

/** Enumera los procesos actuales. Ver `lastTableError` para el porqué de `[]`. */
export async function processTable(): Promise<ProcessRow[]> {
  const startedAt = Date.now();
  tableQueries += 1;
  diagStart("processTable");
  const rows = await readProcessTable();
  diag("processTable", `fin filas=${rows.length} consultas=${tableQueries} error=${lastTableError === null ? "null" : "si"}`, Date.now() - startedAt);
  return rows;
}

/**
 * Filas de la tabla de procesos.
 *
 * Un error NUNCA se devuelve como tabla vacía silenciosa: se anota en
 * `lastTableError` y se devuelve `[]` para que el llamador no reviente, pero la
 * limpieza comprueba ese campo y **falla** en vez de creer que no quedó nada
 * vivo. Una tabla vacía de verdad también es un error: hasta el proceso System
 * (pid 4) existe siempre.
 */
async function readProcessTable(): Promise<ProcessRow[]> {
  try {
    if (IS_WINDOWS) {
      const out = await enumerator(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT],
        PROCESS_TABLE_TIMEOUT_MS,
      );
      const snapshot = readProcessSnapshot(out);
      // Las incidencias viajan CON esta consulta: se registran aquí, en el
      // diagnóstico de la llamada que las produjo, y no en un estado global que
      // otra consulta pudiera pisar. Solo categorías y conteos: nunca filas,
      // líneas de comandos ni argumentos de procesos.
      if (snapshot.parseIssues.length > 0) {
        diag("processTable·parse", `incidencias=${formatParseIssues(snapshot)} lineas=${snapshot.parseIssues.length}`);
      }
      lastTableError = snapshot.error;
      return snapshot.rows;
    }
    const out = await enumerator("ps", ["-eo", "pid=,ppid=,args="], PROCESS_TABLE_TIMEOUT_MS);
    const rows: ProcessRow[] = [];
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3].trim() });
    }
    lastTableError = rows.length === 0 ? "ps no devolvió ningún proceso" : null;
    return rows;
  } catch (error) {
    lastTableError = error instanceof Error ? error.message : String(error);
    return [];
  }
}

/**
 * Instantánea de la tabla REAL del sistema, formato **e** integridad.
 *
 * - Usa el MISMO parser que `rowsFromWindowsCsv()`: encabezado y celdas se
 *   validan una sola vez, en un solo lugar.
 * - Añade la comprobación que solo tiene sentido en producción: la tabla tiene
 *   que contener el proceso actual. Si falta, es un error DURO (no permite
 *   afirmar nada sobre la cobertura) y se devuelve `rows: []`, conservando las
 *   incidencias de parseo.
 */
function readProcessSnapshot(raw: string): ProcessSnapshot {
  const snapshot = parseWindowsProcessCsv(raw);
  if (snapshot.error !== null) return snapshot;
  if (!snapshot.rows.some((row) => row.pid === process.pid)) {
    return {
      rows: [],
      parseIssues: snapshot.parseIssues,
      counts: snapshot.counts,
      error: "la tabla de procesos no incluía el proceso actual",
    };
  }
  return snapshot;
}

/**
 * Índice de la tabla por PID.
 *
 * Un PID duplicado (tabla malformada) **no se sobrescribe en silencio**: el
 * primero gana y se registra la anomalía, para que el diagnóstico lo diga.
 */
export interface IndexedTable {
  byPid: Map<number, ProcessRow>;
  duplicatePids: number[];
  rows: ProcessRow[];
}

export function indexProcessTable(table: ProcessRow[]): IndexedTable {
  const byPid = new Map<number, ProcessRow>();
  const duplicatePids: number[] = [];
  for (const row of table) {
    if (byPid.has(row.pid)) {
      if (!duplicatePids.includes(row.pid)) duplicatePids.push(row.pid);
      continue;
    }
    byPid.set(row.pid, row);
  }
  return { byPid, duplicatePids, rows: table };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadena de ancestros (protegida contra ciclos, PID 0/4 y padres ausentes)
// ─────────────────────────────────────────────────────────────────────────────

/** Contrato de la cadena de ancestros del proceso de test. */
export interface ProtectedChain {
  /** PIDs que nunca se tocan (incluye el propio proceso de test). */
  pids: number[];
  /**
   * La cadena llega a una raíz válida (PID 0, PID 4 o un padre que ya no
   * está en la tabla) sin ciclos ni contradicciones temporales.
   *
   * Es un DATO, no una precondición aplicada: `killOwnTree()` no lo exige.
   */
  structurallyComplete: boolean;
  /**
   * Además, todos los eslabones relevantes tienen `CreationDate` y el padre no
   * es más nuevo que el hijo. Un `creation-unknown` NO se declara verificado.
   *
   * PENDIENTE: `processTable()` no pide `CreationDate`, así que
   * `protectedChain()` se llama sin fechas y este campo queda en `false` en
   * producción. La política de exigirlo antes de limpiar NO está implementada.
   */
  identityVerified: boolean;
  issues: ChainIssue[];
  /** Diagnóstico por eslabón (sin filas ficticias). */
  links: Array<{ pid: number; ppid: number | null; createdAtMs: number | null }>;
}

export type ChainIssue =
  | { kind: "cycle"; pid: number }
  | { kind: "parent-missing"; pid: number }
  | { kind: "parent-newer-than-child"; pid: number; ppid: number }
  | { kind: "creation-unknown"; pid: number };

/**
 * Cadena de padres del proceso actual, **sin límite de profundidad**.
 *
 * Casos tratados explícitamente:
 *
 * - **PID 0 y PID 4** son raíces legítimas: se añaden al conjunto protegido y
 *   se detiene el recorrido. NO convierten la cadena en inválida.
 * - **Padre ausente de la tabla**: se añade al conjunto protegido y se marca
 *   `structurallyComplete = false` (la cadena quedó incompleta).
 * - **Ciclo**: se marca el PID y se corta; la cadena NO es válida.
 * - **Padre más nuevo que el hijo o fecha desconocida**: se informa. La
 *   identidad temporal NO se declara verificada.
 *
 * La ignorancia nunca autoriza: una cadena inválida o sin verificar se refleja
 * en el contrato. La POLITICA de exigir `structurallyComplete` e
 * `identityVerified` antes de cualquier limpieza sigue PENDIENTE (ver
 * `killOwnTree()`): hoy el helper NO la aplica y solo protege con `chain.pids`.
 * Ninguno de estos campos se presenta como garantía cumplida.
 */
export function protectedChain(
  table: ProcessRow[],
  selfPid: number,
  creationTimes: Map<number, number | null> = new Map(),
): ProtectedChain {
  const indexed = indexProcessTable(table);
  const pids: number[] = [selfPid];
  const issues: ChainIssue[] = [];
  const links: ProtectedChain["links"] = [];
  const visited = new Set<number>([selfPid]);
  let structurallyComplete = true;
  let identityVerified = true;

  let cursor = selfPid;
  for (;;) {
    const row = indexed.byPid.get(cursor);
    const createdAtMs = row ? creationTimes.get(cursor) ?? null : null;
    const ppid = row ? row.ppid : null;
    links.push({ pid: cursor, ppid, createdAtMs });

    if (row === undefined) {
      // El proceso de test siempre debería estar; si no está, la cadena es
      // incompleta (pero el propio PID ya está protegido).
      structurallyComplete = false;
      break;
    }

    // La fecha de creación de la FILA REAL se valida SIEMPRE, también cuando su
    // padre es una raíz (0 o 4): antes se retornaba en la raíz sin mirarla y un
    // `creation-unknown` pasaba como verificado.
    if (createdAtMs === null) {
      issues.push({ kind: "creation-unknown", pid: cursor });
      identityVerified = false;
    }

    if (row.ppid === 0 || row.ppid === 4) {
      // Raíz legítima: se protege y se termina el recorrido. Alcanzar una raíz
      // NO vuelve inválida la cadena.
      if (!pids.includes(row.ppid)) pids.push(row.ppid);
      break;
    }

    const parent = indexed.byPid.get(row.ppid);
    if (parent === undefined) {
      // Padre ausente de la tabla: se protege por precaución y la cadena queda
      // incompleta (no se puede recorrer hasta la raíz).
      if (!pids.includes(row.ppid)) pids.push(row.ppid);
      issues.push({ kind: "parent-missing", pid: cursor });
      structurallyComplete = false;
      break;
    }

    if (visited.has(parent.pid)) {
      issues.push({ kind: "cycle", pid: parent.pid });
      structurallyComplete = false;
      break;
    }
    if (!pids.includes(parent.pid)) pids.push(parent.pid);
    visited.add(parent.pid);

    // Coherencia temporal: el padre no puede haber nacido después del hijo.
    const parentCreated = creationTimes.get(parent.pid) ?? null;
    if (createdAtMs !== null && parentCreated !== null && parentCreated > createdAtMs) {
      issues.push({ kind: "parent-newer-than-child", pid: cursor, ppid: parent.pid });
      identityVerified = false;
    }

    cursor = parent.pid;
  }

  return { pids, structurallyComplete, identityVerified, issues, links };
}

/**
 * Cadena de padres del proceso actual como lista de PIDs (solo diagnóstico).
 *
 * Sin límite de profundidad, protegida contra ciclos y contra un padre más nuevo
 * que el hijo (no se sube por un padre más nuevo: la tabla probablemente tiene
 * un PID reciclado).
 */
export async function parentChain(table?: ProcessRow[]): Promise<number[]> {
  const rows = table ?? (await processTable());
  const chain = protectedChain(rows, process.pid);
  return chain.pids;
}

/**
 * Fija qué procesos ya existían (lista blanca): la línea de padres del test y
 * los shells del sistema (`cmd.exe`, que es lo que lanzan los procesos
 * externos). Se llama al empezar el archivo de test.
 */
export async function captureBaseline(extra: number[] = []): Promise<void> {
  // UNA sola consulta: antes `parentChain()` enumeraba por su cuenta y después
  // se volvía a enumerar para los `cmd.exe`.
  const table = await processTable();
  baseline = new Set(await parentChain(table));
  for (const pid of extra) baseline.add(pid);
  for (const row of table) {
    if (/(^|[\\/])cmd\.exe$/i.test(row.cmd)) baseline.add(row.pid);
  }
}

let baseline = new Set<number>();

/** Cuántos procesos existen en la línea base (diagnóstico). */
export function baselineSize(): number {
  return baseline.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// Descendientes transitivos (SOLO observación)
// ─────────────────────────────────────────────────────────────────────────────

export type DescendantIssue =
  /** Una raíz pedida no tiene fila en la tabla (seguimos buscando sus hijos). */
  | { kind: "root-missing"; pid: number }
  /** Existe al menos una fila cuyo `ppid` es una raíz ausente. */
  | { kind: "parent-missing-relevant"; ppid: number }
  /** PID alcanzable desde dos o más raíces distintas. */
  | { kind: "multi-root"; pid: number; roots: number[] }
  /** Ciclo real en el grafo dirigido padre→hijo. */
  | { kind: "cycle"; pid: number }
  /** PID duplicado en la tabla (fixture malformado). */
  | { kind: "pid-duplicated"; pid: number };

export interface DescendantsResult {
  /** TODOS los descendientes encontrados, excluidas TODAS las raíces. */
  descendants: number[];
  issues: DescendantIssue[];
  /**
   * `complete` solo si todas las raíces estaban en la tabla y el recorrido
   * terminó sin ciclos. Con cobertura parcial NO se puede afirmar que el árbol
   * esté limpio.
   */
  coverage: "complete" | "partial";
}

/** Nodo de la cadena de raíces: comparable por ascendencia. */
function isAncestorOf(table: IndexedTable, candidate: number, of: number): boolean {
  const visited = new Set<number>();
  let cursor = table.byPid.get(of)?.ppid;
  while (cursor !== undefined && cursor !== 0 && cursor !== 4 && !visited.has(cursor)) {
    if (cursor === candidate) return true;
    visited.add(cursor);
    cursor = table.byPid.get(cursor)?.ppid;
  }
  return false;
}

/**
 * ¿El conjunto de raíces que alcanzan a `pid` forma una cadena de ascendencia?
 *
 * Solo entonces la anomalía `multi-root` es benigna (una raíz es ancestro de
 * otra). Con TODOS los pares comparables se suprime el aviso; con un par no
 * comparable, la anomalía se informa.
 */
export function rootsFormChain(table: ProcessRow[], roots: number[]): boolean {
  const indexed = indexProcessTable(table);
  const unique = [...new Set(roots)];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i];
      const b = unique[j];
      if (a === b) continue;
      if (!isAncestorOf(indexed, a, b) && !isAncestorOf(indexed, b, a)) return false;
    }
  }
  return true;
}

/**
 * Descendientes transitivos de varias raíces a partir de UNA sola tabla.
 *
 * Contrato (los tests sintéticos lo fijan):
 *
 * - Se recorre **cada raíz por separado** (BFS independiente), aunque la raíz no
 *   tenga fila propia: con una raíz ausente se siguen encontrando sus hijos
 *   visibles y se marca `coverage = "partial"`.
 * - **Todas las raíces se EXCLUYEN del resultado**, incluso si son alcanzables
 *   desde otra raíz. Es lo que evita que una raíz se convierta en "objetivo".
 * - `fromRoots` guarda el conjunto de raíces que alcanzaron el PID. No cuenta
 *   rutas: el BFS por raíz ya da la unión. Dos raíces no relacionadas que
 *   alcanzan el mismo PID ⇒ `multi-root` y `coverage = "partial"`; si todas son
 *   comparables por ascendencia (`rootsFormChain`), no se informa.
 * - `root-missing` se informa por cada raíz sin fila; `parent-missing-relevant`
 *   solo si existen filas cuyo `ppid` es esa raíz.
 * - Los ciclos se detectan con estados de visita (en pila). Un nodo alcanzado
 *   por varias ramas NO es un ciclo.
 * - Los nodos repetidos por PID duplicado se recorren una sola vez, pero el PID
 *   queda listado en `pid-duplicated`.
 * - Un `ppid` inválido viene del parser como centinela `-1` (nunca `0`): esa
 *   fila queda sin relación de descendencia, así que la cobertura se degrada. No
 *   se añade una incidencia nueva: la registra el parser en el diagnóstico de su
 *   consulta.
 * - La cobertura también se degrada cuando la tabla está MALFORMADA: un PID
 *   duplicado (dos filas del mismo proceso con padres distintos) impide afirmar
 *   que el árbol se recorrió entero, aunque los descendientes encontrados se
 *   devuelvan igual.
 *
 * Degradar la cobertura NO autoriza ni bloquea terminaciones: este resultado es
 * SOLO DIAGNÓSTICO y ningún PID descubierto aquí se termina.
 */
export function transitiveDescendants(table: ProcessRow[], roots: number[]): DescendantsResult {
  const indexed = indexProcessTable(table);
  const issues: DescendantIssue[] = [];
  const descendants = new Set<number>();
  const rootsSet = new Set(roots);
  let coverage: DescendantsResult["coverage"] = "complete";

  for (const pid of indexed.duplicatePids) {
    issues.push({ kind: "pid-duplicated", pid });
    // Dos filas del mismo PID son una tabla malformada: no se puede afirmar
    // que se recorrieron todas las relaciones.
    coverage = "partial";
  }

  // Un `ppid` inválido viene del parser como `-1`: esa fila no se puede colgar
  // de ningún padre real (queda sin relación de descendencia), así que la
  // descendencia queda incompleta. Se degrada la cobertura SIN añadir una
  // incidencia nueva: el hecho ya lo registró el parser en su diagnóstico.
  for (const row of table) {
    if (row.ppid >= 0) continue;
    coverage = "partial";
    break;
  }

  /*
   * Índice ppid → hijos construido con TODAS las filas, incluidas las
   * duplicadas: un PID duplicado con padres distintos describe dos relaciones
   * reales y descartar una haría perder descendientes (y la anomalía multi-root).
   * Se deduplica por par (ppid, pid) para no repetir aristas.
   */
  const childrenOf = new Map<number, number[]>();
  const seenEdge = new Set<string>();
  for (const row of table) {
    const key = `${row.ppid}:${row.pid}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    const list = childrenOf.get(row.ppid);
    if (list === undefined) childrenOf.set(row.ppid, [row.pid]);
    else list.push(row.pid);
  }

  const fromRoots = new Map<number, Set<number>>();
  const cycles = new Set<number>();

  for (const root of [...new Set(roots)]) {
    if (!indexed.byPid.has(root)) {
      issues.push({ kind: "root-missing", pid: root });
      coverage = "partial";
      // Aun sin fila propia, puede tener hijos visibles en la tabla.
      if (childrenOf.has(root)) issues.push({ kind: "parent-missing-relevant", ppid: root });
    }

    /*
     * BFS por raíz con la PROFUNDIDAD de cada nodo. Un nodo que ya está a una
     * profundidad menor no se vuelve a recorrer (evita ciclos infinitos y
     * trabajo repetido). Un hijo que ya está en la cola a una profundidad
     * menor o igual es una arista de retroceso: **ciclo real**.
     */
    const depth = new Map<number, number>([[root, 0]]);
    const queue: number[] = [root];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      const currentDepth = depth.get(current) as number;

      for (const child of childrenOf.get(current) ?? []) {
        if (child === current) {
          if (!cycles.has(child)) {
            cycles.add(child);
            issues.push({ kind: "cycle", pid: child });
            coverage = "partial";
          }
          continue;
        }
        const reached = fromRoots.get(child);
        if (reached === undefined) fromRoots.set(child, new Set([root]));
        else if (!reached.has(root)) reached.add(root);

        if (!rootsSet.has(child)) descendants.add(child);

        const known = depth.get(child);
        if (known !== undefined && known <= currentDepth) {
          // Ya visitado a una profundidad menor: arista que cierra un ciclo.
          if (!cycles.has(child)) {
            cycles.add(child);
            issues.push({ kind: "cycle", pid: child });
            coverage = "partial";
          }
          continue;
        }
        if (known !== undefined) continue;
        depth.set(child, currentDepth + 1);
        queue.push(child);
      }
    }
  }

  // `multi-root`: el PID lo alcanzan dos o más raíces que NO forman cadena.
  for (const [pid, from] of fromRoots) {
    if (from.size < 2) continue;
    if (!rootsFormChain(table, [...from])) {
      issues.push({ kind: "multi-root", pid, roots: [...from] });
      coverage = "partial";
    }
  }

  // Una raíz nunca es descendiente de otra raíz, aunque la alcance.
  for (const root of rootsSet) descendants.delete(root);

  return { descendants: [...descendants], issues, coverage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Limpieza conservadora (solo por objeto ChildProcess del test actual)
// ─────────────────────────────────────────────────────────────────────────────

/** Por qué se rechazó un intento de terminación (nunca se intentó matar). */
export type TerminateRefusal =
  | "not-spawned"
  | "creation-timeout"
  | "creation-pending"
  | "invalid-pid"
  | "protected";

export interface TerminateResult {
  kind: "signalled" | "refused";
  refusal?: TerminateRefusal;
  /** Lo que devolvió `child.kill()`. NO confirma terminación. */
  killReturned?: boolean;
  errorCode?: string | null;
}

/**
 * Intenta terminar UNA entrada **por su objeto `ChildProcess`**.
 *
 * Precondiciones (todas obligatorias):
 *
 * 1. `creationState === "spawned"` — un `spawn-failed` nunca llega aquí.
 * 2. `creationWait === "settled-in-time"` — un `timed-out` es un superviviente
 *    tardío y NO se termina.
 * 3. `pid` numérico válido — si es `null`, el informe lo dirá.
 * 4. `pid` fuera de `ctx.protectedPids`.
 *
 * Un `false` o una excepción de `kill()` **no confirman** nada: se registran y,
 * si el proceso no emite `exit`/`close`, queda como `exit-unconfirmed`.
 */
export function terminateCaptured(entry: CapturedEntry, ctx: CleanupContext): TerminateResult {
  if (entry.creationState !== "spawned") return { kind: "refused", refusal: "not-spawned" };
  if (entry.creationWait === "timed-out") return { kind: "refused", refusal: "creation-timeout" };
  if (entry.creationWait === "pending") return { kind: "refused", refusal: "creation-pending" };
  if (entry.pid === null) return { kind: "refused", refusal: "invalid-pid" };
  if (ctx.protectedPids.has(entry.pid)) return { kind: "refused", refusal: "protected" };

  let returned: boolean | null = null;
  let errorCode: string | null = null;
  try {
    returned = entry.child.kill();
  } catch (error) {
    returned = false;
    errorCode = (error as NodeJS.ErrnoException).code ?? null;
  }
  entry.killAttempts.push({ monoMs: ctx.monoNow(), returned, errorCode });
  return { kind: "signalled", killReturned: returned === true, errorCode };
}

/** Resultado de una limpieza: cada hecho queda en su dimensión. */
export interface CleanupResult {
  /** PIDs sobre los que se llamó `kill()` (puede que no hayan muerto). */
  signalled: number[];
  /** Entradas cuyo `exit`/`close` se observó: terminación CONFIRMADA. */
  exitConfirmed: number[];
  /** Entradas señalizadas sin `exit`/`close` dentro del plazo. */
  exitUnconfirmed: number[];
  /** Entradas cuyo proceso no llegó a crearse (`spawn-failed` / sin crear). */
  deadBeforeIdentity: number[];
  /** Entradas con creación pendiente al vencer el plazo de espera. */
  creationPending: number[];
  /**
   * Entradas cuya espera de creación terminó en `timed-out`, sin importar qué
   * pasó después (evento tardío `spawn`, tardío `error` o ningún evento).
   *
   * Es un agregado **aditivo**: no quita una entrada de `creationPending`,
   * `survivorLateSpawn` ni `deadBeforeIdentity`. Sirve para ver el hecho del
   * plazo vencido aunque la clasificación de creación haya cambiado después.
   */
  creationTimedOut: number[];
  /** Supervivientes tardíos: llegaron después de un timeout; no se matan. */
  survivorLateSpawn: number[];
  /** Entradas sin PID válido o con el PID protegido. */
  refused: Array<{ pid: number | null; reason: TerminateRefusal }>;
  /** Errores de runtime posteriores a `spawn` (no afectan a la limpieza). */
  runtimeErrors: Array<{ code: string | null; count: number }>;
}

/**
 * Espera las salidas de todas las entradas de forma CONCURRENTE y global.
 *
 * Una sola espera para todas (no un plazo secuencial por hijo: `N × 2 s`
 * aplazaba el cierre y salía del teardown de Vitest). Los listeners ya estaban
 * instalados en `onCaptured()`, así que un evento pasado no se pierde. El plazo
 * siempre es finito.
 *
 * Los listeners que instala esta función (`once` de `exit` y `close`) son
 * **temporales** y se retiran al terminar, tanto por éxito como por timeout: un
 * `ChildProcess` vivo no acumula un par de listeners por cada limpieza. Los
 * listeners PERMANENTES de `onCaptured()` no se tocan.
 */
export function waitForAllCapturedExits(
  entries: CapturedEntry[],
  timeoutMs: number,
): Promise<{ exited: Set<CapturedEntry>; timedOut: Set<CapturedEntry> }> {
  const exited = new Set<CapturedEntry>();
  const timedOut = new Set<CapturedEntry>();
  const pending = entries.filter((entry) => !entry.exitSeen && !entry.closeSeen);
  for (const entry of entries) {
    if (entry.exitSeen || entry.closeSeen) exited.add(entry);
  }
  if (pending.length === 0) return Promise.resolve({ exited, timedOut });

  return new Promise((resolve) => {
    let remaining = pending.length;
    let done = false;
    /*
     * Solo las funciones instaladas aquí: son las únicas que se retiran. Se
     * guardan por entrada para poder hacer `off()` exacto (un `removeAllListeners`
     * borraría también los de `onCaptured()`).
     */
    const temporary = new Map<CapturedEntry, { onExit: () => void; onClose: () => void }>();
    const unsubscribe = (entry: CapturedEntry): void => {
      const handlers = temporary.get(entry);
      if (handlers === undefined) return;
      temporary.delete(entry);
      entry.child.off("exit", handlers.onExit);
      entry.child.off("close", handlers.onClose);
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const entry of [...temporary.keys()]) unsubscribe(entry);
      resolve({ exited, timedOut });
    };
    const timer = setTimeout(() => {
      for (const entry of pending) {
        if (!exited.has(entry)) timedOut.add(entry);
      }
      finish();
    }, timeoutMs);
    timer.unref?.();

    // Cada entrada se contabiliza UNA vez, aunque emita `exit` y `close`.
    for (const entry of pending) {
      const settle = (): void => {
        if (exited.has(entry) || timedOut.has(entry)) return;
        exited.add(entry);
        remaining -= 1;
        if (remaining === 0) finish();
      };
      if (entry.exitSeen || entry.closeSeen) {
        settle();
        continue;
      }
      const handlers = { onExit: settle, onClose: settle };
      temporary.set(entry, handlers);
      entry.child.once("exit", handlers.onExit);
      entry.child.once("close", handlers.onClose);
    }
  });
}

/**
 * Limpieza de las entradas capturadas del test actual.
 *
 * 1. Decide la creación de cada entrada pendiente (con su plazo monotónico).
 * 2. Intenta terminar SOLO las que cumplen todas las precondiciones.
 * 3. Espera, concurrente y acotado, los eventos `exit`/`close`.
 * 4. Clasifica cada entrada en sus dimensiones independientes.
 *
 * Nunca toca un PID de la tabla de procesos ni usa `process.kill(pid)` ni
 * `taskkill`. Un `kill()` que devuelve `true` sin evento posterior queda como
 * `exit-unconfirmed`; jamás se informa como éxito.
 */
export async function cleanupCaptured(ctx: CleanupContext): Promise<CleanupResult> {
  const startedAt = ctx.monoNow();
  const entries = [...captured.values()];

  diag("cleanup·objetivos", `entradas=${entries.length}`);
  for (const entry of entries) {
    if (entry.creationWait === "pending") await awaitCreation(entry, ctx);
  }

  diag("cleanup·señal", `entradas=${entries.length}`);
  const refused: CleanupResult["refused"] = [];
  for (const entry of entries) {
    // Un proceso que apareció tarde no se termina: se informa.
    if (entry.creationWait === "timed-out" && entry.creationState === "spawned") continue;
    const result = terminateCaptured(entry, ctx);
    if (result.kind === "refused") {
      refused.push({ pid: entry.pid, reason: result.refusal as TerminateRefusal });
    }
  }

  diag("cleanup·espera", `plazo=${ctx.exitTimeoutMs}`);
  const { timedOut } = await waitForAllCapturedExits(entries, ctx.exitTimeoutMs);

  const result = classifyAll(entries, timedOut);
  result.refused = refused;
  diag("cleanup·supervivientes", `confirmados=${result.exitConfirmed.length} sin-confirmar=${result.exitUnconfirmed.length}`, ctx.monoNow() - startedAt);
  diag("cleanup·fin", `entradas=${entries.length}`, ctx.monoNow() - startedAt);
  return result;
}

/**
 * Clasifica las entradas en agregados INDEPENDIENTES por dimensión.
 *
 * Cada hecho se conserva aunque la entrada ya figure en otro agregado. Una misma
 * entrada puede aparecer en varios agregados compatibles y ninguno la reemplaza:
 *
 * - `timed-out` + `spawn-failed`: `deadBeforeIdentity` (el proceso no existió),
 *   `creationPending` (la espera no cerró a tiempo) y `creationTimedOut` (el
 *   plazo venció).
 * - `timed-out` + `spawned`: `creationPending`, `creationTimedOut` y
 *   `survivorLateSpawn` (el proceso existe y no se termina).
 * - `pending` + `spawned`: `creationPending` (sin decisión de espera), más la
 *   dimensión de terminación según sus eventos.
 *
 * `creationPending` conserva su condición original para no cambiar ningún
 * veredicto de `cleanupSucceeded()`; `creationTimedOut` es diagnóstico.
 */
export function classifyAll(
  entries: CapturedEntry[],
  timedOut: Set<CapturedEntry> = new Set(),
): CleanupResult {
  const exitConfirmed: number[] = [];
  const exitUnconfirmed: number[] = [];
  const deadBeforeIdentity: number[] = [];
  const creationPending: number[] = [];
  const creationTimedOut: number[] = [];
  const survivorLateSpawn: number[] = [];
  const signalled: number[] = [];
  const runtimeErrorMap = new Map<string | null, number>();

  const push = (list: number[], pid: number | null): void => {
    // Un PID `null` (proceso sin PID válido) se cuenta con `0` como marcador
    // explícito de "sin PID": el hecho no se pierde aunque no haya número.
    const value = pid === null ? 0 : pid;
    if (!list.includes(value)) list.push(value);
  };

  for (const entry of entries) {
    const pid = entry.pid;

    // Dimensión creación (independiente de la espera y de la terminación).
    if (entry.creationState === "spawn-failed") push(deadBeforeIdentity, pid);
    if (entry.creationState !== "spawn-failed" && entry.creationWait !== "settled-in-time") {
      // Creación sin resultado (pendiente, o `spawn` observado sin la espera
      // hecha): es una incertidumbre de creación y no puede darse por éxito.
      push(creationPending, pid);
    }

    // Dimensión espera: el plazo venció, pase lo que pase después. ADITIVA: no
    // sustituye a ninguna otra categoría (un `spawn` tardío no la borra y un
    // `error` tardío tampoco).
    if (entry.creationWait === "timed-out") push(creationTimedOut, pid);

    // Superviviente tardío: timeout y, aun así, el proceso existe. Se informa
    // ADEMÁS de lo que diga la dimensión de terminación (nunca se señaliza).
    if (entry.creationWait === "timed-out" && entry.creationState === "spawned") {
      push(survivorLateSpawn, pid);
    }

    if (entry.killAttempts.length > 0) push(signalled, pid);

    // Dimensión terminación: SOLO los eventos confirman.
    if (entry.creationState === "spawned") {
      if (entry.exitSeen || entry.closeSeen) push(exitConfirmed, pid);
      else if (entry.killAttempts.length > 0 || timedOut.has(entry)) push(exitUnconfirmed, pid);
    }

    for (const error of entry.runtimeErrors) {
      runtimeErrorMap.set(error.code, (runtimeErrorMap.get(error.code) ?? 0) + 1);
    }
  }

  return {
    signalled,
    exitConfirmed,
    exitUnconfirmed,
    deadBeforeIdentity,
    creationPending,
    creationTimedOut,
    survivorLateSpawn,
    refused: [],
    runtimeErrors: [...runtimeErrorMap].map(([code, count]) => ({ code, count })),
  };
}

/** ¿La limpieza fue satisfactoria? Cualquier incertidumbre devuelve `false`. */
export function cleanupSucceeded(result: CleanupResult, enumerationError: string | null = null): boolean {
  return (
    enumerationError === null &&
    result.exitUnconfirmed.length === 0 &&
    result.creationPending.length === 0 &&
    result.survivorLateSpawn.length === 0 &&
    result.deadBeforeIdentity.length === 0 &&
    result.refused.every((item) => item.reason === "not-spawned")
  );
}

/** PIDs con `0` como marcador de "sin PID válido" (nunca un PID real). */
function formatPids(pids: number[]): string {
  return pids.map((pid) => (pid === 0 ? "sin-pid" : String(pid))).join(", ");
}

/** Resumen en español para hacer fallar el test con un motivo legible. */
export function describeCleanup(result: CleanupResult, enumerationError: string | null = null): string {
  const parts: string[] = [];
  if (enumerationError !== null) parts.push(`enumeración falló: ${enumerationError}`);
  if (result.exitUnconfirmed.length > 0) {
    parts.push(`sin confirmar salida: ${formatPids(result.exitUnconfirmed)}`);
  }
  if (result.survivorLateSpawn.length > 0) {
    parts.push(`supervivientes tardíos: ${formatPids(result.survivorLateSpawn)}`);
  }
  if (result.creationPending.length > 0) {
    parts.push(`creación pendiente: ${formatPids(result.creationPending)}`);
  }
  if (result.creationTimedOut.length > 0) {
    parts.push(`espera de creación vencida: ${formatPids(result.creationTimedOut)}`);
  }
  if (result.deadBeforeIdentity.length > 0) {
    parts.push(`no llegaron a crearse: ${formatPids(result.deadBeforeIdentity)}`);
  }
  const failures = result.refused.filter((item) => item.reason !== "not-spawned");
  if (failures.length > 0) {
    parts.push(
      `omitidos: ${failures.map((item) => `${item.pid ?? "sin-pid"} (${item.reason})`).join(", ")}`,
    );
  }
  if (result.runtimeErrors.length > 0) {
    parts.push(
      `errores de runtime: ${result.runtimeErrors.map((item) => `${item.code ?? "sin-código"}×${item.count}`).join(", ")}`,
    );
  }
  return parts.length === 0 ? "limpieza completa" : parts.join("; ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Compatibilidad con los llamadores E2E existentes
// ─────────────────────────────────────────────────────────────────────────────

export interface OwnTreeOptions {
  /** PIDs raíz que el test conserva (SOLO diagnóstico de descendientes). */
  roots?: number[];
  /** PIDs conocidos de antemano como ajenos. */
  extra?: number[];
}

export interface OwnTree {
  /** PIDs observados del test (SIN el proceso de test ni sus padres). */
  targets: number[];
  /** Procesos de la línea de padres: nunca se tocan. */
  protectedPids: number[];
  /** La instantánea con la que se calcularon los objetivos (diagnóstico). */
  table: ProcessRow[];
  /** Contrato de la cadena de ancestros (estructura e identidad). */
  chain: ProtectedChain;
  /** Descendientes transitivos de las raíces (solo observación). */
  descendants: DescendantsResult;
}

/**
 * Observa los procesos propios del test. **No termina nada.**
 *
 * `targets` es lo que se puede OBSERVAR como del test (hijos directos y
 * descendientes del proceso de test, más lo que el espía capturó), sin la línea
 * de padres. **Ningún PID de `targets` se señaliza**: la terminación solo va
 * por objetos `ChildProcess` capturados.
 *
 * Hace UNA consulta de procesos y devuelve esa misma tabla.
 */
export async function ownTree(options: OwnTreeOptions = {}): Promise<OwnTree> {
  const table = await processTable();
  const chain = protectedChain(table, process.pid);
  const white = new Set([...baseline, ...chain.pids, ...(options.extra ?? [])]);
  const targets = new Set<number>();

  // Lo que el espía capturó (por objeto) y no es de la lista blanca.
  for (const entry of captured.values()) {
    if (entry.pid !== null && !white.has(entry.pid)) targets.add(entry.pid);
  }

  const roots = [...new Set([process.pid, ...(options.roots ?? [])])];
  const descendants = transitiveDescendants(table, roots);
  for (const pid of descendants.descendants) {
    if (!white.has(pid)) targets.add(pid);
  }

  return {
    targets: [...targets],
    protectedPids: chain.pids,
    table,
    chain,
    descendants,
  };
}

export interface KillResult {
  killed: number[];
  /** Pids que siguen vivos después de la escalada (diagnóstico). */
  survivors: number[];
  /** La enumeración de procesos falló: no se puede afirmar la limpieza. */
  enumerationError: string | null;
  /** Resultado completo por dimensiones. */
  cleanup: CleanupResult;
  /** `true` solo si todo se confirmó (ni supervivientes ni incertidumbres). */
  ok: boolean;
  /** Motivo legible cuando `ok` es `false`. */
  detail: string;
}

/**
 * Limpieza del test actual por su interfaz histórica (los 4 archivos E2E).
 *
 * - `roots` se conserva por compatibilidad pero **ya no autoriza a matar un
 *   PID**: solo amplía el diagnóstico de descendientes. La terminación va por
 *   los objetos `ChildProcess` capturados.
 * - Hace UNA consulta de procesos (solo diagnóstico) y luego limpia.
 * - Devuelve `enumerationError` para que el test falle si no pudo observar, y
 *   `survivors`/`ok`/`detail` para que no se declare éxito gratuito.
 *
 * POLITICA DE IDENTIDAD PENDIENTE: el contrato previsto exige que la cadena de
 * ancestros sea `structurallyComplete` e `identityVerified` antes de limpiar.
 * Hoy esta función **no** lo exige: solo protege con `chain.pids` y la tabla de
 * procesos no trae `CreationDate`, así que `identityVerified` sería `false`. El
 * requisito NO se elimina ni se simula exigiendo un valor inalcanzable; queda
 * documentado como deuda hasta que la enumeración incluya la fecha de creación.
 */
export async function killOwnTree(options: OwnTreeOptions = {}): Promise<KillResult> {
  const ctx = createCleanupContext();
  const startedAt = Date.now();
  diagStart("cleanup");

  diagStart("cleanup·objetivos");
  const chain = protectedChain(await processTable(), process.pid);
  const enumerationError = processTableError();
  diag("cleanup·objetivos", `enumeracion=${enumerationError === null ? "ok" : "FALLO"}`, Date.now() - startedAt);
  // Se protege la línea de padres completa (sin límite de profundidad).
  ctx.protectedPids = new Set([process.pid, ...chain.pids]);

  diagStart("cleanup·señal");
  const cleanup = await cleanupCaptured(ctx);

  // Supervivientes: SOLO diagnóstico con `isAlive`, nunca una autorización.
  const survivors = [
    ...cleanup.exitUnconfirmed,
    ...cleanup.survivorLateSpawn,
    ...cleanup.refused
      .filter((item) => item.reason !== "not-spawned" && item.pid !== null && isAlive(item.pid as number))
      .map((item) => item.pid as number),
  ].filter((pid, index, all) => all.indexOf(pid) === index);

  const ok = cleanupSucceeded(cleanup, enumerationError);
  const detail = describeCleanup(cleanup, enumerationError);
  diag(
    "cleanup·fin",
    `senalados=${cleanup.signalled.length} confirmados=${cleanup.exitConfirmed.length} ` +
      `vivos=${survivors.length} enumeracion=${enumerationError === null ? "ok" : "FALLO"}`,
    Date.now() - startedAt,
  );
  return { killed: cleanup.signalled, survivors, enumerationError, cleanup, ok, detail };
}

/** Error de limpieza con la lista de sobrevivientes (para fallar el test). */
export async function describeSurvivors(survivors: number[]): Promise<string> {
  const table = await processTable();
  const detail = survivors
    .map((pid) => {
      const row = table.find((entry) => entry.pid === pid);
      return `${pid}${row ? ` (${row.cmd.slice(0, 120)})` : ""}`;
    })
    .join(", ");
  return `quedaron procesos del test vivos después de la limpieza: ${detail}`;
}

/** Pids hijos directos (diagnóstico, una consulta por llamada). */
export async function directChildren(pid: number): Promise<number[]> {
  return (await processTable()).filter((row) => row.ppid === pid).map((row) => row.pid);
}

/**
 * Espera **diagnóstica** de un PID (experimentos de tests).
 *
 * No verifica identidad: por eso devuelve solo un booleano de "existe o no" y
 * **no** autoriza nada. Su uso permitido es comprobar que un proceso propio del
 * test efectivamente murió.
 */
export async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

/**
 * Termina el árbol de un PID de un EXPERIMENTO de test (supervisor de
 * producción, `taskkill /T` en Windows) con plazo acotado.
 *
 * Está aquí solo para los tests que verifican el supervisor de la aplicación
 * (`killProcessTree`) y que crean procesos propios que conocen por su PID. NO se
 * usa en la limpieza: ese mecanismo termina por PID y el diseño de la limpieza
 * lo prohíbe explícitamente.
 */
export { killProcessTree };
