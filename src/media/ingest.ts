/**
 * Ingesta de archivos locales (Etapa 3B del rediseño).
 *
 * El creador suelta (o elige) un archivo de audio o video. Nunca confiamos en la
 * extensión: el tipo se decide con **ffprobe** sobre el contenido. Copiamos el
 * archivo a la carpeta de la app con un **nombre generado** (el original solo
 * sirve como título por defecto) y lo normalizamos: video a mp4, audio a m4a.
 * El archivo original NUNCA se modifica ni se borra.
 *
 * El núcleo recibe rutas: la subida por HTTP y el guardado temporal viven en el
 * servidor (streaming con @fastify/multipart). Acá solo se procesa un archivo ya
 * presente en disco.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { buildAudioFfmpegArgs, buildFfmpegArgs, buildFfprobeArgs } from "./args.ts";
import { detectBinaries, type FindBinaryOptions } from "./binaries.ts";
import { hasMediaExtension } from "./formats.ts";
import { writeProcessLog } from "./logs.ts";
import { runProcess, type ProcessResult, type RunProcess } from "./run-process.ts";
import { generateThumbnail } from "./thumbs.ts";
import type { MediaOperationJournal } from "./pending-media.ts";
import type { Clip } from "./index.ts";
import { CANCELLED_MESSAGE } from "./index.ts";
import type { MediaErrorCode } from "./validate-url.ts";

/** Opciones de la ingesta de un archivo local. */
export interface IngestLocalFileOptions {
  /** Directorio donde se guardan los clips y sus sidecars. */
  mediaDir: string;
  /**
   * Nombre original del archivo (con extensión). Solo se usa como título por
   * defecto: se escapa y recorta. Nunca se usa como nombre de archivo en disco.
   */
  originalName?: string;
  /** Título explícito (tiene prioridad sobre `originalName` si viene). */
  title?: string;
  /** Duración máxima permitida, en segundos. */
  maxDurationSec?: number;
  /** Tamaño máximo permitido, en bytes. */
  maxBytes?: number;
  /** Timeout de cada proceso externo (ffprobe/ffmpeg), en ms. */
  timeoutMs?: number;
  /** Altura máxima de salida para videos. */
  maxHeight?: number;
  /** Directorio de logs de procesos. Por defecto `<mediaDir>/../logs`. */
  logsDir?: string;
  /** Parámetros de búsqueda de binarios (inyectables en tests). */
  binarySearch?: FindBinaryOptions;
  /** Ejecutor de procesos; inyectable en tests. */
  run?: RunProcess;
  /** Notifica la etapa en curso. */
  onStage?: (stage: IngestStage) => void;
  /**
   * Cancela la ingesta: ffprobe/ffmpeg se terminan y los archivos parciales de
   * ESTA operación (nunca el archivo original) se borran.
   */
  signal?: AbortSignal;
  /**
   * Libro de operaciones de media (opcional). Registra `encodes <id>` mientras
   * ffmpeg escribe el archivo final y hasta que queda el sidecar: así la
   * limpieza de arranque reconoce una conversión interrumpida.
   */
  journal?: MediaOperationJournal;
}

/** Etapas visibles de la ingesta local. */
export type IngestStage = "converting" | "ready";

export interface IngestResultClip extends Clip {
  /** ¿El archivo tiene imagen? Los audios no. */
  hasVideo: boolean;
  /** ¿Es un archivo local (nunca se borra solo)? */
  local: boolean;
  /** ¿Ya existía un clip con el mismo contenido? */
  duplicate: boolean;
}

export type IngestResult =
  | { ok: true; clip: IngestResultClip }
  | { ok: false; reason: IngestErrorCode; message: string };

export type IngestErrorCode = MediaErrorCode | "NOT_MEDIA" | "NO_AUDIO";

export const DEFAULT_INGEST_LIMITS = {
  maxDurationSec: 120,
  maxBytes: 100 * 1024 * 1024,
  timeoutMs: 120_000,
  maxHeight: 1080,
} as const;

/** Título por defecto: sin emojis ni caracteres raros, espacios colapsados. */
export function defaultTitle(originalName: string): string {
  const withoutExt = originalName.replace(/\.[^./\\]+$/, "");
  const cleaned = withoutExt
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "Clip local";
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; size?: string; format_name?: string };
}

/** Resultado del análisis por contenido de un archivo. */
export interface ProbedMedia {
  hasVideo: boolean;
  hasAudio: boolean;
  durationSec: number;
}

export type ProbeResult =
  | { ok: true; media: ProbedMedia }
  | { ok: false; message: string; cancelled?: boolean };

/**
 * Formatos aceptados (por `format_name` de ffprobe). Es una lista corta y
 * explícita: un contenedor fuera de ella se rechaza aunque `ffprobe` lo lea, para
 * no normalizar listas de reproducción, concat ni formatos exóticos. `format_name`
 * puede traer varios nombres separados por coma (p. ej. "mov,mp4,m4a,3gp,3g2,mj2").
 */
