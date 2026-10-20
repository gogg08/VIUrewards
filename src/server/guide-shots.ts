/**
 * Capturas de la guía pública (`/guia`). La página pide la lista de las que
 * EXISTEN para no mostrar huecos ni generar 404 por imágenes que el creador
 * todavía no aportó.
 *
 * Seguridad: la carpeta es fija (`web/assets/guide/`), la ruta no viene del
 * cliente y solo se devuelven **nombres de archivo** que matchean un patrón
 * estricto. Nunca se devuelven rutas, tamaños ni metadatos, y no hay forma de
 * salir de esa carpeta (no se construye ningún path con input del usuario).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Patrón acordado de nombres de captura: `guia-01-kick-developer.png`. */
export const GUIDE_SHOT_PATTERN = /^guia-\d\d-[a-z0-9-]+\.(png|webp|jpg)$/;

/** Subcarpeta (dentro de `/web`) donde viven las capturas. */
export const GUIDE_SHOTS_DIRNAME = "assets/guide";

/**
 * Nombres de las capturas presentes, en orden alfabético. Devuelve `[]` (sin
 * lanzar) si la carpeta no existe todavía, no es una carpeta o no se puede leer:
 * la guía se muestra igual, sin capturas.
 */
export function listGuideShots(webDir: string): string[] {
  const dir = join(webDir, GUIDE_SHOTS_DIRNAME);
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => GUIDE_SHOT_PATTERN.test(name)).sort();
}
