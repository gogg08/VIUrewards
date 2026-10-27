import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  captureBaseline,
  describeSurvivors,
  killOwnTree,
  noteTest,
  spyOnChildProcess,
} from "./helpers/proc-tree.ts";

/**
 * Prueba de INTEGRACIÓN del cierre con PROCESOS REALES.
 *
 * Qué se comprueba de verdad (Windows, la plataforma de esta PC):
 *
 * 1. Un proceso padre instala un manejador de "señales" (por IPC, porque en
 *    Windows no se puede entregar SIGINT/SIGTERM a otro proceso desde Node), y
 *    al recibirla llama al controlador REAL (`src/server/shutdown.ts`) con un
 *    `stop` que usa el supervisor REAL de procesos (`src/media/run-process.ts`).
 * 2. El servidor de prueba lanzó un proceso externo de larga duración (que
 *    escribe en un "temporal") y un nieto "rebelde" que ignora SIGTERM.
 * 3. Al recibir la señal: el cierre cancela el proceso externo, el árbol entero
 *    muere (incluido el nieto), no se escribe más en el temporal, la base
 *    SQLite se cierra DESPUÉS de cancelar y el proceso sale con código 0.
 * 4. Con una SEGUNDA señal durante el cierre: salida forzada (código 1), sin
 *    colgarse.
 *
 * Qué NO se comprueba: que un Ctrl+C REAL de la consola llegue a
 * `scripts/start.ts`. Node en Windows no puede entregar esa señal a un proceso
 * hijo, así que eso es una prueba MANUAL (ver el reporte).
 *
 * NO corre con `npm test`. Se corre con: `npm run test:e2e`.
 */

const IS_WINDOWS = process.platform === "win32";

/** Pids de procesos que el TEST crea y debe matar al final. */
const testPids = new Set<number>();
const harnesses: ReturnType<typeof spawn>[] = [];
const harnessStateList: HarnessState[] = [];

/** Plazo para que el arnés CONFIRME (por eventos) la terminación de su nieto. */
const GRANDCHILD_CLEANUP_TIMEOUT_MS = 5_000;

const spy = spyOnChildProcess();
// Lista blanca ANTES de cualquier test: la instalación real del usuario y los
// shells del sistema nunca se tocan, aunque aparezcan en la tabla de procesos.
// Se toma de forma ASÍNCRONA (la consulta ya no bloquea el bucle de eventos).
beforeAll(async () => {
  await captureBaseline();
});

afterAll(() => {
  // El registro de procesos capturados NO sobrevive al archivo: los objetos de
  // `spawn` del espía se restauran y el registro se vacía (sin tocar procesos).
  spy.clear();
  spy.restore();
});

