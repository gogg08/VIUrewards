/**
 * Libro de operaciones de media y evidencia de conversión interrumpida.
 *
 * Pruebas reales sobre un archivo en una carpeta temporal (nunca `logs/`).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkInterruptedConversion,
  MediaOperationJournal,
  PENDING_MEDIA_FILE,
  pendingMediaPath,
} from "./pending-media.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeLogsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-media-"));
  dirs.push(dir);
  return dir;
}

describe("MediaOperationJournal", () => {
  it("registra y quita operaciones (begin/end)", () => {
    const journal = new MediaOperationJournal(makeLogsDir());
    expect(journal.begin("encodes", "abc")).toBe(true);
    expect(journal.begin("encodes", "abc")).toBe(false);
    expect(journal.has("encodes", "abc")).toBe(true);
    expect(journal.entries()).toEqual([{ kind: "encodes", key: "abc" }]);

    expect(journal.end("encodes", "abc")).toBe(true);
    expect(journal.has("encodes", "abc")).toBe(false);
    expect(journal.entries()).toEqual([]);
  });

  it("persiste en logs/pending-media.txt y lo lee una instancia nueva", () => {
    const logsDir = makeLogsDir();
    const journal = new MediaOperationJournal(logsDir);
    journal.begin("encodes", "abc");
    journal.begin("uploads", "11111111-2222-3333-4444-555555555555");

    const file = pendingMediaPath(logsDir);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("encodes abc");

    // Simula un cierre abrupto: se descarta el objeto y se relee el archivo.
    const revived = new MediaOperationJournal(logsDir);
    expect(revived.has("encodes", "abc")).toBe(true);
    expect(revived.has("uploads", "11111111-2222-3333-4444-555555555555")).toBe(true);
  });

  it("al terminar todas las operaciones deja el archivo vacío", () => {
    const logsDir = makeLogsDir();
    const journal = new MediaOperationJournal(logsDir);
    journal.begin("downloads", "abc");
    journal.end("downloads", "abc");
    expect(readFileSync(pendingMediaPath(logsDir), "utf8")).toBe("");
  });

  it("ignora líneas inválidas del archivo (no confía en su contenido)", () => {
    const logsDir = makeLogsDir();
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      pendingMediaPath(logsDir),
      ["basura 123", "encodes abc", "../../etc/passwd", "uploads 11111111-2222-3333-4444-555555555555"].join("\n"),
      "utf8",
    );

    const journal = new MediaOperationJournal(logsDir);
    expect(journal.entries()).toEqual([
      { kind: "encodes", key: "abc" },
      { kind: "uploads", key: "11111111-2222-3333-4444-555555555555" },
    ]);
  });

  it("sin carpeta de logs funciona solo en memoria (nunca lanza)", () => {
    const journal = new MediaOperationJournal(null);
    expect(journal.begin("encodes", "abc")).toBe(true);
    expect(journal.has("encodes", "abc")).toBe(true);
  });

  it("si no se puede escribir el archivo, sigue funcionando en memoria", () => {
    // Una carpeta que no existe: writeFileSync falla y se ignora.
    const journal = new MediaOperationJournal(join(tmpdir(), "no-existe-esta-carpeta-xyz", "logs"));
    expect(journal.begin("downloads", "abc")).toBe(true);
    expect(journal.has("downloads", "abc")).toBe(true);
  });

  it("el nombre del archivo es estable", () => {
    expect(PENDING_MEDIA_FILE).toBe("pending-media.txt");
  });
});

describe("checkInterruptedConversion", () => {
  const journal = { has: (kind: string, key: string) => kind === "encodes" && key === "abc" };

  it("sin libro no hay evidencia", () => {
    expect(checkInterruptedConversion(null, "abc", []).interrupted).toBe(false);
  });

  it("sin la línea encodes del id no hay evidencia", () => {
    expect(checkInterruptedConversion(journal, "otro", []).interrupted).toBe(false);
  });

  it("con encodes y sin descargas vivas es una conversión interrumpida", () => {
    const check = checkInterruptedConversion(journal, "abc", []);
    expect(check.interrupted).toBe(true);
    expect(check.reason).toContain("convirtiendo");
  });

  it("si quedan temporales de descarga del mismo id, NO hay evidencia", () => {
    const check = checkInterruptedConversion(journal, "abc", ["abc.src.mp4"]);
    expect(check.interrupted).toBe(false);
    expect(check.reason).toContain("descarga");
  });
});
