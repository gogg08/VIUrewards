/**
 * Herramientas y mantenimiento de la biblioteca (Etapa 5, Parte B).
 *
 * Se inyecta `run`, así que no se ejecutan yt-dlp ni ffmpeg reales. Se prueba:
 *  - lectura de versiones (una por herramienta, tolerante a fallos),
 *  - actualización de yt-dlp (resultado traducido, nunca lanza),
 *  - espacio de la biblioteca,
 *  - candidatos de limpieza (solo clips de link, fuera de la cola y sin uso).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunProcess } from "../media/run-process.ts";
import type { ClipRecord } from "../db/clips.ts";
import {
  candidatesBytes,
  cleanupCandidates,
  libraryUsage,
  readToolVersions,
  updateYtdlp,
} from "./tools.ts";

const temps: string[] = [];

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "viu-tools-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `run` falso: responde según el binario (último tramo del comando). */
function fakeRun(versions: { ytdlp?: string; ffmpeg?: string; ffprobe?: string; updateCode?: number }): {
  run: RunProcess;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: RunProcess = async (command, args) => {
    calls.push([command, ...args]);
    const base = command.toLowerCase();
    if (base.includes("yt-dlp")) {
      if (args[0] === "-U") {
        return { code: versions.updateCode ?? 0, stdout: "yt-dlp is up to date", stderr: "", signal: null, timedOut: false } as never;
      }
      return { code: 0, stdout: versions.ytdlp ?? "2024.08.06", stderr: "", signal: null, timedOut: false } as never;
    }
    if (base.includes("ffprobe")) {
      return { code: 0, stdout: versions.ffprobe ?? "ffprobe version 6.1", stderr: "", signal: null, timedOut: false } as never;
    }
    return { code: 0, stdout: versions.ffmpeg ?? "ffmpeg version 6.1", stderr: "", signal: null, timedOut: false } as never;
  };
  return { run, calls };
}

const ALL_BINARIES = {
  pathEnv: "",
  exists: () => true,
};

function clip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: "abc",
    sourceUrl: "https://x/y",
    title: "Clip",
    durationSec: 5,
    sizeBytes: 0,
    file: "abc.mp4",
    createdAt: "2024-01-01T00:00:00.000Z",
    trimStart: null,
    trimEnd: null,
    hasVideo: true,
    missing: false,
    ...overrides,
  };
}

describe("readToolVersions", () => {
  it("lee la versión de cada herramienta", async () => {
    const { run } = fakeRun({ ytdlp: "2024.08.06", ffmpeg: "ffmpeg version 6.1", ffprobe: "ffprobe version 6.1" });
    const versions = await readToolVersions({ run, binarySearch: ALL_BINARIES });
    expect(versions.ytDlp).toBe("2024.08.06");
    expect(versions.ffmpeg).toContain("6.1");
    expect(versions.ffprobe).toContain("6.1");
  });

  it("devuelve null para la herramienta que falla, sin lanzar", async () => {
    const run: RunProcess = async (command) => {
      if (command.includes("ffprobe")) throw new Error("boom");
      return { code: 0, stdout: "ok", stderr: "", signal: null, timedOut: false } as never;
    };
    const versions = await readToolVersions({ run, binarySearch: ALL_BINARIES });
    expect(versions.ffprobe).toBeNull();
    expect(versions.ytDlp).toBe("ok");
  });

  it("sin binarios detectados devuelve todo null", async () => {
    const { run } = fakeRun({});
    const versions = await readToolVersions({ run, binarySearch: { pathEnv: "", exists: () => false } });
    expect(versions).toEqual({ ytDlp: null, ffmpeg: null, ffprobe: null });
  });

  it("lee la versión de ffmpeg aunque venga en stderr con código distinto de 0", async () => {
    // ffmpeg real (Windows) escribe la versión en stderr y sale con un código
    // raro (no 0). Sin esto, la versión salía "no detectada" aunque el binario
    // estuviera instalado.
    const run: RunProcess = async () => ({
      code: 3202818816,
      stdout: "",
      stderr: "ffmpeg version 2023-08-17-git Copyright",
      signal: null,
      timedOut: false,
    }) as never;
    const versions = await readToolVersions({ run, binarySearch: ALL_BINARIES });
    expect(versions.ffmpeg).toContain("ffmpeg version");
  });
});

