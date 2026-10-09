import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deleteClip,
  getClip,
  getSetting,
  listClips,
  openMemoryDatabase,
  reconcileClips,
  renameClip,
  SCHEMA_VERSION,
  setClipTrim,
  setSetting,
  upsertClip,
  type ClipRecord,
} from "./index.ts";

const dirs: string[] = [];

function makeMediaDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "db-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return mediaDir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function sampleClip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: "abc",
    sourceUrl: "https://www.youtube.com/watch?v=x",
    title: "Un clip",
    durationSec: 12,
    sizeBytes: 2048,
    file: "abc.mp4",
    createdAt: "2026-01-01T00:00:00.000Z",
    trimStart: null,
    trimEnd: null,
    ...overrides,
  };
}

describe("migraciones", () => {
  it("crea las tablas y deja el user_version en SCHEMA_VERSION", () => {
    const db = openMemoryDatabase();
    const version = db.pragma("user_version", { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
    expect(() => db.prepare("SELECT * FROM clips").all()).not.toThrow();
    expect(() => db.prepare("SELECT * FROM settings").all()).not.toThrow();
  });

  it("la migración de recorte agrega trim_start y trim_end", () => {
    const db = openMemoryDatabase();
    const columns = db
      .prepare("PRAGMA table_info(clips)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toContain("trim_start");
    expect(columns).toContain("trim_end");
  });
});

describe("settings", () => {
  it("guarda y lee valores; devuelve null si no existe", () => {
    const db = openMemoryDatabase();
    expect(getSetting(db, "k")).toBeNull();
    setSetting(db, "k", "v1");
    expect(getSetting(db, "k")).toBe("v1");
    setSetting(db, "k", "v2");
    expect(getSetting(db, "k")).toBe("v2");
  });
});

describe("clips", () => {
  it("inserta, lista, lee y borra", () => {
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip());
    expect(listClips(db)).toHaveLength(1);
    expect(getClip(db, "abc")?.title).toBe("Un clip");

    expect(deleteClip(db, "abc")).toBe(true);
    expect(listClips(db)).toHaveLength(0);
    expect(deleteClip(db, "abc")).toBe(false);
  });

  it("renombra y no pisa el título al reinsertar el mismo clip (caché)", () => {
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip());
    expect(renameClip(db, "abc", "Nuevo título")).toBe(true);
    expect(getClip(db, "abc")?.title).toBe("Nuevo título");

    // Volver a procesar la misma URL no debe perder el renombrado.
    upsertClip(db, sampleClip({ title: "Título original", sizeBytes: 999 }));
    const clip = getClip(db, "abc");
    expect(clip?.title).toBe("Nuevo título");
    expect(clip?.sizeBytes).toBe(999);
  });

  it("guarda y limpia el recorte sin pisarlo al reinsertar (caché)", () => {
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip());
    expect(getClip(db, "abc")?.trimStart).toBeNull();

    expect(setClipTrim(db, "abc", 2, 7)).toBe(true);
    expect(getClip(db, "abc")?.trimStart).toBe(2);
    expect(getClip(db, "abc")?.trimEnd).toBe(7);

    // Reprocesar la misma URL no debe perder el recorte del usuario.
    upsertClip(db, sampleClip({ sizeBytes: 999 }));
    expect(getClip(db, "abc")?.trimStart).toBe(2);
    expect(getClip(db, "abc")?.trimEnd).toBe(7);

    expect(setClipTrim(db, "abc", null, null)).toBe(true);
    expect(getClip(db, "abc")?.trimStart).toBeNull();
    expect(setClipTrim(db, "inexistente", 0, 1)).toBe(false);
  });
});

describe("reconcileClips", () => {
  it("agrega los mp4 del disco que faltan y quita registros sin archivo", () => {
    const mediaDir = makeMediaDir();
    writeFileSync(join(mediaDir, "nuevo.mp4"), "mp4");
    writeFileSync(
      join(mediaDir, "nuevo.json"),
      JSON.stringify({ title: "Del sidecar", durationSec: 5, sourceUrl: "https://x/y" }),
    );

    const db = openMemoryDatabase();
    upsertClip(db, sampleClip({ id: "fantasma", file: "fantasma.mp4" }));

    const result = reconcileClips(db, mediaDir);
    expect(result.added).toEqual(["nuevo"]);
    expect(result.removed).toEqual(["fantasma"]);

    const clips = listClips(db);
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe("nuevo");
    expect(clips[0].title).toBe("Del sidecar");
    expect(clips[0].durationSec).toBe(5);
  });

  it("es idempotente", () => {
    const mediaDir = makeMediaDir();
    writeFileSync(join(mediaDir, "a.mp4"), "mp4");
    const db = openMemoryDatabase();

    expect(reconcileClips(db, mediaDir).added).toEqual(["a"]);
    expect(reconcileClips(db, mediaDir).added).toEqual([]);
    expect(listClips(db)).toHaveLength(1);
  });
});