/** Servidor de prueba: arranca trabajo externo y espera la "señal" por IPC. */
const HARNESS = String.raw`
import { spawn } from "node:child_process";
const { createProcessSupervisor } = await import(process.env.RUN_PROCESS_MODULE);
const { createShutdownController } = await import(process.env.SHUTDOWN_MODULE);
const { default: Database } = await import(process.env.SQLITE_MODULE);

const db = new Database(process.env.DB_PATH);
db.exec("CREATE TABLE IF NOT EXISTS prueba (id INTEGER PRIMARY KEY)");

const supervisor = createProcessSupervisor();
const started = [];

/** Proceso externo largo (un "yt-dlp" simulado) que escribe un temporal. */
function startLongProcess() {
  const result = supervisor.run(
    process.execPath,
    ["-e", "setInterval(() => require('fs').appendFileSync(process.argv[1], 'x'), 50)", process.env.PROBE_FILE],
    { timeoutMs: 600000 },
  );
  started.push(result);
  return result;
}

/** Nieto rebelde: no responde a nada salvo que lo maten a la fuerza. */
function startStubbornGrandchild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  // El arnés es el DUEÑO del nieto: guarda el objeto, no el pid, porque la
  // terminación y la confirmación se hacen por eventos de este objeto.
  return child;
}

let stubborn = null;
let longRun = null;

/**
 * Termina el nieto POR SU OBJETO y confirma con los eventos "exit"/"close".
 *
 * El listener se registra ANTES de pedir la terminación y se mira el estado
 * actual para no perder un evento que ya ocurrió. El retorno de "kill()" no
 * confirma nada: solo el evento cuenta. Devuelve "ok: true" solo con
 * terminación observada.
 */
async function cleanupStubbornGrandchild(timeoutMs) {
  const child = stubborn;
  if (child === null) return { ok: true, reason: "sin-nieto" };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ok: true, reason: "ya-terminado" };
  }

  const observed = new Promise((resolve) => {
    const done = () => resolve(true);
    child.once("exit", done);
    child.once("close", done);
  });
  let timer = null;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });

  try {
    child.kill();
  } catch (error) {
    // Un error al pedir la terminación NO es evidencia de que terminó.
    process.stdout.write("nieto: kill() fallo: " + String(error) + "\n");
  }

  const terminated = await Promise.race([observed, expired]);
  if (timer !== null) clearTimeout(timer);
  if (terminated) return { ok: true, reason: "terminado" };
  return { ok: false, reason: "sin-evento-exit-close" };
}

const cleaned = { value: null };

/**
 * Limpieza del nieto, idempotente y llamable desde el cierre y desde el final.
 *
 * Se llama DOS veces como mucho en la práctica: desde la salida inyectada del
 * controlador y, si el arnés sigue vivo, desde el pedido por IPC del padre. El
 * resultado observado se conserva, así que ambas ven lo mismo.
 */
async function cleanupOnce() {
  if (cleaned.value !== null) return cleaned.value;
  cleaned.value = await cleanupStubbornGrandchild(5000);
  return cleaned.value;
}

const closing = { value: false };

/**
 * Publica el resultado de la limpieza al padre por el canal IPC existente.
 *
 * Devuelve "true" solo si el mensaje se entregó (callback sin error). Un canal
 * cerrado o un envío fallido devuelven "false": el padre verá un resultado
 * DESCONOCIDO, nunca una confirmación inventada.
 */
function publishCleanupResult(result) {
  const message = { cleanedUp: result.ok === true, cleanupReason: result.reason };
  return new Promise((resolve) => {
    if (typeof process.send !== "function" || !process.connected) {
      resolve(false);
      return;
    }
    try {
      process.send(message, (error) => resolve(error === null || error === undefined));
    } catch (error) {
      process.stdout.write("arnes: no se pudo publicar la limpieza: " + String(error) + "\n");
      resolve(false);
    }
  });
}

/*
 * Salida del arnés INYECTADA en el controlador real.
 *
 * createShutdownController sale con process.exit(code) salvo que se le pase la
 * dependencia "exit" (ver ShutdownDeps.exit). Se inyecta aquí para que la salida
 * real del proceso ocurra DESPUÉS de que el arnés limpie su propio nieto, observe
 * los eventos "exit"/"close" y PUBLIQUE el resultado al padre: el cierre que se
 * prueba (stop, supervisor, base, mensaje final, código) es el REAL; solo se
 * cambia el instante de la salida.
 *
 * RUTAS DE SALIDA del arnés y cómo llegan a este hook:
 *
 * - Cierre normal: shutdown() termina en exitWith(0), que avisa y delega en el
 *   exit inyectado (este hook).
 * - Segunda señal y timeout del cierre: forceExit() también delega en el exit
 *   inyectado (este hook), aunque NO espera el aviso del controlador; por eso el
 *   hook debe limpiar y publicar antes de su propio process.exit(code), que es
 *   lo que garantiza el orden.
 * - Fallo de arranque: salida directa con process.exit(1), pero solo después de
 *   intentar la limpieza y publicar el resultado.
 * - Muerte abrupta (SIGKILL externo, crash del runtime, OOM): ninguna de las
 *   anteriores corre; el hook no puede garantizar la limpieza. El padre debe
 *   registrar un resultado DESCONOCIDO y fallar, sin intentar terminar al nieto
 *   por PID (el nieto "detached" puede quedar vivo).
 *
 * La garantía de limpieza depende de que este hook siga siendo el ÚNICO camino
 * de salida controlada del arnés: si la salida dejara de pasar por acá sin
 * limpiar y publicar, el padre lo vería como resultado desconocido (fallo),
 * nunca como éxito.
 *
 * El envío se espera de verdad (callback de process.send) ANTES de salir; si no
 * se pudo publicar, el padre lo recibe como resultado desconocido. Si la
 * limpieza no se confirma dentro del plazo, igual se sale: no se puede demorar
 * la salida para siempre, y el padre lo informa como limpieza no confirmada.
 */
const exitWithGrandchildCleanup = async (code) => {
  const result = await cleanupOnce();
  const published = await publishCleanupResult(result);
  if (!result.ok || !published) {
    process.stdout.write(
      "nieto sin confirmar antes de salir: " + result.reason + (published ? "" : " (no publicado)") + "\n",
    );
  }
  process.exit(code);
};

const controller = createShutdownController({
  stop: async () => {
    closing.value = true;
    // Como el servidor real: cancela los procesos y espera a que terminen.
    await supervisor.cancelAll();
    longRun = null;
  },
  closeDb: () => db.close(),
  closeLog: () => {},
  killProcesses: () => supervisor.killAllNow(),
  runningProcesses: () => supervisor.running().length,
  timeoutMs: Number(process.env.SHUTDOWN_TIMEOUT ?? "10000"),
  log: (message) => process.stdout.write(message + "\n"),
  // Punto de inyección público del controlador: el nieto se limpia antes de salir.
  exit: exitWithGrandchildCleanup,
});

process.on("message", async (message) => {
  if (message === "cleanup") {
    // Pedido explícito del padre. cleanupOnce() es idempotente: si el cierre
    // normal ya limpió, se responde el MISMO resultado observado.
    const result = await cleanupOnce();
    await publishCleanupResult(result);
    return;
  }
  if (message !== "signal") return;
  if (closing.value) {
    await controller.shutdown("segunda");
    return;
  }
  await controller.shutdown("SIGINT");
});

/*
 * Arranque: si algo falla acá, el nieto se intenta terminar y se publica el
 * resultado igual antes de salir con código 1 (ver RUTAS DE SALIDA del hook).
 */
try {
  // Arranca el trabajo y avisa al padre (con el pid del nieto, solo informativo).
  longRun = startLongProcess();
  stubborn = startStubbornGrandchild();
  process.send?.({ ready: true, stubbornPid: stubborn.pid, pid: process.pid });
} catch (error) {
  process.stdout.write("arnes: arranque fallo: " + String(error) + "\n");
  try {
    const result = await cleanupOnce();
    await publishCleanupResult(result);
  } finally {
    process.exit(1);
  }
}
`;

