import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessResult, RunProcess } from "../media/run-process.ts";
import { DownloadJobManager, JobManagerClosedError, type DownloadJob } from "./jobs.ts";

/**
 * Cierre de los trabajos (`jobs.stop()`): cancelación real, archivos parciales,
 * sin falsos "listo", idempotencia y rechazo de trabajo nuevo.
 *
 * El ejecutor es falso pero SIEMPRE respeta la señal de cancelación: simula lo
 * que hace el supervisor real (termina el proceso y resuelve como cancelado).
 * La terminación de procesos reales se verifica en `src/media/run-process.test.ts`.
 */

const dirs: string[] = [];

function makeDirs(): { mediaDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), "jobs-stop-"));
  dirs.push(parent);
  const mediaDir = join(parent, "media");
  mkdirSync(mediaDir, { recursive: true });
  return { mediaDir, parent };
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

interface SlowRun {
  run: RunProcess;
  /** Resuelve la descarga en curso escribiendo el video (simula el proceso terminando). */
  release: () => void;
  /** ¿La descarga recibió la cancelación? */
  cancelled: () => boolean;
  /** Rutas que dejó la descarga en curso (para verificar la limpieza). */
  partials: () => string[];
}

/** Ejecutor que se queda "descargando" hasta que se libera o se cancela. */
function slowRun(): SlowRun {
  let releaseFn: () => void = () => {};
  let wasCancelled = false;
  const partials: string[] = [];
  const run: RunProcess = async (command, args, options): Promise<ProcessResult> => {
    if (!command.includes("yt-dlp")) {
      if (options.signal?.aborted) {
        return { code: null, stdout: "", stderr: "", timedOut: false, cancelled: true };
      }
      // ffprobe de prueba: un video cualquiera.
      return {
        code: 0,
        stdout: JSON.stringify({
          format: { format_name: "mov,mp4,m4a", duration: "3" },
          streams: [
            { codec_type: "video" },
            { codec_type: "audio" },
          ],
        }),
        stderr: "",
        timedOut: false,
      };
    }
    const template = args[args.indexOf("-o") + 1];
    const source = template.replace("%(ext)s", "mp4");
    const info = source.replace(/\.src\.mp4$/, ".src.info.json");
    // El proceso deja un parcial en disco mientras corre.
    writeFileSync(source, "parcial");
    partials.push(source);
    await new Promise<void>((resolve) => {
      releaseFn = resolve;
      options.signal?.addEventListener("abort", () => {
        wasCancelled = true;
        resolve();
      });
    });
    if (options.signal?.aborted) {
      // Cancelado de verdad: no escribe más y resuelve como cancelación.
      return { code: null, stdout: "", stderr: "", timedOut: false, cancelled: true };
    }
    writeFileSync(source, "video-bytes");
    writeFileSync(info, JSON.stringify({ title: "t", duration: 3, vcodec: "avc1", acodec: "mp4a" }));
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return {
    run,
    release: () => releaseFn(),
    cancelled: () => wasCancelled,
    partials: () => partials,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("jobs.stop(): cierre ordenado de las descargas", () => {
  it("cancela el trabajo activo, espera su fin y no lo marca como listo", async () => {
    const { mediaDir } = makeDirs();
    const slow = slowRun();
    const ready: Clipish[] = [];
    const manager = new DownloadJobManager({
      mediaDir,
      media: { binarySearch },
      run: slow.run,
      onReady: (clip) => ready.push({ id: clip.id }),
    });

    const job = manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await flush();
    expect(manager.get(job.id)?.status).toBe("downloading");

    const result = await manager.stop({ timeoutMs: 5000 });
    expect(result).toEqual({ cancelled: 1, timedOut: false });
    expect(slow.cancelled()).toBe(true);
    // Nunca se registró como listo ni se creó el clip.
    expect(manager.get(job.id)?.status).toBe("error");
    expect(ready).toHaveLength(0);
  });

  it("borra los archivos parciales del trabajo cancelado y no toca archivos ajenos", async () => {
    const { mediaDir } = makeDirs();
    const slow = slowRun();
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run: slow.run });

    // Archivo de un clip que ya existe (no pertenece al trabajo).
    const foreign = join(mediaDir, "otro-clip.mp4");
    writeFileSync(foreign, "no tocar");

    manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await flush();
    const partials = slow.partials();
    expect(partials.length).toBeGreaterThan(0);
    for (const path of partials) expect(existsSync(path)).toBe(true);

    await manager.stop({ timeoutMs: 5000 });

    // El `.src` que dejó el proceso se limpia junto con su info.json.
    for (const path of partials) expect(existsSync(path)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    // Nada quedó suelto en media/ salvo el archivo ajeno.
    expect(readdirSync(mediaDir)).toEqual(["otro-clip.mp4"]);
  });

  it("una cancelación nunca registra un resultado exitoso (aunque el proceso termine bien)", async () => {
    const { mediaDir } = makeDirs();
    const ready: string[] = [];
    // Ejecutor que termina "con éxito" pero tarde, y después responde a la señal.
    const run: RunProcess = async (command, args, options): Promise<ProcessResult> => {
      if (command.includes("yt-dlp")) {
        const template = args[args.indexOf("-o") + 1];
        const source = template.replace("%(ext)s", "mp4");
        writeFileSync(source, "video-bytes");
        writeFileSync(
          source.replace(/\.src\.mp4$/, ".src.info.json"),
          JSON.stringify({ title: "t", duration: 3, vcodec: "avc1", acodec: "mp4a" }),
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { code: 0, stdout: "", stderr: "", timedOut: false, cancelled: options.signal?.aborted };
      }
      writeFileSync(args[args.length - 1], "mp4");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run });
    const job = manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    manager.cancel(job.id);
    expect(manager.get(job.id)?.status).toBe("error");
    await flush();
    expect(manager.get(job.id)?.status).toBe("error");
    expect(ready).toHaveLength(0);
  });

  it("es idempotente: dos stop() comparten la misma operación y solo cancelan una vez", async () => {
    const { mediaDir } = makeDirs();
    const slow = slowRun();
    let onReadyCalls = 0;
    const manager = new DownloadJobManager({
      mediaDir,
      media: { binarySearch },
      run: slow.run,
      onReady: () => {
        onReadyCalls += 1;
      },
    });
    manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await flush();

    const first = manager.stop({ timeoutMs: 5000 });
    const second = manager.stop({ timeoutMs: 5000 });
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ cancelled: 1, timedOut: false });
    expect(b).toEqual(a);
    expect(onReadyCalls).toBe(0);
  });

  it("no acepta trabajos nuevos después de cerrar", async () => {
    const { mediaDir } = makeDirs();
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run: slowRun().run });
    await manager.stop({ timeoutMs: 1000 });
    expect(manager.isStopped()).toBe(true);
    expect(() => manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa")).toThrow(JobManagerClosedError);
    expect(() => manager.createLocal(join(mediaDir, "x.upload"), "x.mp4")).toThrow(/no se aceptan descargas nuevas/);
    expect(() => manager.createThumbBackfill([])).toThrow(JobManagerClosedError);
  });

  it("respeta el plazo: si un trabajo no termina, stop() resuelve con timedOut", async () => {
    const { mediaDir } = makeDirs();
    // Ejecutor que ignora la cancelación (peor caso), pero devuelve rápido: así la
    // ventana del trabajo (el prompt) se cierra y `stop()` puede esperar el
    // resultado. Si se colgara de verdad, lo corta el plazo del servidor/arranque.
    const run: RunProcess = async (command) => {
      if (command.includes("yt-dlp")) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run });
    manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await flush();
    const started = Date.now();
    const result = await manager.stop({ timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("limpia el temporal de una subida local cancelada", async () => {
    const { mediaDir } = makeDirs();
    const temp = join(mediaDir, "temporal.upload");
    writeFileSync(temp, "x");
    // ffprobe nunca responde (hasta que se cancela).
    const run: RunProcess = async (_command, _args, options): Promise<ProcessResult> => {
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve());
      });
      return { code: null, stdout: "", stderr: "", timedOut: false, cancelled: options.signal?.aborted };
    };
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run });
    manager.createLocal(temp, "clip.mp4");
    await flush();
    await manager.stop({ timeoutMs: 5000 });
    expect(existsSync(temp)).toBe(false);
  });
});

