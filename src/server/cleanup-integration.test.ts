/**
 * Integración de la limpieza de arranque con el servidor REAL.
 *
 * Verifica el orden y la coordinación (no vuelve a probar el barrido en sí, eso
 * está en `src/media/cleanup.test.ts`): el servidor crea `.uploads/` para los
 * temporales de subidas y el libro de operaciones vive en `logs/`, así que ambos
 * tienen que apuntar a las MISMAS carpetas que usa el arranque (`scripts/start.ts`).
 * Si no coinciden, la limpieza no ve lo que el servidor dejó.
 *
 * Todo sobre carpetas temporales: nunca `data/`, `media/`, `logs/` ni `.uploads/`
 * del usuario.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../db/database.ts";
import { upsertClip } from "../db/clips.ts";
import { cleanupOrphanTemporaries } from "../media/cleanup.ts";
import { MediaOperationJournal, pendingMediaPath } from "../media/pending-media.ts";
import { createServer } from "./server.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const HOUR = 60 * 60 * 1000;
const OLD_HOURS = 30;
const UUID = "6f1c2a52-7c2e-4a52-9a5f-2b2d5c0e9b11";
const CLIP_ID = "5c2cd8f22bbd6c6b1a7de4d9b82b0d11";

function writeAged(path: string, ageHours: number): void {
  writeFileSync(path, "x", "utf8");
  const when = new Date(Date.now() - ageHours * HOUR);
  utimesSync(path, when, when);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "viu-cleanup-integration-"));
  dirs.push(root);
  return root;
}

describe("carpetas de la limpieza y del servidor", () => {
  it("el servidor usa el .uploads/ y el logs/ que supone la limpieza de arranque", async () => {
    const root = makeRoot();
    const mediaDir = join(root, "media");
    mkdirSync(mediaDir);

    const server = await createServer({ mediaDir, db: openMemoryDatabase(), port: 0 });
    try {
      // Mismas rutas por defecto que `scripts/start.ts` (`<raíz>/.uploads`,
      // `<raíz>/logs`), no otras.
      expect(existsSync(join(root, ".uploads"))).toBe(true);
      expect(server.uploadsDir).toBe(join(root, ".uploads"));
      // El libro solo se escribe cuando hay una operación: la ruta es la misma.
      expect(server.journalPath).toBe(pendingMediaPath(join(root, "logs")));
    } finally {
      await server.stop();
    }
  });

  it("una subida interrumpida que dejó el servidor se limpia después, con el mismo directorio", async () => {
    const root = makeRoot();
    const mediaDir = join(root, "media");
    mkdirSync(mediaDir);

    const db = openMemoryDatabase();
    const server = await createServer({ mediaDir, db, port: 0 });
    let reap: ReturnType<typeof cleanupOrphanTemporaries> | null = null;
    try {
      const stale = join(root, ".uploads", `${UUID}.upload`);
      writeAged(stale, OLD_HOURS);
      // Una conversión declarada y no terminada (cierre abrupto) antes de abrir la
      // biblioteca: el mp4 sin fila queda como artefacto de la app.
      const journal = new MediaOperationJournal(join(root, "logs"));
      journal.begin("encodes", CLIP_ID);
      const output = join(mediaDir, `${CLIP_ID}.mp4`);
      writeAged(output, OLD_HOURS);

      reap = cleanupOrphanTemporaries({ mediaDir, db, hasExclusiveAccess: true, journal });

      expect(reap.removed.sort()).toEqual([`${CLIP_ID}.mp4`, `${UUID}.upload`].sort());
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(output)).toBe(false);
    } finally {
      await server.stop();
      db.close();
    }
  });

  it("un clip registrado y su archivo sobreviven a la limpieza hecha al lado del servidor", async () => {
    const root = makeRoot();
    const mediaDir = join(root, "media");
    mkdirSync(mediaDir);
    const db = openMemoryDatabase();
    const file = `${CLIP_ID}.mp4`;
    writeAged(join(mediaDir, file), OLD_HOURS);
    upsertClip(db, {
      id: CLIP_ID,
      sourceUrl: "https://www.youtube.com/watch?v=x",
      title: "Clip",
      durationSec: 5,
      sizeBytes: 1,
      file,
      createdAt: new Date().toISOString(),
      trimStart: null,
      trimEnd: null,
      hasVideo: true,
      missing: false,
    });

    const server = await createServer({ mediaDir, db, port: 0 });
    try {
      const journal = new MediaOperationJournal(join(root, "logs"));
      const result = cleanupOrphanTemporaries({ mediaDir, db, hasExclusiveAccess: true, journal });
      expect(result.removed).toEqual([]);
      expect(existsSync(join(mediaDir, file))).toBe(true);
    } finally {
      await server.stop();
      db.close();
    }
  });

  it("el cierre ordenado del servidor no deja el libro con operaciones de la sesión", async () => {
    const root = makeRoot();
    const mediaDir = join(root, "media");
    mkdirSync(mediaDir);
    const logsDir = join(root, "logs");
    mkdirSync(logsDir, { recursive: true });
    const journal = new MediaOperationJournal(logsDir);
    journal.begin("encodes", CLIP_ID);

    const server = await createServer({ mediaDir, logDir: logsDir, journal, db: openMemoryDatabase(), port: 0 });
    await server.start();
    await server.stop();
    await server.stop(); // Idempotente: no vuelve a limpiar ni rompe.

    // Lo único que queda en el libro es lo que dejó una ejecución anterior (acá,
    // la línea que declaramos nosotros); el cierre no agrega nada.
    const text = readFileSync(pendingMediaPath(logsDir), "utf8");
    expect(text.trim()).toBe(`encodes ${CLIP_ID}`);
  });
});
