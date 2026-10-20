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
    // Filtro de duración TOLERANTE a que el campo no exista (`<=?`): si yt-dlp
    // no conoce la duración (típico en algunos reels de Instagram), el video NO
    // se rechaza por duración; se valida después con la duración real del
    // archivo (ffprobe). Con `<=` a secas, un `duration` ausente hace fallar el
    // filtro y el reel se rechaza con "does not pass filter" aunque dure pocos
    // segundos. Ver docs/media-limits.md.
    "--match-filter",
    `duration <=? ${options.maxDurationSec}`,
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
    ...localProtocolArgs(),
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

/**
 * Args de ffmpeg para extraer UN cuadro (miniatura) de un clip con imagen. Se
 * toma un instante (`atSec`), se limita el ancho (`maxWidth`) y se codifica jpg.
 * Nunca se usa para modificar el clip: solo lee.
 */
export interface ThumbFfmpegArgsOptions {
  /** Instante del cuadro, en segundos (0 = primer cuadro). */
  atSec: number;
  /** Ancho máximo de la miniatura; la altura se calcula por aspecto. */
  maxWidth: number;
}

export function buildThumbFfmpegArgs(
  inputPath: string,
  outputPath: string,
  options: ThumbFfmpegArgsOptions,
): string[] {
  // `-ss` antes de `-i` busca rápido; `-frames:v 1` corta en el primer cuadro.
  // `scale='min(<w>,iw)':-2` no agranda imágenes más chicas que el límite.
  const scale = `scale='min(${options.maxWidth},iw)':-2`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...localProtocolArgs(),
    "-ss",
    String(Math.max(0, options.atSec)),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    scale,
    "-q:v",
    "3",
    "-f",
    "mjpeg",
    outputPath,
  ];
}

/**
 * Argumentos que RESTRINGEN las entradas a archivos locales (robustez, sección
 * 3.1): impide que un archivo disfrazado (lista de reproducción, concat, HLS) lea
 * otros archivos o abra conexiones de red. `file` cubre archivos y, con
 * `-f concat`/HLS, los subprotocolos quedan fuera de la whitelist.
 */
export function localProtocolArgs(): string[] {
  return ["-protocol_whitelist", "file"];
}

/**
 * Args de ffprobe para inspeccionar un archivo local por CONTENIDO (Etapa 3B).
 * Devuelve un JSON con los streams y el formato; la extensión del archivo no se
 * usa para decidir el tipo. `-show_error` deja el error legible si el archivo no
 * es media.
 */
export function buildFfprobeArgs(inputPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...localProtocolArgs(),
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-i",
    inputPath,
  ];
}

export interface AudioFfmpegArgsOptions {
  /** Bitrate de audio en kbps. */
  audioBitrateKbps?: number;
}

/**
 * Args de ffmpeg para normalizar un archivo SIN imagen a m4a (AAC), aplicando la
 * misma normalización de volumen que los videos (Etapa 3B).
 */
export function buildAudioFfmpegArgs(
  inputPath: string,
  outputPath: string,
  options: AudioFfmpegArgsOptions = {},
): string[] {
  const bitrate = options.audioBitrateKbps ?? 128;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...localProtocolArgs(),
    "-i",
    inputPath,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    `${bitrate}k`,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-movflags",
    "+faststart",
    "-f",
    "ipod",
    outputPath,
  ];
}