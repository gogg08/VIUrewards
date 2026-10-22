/**
 * Patrones de archivos temporales de VIUrewards (lista ÚNICA).
 *
 * La limpieza de arranque (`src/media/cleanup.ts`) solo borra lo que coincida
 * EXACTAMENTE con un patrón de acá. Un archivo desconocido de `/media` nunca se
 * toca: puede ser un clip del usuario o un archivo que alguien copió a mano.
 *
 * De dónde sale cada patrón (verificado en el código):
 *
 *  - `<uuid>.upload` → `POST /api/uploads` escribe el cuerpo en
 *    `<uploadsDir>/<randomUUID()>.upload` y el trabajo lo borra al terminar.
 *  - `<id>.src.<ext>` → yt-dlp, con la plantilla `<id>.src.%(ext)s` (uno o más
 *    archivos de video/audio separados si hubo que combinar).
 *  - `<id>.src.info.json` → yt-dlp (`--write-info-json`). El regex de `.src.`
 *    ya lo cubre.
 *  - `<id>.src.<ext>.part` / `.ytdl` → descargas parciales de yt-dlp (el regex
 *    de `.src.` también los cubre).
 *  - `<id>.<ext>.part` → salida parcial/abortada de ffmpeg sobre el archivo
 *    final (p. ej. `abc.mp4.part` en la cancelación de una conversión).
 *
 * Lo que NUNCA coincide y por lo tanto nunca se borra solo:
 *
 *  - `<id>.json` → **sidecar** de metadata del clip. Lo lee la reconciliación
 *    para reconstruir la fila: no es un temporal.
 *  - `<id>.mp4` / `<id>.m4a` → archivo de un clip (registrado o importado a
 *    mano). La limpieza los trata por separado, con evidencia (ver `cleanup.ts`).
 *  - `thumbs/<id>.jpg` → miniatura de un clip (vive en una subcarpeta que la
 *    limpieza no recorre).
 */

import { mediaExtensionOf } from "./formats.ts";

/** Extensiones permitidas para un archivo de clip (mp4/m4a). */
export const TEMP_MEDIA_EXTENSIONS = [".mp4", ".m4a"] as const;

export type TempMediaExtension = (typeof TEMP_MEDIA_EXTENSIONS)[number];

/** Temporal de una subida por HTTP (`POST /api/uploads`). */
const UPLOAD_TEMP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.upload$/;

/**
 * Descarga de yt-dlp: `<id>.src.<algo>` (el `.info.json`, los `.part` y los
 * `.ytdl` caen acá). El id de un clip es un hash hexadecimal corto.
 */
const DOWNLOAD_TEMP = /^[0-9a-z_-]+\.src\.[^/\\]+$/i;

/** Parcial de ffmpeg sobre el archivo final: `<id>.mp4.part` / `<id>.m4a.part`. */
const PARTIAL_OUTPUT = /^[0-9a-z_-]+\.(?:mp4|m4a)\.part$/i;

/** Temporales asociados a un id de clip concreto (para borrarlos sin esperar). */
export function isTemporaryForClip(name: string, id: string): boolean {
  if (!id) return false;
  return name.startsWith(`${id}.src.`) || name === `${id}.mp4.part` || name === `${id}.m4a.part`;
}

/**
 * ¿El nombre es un temporal de VIUrewards? Solo mira el nombre: no decide si es
 * seguro borrarlo (eso lo hace `cleanup.ts` con la antigüedad y el tipo).
 */
export function isTempFileName(name: string): boolean {
  return UPLOAD_TEMP.test(name) || DOWNLOAD_TEMP.test(name) || PARTIAL_OUTPUT.test(name);
}

/** Categoría del temporal, para el log y las pruebas. */
export type TempKind = "upload" | "download" | "partial";

/** Categoría de un temporal, o `null` si no es un temporal de VIUrewards. */
export function tempKindOf(name: string): TempKind | null {
  if (UPLOAD_TEMP.test(name)) return "upload";
  if (DOWNLOAD_TEMP.test(name)) return "download";
  if (PARTIAL_OUTPUT.test(name)) return "partial";
  return null;
}

/**
 * Qué archivo habría generado yt-dlp a partir de un temporal de descarga
 * (`<id>.src.<ext>` -> `<id>`, sin extensión). Devuelve `null` si el nombre no
 * completa el patrón. El id resultante es un nombre de archivo seguro (solo
 * caracteres del patrón, nunca separadores de ruta).
 */
export function downloadSourceId(name: string): string | null {
  const match = /^([0-9a-z_-]+)\.src\.[^/\\]+$/i.exec(name);
  return match ? match[1] : null;
}

/** Extensión de clip de un archivo final (`.mp4`/`.m4a`), o `null`. */
export function mediaExtensionName(name: string): TempMediaExtension | null {
  const ext = mediaExtensionOf(name);
  return ext === ".mp4" || ext === ".m4a" ? ext : null;
}

/**
 * ¿La clave (sin extensión) tiene pinta de id generado por la app? Un id de
 * clip es un hash hexadecimal de 32 caracteres; también se aceptan nombres
 * alfanuméricos con guiones/guiones bajos (los que yt-dlp puede dejar).
 *
 * OJO: esto por sí solo NO es evidencia de nada (un usuario puede renombrar un
 * archivo); la limpieza lo usa solo para EXCLUIR candidatos, nunca para borrar.
 */
export function looksLikeGeneratedId(stem: string): boolean {
  return /^[0-9a-f]{32}$/i.test(stem) || /^[0-9a-z_-]+$/i.test(stem);
}