const ALLOWED_FORMATS = new Set([
  "mov",
  "mp4",
  "m4a",
  "3gp",
  "3g2",
  "mj2",
  "matroska",
  "webm",
  "mpeg",
  "mpegts",
  "ogg",
  "wav",
  "flac",
  "mp3",
  "aac",
  "ipod",
]);

/** ¿El `format_name` (posible lista separada por coma) está dentro de la lista permitida? */
export function isAllowedFormat(formatName: string | undefined): boolean {
  if (!formatName) return false;
  return formatName
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .some((name) => ALLOWED_FORMATS.has(name));
}

/** Analiza un archivo con ffprobe. El tipo sale del contenido, no de la extensión. */
export async function probeMedia(
  ffprobeBin: string,
  filePath: string,
  run: RunProcess,
  timeoutMs: number,
  logsDir: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const args = buildFfprobeArgs(filePath);
  const result = await run(ffprobeBin, args, { timeoutMs, signal });
  if (result.cancelled) {
    return { ok: false, message: CANCELLED_MESSAGE, cancelled: true };
  }
  if (result.timedOut || result.code !== 0) {
    writeProcessLog(logsDir, "ffprobe", toLog(ffprobeBin, args, result));
    return { ok: false, message: "El archivo no es un audio o video válido." };
  }
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput;
  } catch {
    return { ok: false, message: "El archivo no es un audio o video válido." };
  }
  const streams = parsed.streams ?? [];
  if (!isAllowedFormat(parsed.format?.format_name)) {
    return { ok: false, message: "El archivo usa un formato no soportado." };
  }
  const hasVideo = streams.some((s) => s.codec_type === "video");
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  const duration = Number(parsed.format?.duration);
  return {
    ok: true,
    media: {
      hasVideo,
      hasAudio,
      durationSec: Number.isFinite(duration) ? Math.round(duration) : 0,
    },
  };
}

