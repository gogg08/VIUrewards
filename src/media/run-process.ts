/**
 * Ejecución de binarios externos (Fase 1).
 *
 * Siempre `spawn` con argumentos en array y `shell: false` (AGENTS.md #1).
 * Nunca se construye un string de comando.
 */

import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunProcessOptions {
  timeoutMs: number;
  cwd?: string;
  /** Tope de salida capturada por stream, para no crecer sin límite. */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function appendCapped(current: string, chunk: Buffer, cap: number): string {
  if (current.length >= cap) return current;
  const next = current + chunk.toString("utf8");
  return next.length > cap ? next.slice(0, cap) : next;
}

export type RunProcess = (
  command: string,
  args: string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export const runProcess: RunProcess = (command, args, options) => {
  return new Promise((resolve, reject) => {
    const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk, cap);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk, cap);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
};