#!/usr/bin/env node
/**
 * Prueba rápida del overlay (Fase 2).
 *
 * Levanta el servidor local y encola un clip para verlo en OBS sin dashboard.
 *
 * Uso:
 *   node scripts/play-test.ts <clipId>            # clip ya descargado en /media
 *   node scripts/play-test.ts <url>               # descarga con yt-dlp y lo encola
 *   node scripts/play-test.ts <url> --port=8787 --media-dir=./media
 *
 * EXCLUSIVIDAD: esta herramienta escribe en recursos compartidos con `npm start`
 * (descarga y convierte dentro de `media/`, sirve `/media`, y `createServer`
 * escribe `logs/server.log` y `logs/pending-media.txt`, el libro que el arranque
 * usa como evidencia). Por eso toma el MISMO cerrojo compartido que
 * `scripts/start.ts` (`acquireSharedResourcesLock`) ANTES de lanzar procesos o
 * crear el servidor: si hay una instancia viva, se niega a tocar nada.
 *
 * CONTRATO DE RUTAS (corregido): el cerrojo se toma sobre la raíz que CONTIENE
 * los directorios que la herramienta va a escribir (`media/`, `.uploads/`,
 * `logs/`). Si las opciones no permiten que esa raíz sea única —por ejemplo, un
 * `media/` en un sitio y los logs en otro, o un `--shared-root` que apunta a un
 * lugar distinto del de los datos— la herramienta RECHAZA la combinación con un
 * mensaje en español antes de crear archivos, descargar, escribir logs o tocar
 * el journal. Nunca toma un cerrojo de una raíz mientras escribe en otra.
 *
 * Precedencia de la configuración:
 *
 *  1. `VIUREWARDS_DATA_DIR` (si está definida): manda sobre todo. Los recursos
 *     viven en ese directorio y `--media-dir`/`--shared-root` solo se aceptan si
 *     coinciden con él (si no, se rechaza).
 *  2. `--media-dir=<ruta>` (sin la variable): los recursos viven en ese
 *     `media/` y en su carpeta padre (`logs/` y `.uploads/` al lado).
 *  3. Sin variable ni `--media-dir`: directorio de trabajo (comportamiento
 *     histórico).
 *
 * `--shared-root` es SOLO una validación de coherencia: si no coincide con la
 * raíz de los recursos, se rechaza; nunca redirige el cerrojo.
 */

import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "../src/server/server.ts";
import { acquireSharedResourcesLock, type InstanceLock } from "../src/db/instance-lock.ts";
import { processVideo } from "../src/media/index.ts";
import { resolveRuntimePaths, type RuntimePaths } from "../src/server/paths.ts";

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

/**
 * Rutas efectivas que la herramienta va a usar, todas normalizadas.
 * Es el resultado de aplicar la precedencia de la configuración.
 */
export interface PlayTestPaths {
  /** Raíz que CONTIENE media/, logs/ y .uploads/ (donde va el cerrojo). */
  root: string;
  mediaDir: string;
  logsDir: string;
  uploadsDir: string;
  /** Herramientas administradas (`bin/`), siempre absoluta y bajo la misma raíz. */
  binDir: string;
  /** Runtime de Node para yt-dlp, si se conoce. */
  nodeRuntime?: string;
}

export type PlayTestPathsResult =
  | { ok: true; paths: PlayTestPaths }
  | { ok: false; message: string };

/** Raíz a partir de una carpeta de medios: el padre (`<raíz>/media` → `<raíz>`). */
function rootOfMedia(mediaDir: string): string {
  return resolve(mediaDir, "..");
}

/**
 * ¿El directorio está DENTRO de la raíz (o es la raíz misma)?
 *
 * Se compara sobre rutas ya normalizadas con `resolve`, así que no hay forma de
 * escaparse con `.`, `..` ni con separadores finales.
 */
