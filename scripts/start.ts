#!/usr/bin/env node
/**
 * Arranque completo del producto (Fase 3).
 *
 * Levanta API, dashboard, overlay y WebSocket en un solo proceso. Es el único
 * comando que necesita el usuario final:
 *
 *   npm start
 *
 * Opciones: `--port=8787` (o la variable de entorno PORT).
 *
 * Ciclo de vida (cierre ordenado):
 *
 * - La **primera** señal (SIGINT, SIGTERM o SIGBREAK en Windows) inicia UNA
 *   única secuencia de cierre: se deja de aceptar trabajo, se detiene el polling
 *   de Kick, se cancelan de verdad las descargas/conversiones (yt-dlp/ffmpeg),
 *   se limpian esperas y timers, se cierran los overlays y el HTTP, y recién al
 *   final la base y el log. Si todo sale bien: código 0.
 * - Una **segunda** señal durante el cierre fuerza la salida (código 1): mata
 *   los procesos externos vivos sin esperar y sale.
 * - Un plazo duro (`SHUTDOWN_TIMEOUT_MS`, 10 s) limita el cierre: si vence, se
 *   registra y se fuerza la salida (código 1).
 *
 * Exclusividad: una sola instancia por conjunto de datos. El cerrojo de la
 * raíz de recursos compartidos (`.viurewards.lock`, ver
 * `acquireSharedResourcesLock`) se toma ANTES de abrir la base; si falta, el
 * arranque termina con `SharedDataInUseError` (código 3) sin abrir SQLite, sin
 * reconciliar y sin levantar el servidor.
 *
 * Rutas (Fase de distribución, Etapa 1): todas las rutas MUTABLES las resuelve
 * `resolveRuntimePaths` (`src/server/paths.ts`), el único lugar que lee
 * `VIUREWARDS_DATA_DIR`. Sin la variable se conserva la distribución histórica
 * (todo bajo el directorio de trabajo); con la variable, base, medios, uploads,
 * logs y `bin/` viven dentro del directorio de datos y el cerrojo se toma ahí.
 * Los recursos estáticos del servidor no dependen de esta configuración.
 *
 * Este archivo es el **dueño** de la base y del logger: `AppServer.stop()` no
 * los cierra (los tests y otros consumidores comparten ese método sin ser dueños
 * de la base). Se cierran acá, en ese orden y una sola vez.
 */