/** Lo mínimo de un clip que usa `onReady` en estas pruebas. */
interface Clipish {
  id: string;
}

describe("jobs.stop(): un trabajo que espera turno no bloquea el cierre", () => {
  it("cancela también los que están en cola y no arranca ninguno después", async () => {
    const { mediaDir } = makeDirs();
    const slow = slowRun();
    let started = 0;
    const run: RunProcess = async (command, args, options) => {
      if (command.includes("yt-dlp")) started += 1;
      return slow.run(command, args, options);
    };
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run, maxConcurrent: 1 });

    const first = manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    const second = manager.create("https://www.youtube.com/watch?v=bbbbbbbbbbb");
    await flush();
    expect(started).toBe(1);
    expect(manager.get(second.id)?.status).toBe("queued");

    const result = await manager.stop({ timeoutMs: 5000 });
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(2);
    // El que esperaba turno nunca arrancó su proceso.
    expect(started).toBe(1);
    expect(manager.get(first.id)?.status).toBe("error");
    expect(manager.get(second.id)?.status).toBe("error");
  });

  it("onDone se avisa una sola vez aunque el trabajo se cancele y el runner después termine", async () => {
    const { mediaDir } = makeDirs();
    const slow = slowRun();
    const done: string[] = [];
    const manager = new DownloadJobManager({ mediaDir, media: { binarySearch }, run: slow.run });
    manager.create("https://www.youtube.com/watch?v=aaaaaaaaaaa", { onDone: (job) => done.push(job.status) });
    await flush();

    await manager.stop({ timeoutMs: 5000 });
    expect(done).toEqual(["error"]);
  });
});
