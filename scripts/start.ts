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
  const reconciled = reconcileClips(db, mediaDir);
  if (reconciled.added.length > 0 || reconciled.removed.length > 0) {
    console.log(
      `Biblioteca sincronizada con /media: +${reconciled.added.length} agregados, -${reconciled.removed.length} quitados.`,
    );
  }

  const server = await createServer({ mediaDir, db, port: resolvePort(process.argv.slice(2), db) });
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