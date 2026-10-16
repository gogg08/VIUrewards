/**
 * Núcleo de media (Fase 1).
 *
 * Flujo: validar URL -> detectar binarios -> descargar con yt-dlp ->
 * recodificar con ffmpeg a mp4 H.264/AAC -> guardar en /media.
 * Si el hash de la URL ya existe, se reutiliza el clip (caché).
 *
 * Sin servidor HTTP, sin base de datos, sin dashboard. Los metadatos del clip
 * se guardan en un sidecar `<id>.json` junto al mp4 (no es una base de datos).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { buildFfmpegArgs, buildYtdlpArgs } from "./args.ts";
import { detectBinaries, type FindBinaryOptions } from "./binaries.ts";
import { writeProcessLog } from "./logs.ts";
import { runProcess, type ProcessResult, type RunProcess } from "./run-process.ts";
import { generateThumbnail } from "./thumbs.ts";
import {
  validateUrl,
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_MAX_URL_LENGTH,
  type MediaErrorCode,
} from "./validate-url.ts";

export interface MediaOptions {
  /** Directorio donde se guardan los clips y sus metadatos. */
  mediaDir: string;
  allowedDomains?: readonly string[];
  maxUrlLength?: number;
  maxDurationSec?: number;
  maxBytes?: number;
  timeoutMs?: number;
  maxHeight?: number;
  /**
   * Directorio de logs de procesos (stderr crudo de yt-dlp/ffmpeg).
   * Por defecto: `<mediaDir>/../logs`.
   */
  logsDir?: string;
  /** Parámetros de búsqueda de binarios (inyectables en tests). */
  binarySearch?: FindBinaryOptions;
  /** Ejecutor de procesos; inyectable en tests. Por defecto `runProcess`. */
  run?: RunProcess;
  /** Habilita el runtime JS de Node para yt-dlp. Por defecto según la versión de Node. */
  jsRuntime?: boolean;
  /** Notifica la etapa en curso (para mostrar progreso en el dashboard). */
  onStage?: (stage: MediaStage) => void;
}

/** Etapas visibles del proceso de media. */
export type MediaStage = "downloading" | "converting";

export interface Clip {
  id: string;
  path: string;
  durationSec: number;
  sizeBytes: number;
  title: string;
  /** ¿El archivo tiene imagen? Los videos sí; los audios locales no. */
  hasVideo?: boolean;
  /** ¿Es un archivo local (nunca se limpia solo)? */
  local?: boolean;
}

export type MediaResult =
  | { ok: true; clip: Clip }
  | { ok: false; reason: MediaErrorCode; message: string };

export const DEFAULT_MEDIA_LIMITS = {
  maxDurationSec: 120,
  maxBytes: 100 * 1024 * 1024,
  timeoutMs: 120_000,
  maxHeight: 1080,
} as const;

/**
 * Versión mínima de Node para usar el runtime JS de yt-dlp (EJS).
 * Ver https://github.com/yt-dlp/yt-dlp/wiki/EJS y docs/media-js-runtime.md.
 */
export const EJS_MIN_NODE_MAJOR = 22;

/** ¿El Node en el que corre la app sirve como runtime JS de yt-dlp? */
export function nodeSupportsEjs(version: string = process.versions.node): boolean {
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major >= EJS_MIN_NODE_MAJOR;
}

interface ClipMeta {
  id: string;
  title: string;
  durationSec: number;
  sizeBytes: number;
  sourceUrl: string;
  createdAt: string;
}

export interface VideoInfo {
  title?: string;
  duration?: number;
  ext?: string;
  vcodec?: string;
  acodec?: string;
}

function clipId(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 32);
}

const NON_MEDIA_EXTENSIONS = new Set(["mhtml", "html", "htm"]);

function hasNonMediaExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return NON_MEDIA_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * ¿La descarga sirve como media? Frena páginas (mhtml/html) y formatos sin
 * pistas de video ni audio (p. ej. un storyboard: vcodec y acodec = "none").
 * yt-dlp puede terminar con éxito habiendo bajado una de esas cosas.
 */