function isInside(root: string, dir: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Resuelve las rutas efectivas y valida que sean PROTEGIBLES por un único
 * cerrojo. No crea nada ni toca el disco: solo calcula y compara.
 *
 * Devuelve `ok: false` con un mensaje en español cuando:
 *  - `VIUREWARDS_DATA_DIR` es inválida (lo informa `resolveRuntimePaths`);
 *  - `--media-dir` apunta a un `media/` distinto de `<datos>/media`;
 *  - `--shared-root` no es la raíz de los recursos.
 */
export function resolvePlayTestPaths(options: {
  args: string[];
  cwd: string;
}): PlayTestPathsResult {
  const resolved = resolveRuntimePaths({ cwd: options.cwd });
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const dataPaths: RuntimePaths = resolved.paths;

  const mediaFlag = parseFlag(options.args, "--media-dir");
  const sharedFlag = parseFlag(options.args, "--shared-root");

  let effective: PlayTestPaths;
  if (dataPaths.mode === "configured") {
    // La variable manda: todo se deriva de ella.
    effective = {
      root: dataPaths.root,
      mediaDir: dataPaths.mediaDir,
      logsDir: dataPaths.logsDir,
      uploadsDir: dataPaths.uploadsDir,
      binDir: dataPaths.binDir,
      nodeRuntime: dataPaths.nodeRuntime,
    };
  } else if (mediaFlag !== undefined) {
    // Sin la variable, `--media-dir` define el media y todo lo demás va al lado.
    const mediaDir = resolve(options.cwd, mediaFlag);
    const root = rootOfMedia(mediaDir);
    effective = {
      root,
      mediaDir,
      logsDir: join(root, "logs"),
      uploadsDir: join(root, ".uploads"),
      binDir: join(root, "bin"),
    };
  } else {
    effective = {
      root: dataPaths.root,
      mediaDir: dataPaths.mediaDir,
      logsDir: dataPaths.logsDir,
      uploadsDir: dataPaths.uploadsDir,
      binDir: dataPaths.binDir,
      nodeRuntime: dataPaths.nodeRuntime,
    };
  }

  // `--media-dir` junto con la variable solo se acepta si es EL MISMO media.
  if (mediaFlag !== undefined && dataPaths.mode === "configured") {
    const requested = resolve(options.cwd, mediaFlag);
    if (requested !== effective.mediaDir) {
      return {
        ok: false,
        message: [
          `--media-dir ("${requested}") no coincide con los medios del directorio de datos configurado ("${effective.mediaDir}").`,
          `Con ${"VIUREWARDS_DATA_DIR"} definida, los recursos los fija esa variable:`,
          "quitá --media-dir o configurá la variable con el directorio que querés usar.",
        ].join(" "),
      };
    }
  }

  // `--shared-root` NO redirige el cerrojo: solo se acepta si coincide con la
  // raíz de los recursos que la herramienta va a escribir.
  if (sharedFlag !== undefined) {
    const requested = resolve(options.cwd, sharedFlag);
    if (requested !== effective.root) {
      return {
        ok: false,
        message: [
          `--shared-root ("${requested}") no es la raíz de los recursos que play-test va a usar ("${effective.root}").`,
          "El cerrojo tiene que proteger los mismos medios, uploads y logs que se escriben;",
          "quitá --shared-root o usá la ruta que contenga esos directorios.",
        ].join(" "),
      };
    }
  }

  // Invariante final: TODO recurso que la herramienta escribe tiene que quedar
  // dentro de la raíz del cerrojo. Si alguna derivación se cambia y deja algo
  // afuera (por ejemplo, un `media/` que es una raíz de unidad o un padre
  // compartido), se rechaza en vez de escribir fuera de la exclusividad.
  const escaped = [effective.mediaDir, effective.logsDir, effective.uploadsDir, effective.binDir].filter(
    (dir) => !isInside(effective.root, dir),
  );
  if (escaped.length > 0) {
    return {
      ok: false,
      message: [
        `La raíz de los recursos ("${effective.root}") no contiene ${escaped.map((dir) => `"${dir}"`).join(", ")},`,
        "así que un único cerrojo no puede proteger todos los recursos que play-test escribe.",
        "Elegí una carpeta que contenga media/, .uploads/, logs/ y bin/, o configurá VIUREWARDS_DATA_DIR.",
      ].join(" "),
    };
  }

  return { ok: true, paths: effective };
}

export interface PlayTestOptions {
  /** Argumentos de la línea de comandos (sin `node` ni el script). */
  args: string[];
  /** cwd de la herramienta: define la raíz de recursos compartidos. */
  cwd: string;
  /** Registro inyectable (tests). */
  log?: (message: string) => void;
  /** Error inyectable (tests). */
  error?: (message: string) => void;
  /**
   * Espera de cierre inyectable (tests). En producción espera señales reales;
   * inyectada, permite ejercer el ciclo completo sin señales del sistema.
   */
  waitForClose?: () => Promise<void>;
}

/**
 * Corre la herramienta completa. Devuelve el código de salida (0 si terminó
 * bien, 1 si hubo un error o no obtuvo la exclusividad).
 *
 * Separada de `main()` para que los tests la ejerzan sin depender de
 * `process.argv` ni matar el proceso de test.
 */
export async function main(options: PlayTestOptions): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(message));
  const error = options.error ?? ((message: string) => console.error(message));
  const args = options.args;

  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    log("Uso: node scripts/play-test.ts <clipId|url> [--port=8787] [--media-dir=./media]");
    return 1;
  }

  const port = Number(parseFlag(args, "--port") ?? 8787);

  // 1) Rutas efectivas, normalizadas y VALIDADAS antes de tocar nada.
  const resolvedPaths = resolvePlayTestPaths({ args, cwd: options.cwd });
  if (!resolvedPaths.ok) {
    error(`No se puede usar play-test: ${resolvedPaths.message} No se tocó ningún archivo.`);
    return 1;
  }
  const paths = resolvedPaths.paths;

  // 2) Exclusividad sobre la raíz que CONTIENE los recursos que se van a
  // escribir (media/, logs/, .uploads/). Misma raíz ⇒ mismo cerrojo que
  // `npm start`; por construcción, nunca una raíz distinta.
  const lock: InstanceLock = acquireSharedResourcesLock(paths.root);
  if (!lock.acquired) {
    error(
      `No se puede usar play-test: ${lock.message} ` +
        "Cerrá la app (npm start) antes de probar el overlay con esta herramienta; no se tocó ningún archivo.",
    );
    return 1;
  }

  let server: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    let clipId = target;
    // Mismo conjunto de herramientas que `scripts/start.ts` (el `bin/` del
    // directorio de datos), nunca un `bin/` relativo al cwd. `processVideo`
    // busca por `binarySearch`, así que allí se pasa en esa forma.
    const binarySearch = { binDir: paths.binDir };
    const binaries = { binDir: paths.binDir, nodeRuntime: paths.nodeRuntime };

    if (/^https?:\/\//i.test(target)) {
      log(`Descargando ${target} ...`);
      const result = await processVideo(target, {
        mediaDir: paths.mediaDir,
        logsDir: paths.logsDir,
        binarySearch,
        ...binaries,
      });
      if (!result.ok) {
        error(`Error [${result.reason}]: ${result.message}`);
        return 1;
      }
      clipId = result.clip.id;
      log(`Clip listo: ${clipId}`);
    }

    // Uploads y logs se pasan EXPLÍCITOS: así no se derivan del medio (que
    // podría ser `media/` de otra raíz) sino del conjunto ya validado.
    server = await createServer({
      mediaDir: paths.mediaDir,
      uploadsDir: paths.uploadsDir,
      logDir: paths.logsDir,
      port,
      media: { ...binaries, binarySearch },
    });
    const info = await server.start();
    server.queue.enqueue({ clipId, maxDurationSec: 30 });

    log("");
    log("Servidor arriba. Agregá esta URL como Browser Source en OBS:");
    log(`  ${info.overlayUrl}`);
    log("Ctrl+C para cerrar.");
    log("");

    await (options.waitForClose ?? waitForSignal)();
    return 0;
  } finally {
    // Se cierra el servidor (que usa los recursos) y RECIÉN se libera el cerrojo
    // propio. Nunca libera el cerrojo de otra instancia: si no lo tomó, se sale
    // arriba y `release()` es un no-op.
    if (server) await server.stop().catch(() => undefined);
    lock.release();
  }
}

/** Espera SIGINT/SIGTERM/SIGBREAK (como hace el servidor real). */
function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      process.off("SIGBREAK", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
    // SIGBREAK (Ctrl+Break de Windows) no existe en todos los sistemas.
    try {
      process.once("SIGBREAK", done);
    } catch {
      // Se ignora.
    }
  });
}

// Solo se ejecuta como punto de entrada (mismo criterio que `scripts/start.ts`).
// Importarlo desde un test NUNCA debe lanzar procesos ni tomar el cerrojo.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main({ args: process.argv.slice(2), cwd: process.cwd() })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((caught: unknown) => {
      console.error(`Error: ${caught instanceof Error ? caught.message : String(caught)}`);
      process.exitCode = 1;
    });
}