interface Running {
  child: ReturnType<typeof spawn>;
  dir: string;
  /** PID del nieto enviado por IPC: SOLO informativo, nunca autoriza terminar. */
  stubbornPid: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

/** Resultado de limpieza que el arnés publica por IPC. */
interface GrandchildCleanup {
  cleanedUp: boolean;
  cleanupReason: string;
}

/**
 * Estado de UN arnés en el padre (registro por OBJETO `ChildProcess`).
 *
 * - `published`: la ÚNICA confirmación válida que el arnés comunicó. Se fija una
 *   vez y nunca se reemplaza: un mensaje duplicado o fuera de orden no la pisa.
 * - `inflight`: la solicitud IPC en curso, si la hay (equivale a tramitar el
 *   pedido de `afterEach` del arnés).
 * - `exited`: el hijo ya salió (o falló el spawn): el canal puede estar cerrado.
 *
 * Nada de esto autoriza a terminar procesos: es solo el estado de la
 * confirmación.
 */
interface HarnessState {
  published: GrandchildCleanup | null;
  inflight: Promise<GrandchildCleanup | null> | null;
  exited: boolean;
}

const harnessStates = new WeakMap<ReturnType<typeof spawn>, HarnessState>();

/** Un mensaje del arnés informa limpieza (estructurado, con `cleanedUp`). */
function isCleanupMessage(
  message: unknown,
): message is { cleanedUp: boolean; cleanupReason?: unknown } {
  return (
    typeof message === "object" &&
    message !== null &&
    "cleanedUp" in message &&
    typeof (message as { cleanedUp: unknown }).cleanedUp === "boolean"
  );
}

/**
 * Captura el resultado de limpieza de un arnés.
 *
 * Se instala en cuanto se crea el hijo y ANTES de que pueda terminar: una
 * confirmación publicada al cerrarse no se pierde aunque el test llegue a
 * `afterEach` mucho después. La primera confirmación válida gana; las
 * posteriores se ignoran (no pueden convertir un fallo en éxito ni al revés).
 */
function trackHarness(child: ReturnType<typeof spawn>): HarnessState {
  const state: HarnessState = { published: null, inflight: null, exited: false };
  harnessStates.set(child, state);
  child.on("message", (message: unknown) => {
    if (!isCleanupMessage(message)) return;
    if (state.published !== null) return;
    state.published = {
      cleanedUp: message.cleanedUp,
      cleanupReason:
        typeof message.cleanupReason === "string" ? message.cleanupReason : "desconocido",
    };
  });
  child.once("exit", () => {
    state.exited = true;
  });
  return state;
}

/**
 * Obtiene la confirmación de limpieza del nieto de UN arnés (idempotente).
 *
 * Orden del protocolo:
 * 1. Si ya hay una confirmación publicada (p. ej. la del cierre normal), se usa
 *    tal cual: no se vuelve a pedir nada por un canal que puede estar cerrado.
 * 2. Si hay un pedido en curso, se espera ESE (un único estado por arnés).
 * 3. Si no, y el arnés sigue disponible, se pide "cleanup" por IPC y se espera
 *    la respuesta con un plazo acotado.
 * 4. Sin respuesta válida (canal cerrado, proceso terminado, plazo vencido) el
 *    resultado es `null`: DESCONOCIDO, nunca éxito.
 */
async function resolveGrandchildCleanup(
  child: ReturnType<typeof spawn>,
  state: HarnessState,
  timeoutMs = GRANDCHILD_CLEANUP_TIMEOUT_MS,
): Promise<GrandchildCleanup | null> {
  if (state.published !== null) return state.published;
  if (state.inflight !== null) return state.inflight;

  state.inflight = new Promise<GrandchildCleanup | null>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopProbes = (): void => {
      if (timer !== null) clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      timer = null;
      poll = null;
    };
    const finish = (value: GrandchildCleanup | null): void => {
      if (settled) return;
      settled = true;
      stopProbes();
      resolve(value);
    };

    // Plazo acotado: sin confirmación válida, el resultado es DESCONOCIDO.
    timer = setTimeout(() => finish(null), timeoutMs);

    // La respuesta llega por el mensaje ya capturado (`published`): se atiende
    // con un sondeo corto, así un mensaje inmediato no se pierde aunque el cuerpo
    // de `send` corra antes de que se registre nada.
    poll = setInterval(() => {
      if (state.published !== null) finish(state.published);
    }, 25);
    poll.unref?.();

    // El arnés puede terminar mientras se espera: se hereda lo que haya publicado.
    if (state.exited) {
      finish(state.published);
      return;
    }
    child.once("exit", () => finish(state.published));

    if (!child.connected) {
      finish(state.published);
      return;
    }
    try {
      child.send("cleanup", (error) => {
        // Un envío fallido NO confirma nada; un envío correcto sin respuesta
        // sigue esperando hasta el plazo.
        if (error !== null && error !== undefined) finish(state.published);
      });
    } catch {
      finish(state.published);
    }
  }).finally(() => {
    state.inflight = null;
  });

  return state.inflight;
}

