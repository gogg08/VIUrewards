/**
 * Tabla `clips`: biblioteca de clips descargados (Fase 3).
 *
 * La base es la fuente de verdad para el dashboard. Al iniciar, `reconcileClips`
 * la pone de acuerdo con lo que hay en disco: agrega los mp4 que falten y
 * elimina los registros cuyo archivo ya no está.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { SqliteDatabase } from "./database.ts";

export interface ClipRecord {
  id: string;
  sourceUrl: string;
  title: string;
  durationSec: number;
  sizeBytes: number;
  /** Nombre de archivo dentro de la carpeta media (nunca una ruta absoluta). */
  file: string;
  createdAt: string;
  /** Recorte no destructivo: segundo de inicio (null = 0). */
  trimStart: number | null;
  /** Recorte no destructivo: segundo de fin (null = hasta el final). */
  trimEnd: number | null;
  /** ¿El archivo tiene imagen? Los mp4 vienen con video; los audios de la Etapa 3B, no. */
  hasVideo: boolean;
}

interface ClipRow {
  id: string;
  source_url: string;
  title: string;
  duration_sec: number;
  size_bytes: number;
  file: string;
  created_at: string;
  trim_start: number | null;
  trim_end: number | null;
  has_video: number;
}

/** Metadatos que el módulo de media escribe en el sidecar `<id>.json`. */
interface ClipSidecar {
  title?: string;
  durationSec?: number;
  sizeBytes?: number;
  sourceUrl?: string;
  createdAt?: string;
}

function toRecord(row: ClipRow): ClipRecord {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    title: row.title,
    durationSec: row.duration_sec,
    sizeBytes: row.size_bytes,
    file: row.file,
    createdAt: row.created_at,
    trimStart: row.trim_start,
    trimEnd: row.trim_end,
    hasVideo: row.has_video === 1,
  };
}

export function listClips(db: SqliteDatabase): ClipRecord[] {
  const rows = db
    .prepare<ClipRow>("SELECT * FROM clips ORDER BY created_at DESC, id ASC")
    .all();
  return rows.map(toRecord);
}

export function getClip(db: SqliteDatabase, id: string): ClipRecord | null {
  const row = db.prepare<ClipRow>("SELECT * FROM clips WHERE id = ?").get(id);
  return row ? toRecord(row) : null;
}

/**
 * Inserta o actualiza un clip. En conflicto no pisa el título ni el recorte:
 * son decisiones del usuario que no deben perderse si el mismo video se vuelve
 * a procesar (caché).
 */
export function upsertClip(db: SqliteDatabase, clip: ClipRecord): void {
  db.prepare(
    `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at, trim_start, trim_end, has_video)
     VALUES (@id, @sourceUrl, @title, @durationSec, @sizeBytes, @file, @createdAt, @trimStart, @trimEnd, @hasVideo)
     ON CONFLICT(id) DO UPDATE SET
       source_url   = excluded.source_url,
       duration_sec = excluded.duration_sec,
       size_bytes   = excluded.size_bytes,
       file         = excluded.file`,
  ).run({ ...clip, hasVideo: clip.hasVideo ? 1 : 0 });
}

/** Guarda el recorte no destructivo. Devuelve `false` si el clip no existe. */
export function setClipTrim(
  db: SqliteDatabase,
  id: string,
  trimStart: number | null,
  trimEnd: number | null,
): boolean {
  const result = db
    .prepare("UPDATE clips SET trim_start = ?, trim_end = ? WHERE id = ?")
    .run(trimStart, trimEnd, id);
  return result.changes > 0;
}

/** Cambia el título del clip. Devuelve `false` si el clip no existe. */
export function renameClip(db: SqliteDatabase, id: string, title: string): boolean {
  const result = db.prepare("UPDATE clips SET title = ? WHERE id = ?").run(title, id);
  return result.changes > 0;
}

/** Borra el registro del clip (no el archivo). Devuelve `false` si no existía. */
export function deleteClip(db: SqliteDatabase, id: string): boolean {
  const result = db.prepare("DELETE FROM clips WHERE id = ?").run(id);
  return result.changes > 0;
}

export interface ReconcileResult {
  added: string[];
  removed: string[];
}

function readSidecar(mediaDir: string, id: string): ClipSidecar | null {
  const path = join(mediaDir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClipSidecar;
  } catch {
    return null;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Sincroniza la tabla con los `.mp4` presentes en la carpeta media.
 * Agrega los que falten (leyendo el sidecar si existe) y quita los registros
 * cuyo archivo ya no está.
 */
export function reconcileClips(db: SqliteDatabase, mediaDir: string): ReconcileResult {
  const added: string[] = [];
  const removed: string[] = [];

  const entries = existsSync(mediaDir) ? readdirSync(mediaDir) : [];
  const idsOnDisk = new Set<string>();
  const mp4Names = new Map<string, string>();
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".mp4")) continue;
    const id = name.slice(0, -4);
    idsOnDisk.add(id);
    mp4Names.set(id, name);
  }

  const known = new Set(listClips(db).map((clip) => clip.id));
  for (const id of idsOnDisk) {
    if (known.has(id)) continue;
    const sidecar = readSidecar(mediaDir, id);
    const file = mp4Names.get(id) ?? `${id}.mp4`;
    upsertClip(db, {
      id,
      sourceUrl: sidecar?.sourceUrl ?? "",
      title: sidecar?.title ?? id,
      durationSec: sidecar?.durationSec ?? 0,
      sizeBytes: sidecar?.sizeBytes ?? fileSize(join(mediaDir, file)),
      file,
      createdAt: sidecar?.createdAt ?? new Date().toISOString(),
      trimStart: null,
      trimEnd: null,
      hasVideo: true,
    });
    added.push(id);
  }

  for (const clip of listClips(db)) {
    if (idsOnDisk.has(clip.id)) continue;
    deleteClip(db, clip.id);
    removed.push(clip.id);
  }

  return { added, removed };
}