/**
 * Formatos de archivo de los clips (lista única).
 *
 * Es la ÚNICA fuente de verdad de las extensiones de los archivos de la
 * biblioteca. La usan:
 *  - la ingesta local (`ingest.ts`) al nombrar la salida,
 *  - el módulo de descarga por link (`index.ts`),
 *  - la reconciliación de arranque (`db/clips.ts`), que debe reconocer TODOS los
 *    formatos, no una extensión fija,
 *  - el servidor al servir `/media` y al resolver la URL del medio.
 *
 * Sin dependencias: puede importarse desde cualquier módulo sin arrastrar
 * lógica de procesos externos.
 */

/** Extensiones permitidas para los archivos de clip (con el punto). */
export const MEDIA_EXTENSIONS = [".mp4", ".m4a"] as const;

export type MediaExtension = (typeof MEDIA_EXTENSIONS)[number];

/** ¿La ruta/nombre termina en una extensión de clip permitida? */
export function hasMediaExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Extensión de clip de un nombre de archivo, o `null` si no es un formato de
 * clip. Devuelve la extensión en minúsculas, con el punto.
 */
export function mediaExtensionOf(name: string): MediaExtension | null {
  const lower = name.toLowerCase();
  return MEDIA_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? null;
}

/**
 * Quita la extensión de clip de un nombre (p. ej. `abc.mp4` -> `abc`). Si no
 * tiene una extensión permitida, devuelve el nombre tal cual.
 */
export function stripMediaExtension(name: string): string {
  const ext = mediaExtensionOf(name);
  return ext ? name.slice(0, -ext.length) : name;
}
