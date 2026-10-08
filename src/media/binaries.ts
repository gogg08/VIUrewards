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
}

export function binaryCandidates(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.exe`, name] : [name];
}

export function findBinary(name: string, options: FindBinaryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const pathDirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0);
  const dirs = [...(options.extraDirs ?? []), ...pathDirs];

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
  const extraDirs = options.extraDirs ?? [options.binDir ?? "bin"];

  const ytDlp = findBinary("yt-dlp", { ...options, extraDirs });
  const ffmpeg = findBinary("ffmpeg", { ...options, extraDirs });

  if (ytDlp && ffmpeg) return { ok: true, binaries: { ytDlp, ffmpeg } };

  const missing: string[] = [];
  if (!ytDlp) missing.push("yt-dlp");
  if (!ffmpeg) missing.push("ffmpeg");
  return { ok: false, missing, message: missingMessage(missing) };
}