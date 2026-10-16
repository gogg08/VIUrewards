#!/usr/bin/env node
/**
 * Arranque completo del producto (Fase 3).
 *
 * Levanta API, dashboard, overlay y WebSocket en un solo proceso. Es el único
 * comando que necesita el usuario final:
 *
 *   npm start
 *
 * Opciones: `--port=8787` (o la variable de entorno PORT).
 */

import { join } from "node:path";

import { openDatabase, reconcileClips, type SqliteDatabase } from "../src/db/index.ts";
import { createClipRebuilder } from "../src/media/rebuild.ts";
import { createServer } from "../src/server/server.ts";
import { readSettings } from "../src/server/settings.ts";

function resolvePort(args: string[], db: SqliteDatabase): number {
  const flag = args.find((arg) => arg.startsWith("--port="));
  const raw = flag ? flag.slice("--port=".length) : process.env.PORT;
  if (raw !== undefined) {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return readSettings(db).port;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const mediaDir = join(root, "media");
  const dataDir = join(root, "data");

  const db = openDatabase(join(dataDir, "app.db"));

  // Reconciliación de arranque: pone la biblioteca de acuerdo con /media. Nunca
  // borra clips en silencio: agrega los que falten (sidecar o ffprobe), MARCA
  // los que perdieron su archivo y aborta sin tocar nada si la carpeta no se
  // puede leer. El id y el nombre de archivo nunca cambian.
  const result = await reconcileClips(db, mediaDir, {
    rebuild: createClipRebuilder({ mediaDir }),
    log: (message) => console.log(message),
  });

  if (result.aborted) {
    console.warn(`Aviso: ${result.message ?? "no se pudo revisar la carpeta de medios."}`);
  } else if (
    result.added.length > 0 ||
    result.missing.length > 0 ||
    result.restored.length > 0 ||
    result.skipped.length > 0
  ) {
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`+${result.added.length} recuperados`);
    if (result.missing.length > 0) parts.push(`${result.missing.length} sin archivo (marcados, no borrados)`);
    if (result.restored.length > 0) parts.push(`${result.restored.length} reaparecidos`);
    if (result.skipped.length > 0) parts.push(`${result.skipped.length} omitidos`);
    console.log(`Biblioteca sincronizada con /media: ${parts.join(", ")}.`);
  }

  // Aviso descartable en el dashboard (además de la consola): solo si hubo
  // recuperaciones o clips marcados sin archivo.
  const libraryNotice =
    result.added.length > 0 || result.missing.length > 0
      ? { recovered: result.added.length, missing: result.missing.length, restored: result.restored.length }
      : undefined;

  const server = await createServer({
    mediaDir,
    db,
    port: resolvePort(process.argv.slice(2), db),
    libraryNotice,
  });
  const info = await server.start();

  const firstRun = server.auth.isConfigured()
    ? ""
    : " (primera vez: te va a pedir crear una contraseña)";

  console.log("");
  console.log("VIUrewards está corriendo.");
  console.log(`  Dashboard: ${info.dashboardUrl}`);
  console.log(`  Overlay:   ${info.overlayUrl}`);
  console.log(`  Abrí el dashboard en el navegador${firstRun}.`);
  console.log("  Ctrl+C para cerrar.");
  console.log("");

  const shutdown = async (): Promise<void> => {
    await server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});