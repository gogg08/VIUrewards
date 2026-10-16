/**
 * Prueba de INTEGRACIÓN de la pestaña Ajustes → Biblioteca y descargas con los
 * binarios REALES de esta PC.
 *
 * El bug que cubre: `createServer` recibía el ejecutor de procesos (`run`) solo
 * inyectado en los tests; en producción (scripts/start.ts) quedaba `undefined`,
 * así que la versión de yt-dlp salía "no detectada" y actualizar respondía
 * "No hay ejecutor de procesos disponible". Esta prueba arranca un servidor con
 * un puerto y una base TEMPORALES y SIN inyectar `run`, y verifica que
 * `GET /api/library/usage` devuelve las versiones reales.
 *
 * NO corre con `npm test`. Se corre con:
 *
 *   npm run test:e2e
 *
 * Si faltan los binarios, se SALTA con un aviso claro. NUNCA ejecuta la
 * actualización real de yt-dlp (`-U` modificaría la instalación): esa solo se
 * prueba con un `run` inyectado.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../../src/db/index.ts";
import { detectBinaries } from "../../src/media/binaries.ts";
import { createServer, type AppServer } from "../../src/server/server.ts";
import { SESSION_COOKIE } from "../../src/server/auth.ts";

const detection = detectBinaries();
const binariesAvailable = detection.ok;
const skipReason = binariesAvailable
  ? ""
  : "Se omite: faltan yt-dlp, ffmpeg y/o ffprobe reales en esta PC (o en bin/). Instalalos para correr esta prueba.";

const dirs: string[] = [];
const servers: AppServer[] = [];

afterAll(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe.skipIf(!binariesAvailable)("Ajustes → Biblioteca con binarios reales", () => {
  beforeAll(() => {
    if (!binariesAvailable) console.warn(skipReason);
  });

  it("sin inyectar `run`, /api/library/usage devuelve versiones reales", async () => {
    const parent = mkdtempSync(join(tmpdir(), "viu-e2e-tools-"));
    dirs.push(parent);
    const mediaDir = join(parent, "media");

    // Igual que scripts/start.ts: NO se pasa `run`.
    const server = await createServer({
      mediaDir,
      db: openMemoryDatabase(),
      port: 0, // puerto temporal
      requireOverlay: false,
    });
    servers.push(server);
    await server.app.ready();
    await server.auth.setPassword("contrasena-de-prueba");
    const cookie = `${SESSION_COOKIE}=${server.auth.createSession()}`;

    const response = await server.app.inject({
      method: "GET",
      url: "/api/library/usage",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.binariesOk).toBe(true);
    // Las tres versiones se detectan de verdad (no null): este es el bug real.
    expect(body.tools.ytDlp).not.toBeNull();
    expect(body.tools.ffmpeg).not.toBeNull();
    expect(body.tools.ffprobe).not.toBeNull();
  });
});
