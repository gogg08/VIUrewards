/**
 * Log de procesos externos (Fase 1).
 *
 * La salida cruda de yt-dlp/ffmpeg (stderr y stdout) se guarda en disco para
 * depurar, pero nunca se muestra al usuario ni se incluye en los mensajes de
 * error. La app es para usuarios no técnicos: ven un mensaje corto en español.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcessLogData {
  /** Ejecutable lanzado. */
  command: string;
  /** Argumentos (sin secretos: el módulo de media no maneja tokens). */
  args: readonly string[];
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Escribe el detalle crudo de un proceso a `<logsDir>/<stamp>-<label>.log`.
 * Best-effort: si falla, devuelve `null` y no interrumpe el flujo.
 */
export function writeProcessLog(
  logsDir: string,
  label: string,
  data: ProcessLogData,
): string | null {
  try {
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(logsDir, `${stamp}-${label}.log`);
    const body = [
      `command: ${data.command}`,
      `args: ${JSON.stringify(data.args)}`,
      `exitCode: ${data.code}`,
      `timedOut: ${data.timedOut}`,
      "",
      "--- stdout ---",
      data.stdout.trim(),
      "--- stderr ---",
      data.stderr.trim(),
      "",
    ].join("\n");
    writeFileSync(path, body, "utf8");
    return path;
  } catch {
    return null;
  }
}