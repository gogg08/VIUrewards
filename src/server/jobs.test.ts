import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, RunProcess } from "../media/run-process.ts";
import type { Clip } from "../media/index.ts";
import { DownloadJobManager, type DownloadJob } from "./jobs.ts";

const dirs: string[] = [];
const SECRET = "RAW_STDERR_SECRET_SHOULD_NOT_LEAK";

function makeDirs(): { mediaDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "jobs-test-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return { mediaDir, parent };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

// Binarios "presentes" para que detectBinaries no falle.
const binarySearch = {
  pathEnv: "/fake/bin",
  extraDirs: [] as string[],
  platform: "linux" as NodeJS.Platform,
  exists: () => true,
};

function successRun(): RunProcess {
  return async (command, args): Promise<ProcessResult> => {
    if (command.includes("yt-dlp")) {
      const template = args[args.indexOf("-o") + 1];
      const source = template.replace("%(ext)s", "mp4");
      writeFileSync(source, "video-bytes");
      writeFileSync(
        source.replace(/\.src\.mp4$/, ".src.info.json"),
        JSON.stringify({ title: "Título de prueba", duration: 12, vcodec: "avc1", acodec: "mp4a" }),
      );
    } else {
      writeFileSync(args[args.length - 1], "mp4-bytes");
    }
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}

function failingYtdlpRun(): RunProcess {
  return async (): Promise<ProcessResult> => ({
    code: 1,
    stdout: "",
    stderr: `ERROR: ${SECRET}`,
    timedOut: false,
  });
}

async function waitForJob(manager: DownloadJobManager, id: string): Promise<DownloadJob> {
  const deadline = Date.now() + 3000;
  let job = manager.get(id);
  while (job && (job.status === "queued" || job.status === "downloading" || job.status === "converting")) {
    if (Date.now() > deadline) throw new Error("el trabajo no terminó a tiempo");
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = manager.get(id);
  }
  if (!job) throw new Error("trabajo inexistente");
  return job;
}

describe("DownloadJobManager", () => {
  it("pasa por descarga/convertir, queda listo y avisa a onReady", async () => {
    const { mediaDir } = makeDirs();
    const stages: string[] = [];
    const ready: Clip[] = [];
    const manager = new DownloadJobManager({
      mediaDir,
      media: { binarySearch },
      run: successRun(),
      onReady: (clip) => {
        ready.push(clip);
        stages.push("ready");
      },
    });

    const job = manager.create("https://www.youtube.com/watch?v=abc12345678");
    const finished = await waitForJob(manager, job.id);

    expect(finished.status).toBe("ready");
    expect(finished.clipId).toBeDefined();
    expect(finished.title).toBe("Título de prueba");
    expect(ready).toHaveLength(1);
    expect(ready[0].title).toBe("Título de prueba");
  });

  it("marca error con un mensaje corto y sin el stderr crudo", async () => {
    const { mediaDir } = makeDirs();
    const manager = new DownloadJobManager({
      mediaDir,
      media: { binarySearch },
      run: failingYtdlpRun(),
    });

    const job = manager.create("https://www.youtube.com/watch?v=abc12345678");
    const finished = await waitForJob(manager, job.id);

    expect(finished.status).toBe("error");
    expect(finished.message).toBeTruthy();
    expect(finished.message).not.toContain(SECRET);
    expect(finished.message).not.toContain("ERROR:");
    expect(finished.message).toContain("No se pudo descargar");
  });

  it("rechaza una URL inválida sin tocar los binarios", async () => {
    const { mediaDir } = makeDirs();
    let called = false;
    const manager = new DownloadJobManager({
      mediaDir,
      media: { binarySearch },
      run: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });

    const job = manager.create("http://example.com/video");
    const finished = await waitForJob(manager, job.id);

    expect(finished.status).toBe("error");
    expect(called).toBe(false);
  });

  it("lista los trabajos más recientes primero", async () => {
    const { mediaDir } = makeDirs();
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run: successRun() });
    const first = manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await waitForJob(manager, first.id);
    const second = manager.create("https://www.youtube.com/watch?v=bbbbbbbbbbb");

    const list = manager.list();
    expect(list[0].id).toBe(second.id);
  });
});