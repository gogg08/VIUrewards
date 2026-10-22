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
 * EXCLUSIVIDAD: esta herramienta escribe en la MISMA raíz de recursos que
 * `npm start` (la carpeta del cwd, o la que se indique con `--shared-root=`):
 * descarga y convierte dentro de `media/`, sirve `/media`, y `createServer`
 * escribe `logs/server.log` y `logs/pending-media.txt` (el libro que el arranque
 * usa como evidencia). Por eso toma el MISMO cerrojo compartido que
 * `scripts/start.ts` (`acquireSharedResourcesLock`) ANTES de lanzar procesos o
 * crear el servidor: si hay una instancia viva, se niega a tocar nada. Si no hay
 * exclusividad, el servidor principal sigue sin poder arrancar hasta que esta
 * herramienta termine.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "../src/server/server.ts";
import { acquireSharedResourcesLock, type InstanceLock } from "../src/db/instance-lock.ts";
import { processVideo } from "../src/media/index.ts";

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
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

  const mediaDir = parseFlag(args, "--media-dir") ?? join(options.cwd, "media");
  const port = Number(parseFlag(args, "--port") ?? 8787);
  // Misma raíz compartida que `npm start`: la que contiene `media/`, `.uploads/`
  // y `logs/`. Por defecto es el cwd de la herramienta (que es donde
  // `createServer` buscaría esos directorios si no se le pasan).
  const sharedRoot = parseFlag(args, "--shared-root") ?? options.cwd;

  // Exclusividad ANTES de descargar, convertir o escribir logs compartidos.
  const lock: InstanceLock = acquireSharedResourcesLock(sharedRoot);
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
    if (/^https?:\/\//i.test(target)) {
      log(`Descargando ${target} ...`);
      const result = await processVideo(target, { mediaDir });
      if (!result.ok) {
        error(`Error [${result.reason}]: ${result.message}`);
        return 1;
      }
      clipId = result.clip.id;
      log(`Clip listo: ${clipId}`);
    }

    server = await createServer({ mediaDir, port });
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