describe("updateYtdlp", () => {
  it("actualiza correctamente y devuelve la salida", async () => {
    const { run } = fakeRun({ updateCode: 0 });
    const result = await updateYtdlp({ run, binarySearch: ALL_BINARIES });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("up to date");
    expect(result.message).toContain("actualizó");
  });

  it("sin yt-dlp no ejecuta nada y avisa en español", async () => {
    const { run, calls } = fakeRun({});
    const result = await updateYtdlp({ run, binarySearch: { pathEnv: "", exists: () => false } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("yt-dlp");
    expect(calls).toHaveLength(0);
  });

  it("un fallo del proceso no lanza: lo traduce a un mensaje", async () => {
    const { run } = fakeRun({ updateCode: 1 });
    const result = await updateYtdlp({ run, binarySearch: ALL_BINARIES });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no pudo actualizarse");
  });

  it("el mensaje del binario faltante trae el qué hacer, no un texto interno", async () => {
    // Sin `run`: el real se conecta por defecto, pero con binarios faltantes ni se
    // ejecuta nada y el mensaje debe explicar cómo instalarlos.
    const result = await updateYtdlp({ binarySearch: { pathEnv: "", exists: () => false } });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("ejecutor de procesos");
    expect(result.message).toContain("bin/");
  });

  it("un fallo de escritura (sin permisos) no toca el binario y explica en español", async () => {
    // Nosotros no escribimos el binario: `yt-dlp -U` lo hace él mismo y, si no
    // puede, aborta dejando el ejecutable intacto. Simulamos ese fallo y
    // verificamos que el binario sigue respondiendo su versión.
    const run: RunProcess = async (_command, args) => {
      if (args[0] === "-U") {
        return {
          code: 1,
          stdout: "",
          stderr: "ERROR: unable to write to /usr/local/bin/yt-dlp (permission denied)",
          signal: null,
          timedOut: false,
        } as never;
      }
      return { code: 0, stdout: "2024.08.06", stderr: "", signal: null, timedOut: false } as never;
    };
    const failed = await updateYtdlp({ run, binarySearch: ALL_BINARIES });
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("no pudo actualizarse");
    expect(failed.output).toContain("permission denied");

    // El binario sigue usable: la detección de versión funciona igual.
    const versions = await readToolVersions({ run, binarySearch: ALL_BINARIES });
    expect(versions.ytDlp).toBe("2024.08.06");
  });

  it("un timeout del proceso no lanza: mensaje claro", async () => {
    const run: RunProcess = async () => ({ code: null, stdout: "", stderr: "", signal: null, timedOut: true }) as never;
    const result = await updateYtdlp({ run, binarySearch: ALL_BINARIES });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no pudo actualizarse");
  });
});

describe("libraryUsage", () => {
  it("suma los archivos de los clips y las miniaturas", () => {
    const mediaDir = makeTemp();
    writeFileSync(join(mediaDir, "abc.mp4"), "12345");
    writeFileSync(join(mediaDir, "def.mp4"), "123");
    mkdirSync(join(mediaDir, "thumbs"), { recursive: true });
    writeFileSync(join(mediaDir, "thumbs", "abc.jpg"), "12");

    const usage = libraryUsage(mediaDir, [clip({ id: "abc", file: "abc.mp4" }), clip({ id: "def", file: "def.mp4" })]);
    expect(usage.clips).toBe(2);
    expect(usage.clipBytes).toBe(8);
    expect(usage.thumbBytes).toBe(2);
    expect(usage.totalBytes).toBe(10);
  });

  it("no sigue rutas que se escapan de la carpeta de medios", () => {
    const mediaDir = makeTemp();
    const usage = libraryUsage(mediaDir, [clip({ file: "../secreto.mp4" })]);
    expect(usage.clipBytes).toBe(0);
  });
});

describe("cleanupCandidates", () => {
  it("solo incluye clips de link, fuera de la cola y sin uso", () => {
    const mediaDir = makeTemp();
    const clips = [
      clip({ id: "link-libre", file: "link-libre.mp4" }),
      clip({ id: "link-en-cola", file: "link-en-cola.mp4" }),
      clip({ id: "link-en-uso", file: "link-en-uso.mp4" }),
      clip({ id: "local", sourceUrl: "", file: "local.mp4" }),
    ];
    const candidates = cleanupCandidates(
      mediaDir,
      clips,
      new Set(["link-en-cola"]),
      new Set(["link-en-uso"]),
    );
    expect(candidates.map((c) => c.id)).toEqual(["link-libre"]);
  });

  it("nunca incluye un archivo local aunque no esté en uso", () => {
    const mediaDir = makeTemp();
    const candidates = cleanupCandidates(mediaDir, [clip({ id: "a", sourceUrl: "", file: "a.m4a" })], new Set(), new Set());
    expect(candidates).toHaveLength(0);
  });

  it("candidatesBytes suma los tamaños", () => {
    expect(
      candidatesBytes([
        { id: "a", title: "A", file: "a.mp4", sizeBytes: 10 },
        { id: "b", title: "B", file: "b.mp4", sizeBytes: 32 },
      ]),
    ).toBe(42);
  });
});
