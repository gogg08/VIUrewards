/**
 * Prueba de INTEGRACIÓN del canal de control del LAUNCHER, con el launcher de
 * verdad (`scripts/dist/launcher-harness.ps1`, PowerShell) y el servidor real
 * (`scripts/start.ts`) como proceso hijo.
 *
 * Qué comprueba de verdad (cada punto pertenece a un test concreto):
 *
 *  1. El launcher abre el canal, recibe `accepted` y `started` (puerto y URL
 *     salen del canal, no de la consola) y el servidor queda accesible por HTTP.
 *  2. Una orden de cierre SIN el token NO cierra el servidor (sigue vivo y
 *     responde) y una orden CON el token inicia UNA sola secuencia: llegan
 *     `closing` y `finished` (código 0) y el proceso sale con código 0.
 *  3. Después del cierre la base temporal se puede reabrir (`openDatabase` +
 *     `SELECT` sobre `clips`) y el cerrojo compartido se liberó. Los puntos 1-3
 *     son del test «el launcher cierra ordenadamente por el canal y libera el
 *     cerrojo».
 *  4. Con otra instancia usando los MISMOS datos, el launcher recibe el código
 *     3, no manda ninguna orden de cierre y no toca el cerrojo ajeno (test «con
 *     los datos en uso…»).
 *
 * Lo mismo sobre el PAQUETE extraído (canal del launcher, cierre ordenado, cerrojo
 * y base reabrible) se comprueba en `scripts/dist/smoke.mjs` y en `npm run
 * test:dist`; acá no se duplica.
 *
 * Datos: todo vive en `mkdtempSync`. Nunca `data/`, `media/` ni `logs/` reales.
 * Los procesos que se crean son los de esta prueba y se limpian por parentesco
 * (ver `helpers/proc-tree.ts`): no se busca nada por puerto ni por nombre.
 *
 * NO corre con `npm test`. Se corre con: `npm run test:e2e`.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.ts";
import { SHARED_RESOURCES_LOCK_FILE } from "../../src/db/instance-lock.ts";
import {
  captureBaseline,
  describeSurvivors,
  killOwnTree,
  spyOnChildProcess,
} from "./helpers/proc-tree.ts";

captureBaseline();
spyOnChildProcess();

const IS_WINDOWS = process.platform === "win32";
const LAUNCHER = new URL("../../scripts/dist/launcher-harness.ps1", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const ENTRY = new URL("../../scripts/start.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const created: ChildProcess[] = [];
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "viu-e2e-launcher-"));
  roots.push(root);
  return root;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface LauncherResult {
  code: number | null;
  result: Record<string, unknown>;
  output: string;
}

/**
 * Ejecuta el launcher de prueba. Devuelve el JSON que imprime y su código de
 * salida (0 = flujo correcto o «datos en uso», 1 = fallo).
 */
async function runLauncher(
  args: string[],
  ms = 120_000,
): Promise<LauncherResult> {
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", LAUNCHER, ...args],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  created.push(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`el launcher no terminó en ${ms} ms:\n${output}`)), ms);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  // El resultado es el ÚLTIMO objeto JSON de la salida. Los mensajes del canal
  // también son JSON pero van en una sola línea, mientras que el resultado se
  // imprime indentado (con CRLF o LF): se busca el último bloque que abra con
  // llave en su propia línea y contenga "status".
  let result: Record<string, unknown> = {};
  const blocks = [...output.matchAll(/(\{\r?\n[\s\S]*?\r?\n\})/g)];
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block[1]) as Record<string, unknown>;
      if (typeof parsed.status === "string") {
        result = parsed;
        break;
      }
    } catch {
      // No era el objeto final: se sigue con el anterior.
    }
  }
  return { code, result, output };
}

async function waitForHttp(port: number, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`);
      if (response.ok) return true;
    } catch {
      // Todavía no escucha.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function cleanupRoots(): void {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows puede retener carpetas; no debe tapar el resultado.
    }
  }
}

afterEach(async () => {
  const pids = created
    .splice(0)
    .map((child) => child.pid)
    .filter((pid): pid is number => typeof pid === "number");
  const result = await killOwnTree({ roots: pids });
  expect(result.enumerationError, "la enumeración de procesos falló; no se puede afirmar que no quedó nada vivo").toBeNull();
  expect(result.survivors, describeSurvivors(result.survivors)).toEqual([]);
  cleanupRoots();
});

it.skipIf(!IS_WINDOWS)(
  "el launcher cierra ordenadamente por el canal y libera el cerrojo",
  { timeout: 180_000 },
  async () => {
    const root = makeRoot();
    const dataDir = join(root, "datos");
    mkdirSync(dataDir, { recursive: true });
    const port = await freePort();

    const { code, result, output } = await runLauncher([
      "-NodeExe",
      process.execPath,
      "-Entry",
      ENTRY,
      "-DataDir",
      dataDir,
      "-Port",
      String(port),
    ]);

    expect(result.status, output).toBe("closed");
    expect(result.accepted).toBe(true);
    expect(result.started).toBe(true);
    expect(result.closing).toBe(true);
    expect(result.finished).toBe(true);
    expect(result.finishedCode).toBe(0);
    // La orden SIN token se rechazó: el servidor siguió hasta la orden válida.
    expect(result.rejectedUnauthenticated).toBe(true);
    expect(result.orderedShutdown).toBe(true);
    expect(result.forcedKill).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.port).toBe(port);
    expect(code).toBe(0);

    // El cerrojo se liberó y la base temporal se puede reabrir. En modo
    // configurado el cerrojo vive DENTRO del directorio de datos.
    expect(existsSync(join(dataDir, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
    const db = openDatabase(join(dataDir, "app.db"));
    try {
      const row = db.prepare("SELECT COUNT(*) AS total FROM clips").get() as { total: number };
      expect(row.total).toBe(0);
    } finally {
      db.close();
    }
  },
);

it.skipIf(!IS_WINDOWS)(
  "con los datos en uso, el launcher sale con 3 y no toca el cerrojo ajeno",
  { timeout: 180_000 },
  async () => {
    const root = makeRoot();
    const dataDir = join(root, "datos");
    mkdirSync(dataDir, { recursive: true });
    const port = await freePort();

    // Primera instancia: el servidor real, arrancado con el runtime del test.
    const first = spawn(process.execPath, [ENTRY, `--port=${port}`], {
      cwd: root,
      env: { ...process.env, VIUREWARDS_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    created.push(first);
    expect(await waitForHttp(port)).toBe(true);

    // En modo configurado el cerrojo compartido vive dentro del directorio de
    // datos (no en la carpeta de la versión).
    const lockPath = join(dataDir, SHARED_RESOURCES_LOCK_FILE);
    expect(existsSync(lockPath)).toBe(true);
    const lockBefore = readFileSync(lockPath, "utf8");

    // Segunda instancia, por el launcher: debe recibir 3 sin mandar el cierre.
    const status = await runLauncher([
      "-NodeExe",
      process.execPath,
      "-Entry",
      ENTRY,
      "-DataDir",
      dataDir,
      "-Port",
      String(await freePort()),
      "-ExpectInUse",
      "-AllowExistingData",
    ]);

    expect(status.result.status, status.output).toBe("in-use");
    expect(status.result.exitCode).toBe(3);
    expect(status.result.orderedShutdown).toBe(false);
    expect(status.result.lockUnchanged).toBe(true);
    expect(status.code).toBe(0);

    // La primera sigue viva, sirviendo y con SU cerrojo intacto.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
    expect(await waitForHttp(port)).toBe(true);
  },
);
