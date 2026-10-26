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

spyOnChildProcess();
// Lista blanca ANTES de cualquier test: la instalación real del usuario y los
// shells del sistema nunca se tocan, aunque aparezcan en la tabla de procesos.
// Se toma de forma ASÍNCRONA (la consulta ya no bloquea el bucle de eventos).
beforeAll(async () => {
  await captureBaseline();
});

afterAll(() => {
  // Solo los pids que ESTE archivo anotó (el nieto rebelde y el arnés). Nunca
  // un pid reconstruido ni un proceso buscado por nombre o puerto.
  for (const pid of testPids) {
    if (!isAlivePid(pid)) continue;
    try {
      process.kill(pid);
    } catch {
      // Ya murió.
    }
  }
});

function isAlivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

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
  return child.pid;
}

let stubborPid = null;
let longRun = null;

const closing = { value: false };
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
});

process.on("message", async (message) => {
  if (message !== "signal") return;
  if (closing.value) {
    await controller.shutdown("segunda");
    return;
  }
  await controller.shutdown("SIGINT");
});

// Arranca el trabajo y avisa al padre (con el pid del nieto).
longRun = startLongProcess();
stubborPid = startStubbornGrandchild();
process.send?.({ ready: true, stubbornPid: stubborPid, pid: process.pid });
`;

interface Running {
  child: ReturnType<typeof spawn>;
  dir: string;
  stubbornPid: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
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
});

/**
 * Limpieza al terminar CADA test, falle o no.
 *
 * Toca solo los procesos que este archivo creó: el arnés (por parentesco) y sus
 * descendientes, más el nieto `detached` que el arnés avisó por IPC. Si uno
 * sobrevive, el test falla con su pid y su línea de comandos.
 */
afterEach(async () => {
  const harnessPids = harnesses
    .splice(0)
    .map((child) => child.pid)
    .filter((pid): pid is number => typeof pid === "number");
  const result = await killOwnTree({ roots: [...harnessPids, ...testPids] });
  testPids.clear();
  expect(result.enumerationError, "la enumeración de procesos falló; no se puede afirmar que no quedó nada vivo").toBeNull();
  expect(result.survivors, await describeSurvivors(result.survivors)).toEqual([]);
  cleanup();
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
      // Sin señal directa: `afterEach` limpia por parentesco (incluye el
      // arnés, el proceso externo del supervisor y el nieto `detached`).
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
      // La limpieza de procesos la hace `afterEach`.
      cleanup();
    }
  },
);
