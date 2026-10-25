#!/usr/bin/env node
/**
 * Arnés IPC del CIERRE ORDENADO (Fase de distribución, Etapa 2, Parte G).
 *
 * Por qué existe: en Windows, un proceso de Node que NO tiene una consola
 * interactiva no puede entregar SIGINT/SIGTERM/SIGBREAK a otro proceso. Se
 * verificó en este repo (ver `docs/distribution.md`):
 *
 *   - `child.kill("SIGTERM")` / `child.kill("SIGINT")` matan el hijo SIN que
 *     corran sus handlers.
 *   - `child.kill("SIGBREAK")` se traduce a `SIGKILL`.
 *   - `taskkill` sin `/F` falla («solo se puede terminar de forma forzada»).
 *
 * El cierre ordenado en Windows solo se ejerce con un Ctrl+C real de una consola
 * interactiva (prueba MANUAL) o —en automatización— desde adentro del propio
 * servidor. Eso es lo que hace este arnés.
 *
 * Qué hace, sin duplicar el apagado:
 *
 *  1. Toma los MISMOS argumentos que `scripts/start.ts` (`--port=`, `PORT`,
 *     `VIUREWARDS_DATA_DIR`, …).
 *  2. Aplica la MISMA secuencia de producción: `resolveRuntimePaths` →
 *     `prepareDataDir` → `acquireSharedResourcesLock` → `openDatabase` →
 *     limpieza de temporales → `reconcileClips` → `createServer` → `start` →
 *     `createShutdownController` (`server.stop()` + `closeDb` + `closeLog`),
 *     incluidos los handlers de SIGINT/SIGTERM/SIGBREAK.
 *  3. La única diferencia con producción es el canal de control: instala el
 *     canal del launcher (`src/server/control-channel.ts`) y acepta también el
 *     mensaje legacy de los tests (`{shutdown:true}`) por IPC. Los dos terminan
 *     en el MISMO `controller.shutdown(...)`: no hay una implementación de
 *     apagado alternativa.
 *
 * Habilitación explícita, solo para tests: el arnés exige
 * `VIUREWARDS_TEST_IPC_TOKEN` y un canal IPC (`process.send`). En el uso normal
 * nadie define esa variable ni lanza el servidor desde `fork`, así que la
 * interfaz no existe. El canal del launcher requiere además `--Control` y
 * `--Exchange`, que solo pasa el launcher.
 */

