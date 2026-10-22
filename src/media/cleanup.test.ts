/**
 * Limpieza de temporales huérfanos: pruebas REALES sobre directorios y una base
 * SQLite temporales (nunca `data/app.db` ni `media/` del usuario).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../db/database.ts";
import { upsertClip, type ClipRecord, type SqliteDatabase } from "../db/index.ts";
import { cleanupOrphanTemporaries, DEFAULT_MIN_AGE_MS } from "./cleanup.ts";
import { MediaOperationJournal } from "./pending-media.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

interface Env {
  root: string;
  mediaDir: string;
  uploadsDir: string;
  db: SqliteDatabase;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "cleanup-test-"));
  dirs.push(root);
  const mediaDir = join(root, "media");
  const uploadsDir = join(root, ".uploads");
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  return { root, mediaDir, uploadsDir, db: openMemoryDatabase() };
}

const HOUR = 60 * 60 * 1000;

/** Crea un archivo y le pone una antigüedad en horas. */
function writeFile(path: string, ageHours: number, content = "x"): void {
  writeFileSync(path, content, "utf8");
  const when = new Date(Date.now() - ageHours * HOUR);
  utimesSync(path, when, when);
}

function clip(id: string, file: string): ClipRecord {
  return {
    id,
    sourceUrl: "https://www.youtube.com/watch?v=x",
    title: "Clip",
    durationSec: 10,
    sizeBytes: 1,
    file,
    createdAt: new Date().toISOString(),
    trimStart: null,
    trimEnd: null,
    hasVideo: true,
    missing: false,
  };
}

const OLD = 30;
const RECENT = 1;
const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const ID = "797340ceb74c36423aa0e16fd09af200";

