/**
 * Prueba de INTEGRACIÓN del rebuild de la reconciliación con ffmpeg/ffprobe REALES.
 *
 * El rebuild de un clip sin sidecar solo estaba cubierto con un `run` inyectado.
 * Esta prueba usa los binarios reales de la PC:
 *
 *  1. Genera un mp4 y un m4a de ~2 s con el MISMO `ingestLocalFile` que usa la
 *     app (que a su vez usa los mismos argumentos de ffmpeg/ffprobe).
 *  2. Borra los sidecar `.json` para forzar la reconstrucción por ffprobe.
 *  3. Corre `reconcileClips` con `createClipRebuilder` (ffprobe real) sobre una
 *     base en memoria y verifica que re-agrega cada clip con duración, tamaño y
 *     `has_video` correctos.
 *
 * NO corre con `npm test` (que sería lento y depende de binarios). Se corre con:
 *
 *   npm run test:e2e
 *
 * Si ffmpeg o ffprobe no están disponibles, se SALTA con un aviso claro.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getClip, listClips, openMemoryDatabase, reconcileClips } from "../../src/db/index.ts";
import { detectBinaries } from "../../src/media/binaries.ts";
import { ingestLocalFile } from "../../src/media/ingest.ts";
import { createClipRebuilder } from "../../src/media/rebuild.ts";
import { runProcess } from "../../src/media/run-process.ts";

const detection = detectBinaries();
/**
 * La prueba necesita ffmpeg (para generar los archivos) y ffprobe (para
 * reconstruir). No exige yt-dlp: no se descarga nada.
 */
const binariesAvailable = detection.ok;
const skipReason = binariesAvailable
  ? ""
  : "Se omite: faltan ffmpeg y/o ffprobe reales en esta PC (o en bin/). Instalalos para correr esta prueba.";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "viu-e2e-"));
  dirs.push(dir);
  return dir;
}

/**
 * Genera un archivo de entrada de prueba con ffmpeg real, usando argumentos
 * equivalentes a los que produce la app (sintético, sin descargar nada).
 *  - video: testsrc a 320x240 + audio senoidal, 2 s.
 *  - audio: solo senoidal, 2 s.
 */
async function makeSource(kind: "video" | "audio", outPath: string): Promise<void> {
  const args =
    kind === "video"
      ? [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=320x240:rate=25:duration=2",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=2",
          "-shortest",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          outPath,
        ]
      : [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=2",
          "-c:a",
          "aac",
          outPath,
        ];
  const result = await runProcess(detection.ok ? detection.binaries.ffmpeg : "ffmpeg", args, {
    timeoutMs: 60_000,
  });
  if (result.code !== 0 || !existsSync(outPath)) {
    throw new Error(`No se pudo generar el archivo de prueba (${kind}): ${result.stderr}`);
  }
}

/** Borra el sidecar `<id>.json` (simula un archivo sin metadata en /media). */
function removeSidecar(mediaDir: string, id: string): void {
  const path = join(mediaDir, `${id}.json`);
  if (existsSync(path)) unlinkSync(path);
}

afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe.skipIf(!binariesAvailable)("rebuild con ffmpeg/ffprobe reales", () => {
  beforeAll(() => {
    if (!binariesAvailable) console.warn(skipReason);
  });

  it("reconstruye un mp4 sin sidecar con duración, tamaño y has_video correctos", async () => {
    const parent = makeTempDir();
    const mediaDir = join(parent, "media");
    const source = join(parent, "entrada-video.mp4");
    await makeSource("video", source);

    // Ingesta REAL (mismos argumentos que la app): crea <id>.mp4 + <id>.json.
    const ingested = await ingestLocalFile(source, { mediaDir, binarySearch: undefined });
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    expect(ingested.clip.hasVideo).toBe(true);

    // Forzamos la reconstrucción: borramos el sidecar.
    removeSidecar(mediaDir, ingested.clip.id);

    const db = openMemoryDatabase();
    const rebuild = createClipRebuilder({ mediaDir });
    const result = await reconcileClips(db, mediaDir, { rebuild });

    expect(result.added).toEqual([ingested.clip.id]);
    expect(result.skipped).toEqual([]);

    const clip = getClip(db, ingested.clip.id);
    expect(clip).not.toBeNull();
    expect(clip?.hasVideo).toBe(true);
    expect(clip?.file.endsWith(".mp4")).toBe(true);
    // Duración de ~2 s (redondeada); el archivo de prueba dura exactamente 2 s.
    expect(clip?.durationSec).toBe(2);
    // Tamaño real del archivo en disco (ffprobe no lo cambia).
    const size = statSync(join(mediaDir, clip?.file as string)).size;
    expect(clip?.sizeBytes).toBe(size);
    expect(clip?.sizeBytes).toBeGreaterThan(0);
    // Título derivado legible (nunca el id completo).
    expect(clip?.title).toMatch(/^Clip /);
  });

  it("reconstruye un m4a sin sidecar con has_video en falso", async () => {
    const parent = makeTempDir();
    const mediaDir = join(parent, "media");
    const source = join(parent, "entrada-audio.m4a");
    await makeSource("audio", source);

    const ingested = await ingestLocalFile(source, { mediaDir });
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    expect(ingested.clip.hasVideo).toBe(false);

    removeSidecar(mediaDir, ingested.clip.id);

    const db = openMemoryDatabase();
    const rebuild = createClipRebuilder({ mediaDir });
    const result = await reconcileClips(db, mediaDir, { rebuild });

    expect(result.added).toEqual([ingested.clip.id]);
    const clip = getClip(db, ingested.clip.id);
    expect(clip?.hasVideo).toBe(false);
    expect(clip?.file.endsWith(".m4a")).toBe(true);
    expect(clip?.durationSec).toBe(2);
    expect(clip?.sizeBytes).toBe(statSync(join(mediaDir, clip?.file as string)).size);
    expect(clip?.title).toMatch(/^Audio /);
  });

  it("un archivo que no es medio se omite y se registra (no se borra)", async () => {
    const parent = makeTempDir();
    const mediaDir = join(parent, "media");
    mkdirSync(mediaDir, { recursive: true });
    // Un .mp4 falso (texto plano): ffprobe real lo rechaza.
    writeFileSync(join(mediaDir, "falso.mp4"), "esto no es un video");

    const db = openMemoryDatabase();
    const rebuild = createClipRebuilder({ mediaDir });
    const result = await reconcileClips(db, mediaDir, { rebuild });

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(["falso.mp4"]);
    expect(listClips(db)).toHaveLength(0);
    // El archivo trucho sigue en disco.
    expect(existsSync(join(mediaDir, "falso.mp4"))).toBe(true);
  });
});
