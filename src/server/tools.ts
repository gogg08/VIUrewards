/**
 * Herramientas externas y mantenimiento de la biblioteca (Etapa 5, Parte B).
 *
 * Acá vive lo que el dashboard muestra y ejecuta desde Ajustes:
 *  - versión de yt-dlp, ffmpeg y ffprobe (solo por acción explícita),
 *  - actualización de yt-dlp (por acción explícita del creador),
 *  - espacio que ocupa la biblioteca,
 *  - vista previa de la limpieza de caché (qué se borraría).
 *
 * Todo proceso se lanza con `run` (spawn con argumentos en array, `shell: false`).
 * No hay `exec` ni concatenación de comandos (AGENTS.md #1).
 */

import { statSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { detectBinaries, type FindBinaryOptions } from "../media/binaries.ts";
import { hasMediaExtension } from "../media/formats.ts";
import { thumbsDir } from "../media/thumbs.ts";
import type { RunProcess } from "../media/run-process.ts";
import { runProcess } from "../media/run-process.ts";
import type { ClipRecord } from "../db/clips.ts";

export type { RunProcess };

export interface ToolVersions {
  ytDlp: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
}

export interface ToolInfoOptions {
  binarySearch?: FindBinaryOptions & { binDir?: string };
  run?: RunProcess;
  timeoutMs?: number;
}

/** Primer renglón no vacío de una salida de versión. */
function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ?? "";
}

/**
 * Lee la versión de cada herramienta ejecutándola con `--version`. Nunca lanza:
 * si falta el binario o falla el proceso, devuelve `null` para esa herramienta.
 */
export async function readToolVersions(options: ToolInfoOptions): Promise<ToolVersions> {
  const run = options.run ?? runProcess;
  const detection = detectBinaries(options.binarySearch);
  if (!detection.ok) return { ytDlp: null, ffmpeg: null, ffprobe: null };

  const timeoutMs = options.timeoutMs ?? 8000;

  const versionOf = async (bin: string): Promise<string | null> => {
    try {
      const result = await run(bin, ["--version"], { timeoutMs });
      // ffmpeg/ffprobe devuelven la versión en stderr y, en Windows, con un
      // código de salida distinto de 0 (ffmpeg no usa 0 en `--version`). Por eso
      // NO exigimos code 0: si hay una primera línea de texto, la usamos.
      const text = firstLine(result.stdout) || firstLine(result.stderr);
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  };

  const [ytDlp, ffmpeg, ffprobe] = await Promise.all([
    versionOf(detection.binaries.ytDlp),
    versionOf(detection.binaries.ffmpeg),
    versionOf(detection.binaries.ffprobe),
  ]);
  return { ytDlp, ffmpeg, ffprobe };
}

export interface YtdlpUpdateResult {
  ok: boolean;
  /** Salida combinada (recortada) para mostrar al creador. */
  output: string;
  message: string;
}

/**
 * Actualiza yt-dlp con `-U` (la forma documentada del propio binario). Solo se
 * llama por acción explícita del creador. Nunca lanza: traduce a un resultado.
 */
export async function updateYtdlp(options: ToolInfoOptions): Promise<YtdlpUpdateResult> {
  const run = options.run ?? runProcess;
  const detection = detectBinaries(options.binarySearch);
  if (!detection.ok) {
    return { ok: false, output: "", message: detection.message };
  }
  try {
    const result = await run(detection.binaries.ytDlp, ["-U"], { timeoutMs: options.timeoutMs ?? 120000 });
    const output = (result.stdout + "\n" + result.stderr).trim().slice(0, 4000);
    if (result.code === 0) {
      return { ok: true, output, message: "yt-dlp se actualizó correctamente." };
    }
    return { ok: false, output, message: "yt-dlp no pudo actualizarse. Revisá el detalle." };
  } catch (error) {
    return {
      ok: false,
      output: "",
      message: `No se pudo actualizar yt-dlp: ${error instanceof Error ? error.message : "error desconocido"}.`,
    };
  }
}

export interface LibraryUsage {
  /** Cantidad de clips guardados. */
  clips: number;
  /** Bytes ocupados por los archivos de los clips. */
  clipBytes: number;
  /** Bytes ocupados por las miniaturas. */
  thumbBytes: number;
  /** Total (clips + miniaturas). */
  totalBytes: number;
}

/** Suma el tamaño de un archivo sin lanzar (0 si no existe o no se puede leer). */
function safeSize(path: string): number {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/** Espacio que ocupa la biblioteca (archivos de clip + miniaturas). */
export function libraryUsage(mediaDir: string, clips: ClipRecord[]): LibraryUsage {
  let clipBytes = 0;
  for (const clip of clips) {
    const path = resolve(mediaDir, clip.file);
    // Nunca se sigue una ruta que se escape de la carpeta de medios.
    if (path.startsWith(mediaDir + sep) || path === mediaDir) clipBytes += safeSize(path);
  }
  let thumbBytes = 0;
  try {
    const dir = thumbsDir(mediaDir);
    for (const name of readdirSync(dir)) {
      thumbBytes += safeSize(join(dir, name));
    }
  } catch {
    // Sin miniaturas todavía.
  }
  return { clips: clips.length, clipBytes, thumbBytes, totalBytes: clipBytes + thumbBytes };
}

export interface CleanupCandidate {
  id: string;
  title: string;
  file: string;
  sizeBytes: number;
}

/**
 * Qué borraría la limpieza de caché: SOLO clips de link (con `sourceUrl`), que
 * no estén en la cola y que ninguna recompensa use. Nunca toca archivos locales.
 */
export function cleanupCandidates(
  mediaDir: string,
  clips: ClipRecord[],
  inQueue: ReadonlySet<string>,
  usedByRewards: ReadonlySet<string>,
): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  for (const clip of clips) {
    if (clip.sourceUrl === "") continue; // archivo local: nunca se borra solo
    if (inQueue.has(clip.id)) continue;
    if (usedByRewards.has(clip.id)) continue;
    const path = resolve(mediaDir, clip.file);
    out.push({
      id: clip.id,
      title: clip.title,
      file: clip.file,
      sizeBytes: safeSize(path),
    });
  }
  return out;
}

/** Suma de bytes de una lista de candidatos. */
export function candidatesBytes(candidates: CleanupCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.sizeBytes, 0);
}

/** Extensión de un archivo de clip reconocida (para no borrar cualquier cosa). */
export function isKnownMediaFile(file: string): boolean {
  return hasMediaExtension(file);
}
