/**
 * Tests de la ingesta de archivos locales (Etapa 3B).
 *
 * No se ejecutan ffmpeg ni ffprobe reales: se inyecta `run`. Se prueba:
 *  - validación por CONTENIDO (no por extensión),
 *  - límites de tamaño y duración,
 *  - duplicados por contenido,
 *  - nombre generado (nunca el original) y que el original no se toca,
 *  - audio -> m4a (hasVideo false) y video -> mp4 (hasVideo true).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, RunProcess } from "./run-process.ts";
import { defaultTitle, ingestLocalFile } from "./ingest.ts";

const dirs: string[] = [];

function makeDirs(): { mediaDir: string; logsDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "ingest-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  const logsDir = join(parent, "logs");
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return { mediaDir, logsDir, parent };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const binarySearch = {
  pathEnv: "/fake/bin",
  extraDirs: [] as string[],
  platform: "linux" as NodeJS.Platform,
  exists: () => true,
};

interface ProbeJson {
  streams: Array<{ codec_type: string }>;
  format: { duration: string };
}

/** Ejecutor falso: responde ffprobe con un JSON fijo y ffmpeg creando la salida. */
function fakeRun(probe: ProbeJson): { run: RunProcess; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunProcess = async (command, args): Promise<ProcessResult> => {
    calls.push([command, ...args]);
    if (command.includes("ffprobe")) {
      return { code: 0, stdout: JSON.stringify(probe), stderr: "", timedOut: false };
    }
    // ffmpeg: crea el archivo de salida (último argumento).
    writeFileSync(args[args.length - 1], "salida");
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { run, calls };
}

function writeSource(parent: string, name: string, content = "contenido-unico"): string {
  const path = join(parent, name);
  writeFileSync(path, content);
  return path;
}

describe("ingestLocalFile", () => {
  it("acepta un video y lo normaliza a mp4 con hasVideo en verdadero", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "grabacion.MP4", "video-bytes");
    const { run } = fakeRun({ streams: [{ codec_type: "video" }], format: { duration: "12.4" } });

    const result = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clip.hasVideo).toBe(true);
    expect(result.clip.path.endsWith(".mp4")).toBe(true);
    expect(result.clip.durationSec).toBe(12);
    expect(result.clip.local).toBe(true);
    expect(result.clip.duplicate).toBe(false);
    // El título sugerido sale del nombre original, sin extensión.
    expect(result.clip.title).toBe("grabacion");
  });

  it("acepta un audio y lo normaliza a m4a con hasVideo en falso", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "cancion.mp3", "audio-bytes");
    const { run } = fakeRun({ streams: [{ codec_type: "audio" }], format: { duration: "30" } });

    const result = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clip.hasVideo).toBe(false);
    expect(result.clip.path.endsWith(".m4a")).toBe(true);
  });

  it("valida por contenido: un archivo con extensión de video pero sin streams se rechaza", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "trampa.mp4", "no-es-media");
    const { run } = fakeRun({ streams: [], format: { duration: "0" } });

    const result = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_MEDIA");
  });

  it("rechaza un archivo que ffprobe no puede leer", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "roto.mp4", "basura");
    const run: RunProcess = async () => ({ code: 1, stdout: "", stderr: "error", timedOut: false });

    const result = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NOT_MEDIA");
  });

  it("respeta el límite de tamaño antes de gastar procesos", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "grande.mp4", "x".repeat(2048));
    const { run, calls } = fakeRun({ streams: [{ codec_type: "video" }], format: { duration: "5" } });

    const result = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run, maxBytes: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("TOO_BIG");
    expect(calls).toHaveLength(0);
  });

  it("respeta el límite de duración", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "largo.mp4", "x".repeat(10));
    const { run } = fakeRun({ streams: [{ codec_type: "video" }], format: { duration: "600" } });

    const result = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run, maxDurationSec: 60 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("TOO_LONG");
  });

  it("detecta duplicados por contenido y reutiliza el clip existente", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "uno.mp4", "mismo-contenido");
    const other = writeSource(parent, "dos.mp4", "mismo-contenido");
    const { run } = fakeRun({ streams: [{ codec_type: "video" }], format: { duration: "8" } });

    const first = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run });
    const second = await ingestLocalFile(other, { mediaDir, logsDir, binarySearch, run });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.clip.id).toBe(first.clip.id);
    expect(second.clip.duplicate).toBe(true);
  });

  it("nunca toca el archivo original", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "original.mp4", "contenido-original");
    const before = readFileSync(source, "utf8");
    const { run } = fakeRun({ streams: [{ codec_type: "video" }], format: { duration: "5" } });

    await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run });

    expect(readFileSync(source, "utf8")).toBe(before);
  });

  it("el nombre del archivo en disco es el id generado, no el original", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = writeSource(parent, "con espacios raros .mp4", "contenido-x");
    const { run } = fakeRun({ streams: [{ codec_type: "video" }], format: { duration: "5" } });

    const result = await ingestLocalFile(source, { mediaDir, logsDir, binarySearch, run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clip.path).not.toContain("espacios");
    expect(basename(result.clip.path)).toMatch(/^[0-9a-f]{32}\.mp4$/);
  });
});

describe("defaultTitle", () => {
  it("quita la extensión y colapsa espacios", () => {
    expect(defaultTitle("  Mi  Video  Final.MP4")).toBe("Mi Video Final");
  });

  it("cae a un texto genérico si queda vacío", () => {
    expect(defaultTitle(".mp4")).toBe("Clip local");
  });
});
