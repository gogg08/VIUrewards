/**
 * Tests de las miniaturas de clips (sección 2.4).
 *
 * No se ejecuta ffmpeg real: se inyecta `run`. Se prueba:
 *  - los argumentos como array (spawn, nunca un string),
 *  - el instante elegido según la duración (10 %, mínimo 1 s),
 *  - el respaldo ante un fallo (ok:false, sin archivo),
 *  - que el clip no se toca y la salida la genera la app,
 *  - el borrado conjunto.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, RunProcess } from "./run-process.ts";
import {
  DEFAULT_THUMB_WIDTH,
  generateThumbnail,
  removeThumb,
  thumbExists,
  thumbPath,
  thumbTimestamp,
  thumbsDir,
} from "./thumbs.ts";

const dirs: string[] = [];

function makeMediaDir(): string {
  const parent = mkdtempSync(join(tmpdir(), "thumbs-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return mediaDir;
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

/** Ejecutor falso: ffmpeg crea la salida (último argumento) y devuelve el código indicado. */
function fakeRun(code = 0): { run: RunProcess; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunProcess = async (command, args): Promise<ProcessResult> => {
    calls.push([command, ...args]);
    if (code === 0) writeFileSync(args[args.length - 1], "jpg-out");
    return { code, stdout: "", stderr: "", timedOut: false };
  };
  return { run, calls };
}

describe("thumbTimestamp", () => {
  it("usa el 10 % de la duración", () => {
    expect(thumbTimestamp(100)).toBe(10);
  });

  it("aplica un mínimo de 1 s para clips cortos", () => {
    expect(thumbTimestamp(4)).toBe(1);
    expect(thumbTimestamp(9)).toBe(1);
  });

  it("nunca pasa del final del clip", () => {
    expect(thumbTimestamp(2)).toBeLessThan(2);
  });

  it("cae a 0 ante una duración inválida", () => {
    expect(thumbTimestamp(0)).toBe(0);
    expect(thumbTimestamp(Number.NaN)).toBe(0);
  });
});

describe("generateThumbnail", () => {
  it("genera la miniatura con argumentos en array y la carpeta thumbs", async () => {
    const mediaDir = makeMediaDir();
    const clipPath = join(mediaDir, "abc.mp4");
    writeFileSync(clipPath, "clip");
    const { run, calls } = fakeRun();

    const result = await generateThumbnail(clipPath, "abc", {
      mediaDir,
      durationSec: 40,
      binarySearch,
      run,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(thumbPath(mediaDir, "abc"));
    expect(existsSync(result.path)).toBe(true);
    expect(thumbExists(mediaDir, "abc")).toBe(true);
    // Un solo llamado, a ffmpeg, con args en array (nunca un comando string).
    expect(calls).toHaveLength(1);
    const args = calls[0];
    expect(args[0]).toContain("ffmpeg");
    expect(args).toContain("-i");
    expect(args).toContain(clipPath);
    expect(args).toContain("-frames:v");
    // `-ss` = 10 % de 40 s = 4 s.
    expect(args[args.indexOf("-ss") + 1]).toBe("4");
    expect(args).toContain(thumbPath(mediaDir, "abc"));
    // La carpeta de miniaturas vive fuera de la lista de clips.
    expect(thumbPath(mediaDir, "abc").startsWith(thumbsDir(mediaDir))).toBe(true);
  });

  it("no agranda imágenes más chicas que el ancho máximo", async () => {
    const mediaDir = makeMediaDir();
    const clipPath = join(mediaDir, "abc.mp4");
    writeFileSync(clipPath, "clip");
    const { run, calls } = fakeRun();

    await generateThumbnail(clipPath, "abc", { mediaDir, durationSec: 30, binarySearch, run });

    const vf = calls[0][calls[0].indexOf("-vf") + 1];
    expect(vf).toContain(String(DEFAULT_THUMB_WIDTH));
    expect(vf).toContain("min(");
  });

  it("ante un fallo devuelve ok:false sin dejar archivo (el clip sigue usable)", async () => {
    const mediaDir = makeMediaDir();
    const clipPath = join(mediaDir, "abc.mp4");
    writeFileSync(clipPath, "clip");
    const { run } = fakeRun(1);

    const result = await generateThumbnail(clipPath, "abc", { mediaDir, durationSec: 30, binarySearch, run });

    expect(result.ok).toBe(false);
    expect(thumbExists(mediaDir, "abc")).toBe(false);
  });

  it("ante un timeout no deja archivo", async () => {
    const mediaDir = makeMediaDir();
    const clipPath = join(mediaDir, "abc.mp4");
    writeFileSync(clipPath, "clip");
    const run: RunProcess = async () => ({ code: 0, stdout: "", stderr: "", timedOut: true });

    const result = await generateThumbnail(clipPath, "abc", { mediaDir, durationSec: 30, binarySearch, run });

    expect(result.ok).toBe(false);
    expect(thumbExists(mediaDir, "abc")).toBe(false);
  });

  it("no modifica el clip original", async () => {
    const mediaDir = makeMediaDir();
    const clipPath = join(mediaDir, "abc.mp4");
    writeFileSync(clipPath, "clip-original");
    const { run } = fakeRun();

    await generateThumbnail(clipPath, "abc", { mediaDir, durationSec: 30, binarySearch, run });

    expect(existsSync(clipPath)).toBe(true);
  });
});

describe("removeThumb", () => {
  it("borra la miniatura junto con el clip", async () => {
    const mediaDir = makeMediaDir();
    const clipPath = join(mediaDir, "abc.mp4");
    writeFileSync(clipPath, "clip");
    const { run } = fakeRun();
    await generateThumbnail(clipPath, "abc", { mediaDir, durationSec: 30, binarySearch, run });
    expect(thumbExists(mediaDir, "abc")).toBe(true);

    removeThumb(mediaDir, "abc");

    expect(thumbExists(mediaDir, "abc")).toBe(false);
    // El clip en sí no se toca: eso lo decide quien llama.
    expect(existsSync(clipPath)).toBe(true);
  });
});
