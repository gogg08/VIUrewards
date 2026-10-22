/**
 * Limpieza de archivos temporales huérfanos al arrancar.
 *
 * Un cierre abrupto (apagón, cierre forzado, `kill`) puede dejar:
 *
 *  - subidas interrumpidas en `.uploads/` (`<uuid>.upload`);
 *  - descargas de yt-dlp en `/media` (`<id>.src.<ext>`, `<id>.src.info.json`,
 *    `<id>.src.<ext>.part`);
 *  - salidas parciales de ffmpeg (`<id>.mp4.part`, `<id>.m4a.part`).
 *
 * Reglas de seguridad (conservadoras a propósito):
 *
 *  1. **Sin exclusividad de instancia no se borra nada** (ver
 *     `src/db/instance-lock.ts`): otra copia abierta por error podría estar
 *     usando un temporal reciente.
 *  2. Solo se consideran los patrones explícitos de `temp-patterns.ts`, dentro
 *     de los dos directorios permitidos y **sin recursión**.
 *  3. Antigüedad mínima de 24 h (`DEFAULT_MIN_AGE_MS`), por fecha de
 *     modificación. Un temporal reciente se conserva aunque parezca huérfano.
 *  4. Nunca se siguen enlaces simbólicos: `lstat`, y solo archivos regulares.
 *  5. Un temporal de un clip **registrado** en la base se conserva.
 *  6. Un archivo de clip (`<id>.mp4`/`.m4a`) **nunca** se borra solo por no
 *     tener fila: la reconciliación los importa a propósito. La ÚNICA excepción
 *     es un archivo con **evidencia** de una conversión interrumpida (libro de
 *     operaciones `encodes <id>` sin terminar y sin temporales de descarga
 *     vivos, ver `pending-media.ts`): la app misma declaró que lo escribió y no
 *     llegó a registrarlo. Sin libro, el archivo se conserva siempre.
 *  7. Si algo falla (permisos, archivo en uso) se registra, se conserva y se
 *     sigue con el resto. Nunca impide arrancar.
 */

import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";

import { getClip, type SqliteDatabase } from "../db/index.ts";
import { checkInterruptedConversion, type MediaOperationJournal } from "./pending-media.ts";
import { downloadSourceId, isTempFileName, mediaExtensionName, tempKindOf } from "./temp-patterns.ts";

/** Antigüedad mínima por defecto para borrar un temporal (24 h). */
export const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface CleanupOptions {
  /** Carpeta de clips (por defecto `media/`). */
  mediaDir: string;
  /** Carpeta de temporales de subidas (por defecto `<mediaDir>/../.uploads`). */
  uploadsDir?: string;
  /** Base de la app: con ella se decide si un temporal pertenece a un clip. */
  db: SqliteDatabase;
  /**
   * ¿Esta instancia tiene exclusividad sobre los directorios? Sin esto no se
   * borra nada (se devuelve `aborted` con el motivo).
   */
  hasExclusiveAccess: boolean;
  /** Reloj inyectable en tests. */
  now?: () => number;
  /** Antigüedad mínima de un temporal (24 h por defecto). */
  minAgeMs?: number;
  /**
   * Libro de operaciones de media. Si viene, un archivo final con evidencia de
   * conversión interrumpida se elimina; sin libro, nunca se borra un mp4/m4a.
   */
  journal?: MediaOperationJournal;
  /** Registro en español de lo que se hace (nunca datos sensibles). */
  log?: (message: string) => void;
}

export interface CleanupResult {
  /** Cantidad de archivos examinados (los que coincidieron con un patrón temporal). */
  examined: number;
  /** Nombres de archivos eliminados. */
  removed: string[];
  /** Archivos conservados, con el motivo. */
  kept: { name: string; reason: string }[];
  /** Errores al borrar (el archivo se conserva). */
  errors: { name: string; message: string }[];
  /** `true` si no se borró nada (sin exclusividad o carpeta ilegible). */
  aborted: boolean;
  /** Motivo del abort, o el resumen, para el log. */
  message?: string;
}

export const KEEP_REASON = {
  recent: "Es reciente (menos de la antigüedad mínima).",
  registered: "Pertenece a un clip registrado.",
  notRegular: "No es un archivo regular (enlace simbólico o directorio).",
  clipOutput: "Es un archivo de clip sin fila en la base: la reconciliación lo importa.",
} as const;

