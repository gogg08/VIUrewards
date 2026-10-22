/**
 * Operaciones de media en curso (libro en memoria) + evidencia de una
 * conversión interrumpida.
 *
 * Para qué sirve: al arrancar hay que decidir si un archivo final
 * (`<id>.mp4` / `<id>.m4a`) sin fila en la base es un **artefacto de una
 * operación interrumpida** o un archivo que hay que importar. Borrar un mp4 sin
 * fila "porque no está registrado" sería destructivo: la reconciliación los
 * importa a propósito.
 *
 * El libro resuelve el caso en el que la app **ve** la operación de punta a
 * punta: la limpieza corre al arrancar, cuando todavía no hay nada en curso, así
 * que el libro también se escribe en un archivo pequeño en `logs/` para que
 * sobreviva a un cierre abrupto:
 *
 *  - `logs/pending-media.txt`, una línea por operación:
 *    `encodes <id>` (yt-dlp + ffmpeg ya escribieron `<id>.mp4`),
 *    `downloads <id>` (yt-dlp empezó con `<id>.src.*`),
 *    `uploads <uuid>` (se está recibiendo una subida).
 *  - Se reescribe al empezar y al terminar cada operación (las terminadas se
 *    quitan). Si el proceso muere a la fuerza, queda la línea.
 *
 * La evidencia de una conversión interrumpida exige **las dos cosas**:
 *
 *  1. una línea `encodes <id>` del libro (la app misma declaró que escribió ese
 *     archivo y todavía no terminó de registrarlo), y
 *  2. ningún temporal de descarga vivo (`<id>.src.*`, `<id>.src.info.json`,
 *     `.part`) del mismo id: si quedan, el trabajo puede seguir en curso.
 *
 * Sin la línea del libro el archivo se conserva: no hay forma segura de
 * distinguirlo de un clip del usuario. Esto también cubre el caso de un proceso
 * muerto antes del ESCRITO FINAL: se conserva, y la reconciliación lo importa.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MediaOperationKind = "encodes" | "downloads" | "uploads";

export interface MediaOperation {
  kind: MediaOperationKind;
  /** Id del clip (para encodes/downloads) o de la subida (uuid). */
  key: string;
}

/** Archivo del libro dentro de la carpeta de logs. */
export const PENDING_MEDIA_FILE = "pending-media.txt";

/** Nombre del libro dentro de `logs/` (para los llamadores que no quieren la ruta). */
export function pendingMediaPath(logsDir: string): string {
  return join(logsDir, PENDING_MEDIA_FILE);
}

