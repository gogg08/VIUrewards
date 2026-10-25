/**
 * Utilidades de archivo y ZIP del empaquetado (Etapa 2).
 *
 * Sin dependencias nuevas: la lista de archivos copiados y la verificación del
 * contenido del ZIP se hacen con `node:fs`. El ZIP se **escribe** con una
 * herramienta del sistema (`zip -r` en PowerShell, `zip` en Unix o el
 * `Compress-Archive` de PowerShell 5 en Windows), elegida por `build` en
 * `scripts/package.ts`; acá solo viven las piezas puras y verificables.
 */

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

/** Rutas (relativas, con `/`) de todos los archivos de un árbol, ordenadas. */
export function listFiles(root: string, options: { ignore?: (rel: string) => boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (options.ignore?.(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(rel);
      // Los symlinks se ignoran a propósito: el paquete no los incluye y la
      // verificación posterior también los rechaza si apareciera alguno.
    }
  };
  walk(root);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** SHA-256 de un archivo, en hex minúsculas. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** SHA-256 de un buffer, en hex minúsculas. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface VerifiedSize {
  bytes: number;
  files: number;
}

/** Tamaño total (bytes y cantidad de archivos) de un árbol. */
export function treeSize(root: string, files: string[]): VerifiedSize {
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += statSync(join(root, rel)).size;
    } catch {
      // Un archivo que desapareció no rompe el cálculo del manifiesto.
    }
  }
  return { bytes, files: files.length };
}

/**
 * Verifica que un árbol de staging no contenga datos de usuario ni secretos.
 * Devuelve la lista de violaciones (vacía si está limpio).
 */
export function findForbiddenPaths(
  files: string[],
  forbiddenSegments: readonly string[],
  forbiddenTopLevel: readonly string[],
): string[] {
  const violations: string[] = [];
  for (const rel of files) {
    const segments = rel.split("/");
    for (const forbidden of forbiddenSegments) {
      // `.env` y similares: se comparan como segmento exacto o con sufijo de
      // variantes (`.env.local`).
      if (segments.some((segment) => segment === forbidden || segment.startsWith(`${forbidden}.`))) {
        violations.push(rel);
        break;
      }
    }
    if (segments.length > 1 && forbiddenTopLevel.includes(segments[0] ?? "")) {
      violations.push(rel);
    }
  }
  return [...new Set(violations)];
}

/** Lee un JSON con un error claro en español si está roto. */
export function readJsonFile<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new Error(`No se pudo leer ${what} (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Formatea bytes de forma legible (para logs del build). */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}