import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { openDatabase, reconcileClips, type SqliteDatabase } from "../src/db/index.ts";
import { acquireInstanceLock, acquireSharedResourcesLock, type InstanceLock } from "../src/db/instance-lock.ts";
import { SharedDataInUseError, SHARED_DATA_IN_USE_EXIT_CODE } from "../src/db/instance-lock-error.ts";
import { cleanupOrphanTemporaries, openMediaDir } from "../src/media/cleanup.ts";
import { FileMediaOperationJournal } from "../src/media/pending-media.ts";
import { createClipRebuilder } from "../src/media/rebuild.ts";
import { processSupervisor } from "../src/media/run-process.ts";
import {
  INVALID_DATA_DIR_EXIT_CODE,
  InvalidDataDirError,
  describePaths,
  legacyDataNotice,
  prepareDataDir,
  resolveRuntimePaths,
  type RuntimePaths,
} from "../src/server/paths.ts";
import { createServer } from "../src/server/server.ts";
import { readSettings } from "../src/server/settings.ts";
import { createShutdownController, DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../src/server/shutdown.ts";

/**
 * Limpieza de temporales huérfanos de ejecuciones anteriores.
 *
 * Corre ANTES de crear el servidor (que crea `.uploads/` y `logs/` igual, así
 * que las carpetas son las mismas) y solo con exclusividad de instancia: otra
 * copia abierta por error podría estar usando un temporal reciente. El orden es
 * importante: primero se limpia lo que quedó de un cierre abrupto y recién
 * después se reconstruye la biblioteca, para que una salida de conversión
 * interrumpida no se importe como clip.
 *
 * Nunca impide arrancar: todo se registra y se sigue.
 */
export function runStartupCleanup(
  db: SqliteDatabase,
  mediaDir: string,
  uploadsDir: string,
  journal: FileMediaOperationJournal,
  hasExclusiveAccess: boolean,
): void {
  try {
    const opened = openMediaDir(mediaDir);
    if (!opened.ok) {
      console.warn(`Aviso: ${opened.message}`);
      return;
    }
    const result = cleanupOrphanTemporaries({
      mediaDir,
      uploadsDir,
      db,
      hasExclusiveAccess,
      journal,
    });
    for (const kept of result.kept) {
      if (kept.reason.startsWith("Pertenece a un clip registrado")) continue;
      console.log(`Limpieza: se conservó ${kept.name} (${kept.reason})`);
    }
    // Diagnóstico compacto de la evidencia de arranque (sin datos sensibles).
    console.log(
      `Limpieza: evidencia de arranque: ${journal.entries().map((entry) => `${entry.kind} ${entry.key}`).join(", ") || "ninguna"}`,
    );
    for (const failure of result.errors) {
      console.warn(`Aviso: no se pudo eliminar ${failure.name}; se conserva.`);
    }
  } catch (error) {
    // La limpieza es best-effort: un fallo acá no puede impedir arrancar.
    console.warn(`Aviso: la limpieza de temporales falló: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Controlador del cierre ordenado.
 *
 * Vive en `src/server/shutdown.ts` (no acá) para que los tests lo importen sin
 * ejecutar el arranque real. Se re-exporta para quien use este punto de entrada.
 */
export { createShutdownController, type ShutdownController } from "../src/server/shutdown.ts";

/** Señales que inician el cierre ordenado (SIGBREAK es el Ctrl+Break de Windows). */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK"];

function resolvePort(args: string[], db: SqliteDatabase): number {
  const flag = args.find((arg) => arg.startsWith("--port="));
  const raw = flag ? flag.slice("--port=".length) : process.env.PORT;
  if (raw !== undefined) {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return readSettings(db).port;
}

async function main(): Promise<void> {
  // Rutas mutables: resueltas ANTES de tocar nada (cerrojo, base, carpetas). Una
  // configuración inválida sale con `InvalidDataDirError` (código 2) y sin
  // inicializar en otra carpeta. Sin `VIUREWARDS_DATA_DIR` esto devuelve
  // exactamente las rutas históricas bajo el directorio de trabajo.
  const resolved = resolveRuntimePaths();
  if (!resolved.ok) throw new InvalidDataDirError(resolved.message);
  const paths: RuntimePaths = resolved.paths;

  // En modo configurado el directorio de datos puede no existir todavía; se crea
  // (con `bin/` y `logs/`) antes del cerrojo, para que un problema de permisos se
  // informe como tal y no como "datos en uso". En modo heredado no se crea nada
  // nuevo: `logs/` y `.uploads/` los crea el arranque como siempre.
  if (paths.mode === "configured") {
    const prepared = prepareDataDir(paths.dataDir);
    if (!prepared.ok) throw new InvalidDataDirError(prepared.message);
  }

  for (const warning of paths.warnings) console.warn(`Aviso: ${warning}`);

  // Aviso si se configuró un directorio externo vacío y quedó una base anterior
  // en la ubicación heredada: no se mueve ni se copia nada, solo se avisa.
  const legacyNotice = legacyDataNotice(paths);
  if (legacyNotice) console.warn(legacyNotice);

  const mediaDir = paths.mediaDir;
  const dataDir = paths.dataDir;
  const logsDir = paths.logsDir;
  const uploadsDir = paths.uploadsDir;

  // Exclusividad sobre los RECURSOS COMPARTIDOS (la raíz con `media/`,
  // `.uploads/` y `logs/`), ANTES de abrir la base: dos copias con `data/`
  // distintos pero el mismo `media/` competirían por la biblioteca y por
  // SQLite. Si falta, se sale sin tocar nada (ni base, ni reconciliación, ni
  // servidor) y sin liberar el cerrojo ajeno: `acquireInstanceLock` solo borra
  // el archivo que creó esta instancia.
  //
  // En modo configurado la raíz es el directorio de datos persistente, así que el
  // cerrojo no queda en una carpeta de versión que se reemplaza al actualizar.
  const sharedLock = acquireSharedResourcesLock(paths.root, {
    path: paths.lockPath,
    log: (message) => console.warn(`Aviso: ${message}`),
  });
  if (!sharedLock.acquired) {
    throw new SharedDataInUseError(
      `${sharedLock.message} Cerrá esa copia antes de abrir una nueva; esta instalación no va a arrancar para no tocar los datos compartidos.`,
    );
  }

  let db: SqliteDatabase;
  try {
    db = openDatabase(paths.dbPath);
  } catch (error) {
    // La base no se abrió: el cerrojo de esta instancia igual se libera.
    sharedLock.release();
    throw error;
  }

  // Segundo cerrojo (dentro de `data/`): diagnóstico de la carpeta de datos y
  // de la limpieza. La exclusividad real ya la garantiza el de arriba.
  const lock: InstanceLock = acquireInstanceLock(paths.dbPath, {
    log: (message) => console.warn(`Aviso: ${message}`),
  });
  if (!lock.acquired) console.warn(`Aviso: ${lock.message}`);

  console.log(`VIUrewards: ${describePaths(paths)}`);

  // El log del servidor vive fuera de /media. Se crea antes del libro y de la
  // limpieza para que el libro pueda persistirse desde el primer momento.
  mkdirSync(logsDir, { recursive: true });

  // Libro de EVIDENCIA: se lee lo que dejó un cierre abrupto ANTES de crear
  // cualquier otro libro (el de la sesión reescribe el archivo al construirse).
  // Es de solo lectura: la limpieza y la reconciliación lo consultan, pero no lo
  // modifican, así que un fallo de escritura del libro de la sesión no puede
  // hacer perder la evidencia.
  const startupEvidence = new FileMediaOperationJournal(logsDir, { transient: true });

  // Libro de la SESIÓN: el que actualiza el servidor (y persiste en
  // `logs/pending-media.txt`).
  const journal = new FileMediaOperationJournal(logsDir);
  runStartupCleanup(db, mediaDir, uploadsDir, startupEvidence, lock.acquired);

  // Reconciliación de arranque: pone la biblioteca de acuerdo con /media. Nunca
  // borra clips en silencio: agrega los que falten (sidecar o ffprobe), MARCA
  // los que perdieron su archivo y aborta sin tocar nada si la carpeta no se
  // puede leer. El id y el nombre de archivo nunca cambian. Con `evidence`, una
  // salida de conversión interrumpida NO se importa (la limpieza la borra).
  const result = await reconcileClips(db, mediaDir, {
    rebuild: createClipRebuilder({ mediaDir, journal: startupEvidence }),
    evidence: true,
    log: (message) => console.log(message),
  });

  if (result.aborted) {
    console.warn(`Aviso: ${result.message ?? "no se pudo revisar la carpeta de medios."}`);
  } else if (
    result.added.length > 0 ||
    result.missing.length > 0 ||
    result.restored.length > 0 ||
    result.skipped.length > 0
  ) {
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`+${result.added.length} recuperados`);
    if (result.missing.length > 0) parts.push(`${result.missing.length} sin archivo (marcados, no borrados)`);
    if (result.restored.length > 0) parts.push(`${result.restored.length} reaparecidos`);
    if (result.skipped.length > 0) parts.push(`${result.skipped.length} omitidos`);
    console.log(`Biblioteca sincronizada con /media: ${parts.join(", ")}.`);
  }

  // Aviso descartable en el dashboard (además de la consola): solo si hubo
  // recuperaciones o clips marcados sin archivo.
  const libraryNotice =
    result.added.length > 0 || result.missing.length > 0
      ? { recovered: result.added.length, missing: result.missing.length, restored: result.restored.length }
      : undefined;

  let dbClosed = false;
  const closeDb = (): void => {
    if (dbClosed) return;
    dbClosed = true;
    lock.release();
    db.close();
    // El cerrojo compartido se libera ÚLTIMO: mientras la base y los recursos se
    // cierran, otra instancia no puede empezar a usarlos.
    sharedLock.release();
  };

  const server = await createServer({
    mediaDir,
    db,
    port: resolvePort(process.argv.slice(2), db),
    libraryNotice,
    processes: processSupervisor,
    uploadsDir,
    logDir: logsDir,
    journal,
    // Herramientas administradas: `bin/` del directorio de datos (absoluta). En
    // modo heredado es `<cwd>/bin`, así que el comportamiento no cambia; en modo
    // configurado sigue a los datos y el botón del dashboard actualiza ESE
    // ejecutable, que una actualización de VIUrewards no reemplaza.
    media: {
      binDir: paths.binDir,
      nodeRuntime: paths.nodeRuntime,
    },
  });
  let info;
  try {
    info = await server.start();
  } catch (error) {
    // No arrancó (p. ej. puerto ocupado): se liberan los recursos ya abiertos para
    // no dejar los cerrojos tomados a una copia que no está corriendo.
    await server.stop().catch(() => undefined);
    closeDb();
    throw error;
  }

  const firstRun = server.auth.isConfigured()
    ? ""
    : " (primera vez: te va a pedir crear una contraseña)";

  console.log("");
  console.log("VIUrewards está corriendo.");
  console.log(`  Dashboard: ${info.dashboardUrl}`);
  console.log(`  Overlay:   ${info.overlayUrl}`);
  console.log(`  Abrí el dashboard en el navegador${firstRun}.`);
  console.log("  Ctrl+C para cerrar.");
  console.log("");

  const controller = createShutdownController({
    stop: () => server.stop({ timeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS }),
    closeDb,
    closeLog: () => server.logger.close(),
    killProcesses: () => processSupervisor.killAllNow(),
    runningProcesses: () => processSupervisor.running().length,
    log: (message) => {
      console.log(message);
      server.logger.info(message);
    },
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    try {
      process.on(signal, () => void controller.shutdown(signal));
    } catch {
      // SIGBREAK no existe en todos los sistemas: se ignora.
    }
  }
}

// Solo se arranca si este archivo es el punto de entrada (`npm start`).
// Importarlo (tests, herramientas) NUNCA debe abrir la base ni levantar el
// servidor: eso usaría `data/app.db` y `media/` reales.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error: unknown) => {
    if (error instanceof SharedDataInUseError) {
      console.error(`No se puede arrancar VIUrewards: ${error.reason}`);
      process.exitCode = SHARED_DATA_IN_USE_EXIT_CODE;
      return;
    }
    if (error instanceof InvalidDataDirError) {
      // Ruta de datos mal configurada: NO se inicializó en otra carpeta.
      console.error(`No se puede arrancar VIUrewards: ${error.reason}`);
      process.exitCode = INVALID_DATA_DIR_EXIT_CODE;
      return;
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { main, SharedDataInUseError, SHARED_DATA_IN_USE_EXIT_CODE, InvalidDataDirError, INVALID_DATA_DIR_EXIT_CODE };