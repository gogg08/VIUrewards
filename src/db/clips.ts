/**
 * Tabla `clips`: biblioteca de clips descargados (Fase 3).
 *
 * La base es la fuente de verdad para el dashboard. Al iniciar, `reconcileClips`
 * la pone de acuerdo con lo que hay en disco, reconociendo TODOS los formatos
 * permitidos: agrega los archivos que falten y MARCA los registros cuyo archivo
 * ya no está (nunca los borra en silencio).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { mediaExtensionOf } from "../media/formats.ts";
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
  /** ¿Falta el archivo en /media? La fila se conserva y la biblioteca lo avisa. */
  missing: boolean;
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
  missing: number;
}

/** Metadatos que el módulo de media escribe en el sidecar `<id>.json`. */
interface ClipSidecar {
  title?: string;
  durationSec?: number;
  sizeBytes?: number;
  sourceUrl?: string;
  createdAt?: string;
  /** ¿El archivo tiene imagen? (los audios locales lo escriben en falso). */
  hasVideo?: boolean;
  /** ¿Es un archivo local (nunca se borra solo)? */
  local?: boolean;
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
    missing: row.missing === 1,
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
    `INSERT INTO clips (id, source_url, title, duration_sec, size_bytes, file, created_at, trim_start, trim_end, has_video, missing)
     VALUES (@id, @sourceUrl, @title, @durationSec, @sizeBytes, @file, @createdAt, @trimStart, @trimEnd, @hasVideo, @missing)
     ON CONFLICT(id) DO UPDATE SET
       source_url   = excluded.source_url,
       duration_sec = excluded.duration_sec,
       size_bytes   = excluded.size_bytes,
       file         = excluded.file,
       missing      = excluded.missing`,
  ).run({ ...clip, hasVideo: clip.hasVideo ? 1 : 0, missing: clip.missing ? 1 : 0 });
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

/** Marca o desmarca un clip cuyo archivo falta. Devuelve `false` si no existe. */
export function setClipMissing(db: SqliteDatabase, id: string, missing: boolean): boolean {
  const result = db.prepare("UPDATE clips SET missing = ? WHERE id = ?").run(missing ? 1 : 0, id);
  return result.changes > 0;
}

export interface ReconcileResult {
  /** Ids de clips nuevos agregados a la biblioteca. */
  added: string[];
  /** Ids de clips marcados como "archivo ausente" (la fila NO se borra). */
  missing: string[];
  /** Ids de clips cuyo archivo reapareció (se les quitó la marca). */
  restored: string[];
  /**
   * Nombres de archivos válidos que NO se pudieron importar (no se pudo leer su
   * metadata y no había sidecar). Se registran, no se borran del disco.
   */
  skipped: string[];
  /** ¿Se abortó sin tocar nada? (carpeta de medios ausente o ilegible). */
  aborted: boolean;
  /** Motivo del abort o resumen, para el log y el aviso del dashboard. */
  message?: string;
}

/** Metadata con la que se reconstruye una fila de clip (del sidecar o de ffprobe). */
export interface RebuiltClip {
  title: string;
  durationSec: number;
  sizeBytes: number;
  sourceUrl: string;
  hasVideo: boolean;
}

export interface ReconcileOptions {
  now?: () => string;
  /**
   * Reconstruye la metadata de un archivo que no tiene fila ni sidecar (p. ej.
   * con ffprobe). Si no se pasa, esos archivos se **omiten** (se registran en
   * `skipped`) y no se toca la base por ellos. Nunca lanza: devuelve null si no
   * pudo.
   */
  rebuild?: (id: string, file: string, filePath: string) => Promise<RebuiltClip | null>;
  /** Escribe el resultado en el log (en español, sin secretos). */
  log?: (message: string) => void;
}

/** Resultado de mirar la carpeta de medios. */
export type MediaScan =
  | { ok: true; files: Map<string, string>; directories: number }
  | { ok: false; message: string };

/**
 * Mira la carpeta de medios y devuelve los archivos de clip (id -> nombre),
 * reconociendo TODAS las extensiones permitidas (lista compartida). No decide
 * nada: solo mira. Si la carpeta no existe, no es una carpeta o no se puede
 * leer, devuelve un fallo (para que la reconciliación aborte y no toque nada).
 */
export function scanMediaDir(mediaDir: string): MediaScan {
  let stat;
  try {
    stat = statSync(mediaDir);
  } catch {
    return { ok: false, message: `No existe la carpeta de medios (${mediaDir}).` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, message: `La carpeta de medios no es una carpeta (${mediaDir}).` };
  }
  let entries: string[];
  try {
    entries = readdirSync(mediaDir);
  } catch {
    return { ok: false, message: `No se pudo leer la carpeta de medios (${mediaDir}).` };
  }
  const files = new Map<string, string>();
  let directories = 0;
  for (const name of entries) {
    let isDir = false;
    try {
      isDir = statSync(join(mediaDir, name)).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      directories += 1;
      continue;
    }
    const ext = mediaExtensionOf(name);
    if (!ext) continue;
    files.set(name.slice(0, -ext.length), name);
  }
  return { ok: true, files, directories };
}

/**
 * Reconstruye la fila de un clip a partir del sidecar `<id>.json` (que escriben
 * tanto la descarga por link como la ingesta local). Devuelve `null` si no hay
 * sidecar o si está corrupto.
 */
