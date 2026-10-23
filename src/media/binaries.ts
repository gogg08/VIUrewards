/**
 * Detección de binarios externos (Fase 1).
 *
 * Busca yt-dlp y ffmpeg en `./bin` y en el PATH. Todavía no los descarga.
 * En Windows solo se aceptan ejecutables (`.exe`): un `.cmd` o `.bat` no se
 * puede lanzar con `spawn` sin shell, y no queremos usar shell por el riesgo
 * de inyección (AGENTS.md #1).
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface BinaryPaths {
  ytDlp: string;
  ffmpeg: string;
  ffprobe: string;
}

export type BinaryDetection =
  | { ok: true; binaries: BinaryPaths }
  | { ok: false; missing: string[]; message: string };

export interface FindBinaryOptions {
  /** Valor de PATH a usar; por defecto `process.env.PATH`. */
  pathEnv?: string;
  /** Directorios extra donde buscar, en orden, antes del PATH. */
  extraDirs?: string[];
  platform?: NodeJS.Platform;
  /** Inyectable en tests; por defecto `existsSync`. */
  exists?: (path: string) => boolean;
  /**
   * Directorio de herramientas administradas, buscado ANTES que todo lo demás.
   * Debe ser una ruta ya resuelta (absoluta): `detectBinaries` nunca la deriva
   * del directorio de trabajo. Vive acá (y no solo en `detectBinaries`) para que
   * también lo respete un `findBinary` directo.
   */
  binDir?: string;
}

export function binaryCandidates(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.exe`, name] : [name];
}

export function findBinary(name: string, options: FindBinaryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const pathDirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0);
  // El `binDir` administrado tiene prioridad sobre cualquier `extraDirs`.
  const dirs = [
    ...(options.binDir ? [options.binDir] : []),
    ...(options.extraDirs ?? []),
    ...pathDirs,
  ];

  for (const dir of dirs) {
    for (const candidate of binaryCandidates(name, platform)) {
      const full = join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return null;
}

function missingMessage(missing: string[]): string {
  return [
    `Faltan binarios externos: ${missing.join(", ")}.`,
    "Instalalos y volvé a intentar:",
    "  Windows:  winget install yt-dlp.yt-dlp   y   winget install Gyan.FFmpeg",
    "  macOS:    brew install yt-dlp ffmpeg",
    "  Linux:    sudo apt install yt-dlp ffmpeg",
    "También podés poner los ejecutables en la carpeta bin/ del proyecto.",
  ].join("\n");
}

export function detectBinaries(
  options: FindBinaryOptions & { binDir?: string } = {},
): BinaryDetection {
  // Sin `binDir` se conserva el comportamiento histórico: `bin/` relativo al
  // directorio de trabajo. El arranque siempre pasa una ruta absoluta.
  const binDir = options.binDir ?? "bin";
  const extraDirs = options.extraDirs ?? [];

  const ytDlp = findBinary("yt-dlp", { ...options, extraDirs, binDir });
  const ffmpeg = findBinary("ffmpeg", { ...options, extraDirs, binDir });
  // ffprobe se usa para validar archivos locales por contenido (Etapa 3B). Suele
  // venir junto con ffmpeg; si no está, la subida de archivos locales falla con
  // un mensaje claro en vez de intentar adivinar el tipo por la extensión.
  const ffprobe = findBinary("ffprobe", { ...options, extraDirs, binDir });

  if (ytDlp && ffmpeg && ffprobe) return { ok: true, binaries: { ytDlp, ffmpeg, ffprobe } };

  const missing: string[] = [];
  if (!ytDlp) missing.push("yt-dlp");
  if (!ffmpeg) missing.push("ffmpeg");
  if (!ffprobe) missing.push("ffprobe");
  return { ok: false, missing, message: missingMessage(missing) };
}