interface Entry {
  name: string;
  stats: Stats;
}

/** Lee un directorio sin recursión y sin seguir enlaces. `null` si no se puede. */
function listDir(dir: string): Entry[] | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const out: Entry[] = [];
  for (const name of names) {
    try {
      out.push({ name, stats: lstatSync(join(dir, name)) });
    } catch {
      // Desapareció entre el listado y el lstat: se ignora.
    }
  }
  return out;
}

export function removeOrphanUploads(dir: string, minAgeMs: number, now = Date.now()): string[] {
  const removed: string[] = [];
  const entries = listDir(dir);
  if (!entries) return removed;
  for (const entry of entries) {
    if (tempKindOf(entry.name) !== "upload") continue;
    if (!entry.stats.isFile()) continue;
    if (now - entry.stats.mtimeMs <= minAgeMs) continue;
    const path = join(dir, entry.name);
    try {
      const check = lstatSync(path);
      if (!check.isFile() || check.isSymbolicLink()) continue;
      rmSync(path, { force: true });
      removed.push(entry.name);
    } catch {
      // En uso o sin permisos: se conserva y no interrumpe el cierre.
    }
  }
  return removed;
}

export interface OpenedMediaDir {
  /** ¿Existe y se puede listar? */
  ok: boolean;
  /** Se intentó crearla porque no existía. */
  created: boolean;
  /** Motivo legible si no está disponible. */
  message?: string;
}

/**
 * Asegura que la carpeta de medios exista y sea legible ANTES de reconciliar.
 *
 * El permiso de escritura es el permiso para limpiar: con la carpeta creada, un
 * error de read-only (unidad protegida) se detecta acá en vez de convertirse en
 * un "no se borró nada" silencioso. Nunca lanza.
 */