export function isUsableDownload(sourcePath: string, info: VideoInfo | null): boolean {
  if (hasNonMediaExtension(sourcePath)) return false;
  if (info && info.vcodec === "none" && info.acodec === "none") return false;
  return true;
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function failure(reason: MediaErrorCode, message: string): MediaResult {
  return { ok: false, reason, message };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Mensaje corto en español para el usuario. Nunca incluye la salida cruda del
 * proceso (esa va al log en disco).
 */
function downloadFailureMessage(
  reason: MediaErrorCode,
  limits: { maxDurationSec: number; maxBytes: number },
): string {
  switch (reason) {
    case "TOO_LONG":
      return `El video dura más de ${limits.maxDurationSec} s (límite configurado).`;
    case "TOO_BIG":
      return `El video pesa más de ${formatMb(limits.maxBytes)} (límite configurado).`;
    default:
      return "No se pudo descargar el video. Revisá el archivo de log para más detalles.";
  }
}

/** Registra el proceso en disco (best-effort) y devuelve el fallo tipado. */
function logFailure(
  logsDir: string,
  label: string,
  data: { command: string; args: readonly string[]; result: ProcessResult },
  reason: MediaErrorCode,
  message: string,
): MediaResult {
  writeProcessLog(logsDir, label, {
    command: data.command,
    args: data.args,
    code: data.result.code,
    timedOut: data.result.timedOut,
    stdout: data.result.stdout,
    stderr: data.result.stderr,
  });
  return failure(reason, message);
}

/** Archivo descargado por yt-dlp: `<id>.src.<ext>` (nunca el título del video). */
function findDownloadedSource(mediaDir: string, id: string): string | null {
  const prefix = `${id}.src.`;
  const match = readdirSync(mediaDir).find((name) => {
    if (!name.startsWith(prefix)) return false;
    return !name.endsWith(".json") && !name.endsWith(".part") && !name.endsWith(".ytdl");
  });
  return match ? join(mediaDir, match) : null;
}

/** Traduce la salida de yt-dlp a un código de error cuando no hay archivo descargado. */
function classifyYtdlpFailure(result: ProcessResult): MediaErrorCode {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (output.includes("does not pass filter")) return "TOO_LONG";
  if (output.includes("max-filesize") || output.includes("larger than")) return "TOO_BIG";
  return "DOWNLOAD_FAILED";
}

export async function processVideo(url: string, options: MediaOptions): Promise<MediaResult> {
  const maxDurationSec = options.maxDurationSec ?? DEFAULT_MEDIA_LIMITS.maxDurationSec;
  const maxBytes = options.maxBytes ?? DEFAULT_MEDIA_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_LIMITS.timeoutMs;
  const maxHeight = options.maxHeight ?? DEFAULT_MEDIA_LIMITS.maxHeight;
  const run = options.run ?? runProcess;
  const logsDir = options.logsDir ?? join(options.mediaDir, "..", "logs");
  const useJsRuntime = options.jsRuntime ?? nodeSupportsEjs();

  const validation = validateUrl(url, {
    allowedDomains: options.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS,
    maxUrlLength: options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH,
  });
  if (!validation.ok) {
    const messages: Record<typeof validation.reason, string> = {
      URL_INVALID: "La URL no es válida: solo se aceptan URLs https, sin credenciales.",
      DOMAIN_NOT_ALLOWED: "El dominio del video no está permitido.",
      TOO_LONG: "La URL es demasiado larga.",
    };
    return failure(validation.reason, messages[validation.reason]);
  }

  const mediaDir = options.mediaDir;
  mkdirSync(mediaDir, { recursive: true });

  const id = clipId(validation.url);
  const outputPath = join(mediaDir, `${id}.mp4`);
  const metaPath = join(mediaDir, `${id}.json`);

  const cachedMeta = readJsonFile<ClipMeta>(metaPath);
  if (existsSync(outputPath) && cachedMeta) {
    return {
      ok: true,
      clip: {
        id,
        path: outputPath,
        durationSec: cachedMeta.durationSec,
        sizeBytes: cachedMeta.sizeBytes,
        title: cachedMeta.title,
        hasVideo: true,
        local: false,
      },
    };
  }

  const detection = detectBinaries(options.binarySearch);
  if (!detection.ok) return failure("BINARY_MISSING", detection.message);

  const sourceBase = `${id}.src`;
  const outputTemplate = join(mediaDir, `${sourceBase}.%(ext)s`);
  const infoPath = join(mediaDir, `${sourceBase}.info.json`);

  const ytdlpBin = detection.binaries.ytDlp;
  const ytdlpArgs = buildYtdlpArgs(validation.url, outputTemplate, {
    maxBytes,
    maxDurationSec,
    jsRuntime: useJsRuntime ? "node" : undefined,
  });
  options.onStage?.("downloading");
  const download = await run(ytdlpBin, ytdlpArgs, { timeoutMs, cwd: mediaDir });
  const downloadLog = { command: ytdlpBin, args: ytdlpArgs, result: download };

  if (download.timedOut) {
    rmSync(infoPath, { force: true });
    return logFailure(
      logsDir,
      "yt-dlp",
      downloadLog,
      "TIMEOUT",
      `La descarga excedió el tiempo máximo (${Math.round(timeoutMs / 1000)} s).`,
    );
  }

  // Si yt-dlp terminó con error, confiamos en su exit code y no en la
  // existencia de un archivo: puede haber dejado una página (.mhtml) o un
  // archivo parcial que no es un video.
  const source = findDownloadedSource(mediaDir, id);
  if (download.code !== 0 || !source) {
    if (source) rmSync(source, { force: true });
    rmSync(infoPath, { force: true });
    const reason = classifyYtdlpFailure(download);
    return logFailure(
      logsDir,
      "yt-dlp",
      downloadLog,
      reason,
      downloadFailureMessage(reason, { maxDurationSec, maxBytes }),
    );
  }

  const info = readJsonFile<VideoInfo>(infoPath);

  // yt-dlp puede terminar con éxito habiendo bajado una página (mhtml) o un
  // storyboard en vez del video, típicamente con una versión vieja frente a
  // YouTube. Lo frenamos antes de ffmpeg, que fallaría con un error confuso.
  if (!isUsableDownload(source, info)) {
    rmSync(source, { force: true });
    rmSync(infoPath, { force: true });
    return logFailure(
      logsDir,
      "yt-dlp",
      downloadLog,
      "DOWNLOAD_FAILED",
      "yt-dlp no obtuvo un video reproducible. Probá actualizarlo (`yt-dlp -U`).",
    );
  }

  const sourceSize = statSync(source).size;
  if (sourceSize > maxBytes) {
    rmSync(source, { force: true });
    rmSync(infoPath, { force: true });
    return failure("TOO_BIG", downloadFailureMessage("TOO_BIG", { maxDurationSec, maxBytes }));
  }

  const ffmpegBin = detection.binaries.ffmpeg;
  const ffmpegArgs = buildFfmpegArgs(source, outputPath, { maxHeight });
  options.onStage?.("converting");
  const convert = await run(ffmpegBin, ffmpegArgs, { timeoutMs });
  rmSync(source, { force: true });
  rmSync(infoPath, { force: true });

  if (convert.timedOut) {
    return logFailure(
      logsDir,
      "ffmpeg",
      { command: ffmpegBin, args: ffmpegArgs, result: convert },
      "TIMEOUT",
      `La conversión excedió el tiempo máximo (${Math.round(timeoutMs / 1000)} s).`,
    );
  }
  if (convert.code !== 0 || !existsSync(outputPath)) {
    return logFailure(
      logsDir,
      "ffmpeg",
      { command: ffmpegBin, args: ffmpegArgs, result: convert },
      "CONVERT_FAILED",
      "No se pudo convertir el video a mp4. Revisá el archivo de log para más detalles.",
    );
  }

  const sizeBytes = statSync(outputPath).size;
  const durationSec = Math.round(info?.duration ?? 0);
  const title = info?.title ?? id;

  const meta: ClipMeta = {
    id,
    title,
    durationSec,
    sizeBytes,
    sourceUrl: validation.url,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  // Miniatura real (sección 2.4). Un video descargado por link siempre tiene
  // imagen. Si falla, el clip queda igual y sin miniatura.
  await generateThumbnail(outputPath, id, {
    mediaDir,
    durationSec,
    logsDir,
    binarySearch: options.binarySearch,
    run: options.run,
    timeoutMs,
  });

  return { ok: true, clip: { id, path: outputPath, durationSec, sizeBytes, title, hasVideo: true, local: false } };
}