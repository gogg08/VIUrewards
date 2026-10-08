/**
 * Construcción de argumentos para los binarios externos (Fase 1).
 *
 * Estas funciones son puras y devuelven `string[]`: nunca se concatena un
 * comando. La URL descargada siempre va al final, precedida por `--`, para que
 * yt-dlp no la interprete como una opción aunque empiece con `-`.
 */

export interface YtdlpArgsOptions {
  /** Tamaño máximo del archivo a descargar, en bytes. */
  maxBytes: number;
  /** Duración máxima del video, en segundos. */
  maxDurationSec: number;
  /**
   * Runtime JS a habilitar (p. ej. "node"). YouTube requiere un runtime externo
   * para resolver sus desafíos JS; sin él, yt-dlp avisa que ciertos formatos
   * pueden faltar. Si se omite, no se agrega el flag. Ver docs/media-js-runtime.md.
   */
  jsRuntime?: string;
}

export function buildYtdlpArgs(
  url: string,
  outputTemplate: string,
  options: YtdlpArgsOptions,
): string[] {
  return [
    "--no-playlist",
    "--no-progress",
    ...(options.jsRuntime ? ["--js-runtimes", options.jsRuntime] : []),
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "--max-filesize",
    String(Math.floor(options.maxBytes)),
    "--match-filter",
    `duration <= ${options.maxDurationSec}`,
    "--write-info-json",
    "-o",
    outputTemplate,
    "--",
    url,
  ];
}

export interface FfmpegArgsOptions {
  /** Altura máxima de salida, en píxeles (el ancho se calcula conservando el aspecto). */
  maxHeight: number;
}

export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  options: FfmpegArgsOptions,
): string[] {
  // `-2` fuerza ancho par; `min(...)` no agranda videos más chicos que el límite.
  const scale = `scale=-2:'min(${options.maxHeight},ih)'`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-vf",
    scale,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}