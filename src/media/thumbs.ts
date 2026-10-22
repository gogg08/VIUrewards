/**
 * Miniaturas de clips (corrección de la sección 2.4).
 *
 * Cada clip CON imagen obtiene una miniatura real (.jpg) extraída con ffmpeg: un
 * solo cuadro, redimensionado a un ancho máximo. Las miniaturas viven en
 * `<mediaDir>/thumbs/<id>.jpg`, fuera de la lista de clips, y se sirven por una
 * ruta de solo lectura con la misma autenticación que /media.
 *
 * Reglas:
 * - Nunca se modifica ni se regraba el clip: ffmpeg solo lee.
 * - Si la miniatura falla, el clip se importa igual (sin miniatura) y se registra.
 * - Todos los procesos usan spawn con argumentos en array y timeout.
 */

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildThumbFfmpegArgs } from "./args.ts";
import { detectBinaries, type FindBinaryOptions } from "./binaries.ts";
import { writeProcessLog } from "./logs.ts";
import { runProcess, type ProcessResult, type RunProcess } from "./run-process.ts";

/** Nombre de la subcarpeta de miniaturas dentro de mediaDir. */
export const THUMBS_DIR = "thumbs";

export interface ThumbnailOptions {
  /** Directorio de clips (la miniatura va en `<mediaDir>/thumbs`). */
  mediaDir: string;
  /** Duración del clip, en segundos (decide el instante del cuadro). */
  durationSec: number;
  /** Ancho máximo de la miniatura, en px. */
  maxWidth?: number;
  /** Timeout del proceso, en ms. */
  timeoutMs?: number;
  /** Directorio de logs de procesos. Por defecto `<mediaDir>/../logs`. */
  logsDir?: string;
  /** Parámetros de búsqueda de binarios (inyectables en tests). */
  binarySearch?: FindBinaryOptions;
  /** Ejecutor de procesos; inyectable en tests. */
  run?: RunProcess;
  /** Cancela la generación: ffmpeg se termina y la miniatura parcial se borra. */
  signal?: AbortSignal;
}

export type ThumbnailResult =
  | { ok: true; path: string }
  | { ok: false; message: string };

export const DEFAULT_THUMB_WIDTH = 480;
export const DEFAULT_THUMB_TIMEOUT_MS = 30_000;

/** Ruta de la miniatura de un clip. La construye la app: nunca el nombre original. */
export function thumbsDir(mediaDir: string): string {
  return join(mediaDir, THUMBS_DIR);
}

export function thumbPath(mediaDir: string, clipId: string): string {
  return join(thumbsDir(mediaDir), `${clipId}.jpg`);
}

export function thumbExists(mediaDir: string, clipId: string): boolean {
  return existsSync(thumbPath(mediaDir, clipId));
}

/** Borra la miniatura de un clip (al borrar el clip o en la limpieza de caché). */
export function removeThumb(mediaDir: string, clipId: string): void {
  rmSync(thumbPath(mediaDir, clipId), { force: true });
}

/**
 * Instante del cuadro: 10 % de la duración, con un mínimo de 1 s (una miniatura
 * cerca del inicio suele ser negra) y nunca más allá del final del clip.
 */
export function thumbTimestamp(durationSec: number, atRatio = 0.1): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const at = Math.max(1, durationSec * atRatio);
  // Deja margen para que `-ss` no caiga fuera del stream.
  return Math.max(0, Math.min(at, Math.max(0, durationSec - 0.1)));
}

/**
 * Extrae la miniatura de un clip con imagen. El clip ya está normalizado, así que
 * la duración es la del clip (no la del original). Nunca falla la importación: si
 * el proceso falla, se devuelve `ok: false` y quien llama decide (log + seguir).
 */
export async function generateThumbnail(
  clipPath: string,
  clipId: string,
  options: ThumbnailOptions,
): Promise<ThumbnailResult> {
  const run = options.run ?? runProcess;
  const maxWidth = options.maxWidth ?? DEFAULT_THUMB_WIDTH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_THUMB_TIMEOUT_MS;
  const logsDir = options.logsDir ?? join(options.mediaDir, "..", "logs");
  const outDir = thumbsDir(options.mediaDir);
  const outputPath = thumbPath(options.mediaDir, clipId);

  const detection = detectBinaries(options.binarySearch);
  if (!detection.ok) return { ok: false, message: detection.message };

  mkdirSync(outDir, { recursive: true });

  const args = buildThumbFfmpegArgs(clipPath, outputPath, {
    atSec: thumbTimestamp(options.durationSec),
    maxWidth,
  });
  const result: ProcessResult = await run(detection.binaries.ffmpeg, args, {
    timeoutMs,
    signal: options.signal,
  });

  if (result.cancelled) {
    rmSync(outputPath, { force: true });
    return { ok: false, message: "La operación se canceló." };
  }

  if (result.timedOut || result.code !== 0 || !existsSync(outputPath)) {
    rmSync(outputPath, { force: true });
    // Log del fallo (best-effort): el clip sigue siendo usable sin miniatura.
    writeProcessLog(logsDir, "thumb", {
      command: detection.binaries.ffmpeg,
      args,
      code: result.code,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    return {
      ok: false,
      message: result.timedOut ? "La miniatura excedió el tiempo máximo." : "No se pudo generar la miniatura.",
    };
  }

  const size = statSync(outputPath).size;
  if (size <= 0) {
    rmSync(outputPath, { force: true });
    return { ok: false, message: "La miniatura salió vacía." };
  }
  return { ok: true, path: outputPath };
}
