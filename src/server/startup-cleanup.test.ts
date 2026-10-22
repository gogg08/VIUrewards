/**
 * Integración del arranque: la evidencia de temporales y la limpieza.
 *
 * Lo que se verifica sobre el pedido de limpieza real de `scripts/start.ts`
 * (`runStartupCleanup`), con carpetas y base temporales:
 *
 *  - un `.upload` y un `.src` viejos y huérfanos se borran;
 *  - una salida de conversión interrumpida (mp4 sin fila + libro) se borra;
 *  - un clip registrado, su sidecar, su miniatura y un archivo ajeno se conservan;
 *  - la limpieza NO toca el libro (es de solo lectura) y es idempotente;
 *  - sin exclusividad no borra nada pero no impide arrancar.
 *
 * El arranque completo como proceso hijo está en `tests/e2e/startup-cleanup.test.ts`
 * (`npm run test:e2e`), que además comprueba el cierre ordenado y la segunda
 * instancia.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { upsertClip } from "../db/clips.ts";
import { openMemoryDatabase, type SqliteDatabase } from "../db/database.ts";
import { FileMediaOperationJournal, pendingMediaPath } from "../media/pending-media.ts";
import { runStartupCleanup } from "../../scripts/start.ts";
import { openMediaDir } from "../media/cleanup.ts";

const HOUR = 60 * 60 * 1000;
const CLIP_ID = "9a3b1c4d5e6f708192a3b4c5d6e7f801";
const OTHER_ID = "c0ffee00deadbeefc0ffee00deadbeef";
const STALE_SOURCE_ID = "deadbeefdeadbeefdeadbeefdeadbeef";
const UUID = "0d9b1f6e-1f2a-4a3c-9d19-7f5b6c0e2a44";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

interface Env {
  root: string;
  mediaDir: string;
  uploadsDir: string;
  logsDir: string;
  db: SqliteDatabase;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "startup-cleanup-"));
  dirs.push(root);
  const mediaDir = join(root, "media");
  const uploadsDir = join(root, ".uploads");
  const logsDir = join(root, "logs");
  for (const dir of [mediaDir, uploadsDir, logsDir]) mkdirSync(dir, { recursive: true });
  return { root, mediaDir, uploadsDir, logsDir, db: openMemoryDatabase() };
}

function writeAged(path: string, ageHours: number, content = "x"): void {
  writeFileSync(path, content, "utf8");
  const when = new Date(Date.now() - ageHours * HOUR);
  utimesSync(path, when, when);
}

function registerClip(env: Env): void {
  upsertClip(env.db, {
    id: CLIP_ID,
    sourceUrl: "https://www.youtube.com/watch?v=x",
    title: "Clip registrado",
    durationSec: 5,
    sizeBytes: 1,
    file: `${CLIP_ID}.mp4`,
    createdAt: new Date().toISOString(),
    trimStart: null,
    trimEnd: null,
    hasVideo: true,
    missing: false,
  });
}

function silentConsole<T>(run: () => T): T {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return run();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

describe("runStartupCleanup (pedido real del arranque)", () => {
  it("crea la carpeta de medios si no existe (instalación nueva)", () => {
    const env = makeEnv();
    rmSync(env.mediaDir, { recursive: true, force: true });
    expect(openMediaDir(env.mediaDir).ok).toBe(true);
    expect(existsSync(env.mediaDir)).toBe(true);
  });

  it("borra huérfanos viejos y conserva la biblioteca", () => {
    const env = makeEnv();
    registerClip(env);
    const staleUpload = join(env.uploadsDir, `${UUID}.upload`);
    const staleSource = join(env.mediaDir, `${STALE_SOURCE_ID}.src.mp4`);
    const partial = join(env.mediaDir, `${STALE_SOURCE_ID}.mp4.part`);
    const interrupted = join(env.mediaDir, `${OTHER_ID}.mp4`);
    const clipFile = join(env.mediaDir, `${CLIP_ID}.mp4`);
    const sidecar = join(env.mediaDir, `${CLIP_ID}.json`);
    const stranger = join(env.mediaDir, "video-casero.mp4");
    for (const path of [staleUpload, staleSource, partial, interrupted, clipFile, stranger]) writeAged(path, 30);
    writeFileSync(sidecar, JSON.stringify({ title: "Clip registrado" }), "utf8");
    writeFileSync(pendingMediaPath(env.logsDir), `encodes ${OTHER_ID}\n`, "utf8");

    const evidence = new FileMediaOperationJournal(env.logsDir, { transient: true });
    silentConsole(() => runStartupCleanup(env.db, env.mediaDir, env.uploadsDir, evidence, true));

    for (const path of [staleUpload, staleSource, partial, interrupted]) {
      expect(existsSync(path), path).toBe(false);
    }
    for (const path of [clipFile, sidecar, stranger]) expect(existsSync(path), path).toBe(true);
    // El libro es de solo lectura: la evidencia sigue escrita para el próximo paso.
    expect(readFileSync(pendingMediaPath(env.logsDir), "utf8")).toBe(`encodes ${OTHER_ID}\n`);
  });

  it("un temporal reciente se conserva (puede ser de una operación en curso)", () => {
    const env = makeEnv();
    const recent = join(env.uploadsDir, `${UUID}.upload`);
    writeAged(recent, 1);
    const evidence = new FileMediaOperationJournal(env.logsDir, { transient: true });
    silentConsole(() => runStartupCleanup(env.db, env.mediaDir, env.uploadsDir, evidence, true));
    expect(existsSync(recent)).toBe(true);
  });

  it("sin exclusividad no borra nada (otra copia puede estar usándolo)", () => {
    const env = makeEnv();
    const stale = join(env.uploadsDir, `${UUID}.upload`);
    writeAged(stale, 30);
    const evidence = new FileMediaOperationJournal(env.logsDir, { transient: true });
    silentConsole(() => runStartupCleanup(env.db, env.mediaDir, env.uploadsDir, evidence, false));
    expect(existsSync(stale)).toBe(true);
  });

  it("es idempotente: la segunda vez no hay nada que borrar", () => {
    const env = makeEnv();
    const stale = join(env.uploadsDir, `${UUID}.upload`);
    writeAged(stale, 30);
    const evidence = new FileMediaOperationJournal(env.logsDir, { transient: true });
    silentConsole(() => runStartupCleanup(env.db, env.mediaDir, env.uploadsDir, evidence, true));
    expect(existsSync(stale)).toBe(false);
    // No lanza ni toca nada más.
    silentConsole(() => runStartupCleanup(env.db, env.mediaDir, env.uploadsDir, evidence, true));
    expect(existsSync(stale)).toBe(false);
  });

  it("un error imprevisto no impide arrancar", () => {
    const env = makeEnv();
    env.db.close(); // La base no sirve: todo lo que la use falla.
    silentConsole(() => runStartupCleanup(env.db, env.mediaDir, env.uploadsDir, new FileMediaOperationJournal(null), true));
    // Llegar acá sin lanzar es el contrato: el arranque sigue.
    expect(true).toBe(true);
  });
});
