#!/usr/bin/env node
/**
 * CLI de prueba del núcleo de media (Fase 1).
 *
 * Descarga una URL válida, la recodifica a mp4 y la deja en /media.
 * Sin servidor, sin base de datos, sin dashboard.
 *
 * Uso (Node 22.6+ ejecuta .ts directamente; alternativa: npx tsx):
 *   node scripts/media-cli.ts <url>
 *   node scripts/media-cli.ts <url> --media-dir=./media --max-duration=120 \
 *     --max-height=1080 --timeout=120000
 */

import { join } from "node:path";

import { processVideo, DEFAULT_MEDIA_LIMITS } from "../src/media/index.ts";

interface CliOptions {
  url: string;
  mediaDir: string;
  maxDurationSec: number;
  maxHeight: number;
  timeoutMs: number;
}

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): CliOptions | null {
  const url = argv.find((arg) => !arg.startsWith("--"));
  if (!url) return null;
  return {
    url,
    mediaDir: parseFlag(argv, "--media-dir") ?? join(process.cwd(), "media"),
    maxDurationSec: parseNumber(parseFlag(argv, "--max-duration"), DEFAULT_MEDIA_LIMITS.maxDurationSec),
    maxHeight: parseNumber(parseFlag(argv, "--max-height"), DEFAULT_MEDIA_LIMITS.maxHeight),
    timeoutMs: parseNumber(parseFlag(argv, "--timeout"), DEFAULT_MEDIA_LIMITS.timeoutMs),
  };
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB (${bytes} bytes)`;
}

function printUsage(): void {
  console.log(`Uso: node scripts/media-cli.ts <url> [--media-dir=<dir>] [--max-duration=<s>]
                                       [--max-height=<px>] [--timeout=<ms>]

Ejemplo:
  node scripts/media-cli.ts "https://www.youtube.com/watch?v=dQw4w9WgXcQ"`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(`Validando y descargando: ${options.url}`);
  const result = await processVideo(options.url, {
    mediaDir: options.mediaDir,
    maxDurationSec: options.maxDurationSec,
    maxHeight: options.maxHeight,
    timeoutMs: options.timeoutMs,
  });

  if (!result.ok) {
    console.error(`\nError [${result.reason}]: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  const { clip } = result;
  console.log("\nListo:");
  console.log(`  id:         ${clip.id}`);
  console.log(`  título:     ${clip.title}`);
  console.log(`  duración:   ${clip.durationSec} s`);
  console.log(`  tamaño:     ${formatBytes(clip.sizeBytes)}`);
  console.log(`  archivo:    ${clip.path}`);
}

main().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});