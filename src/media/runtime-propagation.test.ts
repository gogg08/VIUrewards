/**
 * Propagación del runtime de Node hasta el argv de yt-dlp (distribución).
 *
 * El overlay/descarga no debe depender del Node instalado globalmente: en
 * distribución se pasa la ruta del Node portable y debe aparecer como
 * `--js-runtimes node:<ruta>` en los argumentos REALES del proceso. Se simula
 * yt-dlp/ffmpeg/ffprobe: nunca se ejecuta un binario.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { processVideo } from "./index.ts";
import type { FindBinaryOptions } from "./binaries.ts";
import type { ProcessResult, RunProcess } from "./run-process.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "media-runtime-"));
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

function ffprobeJson(): string {
  return JSON.stringify({
    streams: [{ codec_type: "video" }, { codec_type: "audio" }],
    format: { format_name: "mov,mp4", duration: "10" },
  });
}

/**
 * Ejecutor simulado que registra los argumentos de yt-dlp y hace que el resto
 * del flujo termine bien (ffmpeg escribe el mp4, ffprobe lo mide).
 */
function capturingRun(): { run: RunProcess; ytdlpArgs: () => string[] } {
  let captured: string[] = [];
  const run: RunProcess = async (command, args) => {
    if (command.includes("ffprobe")) return ok(ffprobeJson());
    if (command.includes("ffmpeg")) {
      writeFileSync(args.at(-1) as string, Buffer.alloc(2048, 1));
      return ok();
    }
    captured = [...args];
    // yt-dlp "descarga": escribe `<id>.src.mp4` y su info.json, como el real.
    const template = args[args.indexOf("-o") + 1] as string;
    const base = template.replace(".%(ext)s", "");
    writeFileSync(`${base}.mp4`, Buffer.alloc(4096, 2));
    writeFileSync(
      `${base}.info.json`,
      JSON.stringify({ title: "Prueba", vcodec: "avc1", acodec: "mp4a", duration: 10 }),
      "utf8",
    );
    return ok();
  };
  return { run, ytdlpArgs: () => captured };
}

describe("processVideo y el runtime de Node para yt-dlp", () => {
  it("pasa `node:<ruta>` cuando se indica el runtime portable", async () => {
    const mediaDir = makeTempDir();
    const { run, ytdlpArgs } = capturingRun();
    const runtime = join("C:", "VIUrewards", "runtime", "node.exe");

    await processVideo("https://youtu.be/abc", {
      mediaDir,
      run,
      binarySearch: fakeBinaries,
      nodeRuntime: runtime,
      jsRuntime: true,
    });

    const args = ytdlpArgs();
    const index = args.indexOf("--js-runtimes");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe(`node:${runtime}`);
  });

  it("sin runtime usa `node` a secas (comportamiento histórico)", async () => {
    const mediaDir = makeTempDir();
    const { run, ytdlpArgs } = capturingRun();

    await processVideo("https://youtu.be/abc", {
      mediaDir,
      run,
      binarySearch: fakeBinaries,
      jsRuntime: true,
    });

    const args = ytdlpArgs();
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe("node");
  });

  it("con el runtime JS deshabilitado no agrega el flag aunque haya ruta", async () => {
    const mediaDir = makeTempDir();
    const { run, ytdlpArgs } = capturingRun();

    await processVideo("https://youtu.be/abc", {
      mediaDir,
      run,
      binarySearch: fakeBinaries,
      nodeRuntime: join("C:", "runtime", "node.exe"),
      jsRuntime: false,
    });

    expect(ytdlpArgs()).not.toContain("--js-runtimes");
  });
});
