/**
 * Versión de build del overlay (Fase 3 + robustez).
 *
 * Es un hash corto de los archivos del overlay (más la fecha de inicio del
 * proceso). El servidor lo embebe en el HTML del overlay y lo manda en el mensaje
 * `state` del WebSocket; si la página quedó vieja (caché de OBS o del navegador),
 * el overlay se recarga solo. Reiniciar la app cambia el hash y fuerza la recarga
 * sin tocar la fuente en OBS.
 *
 * Nunca incluye secretos: solo un hash de contenido.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface OverlayVersionOptions {
  /** Archivos o carpetas cuyos contenidos entran en el hash. */
  paths: string[];
  /** Marca extra (p. ej. la fecha de inicio del proceso). */
  seed?: string;
}

/** Recolecta archivos de forma recursiva; ignora carpetas inexistentes. */
function collectFiles(path: string, out: string[]): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return; // el archivo o la carpeta no existe: no aporta al hash
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) collectFiles(join(path, name), out);
  } else if (stat.isFile()) {
    out.push(path);
  }
}

/** Hash corto (12 hex) del contenido de los archivos indicados. */
export function computeOverlayVersion(options: OverlayVersionOptions): string {
  const files: string[] = [];
  for (const path of options.paths) collectFiles(path, files);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(readFileSync(file));
    } catch {
      // Si un archivo no se puede leer, igual se hashea su ruta para que el
      // cambio de lista (aparición/desaparición) altere la versión.
    }
    hash.update("\0");
  }
  if (options.seed) hash.update(options.seed);
  return hash.digest("hex").slice(0, 12);
}