function serialize(operations: ReadonlyMap<string, MediaOperation>): string {
  const lines = [...operations.values()].map((operation) => `${operation.kind} ${operation.key}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function operationId(operation: MediaOperation): string {
  return `${operation.kind} ${operation.key}`;
}

/**
 * Libro de operaciones (interfaz). Ver `FileMediaOperationJournal`.
 */
export interface MediaOperationJournal {
  /** Operaciones registradas ahora (incluidas las de una ejecución anterior). */
  entries(): MediaOperation[];
  /** ¿Hay una operación de este tipo para esta clave? */
  has(kind: MediaOperationKind, key: string): boolean;
  /** Marca el inicio; `true` si es nueva. Reescribe el archivo (best-effort). */
  begin(kind: MediaOperationKind, key: string): boolean;
  /** Marca el fin (se quita del libro). `true` si estaba. */
  end(kind: MediaOperationKind, key: string): boolean;
  /** Archivo donde se persiste, o `null` si el libro vive solo en memoria. */
  readonly path: string | null;
}

/**
 * Libro de operaciones en disco. Nunca lanza: si no puede escribir el archivo,
 * sigue funcionando en memoria (la limpieza simplemente no encuentra la
 * evidencia).
 */
export class FileMediaOperationJournal implements MediaOperationJournal {
  private readonly operations = new Map<string, MediaOperation>();
  readonly path: string | null;
  /** `true` en modo lectura (`transient`): nunca escribe el archivo. */
  private readonly readOnly: boolean;

  constructor(logsDir: string | null, options: { transient?: boolean } = {}) {
    this.path = logsDir ? pendingMediaPath(logsDir) : null;
    this.readOnly = options.transient === true;
    // `transient`: el libro NO persiste (solo lectura). Lo usa la limpieza de
    // arranque para leer la evidencia de un cierre abrupto sin reescribir el
    // archivo: el libro de la sesión (otro objeto) sigue siendo el dueño, y un
    // fallo de escritura no puede hacer perder la evidencia antes de usarla.
    if (this.readOnly) {
      this.load();
      return;
    }
    if (!this.path || !existsSync(this.path)) return;
    // Al arrancar se carga lo que dejó un cierre abrupto (best-effort).
    this.load();
  }

  /** Lee el archivo y carga las operaciones (best-effort, nunca lanza). */
  private load(): void {
    if (!this.path) return;
    try {
      const text = readFileSync(this.path, "utf8");
      for (const line of text.split("\n")) {
        const match = /^(encodes|downloads|uploads) ([0-9a-z_-]+)$/i.exec(line.trim());
        if (match) this.operations.set(`${match[1]} ${match[2]}`, { kind: match[1] as MediaOperationKind, key: match[2] });
      }
    } catch {
      // Libro ilegible: se ignora (se reescribe con lo nuevo).
    }
  }

  /** Operaciones registradas ahora (incluidas las de una ejecución anterior). */
  entries(): MediaOperation[] {
    return [...this.operations.values()];
  }

  /** ¿Hay una operación de este tipo para esta clave? */
  has(kind: MediaOperationKind, key: string): boolean {
    return this.operations.has(`${kind} ${key}`);
  }

  /** Marca el inicio; `true` si es nueva. Reescribe el archivo (best-effort). */
  begin(kind: MediaOperationKind, key: string): boolean {
    const id = `${kind} ${key}`;
    if (this.operations.has(id)) return false;
    this.operations.set(id, { kind, key });
    this.flush();
    return true;
  }

  /** Marca el fin (se quita del libro). `true` si estaba. */
  end(kind: MediaOperationKind, key: string): boolean {
    const removed = this.operations.delete(`${kind} ${key}`);
    if (removed) this.flush();
    return removed;
  }

  /** Vuelve a escribir el archivo. Escribe primero a un temporal y renombra. */
  private flush(): void {
    // En modo lectura no se escribe nunca; con `path === null` (en memoria)
    // tampoco hay nada que persistir.
    if (!this.path || this.readOnly) return;
    const temporary = `${this.path}.tmp`;
    try {
      writeFileSync(temporary, serialize(this.operations), "utf8");
      renameSync(temporary, this.path);
    } catch {
      // Sin permiso o disco lleno: queda solo en memoria.
    }
  }
}

export interface InterruptedConversionCheck {
  /** ¿El archivo final es, con evidencia, una salida de conversión interrumpida? */
  interrupted: boolean;
  /** Motivo legible (para el log y los tests). */
  reason: string;
}

/**
 * Decide si un archivo final (`<id>.<ext>`) es una conversión interrumpida.
 *
 * `pendingDownloads` son los nombres presentes en `/media` que empiezan con
 * `<id>.src.` (si hay alguno, el trabajo puede seguir en curso).
 */
export function checkInterruptedConversion(
  journal: { has(kind: MediaOperationKind, key: string): boolean } | null,
  id: string,
  pendingDownloads: readonly string[],
): InterruptedConversionCheck {
  if (!journal || !journal.has("encodes", id)) {
    return { interrupted: false, reason: "No hay constancia de una conversión de la app para este archivo." };
  }
  if (pendingDownloads.length > 0) {
    return { interrupted: false, reason: "Todavía quedan temporales de descarga de este archivo." };
  }
  return { interrupted: true, reason: "La app estaba convirtiendo este archivo y no llegó a registrarlo." };
}

/**
 * Nombre histórico del libro en disco. Se mantiene como alias para no cambiar
 * los llamadores existentes ni los tests: lo que se instancia es el libro que
 * persiste en `logs/pending-media.txt`. El tipo es `MediaOperationJournal`.
 */
export const MediaOperationJournal = FileMediaOperationJournal;