function toLog(command: string, args: readonly string[], result: ProcessResult) {
  return {
    command,
    args,
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function failure(reason: IngestErrorCode, message: string): IngestResult {
  return { ok: false, reason, message };
}

/** Hash del contenido: dos archivos idénticos comparten id (detección de duplicados). */
function contentId(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex").slice(0, 32);
}

/**
 * Ingesta un archivo local ya presente en disco. Devuelve el clip normalizado.
 *
 * - Valida el contenido con ffprobe (audio o video; si no, rechaza).
 * - Aplica los límites de tamaño y duración.
 * - Detecta duplicados por contenido (reutiliza el clip existente).
 * - Copia y normaliza: video a mp4, audio a m4a. El original no se toca.
 */
export async function ingestLocalFile(
  sourcePath: string,
  options: IngestLocalFileOptions,
): Promise<IngestResult> {
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_INGEST_LIMITS.maxDurationSec;
  const maxBytes = options.maxBytes ?? DEFAULT_INGEST_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_INGEST_LIMITS.timeoutMs;
  const maxHeight = options.maxHeight ?? DEFAULT_INGEST_LIMITS.maxHeight;
  const run = options.run ?? runProcess;
  const logsDir = options.logsDir ?? join(options.mediaDir, "..", "logs");
  const mediaDir = options.mediaDir;
  const signal = options.signal;
  const cancelled = (): boolean => signal?.aborted === true;

  if (!existsSync(sourcePath)) {
    return failure("DOWNLOAD_FAILED", "No se encontró el archivo a agregar.");
  }
  const sizeBytes = statSync(sourcePath).size;
  if (sizeBytes <= 0) {
    return failure("DOWNLOAD_FAILED", "El archivo está vacío.");
  }
  if (sizeBytes > maxBytes) {
    return failure("TOO_BIG", `El archivo pesa más de ${formatMb(maxBytes)} (límite configurado).`);
  }

  const detection = detectBinaries(options.binarySearch);
  if (!detection.ok) return failure("BINARY_MISSING", detection.message);

  const probe = await probeMedia(detection.binaries.ffprobe, sourcePath, run, timeoutMs, logsDir, signal);
  if (cancelled() || ("cancelled" in probe && probe.cancelled)) {
    return failure("DOWNLOAD_FAILED", CANCELLED_MESSAGE);
  }
  if (!probe.ok) return failure("NOT_MEDIA", probe.message);
  if (!probe.media.hasAudio && !probe.media.hasVideo) {
    return failure("NOT_MEDIA", "El archivo no tiene audio ni video.");
  }
  if (probe.media.durationSec > maxDurationSec) {
    return failure(
      "TOO_LONG",
      `El archivo dura más de ${maxDurationSec} s (límite configurado).`,
    );
  }

  mkdirSync(mediaDir, { recursive: true });

  // Dedupe por CONTENIDO: mismo hash => mismo clip (aunque cambie el nombre).
  const fingerprint = contentId(sourcePath);
  const existing = findClipByFingerprint(mediaDir, fingerprint);
  if (existing) {
    const meta = readSidecarMeta(mediaDir, existing.id);
    return {
      ok: true,
      clip: {
        id: existing.id,
        path: join(mediaDir, existing.file),
        durationSec: meta?.durationSec ?? probe.media.durationSec,
        sizeBytes: meta?.sizeBytes ?? statSync(join(mediaDir, existing.file)).size,
        title: meta?.title ?? options.title?.trim() ?? defaultTitle(options.originalName ?? basename(sourcePath)),
        hasVideo: meta?.hasVideo ?? probe.media.hasVideo,
        local: true,
        duplicate: true,
      },
    };
  }

  const hasVideo = probe.media.hasVideo;
  const ext = hasVideo ? "mp4" : "m4a";
  const id = fingerprint;
  const file = `${id}.${ext}`;
  const outputPath = join(mediaDir, file);
  const title = options.title?.trim() || defaultTitle(options.originalName ?? basename(sourcePath));

  const ffmpegBin = detection.binaries.ffmpeg;
  const ffmpegArgs = hasVideo
    ? buildFfmpegArgs(sourcePath, outputPath, { maxHeight })
    : buildAudioFfmpegArgs(sourcePath, outputPath);
  options.onStage?.("converting");
  // El archivo final puede quedar sin sidecar si el proceso muere: se declara.
  options.journal?.begin("encodes", id);
  const convert = await run(ffmpegBin, ffmpegArgs, { timeoutMs, signal });

  // Cancelada: se borra la salida parcial de esta operación (el original nunca).
  if (convert.cancelled || cancelled()) {
    rmSync(outputPath, { force: true });
    options.journal?.end("encodes", id);
    return failure("CONVERT_FAILED", CANCELLED_MESSAGE);
  }

  if (convert.timedOut) {
    rmSync(outputPath, { force: true });
    options.journal?.end("encodes", id);
    writeProcessLog(logsDir, "ffmpeg", toLog(ffmpegBin, ffmpegArgs, convert));
    return failure(
      "TIMEOUT",
      `La conversión excedió el tiempo máximo (${Math.round(timeoutMs / 1000)} s).`,
    );
  }
  if (convert.code !== 0 || !existsSync(outputPath)) {
    rmSync(outputPath, { force: true });
    options.journal?.end("encodes", id);
    writeProcessLog(logsDir, "ffmpeg", toLog(ffmpegBin, ffmpegArgs, convert));
    return failure("CONVERT_FAILED", "No se pudo preparar el archivo. Revisá el log para más detalles.");
  }

  const outSize = statSync(outputPath).size;
  const meta = {
    id,
    title,
    durationSec: probe.media.durationSec,
    sizeBytes: outSize,
    sourceUrl: "",
    createdAt: new Date().toISOString(),
    hasVideo,
    local: true,
  };
  writeFileSync(join(mediaDir, `${id}.json`), JSON.stringify(meta, null, 2), "utf8");
  // Sidecar escrito: la ingesta terminó (la fila la crea el trabajo).
  options.journal?.end("encodes", id);

  // Miniatura real (sección 2.4): solo para clips CON imagen. Si falla, el clip
  // se importa igual, sin miniatura (queda el respaldo en la tarjeta). Si la
  // ingesta se cancela, no se genera.
  if (hasVideo && !cancelled()) {
    await generateThumbnail(outputPath, id, {
      mediaDir,
      durationSec: probe.media.durationSec,
      logsDir,
      binarySearch: options.binarySearch,
      run: options.run,
      timeoutMs,
      signal,
    });
  }

  options.onStage?.("ready");

  return {
    ok: true,
    clip: {
      id,
      path: outputPath,
      durationSec: probe.media.durationSec,
      sizeBytes: outSize,
      title,
      hasVideo,
      local: true,
      duplicate: false,
    },
  };
}

interface SidecarMeta {
  title?: string;
  durationSec?: number;
  sizeBytes?: number;
  hasVideo?: boolean;
  local?: boolean;
}

function readSidecarMeta(mediaDir: string, id: string): SidecarMeta | null {
  const path = join(mediaDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SidecarMeta;
  } catch {
    return null;
  }
}

/** Busca un clip en disco por su huella de contenido (id = hash). */
function findClipByFingerprint(
  mediaDir: string,
  fingerprint: string,
): { id: string; file: string } | null {
  if (!existsSync(mediaDir)) return null;
  for (const name of readdirSync(mediaDir)) {
    if (!name.startsWith(`${fingerprint}.`)) continue;
    if (!hasMediaExtension(name)) continue;
    return { id: fingerprint, file: name };
  }
  return null;
}