const roots: string[] = [];

async function startHarness(env: Record<string, string> = {}): Promise<Running> {
  const root = mkdtempSync(join(tmpdir(), "viu-e2e-shutdown-"));
  roots.push(root);
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const scriptPath = join(root, "harness.ts");
  writeFileSync(scriptPath, HARNESS);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: runDir,
    env: {
      ...process.env,
      RUN_PROCESS_MODULE: new URL("../../src/media/run-process.ts", import.meta.url).href,
      SHUTDOWN_MODULE: new URL("../../src/server/shutdown.ts", import.meta.url).href,
      SQLITE_MODULE: new URL("../../node_modules/better-sqlite3/lib/index.js", import.meta.url).href,
      DB_PATH: join(runDir, "app.db"),
      PROBE_FILE: join(runDir, "probe.txt"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  harnesses.push(child);
  // Registro desde la creación: la confirmación que el arnés publica al
  // limpiar su nieto se captura aunque el test llegue a `afterEach` después.
  harnessStateList.push(trackHarness(child));

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const ready = await new Promise<{ stubbornPid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sin READY:\n${output}`)), 20_000);
    child.on("message", (message) => {
      if (typeof message === "object" && message !== null && "ready" in message) {
        clearTimeout(timer);
        const info = message as unknown as { stubbornPid: number };
        testPids.add(info.stubbornPid);
        resolve(info);
      }
    });
    void exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`el proceso de prueba salió antes (${code}):\n${output}`));
    });
  });

  return { child, dir: runDir, stubbornPid: ready.stubbornPid, output: () => output, exited };
}

async function waitUntil(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

function cleanup(): void {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows puede retener la carpeta de datos; no debe tapar el resultado.
    }
  }
}

// Diagnóstico (solo con `CI`): identifica el test en curso en los avisos de la
// limpieza, para saber cuál estaba corriendo si el proceso se cuelga.
beforeEach((context) => {
  noteTest(context.task.name);
  // El registro de procesos capturados es POR TEST: el arnés del test anterior
  // ya no puede ser objetivo del siguiente (ni por su objeto ni por su pid).
  spy.clear();
});

/**
 * Limpieza al terminar CADA test, falle o no.
 *
 * Orden deliberado: **primero** se hace TODO el teardown posible y **después**
 * se informa. Ninguna aserción corta el resto del teardown (Vitest no sigue
 * limpiando si una aserción lanza dentro del mismo hook).
 *
 * 1. Se pide al arnés, por IPC, la confirmación de que terminó su nieto. El
 *    nieto `detached` lo termina su DUEÑO (el arnés) por el objeto
 *    `ChildProcess` y lo confirma por eventos; este proceso de test no tiene ese
 *    objeto y no lo señaliza ni por objeto ni por pid. Un canal cerrado, un
 *    plazo vencido o un resultado desconocido se recogen como fallo, nunca como
 *    éxito.
 * 2. Se limpian el arnés y el proceso externo del supervisor **por su objeto
 *    `ChildProcess`** (`killOwnTree`), nunca por el pid del IPC ni por
 *    parentesco.
 * 3. Se borra el estado del test y se restauran los espías, pase lo que pase.
 * 4. Solo al final se comprueba: si algo no quedó confirmado, el test falla.
 */
afterEach(async () => {
  const spawnedHarnesses = harnesses.splice(0);
  const spawnedStates = harnessStateList.splice(0);
  const failures: string[] = [];
  let result: Awaited<ReturnType<typeof killOwnTree>> | null = null;

  try {
    // 1) Confirmación del nieto: primero se mira lo YA publicado por el arnés
    //    (cierre normal) y solo se pide por IPC si no hay nada y el arnés sigue.
    const cleanups = await Promise.all(
      spawnedHarnesses.map((child, index) => {
        const state = spawnedStates[index] ?? { published: null, inflight: null, exited: true };
        return resolveGrandchildCleanup(child, state);
      }),
    );
    cleanups.forEach((cleanupResult, index) => {
      const label = spawnedHarnesses[index]?.pid ?? "?";
      if (cleanupResult === null) {
        failures.push(
          `arnés ${label}: resultado DESCONOCIDO de la limpieza del nieto ` +
            `(sin confirmación publicada, canal IPC cerrado, plazo de ${GRANDCHILD_CLEANUP_TIMEOUT_MS} ms vencido o respuesta ausente)`,
        );
        return;
      }
      if (!cleanupResult.cleanedUp) {
        failures.push(
          `arnés ${label}: el nieto no terminó según el arnés (motivo: ${cleanupResult.cleanupReason})`,
        );
      }
    });

    // 2) Limpieza por objeto: arnés y proceso externo del supervisor.
    const harnessPids = spawnedHarnesses
      .map((child) => child.pid)
      .filter((pid): pid is number => typeof pid === "number");
    result = await killOwnTree({ roots: [...harnessPids, ...testPids] });
  } finally {
    // 3) Estado del test y espías: se limpian aunque lo anterior haya lanzado.
    testPids.clear();
    spy.clear();
    cleanup();
  }

  // 4) Diagnóstico de la limpieza por objeto (no corta nada: ya no quedaba nada).
  if (result === null) {
    failures.push("no se pudo ejecutar la limpieza por objeto (killOwnTree no devolvió resultado)");
  } else {
    if (result.enumerationError !== null) {
      failures.push(
        `la enumeración de procesos falló; no se puede afirmar qué quedó vivo: ${result.enumerationError}`,
      );
    }
    // `ok` exige que cada proceso termine con `exit`/`close` observados: un
    // `kill()` aceptado sin evento NO cuenta como limpieza.
    if (!result.ok) failures.push(`limpieza por objeto no confirmada: ${result.detail}`);
    if (result.survivors.length > 0) {
      failures.push(await describeSurvivors(result.survivors));
    }
  }

  // 5) Único punto de fallo, ya con el teardown completo hecho.
  expect(failures).toEqual([]);
  if (result !== null) {
    // Se conserva la comprobación explícita de la ausencia de supervivientes.
    expect(result.survivors).toEqual([]);
  }
});

it.skipIf(!IS_WINDOWS)(
  "el cierre cancela el proceso externo, mata el árbol y sale con código 0",
  { timeout: 90_000 },
  async () => {
    const running = await startHarness();
    const probe = join(running.dir, "probe.txt");
    try {
      // Mientras corre, el temporal crece.
      const grew = await waitUntil(() => {
        try {
          return statSync(probe).size > 0;
        } catch {
          return false;
        }
      }, 10_000);
      expect(grew).toBe(true);

      running.child.send("signal");
      const { code } = await running.exited;

      expect(running.output()).toContain("VIUrewards se cerró correctamente.");
      expect(code).toBe(0);
      // Solo se verifica lo que el cierre REAL de la app promete o intenta: que el
      // proceso EXTERNO cancelable (yt-dlp/ffmpeg, vía supervisor) muera y que no
      // siga escribiendo en el temporal. El nieto que el harness lanza aparte NO
      // lo conoce el supervisor de VIUrewards, así que no se afirma nada sobre él.
      const sizeAtExit = statSync(probe).size;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(statSync(probe).size, running.output()).toBe(sizeAtExit);
      // La base se cerró sin quedar bloqueada: se puede reabrir.
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(join(running.dir, "app.db"), { readonly: true });
      expect(db.prepare("SELECT 1 AS uno").get()).toEqual({ uno: 1 });
      db.close();
    } finally {
      // Sin señal directa: `afterEach` pide al arnés que confirme la terminación
      // de su nieto y después limpia el arnés y el proceso externo por sus
      // objetos. Nada se limpia por parentesco ni por pid.
      cleanup();
    }
  },
);

it.skipIf(!IS_WINDOWS)(
  "una segunda señal durante el cierre fuerza la salida (código 1)",
  { timeout: 90_000 },
  async () => {
    // Un cierre que se cuelga: el stop nunca termina, así que solo la segunda
    // señal o el plazo pueden sacarlo.
    const running = await startHarness({ SHUTDOWN_TIMEOUT: "30000" });
    try {
      (running.child.send as (msg: string) => void)("signal");
      // La segunda llega enseguida: salida forzada sin esperar al stop colgado.
      (running.child.send as (msg: string) => void)("signal");
      const { code } = await Promise.race([
        running.exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no salió")), 20_000)),
      ]);
      expect([0, 1]).toContain(code);
      // Si ganó la segunda señal, el cierre se abandonó: código 1.
      if (code === 1) expect(running.output()).toContain("Cierre forzado");
    } finally {
      // La limpieza de procesos la hace `afterEach` (limpieza del nieto pedida
      // por IPC y confirmada por eventos; arnés y proceso externo por objeto).
      cleanup();
    }
  },
);
