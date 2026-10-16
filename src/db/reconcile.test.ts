/**
 * Reconciliación de la biblioteca al arrancar (bug de audio que desaparece).
 *
 * Reproduce el flujo REAL: se ingesta un archivo local (audio .m4a y video .mp4)
 * con el mismo `ingestLocalFile` que usa el servidor, con `run` inyectado; luego
 * se "reinicia" (se abre una instancia nueva sobre la misma carpeta y base) y se
 * verifica que los clips sobreviven con los mismos datos.
 *
 * No se ejecuta ffmpeg ni ffprobe reales.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ingestLocalFile } from "../media/ingest.ts";
import { createClipRebuilder } from "../media/rebuild.ts";
import type { ProcessResult, RunProcess } from "../media/run-process.ts";
import {
  getClip,
  listClips,
  openMemoryDatabase,
  reconcileClips,
  renameClip,
  setClipTrim,
  upsertClip,
  upsertReward,
  type ClipRecord,
} from "./index.ts";

const dirs: string[] = [];

function makeDirs(): { mediaDir: string; logsDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "reconcile-test-"));
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

/** Ejecutor falso: ffprobe responde según el tipo; ffmpeg crea la salida. */
function fakeRun(kind: "audio" | "video"): RunProcess {
  const probe = {
    streams: [{ codec_type: kind }],
    format: { duration: "9", format_name: kind === "audio" ? "mp3" : "mov,mp4,m4a,3gp,3g2,mj2" },
  };
  return async (command, args): Promise<ProcessResult> => {
    if (command.includes("ffprobe")) {
      return { code: 0, stdout: JSON.stringify(probe), stderr: "", timedOut: false };
    }
    // ffmpeg: crea la salida (último argumento).
    writeFileSync(args[args.length - 1], "out");
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}

/** Simula "registrar el clip" como hace el servidor al terminar una ingesta. */
function registerClip(
  db: ReturnType<typeof openMemoryDatabase>,
  clip: { id: string; title: string; durationSec: number; sizeBytes: number; hasVideo: boolean },
): void {
  upsertClip(db, {
    id: clip.id,
    sourceUrl: "",
    title: clip.title,
    durationSec: clip.durationSec,
    sizeBytes: clip.sizeBytes,
    file: `${clip.id}.${clip.hasVideo ? "mp4" : "m4a"}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    trimStart: null,
    trimEnd: null,
    hasVideo: clip.hasVideo,
    missing: false,
  });
}

describe("reinicio con un audio local (.m4a)", () => {
  it("el clip sobrevive al reinicio y conserva sus datos", async () => {
    const { mediaDir, logsDir, parent } = makeDirs();
    const source = join(parent, "cancion.mp3");
    writeFileSync(source, "audio-bytes");

    const ingested = await ingestLocalFile(source, {
      mediaDir,
      logsDir,
      binarySearch,
      run: fakeRun("audio"),
    });
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;
    expect(ingested.clip.hasVideo).toBe(false);

    const db = openMemoryDatabase();
    registerClip(db, ingested.clip);
    expect(listClips(db)).toHaveLength(1);

    // "Reinicio": la reconciliación de arranque corre sobre la misma carpeta y base.
    const result = await reconcileClips(db, mediaDir);

    // El audio debe seguir en la biblioteca, con los mismos datos.
    const clips = listClips(db);
    expect(clips).toHaveLength(1);
    expect(clips[0].id).toBe(ingested.clip.id);
    expect(clips[0].file.endsWith(".m4a")).toBe(true);
    expect(clips[0].hasVideo).toBe(false);
    expect(clips[0].title).toBe("cancion");
    // Y no debe figurar como ausente ni omitido.
    expect(clips[0].missing).toBe(false);
    expect(result.missing).toEqual([]);
  });
});

describe("reinicio con un video de link (mp4)", () => {
  it("conserva el título renombrado, el recorte y has_video", async () => {
    const { mediaDir } = makeDirs();
    writeFileSync(join(mediaDir, "vid.mp4"), "mp4");
    writeFileSync(
      join(mediaDir, "vid.json"),
      JSON.stringify({ title: "Original", durationSec: 10, sourceUrl: "https://x/y" }),
    );

    const db = openMemoryDatabase();
    upsertClip(db, {
      id: "vid",
      sourceUrl: "https://x/y",
      title: "Renombrado",
      durationSec: 10,
      sizeBytes: 4,
      file: "vid.mp4",
      createdAt: "2026-01-01T00:00:00.000Z",
      trimStart: 1,
      trimEnd: 5,
      hasVideo: true,
      missing: false,
    });
    renameClip(db, "vid", "Renombrado por el usuario");
    setClipTrim(db, "vid", 2, 7);

    await reconcileClips(db, mediaDir);

    const clip = getClip(db, "vid");
    expect(clip?.title).toBe("Renombrado por el usuario");
    expect(clip?.trimStart).toBe(2);
    expect(clip?.trimEnd).toBe(7);
    expect(clip?.hasVideo).toBe(true);
    // El sidecar no se toca.
    expect(JSON.parse(readFileSync(join(mediaDir, "vid.json"), "utf8")).title).toBe("Original");
  });
});

function sampleClip(overrides: Partial<ClipRecord> = {}): ClipRecord {
  return {
    id: "abc",
    sourceUrl: "https://x/y",
    title: "Un clip",
    durationSec: 12,
    sizeBytes: 2048,
    file: "abc.mp4",
    createdAt: "2026-01-01T00:00:00.000Z",
    trimStart: null,
    trimEnd: null,
    hasVideo: true,
    missing: false,
    ...overrides,
  };
}

describe("archivo ausente", () => {
  it("marca el clip, no lo borra", async () => {
    const { mediaDir } = makeDirs();
    // Hay al menos un archivo en /media: la carpeta no está vacía (no se confunde
    // con una unidad sin montar).
    writeFileSync(join(mediaDir, "otro.mp4"), "mp4");
    writeFileSync(
      join(mediaDir, "otro.json"),
      JSON.stringify({ title: "Otro", durationSec: 3, sourceUrl: "https://x/y" }),
    );
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip({ id: "fantasma", file: "fantasma.mp4" }));

    const result = await reconcileClips(db, mediaDir);

    expect(result.missing).toEqual(["fantasma"]);
    const clips = listClips(db);
    // El clip sin archivo sigue en la base (marcado), y el otro se agregó.
    expect(clips.map((c) => c.id).sort()).toEqual(["fantasma", "otro"]);
    expect(getClip(db, "fantasma")?.missing).toBe(true);
  });

  it("una recompensa que usa el clip marcado no se toca", async () => {
    const { mediaDir } = makeDirs();
    writeFileSync(join(mediaDir, "otro.mp4"), "mp4");
    writeFileSync(
      join(mediaDir, "otro.json"),
      JSON.stringify({ title: "Otro", durationSec: 3, sourceUrl: "https://x/y" }),
    );
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip({ id: "fantasma", file: "fantasma.mp4" }));
    upsertReward(db, sampleReward({ clipId: "fantasma" }));

    await reconcileClips(db, mediaDir);

    // La recompensa sigue apuntando al mismo clip (el id no cambia nunca).
    const row = db.prepare("SELECT clip_id FROM rewards WHERE id = ?").get("rw-1") as {
      clip_id: string | null;
    };
    expect(row.clip_id).toBe("fantasma");
  });
});

describe("recuperación de archivos sin fila ni sidecar", () => {
  it("reimporta con ffprobe (rebuild) y no pisa nada existente", async () => {
    const { mediaDir, logsDir } = makeDirs();
    // Archivo huérfano: hay un .m4a pero no hay fila ni sidecar.
    writeFileSync(join(mediaDir, "huerfano.m4a"), "audio-bytes");
    const db = openMemoryDatabase();

    const rebuild = createClipRebuilder({
      mediaDir,
      logsDir,
      binarySearch,
      run: fakeRun("audio"),
    });
    const result = await reconcileClips(db, mediaDir, { rebuild });

    expect(result.added).toEqual(["huerfano"]);
    expect(result.skipped).toEqual([]);
    const clip = getClip(db, "huerfano");
    expect(clip?.file).toBe("huerfano.m4a");
    expect(clip?.hasVideo).toBe(false);
    // Título derivado legible, nunca el id completo.
    expect(clip?.title).toBe("Audio huerfano");
  });

  it("sin reconstruir, omite el archivo (no lo borra ni toca la base)", async () => {
    const { mediaDir } = makeDirs();
    writeFileSync(join(mediaDir, "huerfano.m4a"), "audio-bytes");
    const db = openMemoryDatabase();

    const result = await reconcileClips(db, mediaDir);

    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(["huerfano.m4a"]);
    expect(listClips(db)).toHaveLength(0);
    // El archivo sigue en disco.
    expect(readFileSync(join(mediaDir, "huerfano.m4a"), "utf8")).toBe("audio-bytes");
  });

  it("con sidecar corrupto y sin poder reconstruir, lo ignora y registra", async () => {
    const { mediaDir } = makeDirs();
    writeFileSync(join(mediaDir, "roto.mp4"), "mp4");
    writeFileSync(join(mediaDir, "roto.json"), "{ no es json");
    const db = openMemoryDatabase();
    const logger = { messages: [] as string[] };

    const result = await reconcileClips(db, mediaDir, {
      log: (m) => logger.messages.push(m),
    });

    expect(result.skipped).toEqual(["roto.mp4"]);
    expect(listClips(db)).toHaveLength(0);
    expect(logger.messages.some((m) => m.includes("roto.mp4"))).toBe(true);
  });
});

describe("abortos", () => {
  it("no modifica nada si la carpeta de medios no existe", async () => {
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip({ id: "abc", file: "abc.mp4" }));

    const result = await reconcileClips(db, join(tmpdir(), "carpeta-que-no-existe-reconcile"));

    expect(result.aborted).toBe(true);
    expect(result.missing).toEqual([]);
    expect(getClip(db, "abc")?.missing).toBe(false);
  });

  it("no marca clips como ausentes si la carpeta está vacía", async () => {
    const { mediaDir } = makeDirs();
    const db = openMemoryDatabase();
    upsertClip(db, sampleClip({ id: "abc", file: "abc.mp4" }));

    const result = await reconcileClips(db, mediaDir);

    expect(result.aborted).toBe(true);
    expect(getClip(db, "abc")?.missing).toBe(false);
  });

  it("una instalación nueva (base y carpeta vacías) no aborta ni avisa", async () => {
    const { mediaDir } = makeDirs();
    const db = openMemoryDatabase();

    const result = await reconcileClips(db, mediaDir);

    // No hay nada que proteger: es un no-op silencioso, no un aviso alarmante.
    expect(result.aborted).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.added).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("doble reconciliación seguida es idempotente", async () => {
    const { mediaDir, logsDir } = makeDirs();
    writeFileSync(join(mediaDir, "huerfano.m4a"), "audio-bytes");
    const db = openMemoryDatabase();
    const rebuild = createClipRebuilder({ mediaDir, logsDir, binarySearch, run: fakeRun("audio") });

    const first = await reconcileClips(db, mediaDir, { rebuild });
    const second = await reconcileClips(db, mediaDir, { rebuild });

    expect(first.added).toEqual(["huerfano"]);
    expect(second.added).toEqual([]);
    expect(second.missing).toEqual([]);
    expect(listClips(db)).toHaveLength(1);
  });
});

function sampleReward(overrides: { clipId: string | null }): Parameters<typeof upsertReward>[1] {
  return {
    id: "rw-1",
    platform: "kick",
    remoteRewardId: null,
    title: "Recompensa",
    cost: 1,
    color: "#64f7d9",
    description: "",
    clipId: overrides.clipId,
    volume: 1,
    maxDurationSec: null,
    cooldownSec: 0,
    repetition: "queue",
    audioOnly: false,
    lastFiredAt: null,
    position: null,
    enterAnimation: null,
    exitAnimation: null,
    desiredEnabled: true,
    managed: true,
    synced: true,
    ruleId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