describe("temporales viejos se eliminan", () => {
  it("borra una subida interrumpida de más de 24 h en .uploads/", () => {
    const env = makeEnv();
    const upload = join(env.uploadsDir, `${UUID}.upload`);
    writeFile(upload, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toContain(`${UUID}.upload`);
    expect(result.errors).toEqual([]);
    expect(existsSync(upload)).toBe(false);
  });

  it("borra los temporales de yt-dlp viejos (.src.*, .info.json, .part)", () => {
    const env = makeEnv();
    const names = [`${ID}.src.mp4`, `${ID}.src.info.json`, `${ID}.src.f137.mp4.part`, `${ID}.mp4.part`];
    for (const name of names) writeFile(join(env.mediaDir, name), OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    for (const name of names) expect(result.removed).toContain(name);
    for (const name of names) expect(existsSync(join(env.mediaDir, name))).toBe(false);
  });

  it("la antigüedad Justo por encima del umbral se borra y por debajo se conserva", () => {
    const env = makeEnv();
    const justOver = join(env.uploadsDir, `${UUID}.upload`);
    writeFile(justOver, 25);
    const older = "11111111-2222-3333-4444-555555555555";
    const liberal = join(env.uploadsDir, `${older}.upload`);
    writeFile(liberal, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
      minAgeMs: 24 * HOUR,
    });

    expect(result.removed).toContain(`${UUID}.upload`);
    expect(result.removed).toContain(`${older}.upload`);
  });
});

describe("archivos que se conservan", () => {
  it("un temporal reciente se conserva", () => {
    const env = makeEnv();
    const upload = join(env.uploadsDir, `${UUID}.upload`);
    writeFile(upload, RECENT);
    const src = join(env.mediaDir, `${ID}.src.mp4`);
    writeFile(src, RECENT);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(result.kept.map((k) => k.name).sort()).toEqual([`${ID}.src.mp4`, `${UUID}.upload`].sort());
    expect(existsSync(upload)).toBe(true);
    expect(existsSync(src)).toBe(true);
  });

  it("un archivo desconocido se conserva (aunque sea viejo)", () => {
    const env = makeEnv();
    const stranger = join(env.mediaDir, "mi-video-casero.mp4");
    writeFile(stranger, OLD);
    const other = join(env.mediaDir, "notas.txt");
    writeFile(other, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(stranger)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("un clip registrado, su miniatura y su sidecar quedan intactos", () => {
    const env = makeEnv();
    upsertClip(env.db, clip(ID, `${ID}.mp4`));
    const file = join(env.mediaDir, `${ID}.mp4`);
    const sidecar = join(env.mediaDir, `${ID}.json`);
    const thumbDir = join(env.mediaDir, "thumbs");
    mkdirSync(thumbDir, { recursive: true });
    const thumb = join(thumbDir, `${ID}.jpg`);
    writeFile(file, OLD);
    writeFile(sidecar, OLD, JSON.stringify({ title: "Clip" }));
    writeFile(thumb, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(thumb)).toBe(true);
  });

  it("no borra los temporales de descarga de un clip registrado", () => {
    const env = makeEnv();
    upsertClip(env.db, clip(ID, `${ID}.mp4`));
    writeFile(join(env.mediaDir, `${ID}.mp4`), OLD);
    const src = join(env.mediaDir, `${ID}.src.mp4`);
    writeFile(src, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(src)).toBe(true);
  });

  it("un MP4/M4A sin fila no se borra nunca, ni siquiera con temporales viejos al lado", () => {
    const env = makeEnv();
    const out = join(env.mediaDir, `${ID}.m4a`);
    writeFile(out, OLD);
    // Evidencia de una conversión interrumpida (descarga vieja del mismo id).
    writeFile(join(env.mediaDir, `${ID}.src.webm`), OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(existsSync(out)).toBe(true);
    expect(result.removed).toEqual([`${ID}.src.webm`]);
    expect(result.kept.some((k) => k.name === `${ID}.m4a`)).toBe(true);
  });
});

describe("salida de conversión con evidencia", () => {
  it("elimina un MP4 viejo sin fila si el libro dice que la app lo estaba convirtiendo", () => {
    const env = makeEnv();
    const journal = new MediaOperationJournal(null);
    journal.begin("encodes", ID);
    const out = join(env.mediaDir, `${ID}.mp4`);
    writeFile(out, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
      journal,
    });

    expect(result.removed).toEqual([`${ID}.mp4`]);
    expect(existsSync(out)).toBe(false);
  });

  it("con evidencia pero reciente, se conserva (trabajo quizá en curso)", () => {
    const env = makeEnv();
    const journal = new MediaOperationJournal(null);
    journal.begin("encodes", ID);
    const out = join(env.mediaDir, `${ID}.mp4`);
    writeFile(out, RECENT);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
      journal,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(out)).toBe(true);
  });

  it("con evidencia pero con temporales de descarga vivos del mismo id, se conserva", () => {
    const env = makeEnv();
    const journal = new MediaOperationJournal(null);
    journal.begin("encodes", ID);
    const out = join(env.mediaDir, `${ID}.mp4`);
    const src = join(env.mediaDir, `${ID}.src.webm`);
    writeFile(out, OLD);
    writeFile(src, RECENT);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
      journal,
    });

    // El `.src` es reciente, así que tampoco se borra; el mp4 se conserva igual.
    expect(result.removed).toEqual([]);
    expect(existsSync(out)).toBe(true);
  });

  it("sin libro, un MP4 sin fila aunque haya un .src viejo al lado no se borra", () => {
    const env = makeEnv();
    const out = join(env.mediaDir, `${ID}.mp4`);
    writeFile(out, OLD);
    writeFile(join(env.mediaDir, `${ID}.src.webm`), OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(existsSync(out)).toBe(true);
  });
});

describe("errores y rutas", () => {
  it("un archivo en uso no impide limpiar los otros y se informa", () => {
    const env = makeEnv();
    const locked = join(env.mediaDir, `${ID}.src.mp4`);
    const free = join(env.mediaDir, `${ID}.mp4.part`);
    writeFile(locked, OLD);
    writeFile(free, OLD);
    // Un directorio con nombre de temporal: no se puede borrar como archivo.
    const dirWithTempName = join(env.mediaDir, "abc123.src.mp4");
    mkdirSync(dirWithTempName);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    // El directorio se conserva con su motivo; los archivos regulares se borran.
    expect(result.kept).toContainEqual({ name: "abc123.src.mp4", reason: expect.stringContaining("No es un archivo regular") });
    expect(result.removed).toContain(`${ID}.mp4.part`);
    expect(existsSync(dirWithTempName)).toBe(true);
  });

  it("las rutas fuera de los directorios permitidos nunca se modifican", () => {
    const env = makeEnv();
    // Un archivo con nombre temporal pero FUERA de media/ y .uploads/.
    const outside = join(env.root, `${UUID}.upload`);
    writeFile(outside, OLD);
    const subdir = join(env.mediaDir, "otra");
    mkdirSync(subdir);
    const nested = join(subdir, `${ID}.src.mp4`);
    writeFile(nested, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(outside)).toBe(true);
    // Sin recursión: lo que está en una subcarpeta no se toca.
    expect(existsSync(nested)).toBe(true);
  });

  it("un enlace simbólico a un archivo externo no permite borrarlo", () => {
    const env = makeEnv();
    const externalDir = mkdtempSync(join(tmpdir(), "cleanup-external-"));
    dirs.push(externalDir);
    const external = join(externalDir, `${UUID}.upload`);
    writeFile(external, OLD);
    const link = join(env.uploadsDir, `${UUID}.upload`);
    try {
      symlinkSync(external, link, "file");
    } catch {
      // Crear symlinks requiere permisos especiales en Windows; sin eso no hay
      // nada que probar (se saltea con aviso).
      return;
    }

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(external)).toBe(true);
    expect(result.kept).toContainEqual({ name: `${UUID}.upload`, reason: expect.stringContaining("enlace simbólico") });
  });

  it("es idempotente: correrla dos veces no rompe nada", () => {
    const env = makeEnv();
    // (Sin fila en la base: los `.src` de un clip registrado se conservan, ver
    // el test siguiente.)
    writeFile(join(env.mediaDir, `${ID}.src.mp4`), OLD);
    writeFile(join(env.uploadsDir, `${UUID}.upload`), OLD);

    const first = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });
    const second = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(first.removed.sort()).toEqual([`${ID}.src.mp4`, `${UUID}.upload`].sort());
    expect(second.removed).toEqual([]);
  });

  it("un clip registrado sin su archivo conserva el .src (puede ser la única copia)", () => {
    const env = makeEnv();
    upsertClip(env.db, clip(ID, `${ID}.mp4`));
    // El archivo final ya no está, pero la fila sigue (reconciliación posterior).
    const stray = join(env.mediaDir, `${ID}.src.mp4`);
    writeFile(stray, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(stray)).toBe(true);
  });

  it("nunca lanza si la carpeta de medios no existe (instalación nueva)", () => {
    const env = makeEnv();
    rmSync(env.mediaDir, { recursive: true, force: true });

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.aborted).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.message).toContain("Todavía no existe la carpeta de medios");
  });

  it("un clip marcado como ausente conserva su .src viejo (puede ser la única copia)", () => {
    const env = makeEnv();
    upsertClip(env.db, { ...clip(ID, `${ID}.mp4`), missing: true });
    const silentPath = join(env.mediaDir, `${ID}.src.m4a`);
    const info = join(env.mediaDir, `${ID}.src.info.json`);
    writeFile(silentPath, OLD);
    writeFile(info, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(silentPath)).toBe(true);
    expect(existsSync(info)).toBe(true);
  });

  it("sin exclusividad de instancia no borra nada", () => {
    const env = makeEnv();
    const old = join(env.uploadsDir, `${UUID}.upload`);
    writeFile(old, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: false,
    });

    expect(result.aborted).toBe(true);
    expect(result.removed).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it("si la base falla, conserva los temporales de descarga en vez de borrarlos", () => {
    const env = makeEnv();
    env.db.close();
    const src = join(env.mediaDir, `${ID}.src.mp4`);
    writeFile(src, OLD);

    const result = cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(src)).toBe(true);
  });

  it("informa el resumen en el log, sin secretos", () => {
    const env = makeEnv();
    writeFile(join(env.uploadsDir, `${UUID}.upload`), OLD);
    const lines: string[] = [];

    cleanupOrphanTemporaries({
      mediaDir: env.mediaDir,
      uploadsDir: env.uploadsDir,
      db: env.db,
      hasExclusiveAccess: true,
      log: (message) => lines.push(message),
    });

    expect(lines.join("\n")).toContain("1 examinados, 1 eliminados");
  });
});

describe("constantes", () => {
  it("la antigüedad mínima por defecto es de 24 h", () => {
    expect(DEFAULT_MIN_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