import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { openDatabase, reconcileClips } from "../../src/db/index.ts";
import { acquireInstanceLock, acquireSharedResourcesLock } from "../../src/db/instance-lock.ts";
import { SharedDataInUseError, SHARED_DATA_IN_USE_EXIT_CODE } from "../../src/db/instance-lock-error.ts";
import { cleanupOrphanTemporaries, openMediaDir } from "../../src/media/cleanup.ts";
import { FileMediaOperationJournal } from "../../src/media/pending-media.ts";
import { createClipRebuilder } from "../../src/media/rebuild.ts";
import { processSupervisor } from "../../src/media/run-process.ts";
import {
  INVALID_DATA_DIR_EXIT_CODE,
  InvalidDataDirError,
  legacyDataNotice,
  prepareDataDir,
  resolveRuntimePaths,
} from "../../src/server/paths.ts";
import { createServer } from "../../src/server/server.ts";
import { readSettings } from "../../src/server/settings.ts";
import { installControlChannel } from "../../src/server/control-channel.ts";
import { createShutdownController, DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../../src/server/shutdown.ts";

/** Variable que habilita el canal de control del arnés. */
const IPC_TOKEN_ENV = "VIUREWARDS_TEST_IPC_TOKEN";

/** Origen del cierre que llega por el mensaje legacy (`{shutdown:true}`). */
const HARNESS_SHUTDOWN_MESSAGE = "dist-ipc";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"];

function resolvePort(args, db) {
  const flag = args.find((arg) => arg.startsWith("--port="));
  const raw = flag ? flag.slice("--port=".length) : process.env.PORT;
  if (raw !== undefined) {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return readSettings(db).port;
}

async function main() {
  const token = process.env[IPC_TOKEN_ENV]?.trim() ?? "";
  const hasChannel = typeof process.send === "function";
  if (token.length === 0 || !hasChannel) {
    throw new Error(
      "El arnés IPC solo corre desde los tests de distribución: hace falta un canal IPC y " +
        `${IPC_TOKEN_ENV}. Para uso normal usá scripts/start.ts.`,
    );
  }

  const resolved = resolveRuntimePaths();
  if (!resolved.ok) throw new InvalidDataDirError(resolved.message);
  const paths = resolved.paths;
  if (paths.mode === "configured") {
    const prepared = prepareDataDir(paths.dataDir);
    if (!prepared.ok) throw new InvalidDataDirError(prepared.message);
  }
  for (const warning of paths.warnings) console.warn(`Aviso: ${warning}`);
  const legacyNotice = legacyDataNotice(paths);
  if (legacyNotice) console.warn(legacyNotice);

  // La MISMA exclusividad que producción, ANTES de abrir SQLite.
  const sharedLock = acquireSharedResourcesLock(paths.root, { path: paths.lockPath });
  if (!sharedLock.acquired) {
    throw new SharedDataInUseError(
      `${sharedLock.message} El arnés no arranca para no tocar los datos compartidos.`,
    );
  }

  let db;
  try {
    db = openDatabase(paths.dbPath);
  } catch (error) {
    sharedLock.release();
    throw error;
  }
  const lock = acquireInstanceLock(paths.dbPath);
  if (!lock.acquired) console.warn(`Aviso: ${lock.message}`);

  mkdirSync(paths.logsDir, { recursive: true });
  const startupEvidence = new FileMediaOperationJournal(paths.logsDir, { transient: true });
  const journal = new FileMediaOperationJournal(paths.logsDir);

  try {
    const opened = openMediaDir(paths.mediaDir);
    if (opened.ok) {
      cleanupOrphanTemporaries({
        mediaDir: paths.mediaDir,
        uploadsDir: paths.uploadsDir,
        db,
        hasExclusiveAccess: lock.acquired,
        journal: startupEvidence,
      });
    }
  } catch (error) {
    console.warn(`Aviso: la limpieza de temporales falló: ${error instanceof Error ? error.message : String(error)}`);
  }
  await reconcileClips(db, paths.mediaDir, {
    rebuild: createClipRebuilder({ mediaDir: paths.mediaDir, journal: startupEvidence }),
    evidence: true,
  });

  const server = await createServer({
    mediaDir: paths.mediaDir,
    db,
    port: resolvePort(process.argv.slice(2), db),
    processes: processSupervisor,
    uploadsDir: paths.uploadsDir,
    logDir: paths.logsDir,
    journal,
    media: { binDir: paths.binDir, nodeRuntime: paths.nodeRuntime },
  });

  let info;
  try {
    info = await server.start();
  } catch (error) {
    await server.stop().catch(() => undefined);
    closeDb();
    throw error;
  }

  let dbClosed = false;
  function closeDb() {
    if (dbClosed) return;
    dbClosed = true;
    lock.release();
    db.close();
    sharedLock.release();
  }

  // El test espera estas líneas: puerto real y cerrojo tomado.
  process.send?.({ ready: true, port: info.port, lockPath: paths.lockPath, pid: process.pid });

  let closing = null;
  /** @type {((outcome: { code: 0 | 1; message: string }) => void) | null} */
  let exitListener = null;
  const controller = createShutdownController({
    stop: () => server.stop({ timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS }),
    closeDb,
    closeLog: () => server.logger.close(),
    killProcesses: () => processSupervisor.killAllNow(),
    runningProcesses: () => processSupervisor.running().length,
    onBeforeExit: (outcome) => exitListener?.(outcome),
    log: (message) => {
      console.log(message);
      server.logger.info(message);
    },
  });

  // Canal del launcher: solo si el launcher pasó `--Control` y `--Exchange`.
  installControlChannel({
    requestShutdown: (reason) => controller.shutdown(reason),
    onBeforeExit: (listener) => {
      exitListener = listener;
    },
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    try {
      process.on(signal, () => {
        closing ??= controller.shutdown(signal);
        void closing;
      });
    } catch {
      // SIGBREAK no existe en todos los sistemas.
    }
  }

  // Mensaje legacy de los tests de distribución (IPC de `fork`): mismo cierre.
  process.on("message", (message) => {
    if (message && message.shutdown === true) {
      closing ??= controller.shutdown(HARNESS_SHUTDOWN_MESSAGE);
      void closing;
    }
  });
}

function isEntryPoint() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

async function run() {
  try {
    await main();
  } catch (error) {
    if (error instanceof SharedDataInUseError) {
      console.error(`No se puede arrancar VIUrewards: ${error.reason}`);
      process.exitCode = SHARED_DATA_IN_USE_EXIT_CODE;
    } else if (error instanceof InvalidDataDirError) {
      console.error(`No se puede arrancar VIUrewards: ${error.reason}`);
      process.exitCode = INVALID_DATA_DIR_EXIT_CODE;
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

// Solo se arranca si este archivo es el punto de entrada. Importarlo (tests) no
// abre la base ni levanta el servidor.
if (isEntryPoint()) await run();