export function openMediaDir(mediaDir: string): OpenedMediaDir {
  let created = false;
  try {
    if (!existsSync(mediaDir)) {
      mkdirSync(mediaDir, { recursive: true });
      created = true;
    }
  } catch (error) {
    return {
      ok: false,
      created,
      message: `No se pudo crear la carpeta de medios: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    accessSync(mediaDir, constants.R_OK | constants.W_OK);
  } catch (error) {
    return {
      ok: false,
      created,
      message: `La carpeta de medios no se puede leer o escribir: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true, created };
}

/**
 * Barre los temporales huérfanos de `media/` y `.uploads/`.
 *
 * Idempotente: lo que quedó se conserva por algún motivo y lo borrado ya no está.
 * Nunca lanza.
 */
export function cleanupOrphanTemporaries(options: CleanupOptions): CleanupResult {
  const result: CleanupResult = { examined: 0, removed: [], kept: [], errors: [], aborted: false };
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const mediaDir = options.mediaDir;
  const uploadsDir = options.uploadsDir ?? join(mediaDir, "..", ".uploads");

  if (!options.hasExclusiveAccess) {
    result.aborted = true;
    result.message = "No hay exclusividad de instancia: no se limpian temporales.";
    log(`Limpieza de temporales: ${result.message}`);
    return result;
  }

  const at = now();

  /** ¿El id corresponde a un clip registrado? Si la base falla, se conserva. */
  const isRegistered = (id: string): boolean => {
    try {
      return getClip(options.db, id) !== null;
    } catch {
      return true;
    }
  };

  /** ¿El clip está registrado y la reconciliación anterior ya vio que falta su archivo? */
  const isRegisteredMissing = (id: string): boolean => {
    try {
      return getClip(options.db, id)?.missing === true;
    } catch {
      return true;
    }
  };

  const remove = (dir: string, name: string): void => {
    const path = join(dir, name);
    try {
      // Defensa: solo archivos regulares sin enlaces, incluso si cambiaron
      // entre el listado y el borrado.
      const check = lstatSync(path);
      if (!check.isFile() || check.isSymbolicLink()) {
        result.kept.push({ name, reason: KEEP_REASON.notRegular });
        return;
      }
      rmSync(path, { force: true });
      result.removed.push(name);
      log(`Limpieza de temporales: se eliminó ${name}.`);
    } catch (error) {
      result.errors.push({ name, message: error instanceof Error ? error.message : String(error) });
      log(`Limpieza de temporales: no se pudo eliminar ${name}; se conserva.`);
    }
  };

  /** Decide y actúa sobre un temporal ya identificado. */
  const handleTemp = (dir: string, entry: Entry, kind: "upload" | "download" | "partial"): void => {
    result.examined += 1;
    const { name, stats } = entry;
    if (!stats.isFile()) {
      result.kept.push({ name, reason: KEEP_REASON.notRegular });
      return;
    }
    if (at - stats.mtimeMs <= minAgeMs) {
      result.kept.push({ name, reason: KEEP_REASON.recent });
      return;
    }
    // Descargas y parciales: si el id es de un clip REGISTRADO se conservan.
    // `isRegistered` devuelve `true` también si la base falla (conservar de más,
    // nunca de menos). Además, la reconciliación corre DESPUÉS de este barrido:
    // un clip registrado cuyo archivo falta todavía no está marcado como
    // ausente, así que un `.src` viejo se conserva y puede ser la única copia.
    // Si el id no se puede leer, tampoco se toca (no sabemos de quién es).
    if (kind !== "upload") {
      const id = downloadSourceId(name) ?? /^([0-9a-z_-]+)\.(?:mp4|m4a)\.part$/i.exec(name)?.[1] ?? null;
      if (!id || isRegistered(id)) {
        result.kept.push({ name, reason: KEEP_REASON.registered });
        return;
      }
    }
    remove(dir, name);
  };

  // ------------------------------------------------------------- .uploads/
  const uploads = listDir(uploadsDir);
  if (uploads) {
    for (const entry of uploads) {
      const kind = tempKindOf(entry.name);
      if (kind !== "upload") continue;
      handleTemp(uploadsDir, entry, kind);
    }
  }

  // --------------------------------------------------------------- media/
  const media = listDir(mediaDir);
  if (!media) {
    // Una carpeta que no existe es normal en una instalación nueva: es el mismo
    // no-op que la reconciliación, no un fallo del barrido.
    result.aborted = true;
    result.message = existsSync(mediaDir)
      ? "No se pudo leer la carpeta de medios: no se limpia nada."
      : "Todavía no existe la carpeta de medios: no hay nada que limpiar.";
    log(`Limpieza de temporales: ${result.message}`);
    return result;
  }

  // Nombres presentes en /media (para la evidencia de conversión interrumpida).
  const mediaNames = new Set(media.map((entry) => entry.name));

  for (const entry of media) {
    const kind = tempKindOf(entry.name);
    if (kind) {
      // `.src` de un clip registrado cuyo archivo FALTA: puede ser la única copia
      // (la descarga terminó y la conversión no). Es recent, no un huérfano.
      if (kind !== "upload") {
        const id = downloadSourceId(entry.name) ?? /^([0-9a-z_-]+)\.(?:mp4|m4a)\.part$/i.exec(entry.name)?.[1];
        if (id && isRegisteredMissing(id)) {
          result.kept.push({ name: entry.name, reason: KEEP_REASON.registered });
          continue;
        }
      }
      handleTemp(mediaDir, entry, kind);
      continue;
    }
    // Archivo de clip (`<id>.mp4`/`.m4a`): solo se elimina con evidencia de una
    // conversión interrumpida. Sin fila y sin evidencia no se toca: la
    // reconciliación lo importa.
    const ext = mediaExtensionName(entry.name);
    if (!ext || !entry.stats.isFile()) continue;
    const id = entry.name.slice(0, -ext.length);
    if (isRegistered(id)) continue;
    result.examined += 1;
    const pendingDownloads = [...mediaNames].filter(
      (name) => name !== entry.name && isTempFileName(name) && downloadSourceId(name) === id,
    );
    const evidence = checkInterruptedConversion(options.journal ?? null, id, pendingDownloads);
    if (!evidence.interrupted) {
      result.kept.push({ name: entry.name, reason: KEEP_REASON.clipOutput });
      continue;
    }
    if (at - entry.stats.mtimeMs <= minAgeMs) {
      result.kept.push({ name: entry.name, reason: KEEP_REASON.recent });
      continue;
    }
    log(`Limpieza de temporales: ${entry.name} quedó de una conversión interrumpida.`);
    remove(mediaDir, entry.name);
  }

  result.message = `Limpieza de temporales: ${result.examined} examinados, ${result.removed.length} eliminados, ${result.kept.length} conservados.`;
  log(result.message);
  return result;
}
