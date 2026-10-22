/**
 * Reconstrucción de la metadata de un clip con ffprobe (reconciliación).
 *
 * La usa la reconciliación de arranque cuando un archivo está en `/media` pero
 * no tiene fila ni sidecar (por ejemplo, un clip que quedó huérfano tras un
 * reinicio). Nunca ejecuta ffmpeg ni toca el archivo: solo lo analiza, con las
 * mismas restricciones de seguridad que la ingesta (`-protocol_whitelist file`
 * y la lista corta de `format_name`).
 */

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { detectBinaries, type FindBinaryOptions } from "./binaries.ts";
import { hasMediaExtension } from "./formats.ts";
import { probeMedia } from "./ingest.ts";
import { checkInterruptedConversion, type MediaOperationJournal } from "./pending-media.ts";
import { isTempFileName, downloadSourceId } from "./temp-patterns.ts";
import { runProcess, type RunProcess } from "./run-process.ts";
import type { RebuiltClip } from "../db/clips.ts";

export interface BuildRebuildClipOptions {
  mediaDir: string;
  /** Directorio de logs de procesos; por defecto `<mediaDir>/../logs`. */
  logsDir?: string;
  timeoutMs?: number;
  binarySearch?: FindBinaryOptions;
  /** Ejecutor de procesos; inyectable en tests. */
  run?: RunProcess;
  /**
   * Libro de operaciones de media (arranque). Si viene, el rebuilder informa la
   * evidencia de una conversión interrumpida: `reconcileClips` con
   * `evidence: true` entonces NO la importa (la borra la limpieza).
   */
  journal?: MediaOperationJournal;
}

/**
 * Título derivado cuando se perdió el original: `"Audio <id corto>"` para
 * archivos sin imagen y `"Clip <id corto>"` para los que sí la tienen. Nunca es
 * el id completo (que es un hash largo, ilegible en la biblioteca).
 */
function derivedTitle(id: string, hasVideo: boolean): string {
  const short = id.slice(0, 8);
  return hasVideo ? `Clip ${short}` : `Audio ${short}`;
}

/**
 * Evidencia de que el archivo quedó de una conversión interrumpida: el libro
 * declara un `encodes <id>` sin terminar y no quedan temporales de descarga
 * (`<id>.src.*`) en `/media`. Sin libro (o sin la línea) no hay evidencia.
 */
function conversionEvidence(
  journal: MediaOperationJournal,
  mediaDir: string,
  id: string,
  file: string,
): { interrupted: boolean; reason?: string } {
  let pendingDownloads: string[] = [];
  try {
    pendingDownloads = readdirSync(mediaDir).filter(
      (name) => name !== file && isTempFileName(name) && downloadSourceId(name) === id,
    );
  } catch {
    // Si no se puede leer la carpeta, no hay evidencia y se conserva.
    return { interrupted: false, reason: "No se pudo leer la carpeta de medios." };
  }
  const check = checkInterruptedConversion(journal, id, pendingDownloads);
  return { interrupted: check.interrupted, reason: check.reason };
}

/**
 * Devuelve una función `rebuild` para `reconcileClips`: analiza el archivo con
 * ffprobe y reconstruye la metadata. Nunca lanza: si ffprobe falta, el archivo
 * no es un medio válido o algo falla, devuelve `null` y la reconciliación omite
 * el archivo (lo registra, no lo borra ni lo borra del disco).
 */
export function createClipRebuilder(
  options: BuildRebuildClipOptions,
): (id: string, file: string, filePath: string) => Promise<RebuiltClip | null> {
  const mediaDir = options.mediaDir;
  const logsDir = options.logsDir ?? join(mediaDir, "..", "logs");
  const timeoutMs = options.timeoutMs ?? 120_000;
  const run = options.run ?? runProcess;

  return async (id: string, file: string, filePath: string): Promise<RebuiltClip | null> => {
    // Nunca confiamos en el nombre: solo analizamos archivos con extensión de
    // clip permitida (la lista compartida).
    if (!hasMediaExtension(file)) return null;
    const detection = detectBinaries(options.binarySearch);
    if (!detection.ok) return null;

    const probe = await probeMedia(detection.binaries.ffprobe, filePath, run, timeoutMs, logsDir);
    if (!probe.ok) return null;
    if (!probe.media.hasVideo && !probe.media.hasAudio) return null;

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(filePath).size;
    } catch {
      sizeBytes = 0;
    }

    return {
      title: derivedTitle(id, probe.media.hasVideo),
      durationSec: probe.media.durationSec,
      sizeBytes,
      // Un clip reconstruido no tiene URL de origen (es un archivo local).
      sourceUrl: "",
      hasVideo: probe.media.hasVideo,
      ...(options.journal ? { evidence: conversionEvidence(options.journal, mediaDir, id, file) } : {}),
    };
  };
}