function sidecarToRebuilt(mediaDir: string, id: string, file: string): RebuiltClip | null {
  const sidecar = readSidecar(mediaDir, id);
  if (!sidecar) return null;
  const hasVideo = typeof sidecar.hasVideo === "boolean" ? sidecar.hasVideo : true;
  return {
    title: typeof sidecar.title === "string" && sidecar.title.length > 0 ? sidecar.title : id,
    durationSec: numberField(sidecar.durationSec),
    sizeBytes: numberField(sidecar.sizeBytes) || fileSize(join(mediaDir, file)),
    sourceUrl: typeof sidecar.sourceUrl === "string" ? sidecar.sourceUrl : "",
    hasVideo,
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** Lee el sidecar `<id>.json` (devuelve `null` si no existe o está corrupto). */
function readSidecar(mediaDir: string, id: string): ClipSidecar | null {
  try {
    const raw = readFileSync(join(mediaDir, `${id}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ClipSidecar;
  } catch {
    return null;
  }
}

/** Tamaño de un archivo en bytes, o 0 si no se puede leer. */
function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Reconstruye la fila de un clip del que solo hay un archivo (sin sidecar):
 * usa `rebuild` (ffprobe) si se pasó; si no, cae a un título derivado sin datos.
 * El id y el nombre de archivo NO cambian.
 */
async function rebuildFromFile(
  id: string,
  file: string,
  filePath: string,
  options: ReconcileOptions,
): Promise<RebuiltClip | null> {
  if (!options.rebuild) return null;
  try {
    return await options.rebuild(id, file, filePath);
  } catch {
    return null;
  }
}

/**
 * Sincroniza la tabla con los archivos de clip presentes en la carpeta media.
 *
 * Reglas (nunca borra filas en silencio):
 *  - Reconoce TODAS las extensiones permitidas (lista compartida), no solo mp4.
 *  - Agrega las filas que falten; usa el sidecar `<id>.json` si existe. Si no hay
 *    sidecar y se pasó `rebuild`, reconstruye con ffprobe. Si no se pudo, omite el
 *    archivo (lo registra en `skipped`) sin tocar la base por él.
 *  - Un clip cuyo archivo ya no está se MARCA como ausente (`missing`), no se
 *    borra. Si el archivo reaparece, se le quita la marca.
 *  - Si la carpeta de medios no existe, no es una carpeta o no se puede leer,
 *    ABORTA sin modificar nada.
 *  - El id del clip y el nombre del archivo nunca cambian.
 */
export async function reconcileClips(
  db: SqliteDatabase,
  mediaDir: string,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const added: string[] = [];
  const missing: string[] = [];
  const restored: string[] = [];
  const skipped: string[] = [];
  const log = options.log ?? (() => {});

  const scan = scanMediaDir(mediaDir);
  if (!scan.ok) {
    return { added, missing, restored, skipped, aborted: true, message: scan.message };
  }
  const files = scan.files;

  const now = options.now ?? (() => new Date().toISOString());
  const existing = new Map(listClips(db).map((clip) => [clip.id, clip]));

  // Batería de seguridad: una carpeta de medios VACÍA se trata como "unidad sin
  // montar" y aborta, pero SOLO si la base tiene clips que se perderían de vista.
  // En una instalación nueva (base sin clips y carpeta vacía) no hay nada que
  // proteger: es un no-op silencioso, no un aviso alarmante.
  if (files.size === 0 && scan.directories === 0) {
    if (existing.size === 0) {
      return { added, missing, restored, skipped, aborted: false };
    }
    return {
      added,
      missing,
      restored,
      skipped,
      aborted: true,
      message: "La carpeta de medios está vacía. No se modificó la biblioteca.",
    };
  }

  // 1) Archivos sin fila: se agregan (sidecar, ffprobe o se omiten).
  for (const [id, file] of files) {
    if (existing.has(id)) continue;
    const filePath = join(mediaDir, file);
    const rebuilt =
      sidecarToRebuilt(mediaDir, id, file) ??
      (await rebuildFromFile(id, file, filePath, options));
    if (!rebuilt) {
      skipped.push(file);
      log(`Reconciliación: se omitió ${file} (no se pudo leer su metadata).`);
      continue;
    }
    upsertClip(db, {
      id,
      sourceUrl: rebuilt.sourceUrl,
      title: rebuilt.title,
      durationSec: rebuilt.durationSec,
      sizeBytes: rebuilt.sizeBytes || fileSize(filePath),
      file,
      createdAt: existing.get(id)?.createdAt ?? now(),
      // Nunca se pisa un recorte existente; una fila nueva nace sin recorte.
      trimStart: null,
      trimEnd: null,
      hasVideo: rebuilt.hasVideo,
      missing: false,
    });
    added.push(id);
    log(`Reconciliación: se recuperó ${id} (${file}).`);
  }

  // 2) Filas sin archivo: se marcan como ausentes (nunca se borran).
  for (const clip of existing.values()) {
    if (files.has(clip.id)) {
      if (clip.missing) {
        setClipMissing(db, clip.id, false);
        restored.push(clip.id);
        log(`Reconciliación: ${clip.id} volvió a aparecer en /media.`);
      }
      continue;
    }
    if (!clip.missing) {
      setClipMissing(db, clip.id, true);
      missing.push(clip.id);
      log(`Reconciliación: falta el archivo de ${clip.id} (${clip.file}); se marcó, no se borró.`);
    }
  }

  return { added, missing, restored, skipped, aborted: false };
}