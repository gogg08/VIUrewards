/**
 * Validación de la duración en descargas por link (corrección del bug de los
 * reels de Instagram).
 *
 * El `duration` que devuelve yt-dlp puede faltar o venir `null`. El filtro
 * `duration <=? N` (tolerante) deja descargar esos videos, y la duración REAL se
 * mide después con ffprobe sobre el archivo convertido. Estos tests simulan
 * yt-dlp, ffmpeg y ffprobe para verificar el flujo completo sin binarios reales.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { processVideo } from "./index.ts";
import type { FindBinaryOptions } from "./binaries.ts";
import type { ProcessResult, RunProcess } from "./run-process.ts";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "media-duration-"));
  dirs.push(dir);
  return dir;
}

const fakeBinaries: FindBinaryOptions = {
  pathEnv: "",
  extraDirs: ["/fake/bin"],
  platform: "linux",
  exists: () => true,
};

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** Salida de ffprobe con la duración y pistas indicadas. */
function ffprobeJson(durationSec: number | null): string {
  return JSON.stringify({
    streams: [{ codec_type: "video" }, { codec_type: "audio" }],
    format: durationSec === null ? { format_name: "mov,mp4" } : { format_name: "mov,mp4", duration: String(durationSec) },
  });
}

interface ScriptedRun {
  run: RunProcess;
  /** ¿Se ejecutó ffprobe sobre el archivo convertido? */
  probedOutput: boolean;
  /** ¿Se ejecutó ffmpeg? */
  converted: boolean;
}

/**
 * Ejecutor simulado: yt-dlp escribe `<id>.src.mp4` + `<id>.src.info.json`,
 * ffmpeg escribe el mp4 final y ffprobe responde con `probeDuration`.
 */
function scriptedRun(options: {
  mediaDir: string;
  infoDuration?: number | null;
  probeDuration: number | null;
  ytdlpStderr?: string;
  ytdlpFail?: boolean;
}): ScriptedRun {
  const state = { probedOutput: false, converted: false };

  const run: RunProcess = async (command, args) => {
    if (command.includes("ffprobe")) {
      state.probedOutput = true;
      return ok(ffprobeJson(options.probeDuration));
    }
    if (command.includes("ffmpeg")) {
      const output = args.at(-1) as string;
      state.converted = true;
      writeFileSync(output, Buffer.alloc(2048, 1));
      return ok();
    }
    // yt-dlp: el template `-o` trae la ruta base `<id>.src.%(ext)s`.
    if (options.ytdlpFail) {
      return { code: 1, stdout: "", stderr: options.ytdlpStderr ?? "", timedOut: false };
    }
    const template = args[args.indexOf("-o") + 1];
    const base = template.replace(".%(ext)s", "");
    writeFileSync(`${base}.mp4`, Buffer.alloc(4096, 2));
    const info: Record<string, unknown> = { title: "Reel de prueba", vcodec: "avc1", acodec: "mp4a" };
    if (options.infoDuration !== undefined) info.duration = options.infoDuration;
    writeFileSync(`${base}.info.json`, JSON.stringify(info), "utf8");
    return ok();
  };

  return {
    run,
    get probedOutput() {
      return state.probedOutput;
    },
    get converted() {
      return state.converted;
    },
  };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const URL = "https://www.instagram.com/reel/abc/";

describe("duración desconocida en la extracción (reel de Instagram)", () => {
  it("no se rechaza por duración cuando el info.json no la trae, y se valida con ffprobe", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({ mediaDir, infoDuration: undefined, probeDuration: 12 });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(scripted.converted).toBe(true);
    expect(scripted.probedOutput).toBe(true);
    // La duración real (ffprobe) es la que queda en el clip.
    expect(result.clip.durationSec).toBe(12);
  });

  it("acepta `duration: null` sin producir el mensaje 'dura más de'", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({ mediaDir, infoDuration: null, probeDuration: 30 });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clip.durationSec).toBe(30);
  });
});

describe("duración conocida que supera el límite", () => {
  it("rechaza con TOO_LONG, borra el archivo y muestra la duración real", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({ mediaDir, infoDuration: 200, probeDuration: 200 });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("TOO_LONG");
    expect(result.message).toContain("200");
    expect(result.message).toContain("90");
    // El mp4 no debe quedar en la biblioteca.
    const files = readdirSync(mediaDir);
    expect(files.some((name) => name.endsWith(".mp4"))).toBe(false);
  });

  it("rechaza cuando el info.json no la trae pero ffprobe mide una duración real mayor", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({ mediaDir, infoDuration: undefined, probeDuration: 300 });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("TOO_LONG");
    expect(result.message).toContain("300");
  });

  it("no rechaza por duración si ffprobe tampoco la conoce", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({ mediaDir, infoDuration: undefined, probeDuration: null });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(true);
  });
});

describe("motivos reales de fallo de yt-dlp", () => {
  it("un rechazo del filtro SIN duración no se mapea a TOO_LONG", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({
      mediaDir,
      probeDuration: null,
      ytdlpFail: true,
      ytdlpStderr: "ERROR: [Instagram] abc: This video does not pass filter (unrelated)",
    });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DOWNLOAD_FAILED");
    expect(result.message).not.toContain("más de 90");
  });

  it("un rechazo del filtro de DURACIÓN sí es TOO_LONG", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({
      mediaDir,
      probeDuration: null,
      ytdlpFail: true,
      ytdlpStderr: "ERROR: This video does not pass filter duration <=? 90",
    });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("TOO_LONG");
  });

  it("un login requerido de Instagram muestra DOWNLOAD_FAILED, no un mensaje de duración", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({
      mediaDir,
      probeDuration: null,
      ytdlpFail: true,
      ytdlpStderr: "ERROR: [Instagram] abc: Login required. Use --cookies-from-browser",
    });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DOWNLOAD_FAILED");
    expect(result.message).not.toContain("más de 90");
  });

  it("un rate limit de Instagram muestra DOWNLOAD_FAILED, no un mensaje de duración", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({
      mediaDir,
      probeDuration: null,
      ytdlpFail: true,
      ytdlpStderr: "ERROR: HTTP Error 429: Too Many Requests",
    });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("DOWNLOAD_FAILED");
  });
});

describe("archivo descargado", () => {
  it("no deja el archivo de origen tras una conversión correcta", async () => {
    const mediaDir = makeTempDir();
    const scripted = scriptedRun({ mediaDir, infoDuration: 10, probeDuration: 10 });

    const result = await processVideo(URL, {
      mediaDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: scripted.run,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(mediaDir, `${result.ok ? result.clip.id : ""}.src.mp4`))).toBe(false);
  });
});
