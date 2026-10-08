#!/usr/bin/env node
/**
 * Prueba rápida del overlay (Fase 2).
 *
 * Levanta el servidor local y encola un clip para verlo en OBS sin dashboard.
 *
 * Uso:
 *   node scripts/play-test.ts <clipId>            # clip ya descargado en /media
 *   node scripts/play-test.ts <url>               # descarga con yt-dlp y lo encola
 *   node scripts/play-test.ts <url> --port=8787 --media-dir=./media
 */

import { join } from "node:path";

import { createServer } from "../src/server/server.ts";
import { processVideo } from "../src/media/index.ts";

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith("--"));
  if (!target) {
    console.log("Uso: node scripts/play-test.ts <clipId|url> [--port=8787] [--media-dir=./media]");
    process.exitCode = 1;
    return;
  }

  const mediaDir = parseFlag(args, "--media-dir") ?? join(process.cwd(), "media");
  const port = Number(parseFlag(args, "--port") ?? 8787);

  let clipId = target;
  if (/^https?:\/\//i.test(target)) {
    console.log(`Descargando ${target} ...`);
    const result = await processVideo(target, { mediaDir });
    if (!result.ok) {
      console.error(`Error [${result.reason}]: ${result.message}`);
      process.exitCode = 1;
      return;
    }
    clipId = result.clip.id;
    console.log(`Clip listo: ${clipId}`);
  }

  const server = await createServer({ mediaDir, port });
  const info = await server.start();
  server.queue.enqueue({ clipId, maxDurationSec: 30 });

  console.log("\nServidor arriba. Agregá esta URL como Browser Source en OBS:");
  console.log(`  ${info.overlayUrl}`);
  console.log("Ctrl+C para cerrar.\n");

  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
