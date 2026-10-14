import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { migrate } from "./database.ts";
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
    hasVideo: true,
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

  it("la migración de la Parte B agrega repetition/last_fired_at y quita user_cooldown_sec", () => {
    const db = openMemoryDatabase();
    const rewardColumns = db
      .prepare("PRAGMA table_info(rewards)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(rewardColumns).toContain("repetition");
    expect(rewardColumns).toContain("last_fired_at");
    expect(rewardColumns).not.toContain("user_cooldown_sec");

    const clipColumns = db
      .prepare("PRAGMA table_info(clips)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(clipColumns).toContain("audio_only");
  });

  it("la migración v10 agrega rewards.audio_only y clips.has_video", () => {
    const db = openMemoryDatabase();
    const rewardColumns = db
      .prepare("PRAGMA table_info(rewards)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(rewardColumns).toContain("audio_only");
    const clipColumns = db
      .prepare("PRAGMA table_info(clips)")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(clipColumns).toContain("has_video");
  });

  it("la migración v10 marca audio_only en las recompensas superpuestas y con clip sin imagen", () => {
    // Se parte de una base en user_version 9 (con clips.audio_only y sin rewards.audio_only).
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE clips (
        id TEXT PRIMARY KEY, source_url TEXT NOT NULL, title TEXT NOT NULL,
        duration_sec INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
        file TEXT NOT NULL, created_at TEXT NOT NULL, trim_start REAL, trim_end REAL,
        audio_only INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE rewards (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, remote_reward_id TEXT,
        title TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 1,
        color TEXT NOT NULL DEFAULT '#00e701', description TEXT NOT NULL DEFAULT '',
        clip_id TEXT, volume REAL NOT NULL DEFAULT 1, max_duration_sec INTEGER,
        cooldown_sec INTEGER NOT NULL DEFAULT 0, repetition TEXT NOT NULL DEFAULT 'queue',
        last_fired_at INTEGER, position_json TEXT, enter_animation TEXT, exit_animation TEXT,
        desired_enabled INTEGER NOT NULL DEFAULT 1, managed INTEGER NOT NULL DEFAULT 1,
        synced INTEGER NOT NULL DEFAULT 0, rule_id TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO clips VALUES ('v', 'u', 'video', 10, 1, 'v.mp4', 'now', NULL, NULL, 0);
      INSERT INTO clips VALUES ('a', 'u', 'audio', 10, 1, 'a.mp4', 'now', NULL, NULL, 1);
      INSERT INTO rewards (id, platform, title, clip_id, repetition, created_at, updated_at)
        VALUES ('ov', 'p', 'Ov', 'v', 'overlap', 'now', 'now');
      INSERT INTO rewards (id, platform, title, clip_id, repetition, created_at, updated_at)
        VALUES ('mk', 'p', 'Mk', 'a', 'queue', 'now', 'now');
      INSERT INTO rewards (id, platform, title, clip_id, repetition, created_at, updated_at)
        VALUES ('pl', 'p', 'Pl', 'v', 'queue', 'now', 'now');
      PRAGMA user_version = 9;
    `);

    migrate(db);

    const rows = db
      .prepare<{ id: string; audio_only: number }>("SELECT id, audio_only FROM rewards ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "mk", audio_only: 1 },
      { id: "ov", audio_only: 1 },
      { id: "pl", audio_only: 0 },
    ]);
    // Todos los clips existentes conservan imagen.
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
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

  it("guarda si el clip tiene imagen y no lo pisa al reinsertar (caché)", () => {
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip({ hasVideo: false }));
    expect(getClip(db, "abc")?.hasVideo).toBe(false);

    // Reprocesar la misma URL (hasVideo en verdadero por defecto) no debe pisarlo.
    upsertClip(db, sampleClip({ sizeBytes: 999 }));
    expect(getClip(db, "abc")?.hasVideo).toBe(false);
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