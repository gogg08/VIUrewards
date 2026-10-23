/**
 * `scripts/play-test.ts` y el cerrojo de recursos compartidos.
 *
 * La herramienta escribe en la MISMA raíz que `npm start` (descarga en `media/`,
 * `createServer` crea `logs/server.log` y `logs/pending-media.txt`). Estos tests
 * comprueban que:
 *
 *  1. Sin otra instancia toma el cerrojo, lo libera al terminar y no deja logs
 *     compartidos si falla antes de crear el servidor.
 *  2. Con una instancia viva se NIEGA: no descarga, no crea el servidor y no
 *     toca el cerrojo ajeno (ni su contenido ni su existencia).
 *
 * Todo corre en una carpeta temporal: nunca `data/`, `media/` ni `logs/` reales.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../scripts/play-test.ts";
import { SHARED_RESOURCES_LOCK_FILE } from "../db/instance-lock.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "viu-playtest-"));
  dirs.push(root);
  for (const dir of ["media", "logs", ".uploads"]) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

/** Captura la salida de la herramienta sin ensuciar la del test. */
async function run(
  args: string[],
  cwd: string,
  waitForClose: () => Promise<void> = () => new Promise<void>(() => {}),
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main({ args, cwd, log: (m) => out.push(m), error: (m) => err.push(m), waitForClose }).catch(
    (caught: unknown) => {
      // La herramienta no traga errores del servidor: se propaga al punto de
      // entrada. El test lo trata como falla (nunca es un cierre exitoso).
      err.push(caught instanceof Error ? caught.message : String(caught));
      return 1;
    },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("scripts/play-test.ts y la exclusividad compartida", () => {
  it("sin otra instancia toma el cerrojo, sirve el overlay y lo libera al cerrar", async () => {
    const root = makeRoot();
    // Un id que la base no conoce: el servidor arranca igual (la cola avisa al
    // reproducir) y la herramienta llega hasta la espera de cierre.
    let release: () => void = () => {};
    const waitForClose = (): Promise<void> => new Promise<void>((resolve) => (release = resolve));
    const out: string[] = [];
    const err: string[] = [];
    const pending = main({ args: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--port=0"], cwd: root, log: (m) => out.push(m), error: (m) => err.push(m), waitForClose }).then(
      (code) => code,
      (caught: unknown) => {
        err.push(caught instanceof Error ? caught.message : String(caught));
        return 1;
      },
    );

    // Mientras corre, el cerrojo propio está tomado…
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(root, SHARED_RESOURCES_LOCK_FILE)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect({ out: out.join("\n"), err: err.join("\n") }).toEqual({ out: expect.stringContaining("Servidor arriba"), err: "" });
    expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(true);

    release();
    expect(await pending).toBe(0);
    expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
  }, 60_000);

  it("un error propio después de tomar el cerrojo lo libera (no lo deja tomado)", async () => {
    const root = makeRoot();
    // `--port` inválido: `createServer`/`start` falla DESPUÉS de tomar el cerrojo.
    const { code } = await run(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--port=-1"], root);
    expect(code).toBe(1);
    expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
  }, 30_000);

  it("con una instancia viva se niega sin tocar el cerrojo ajeno ni crear logs", async () => {
    const root = makeRoot();
    const lockPath = join(root, SHARED_RESOURCES_LOCK_FILE);
    // Cerrojo "ajeno": el pid del proceso de test está VIVO, así que se respeta.
    const foreign = JSON.stringify({ pid: process.pid, at: Date.now() });
    writeFileSync(lockPath, foreign, "utf8");
    const logsBefore = readdirSync(join(root, "logs"));

    // Una URL fuerza la ruta de descarga: si no se detuviera antes, lanzaría
    // yt-dlp sobre `media/` compartida.
    const { code, err } = await run(["https://example.invalid/video", "--port=0"], root);

    expect(code).toBe(1);
    expect(err).toContain("No se puede usar play-test");
    expect(err).toContain("Otra copia");
    // No lanzó la descarga ni creó el servidor.
    expect(err).not.toContain("Descargando");
    expect(readdirSync(join(root, "media"))).toEqual([]);
    expect(readdirSync(join(root, "logs"))).toEqual(logsBefore);
    expect(existsSync(join(root, "logs", "server.log"))).toBe(false);
    expect(existsSync(join(root, "logs", "pending-media.txt"))).toBe(false);
    // El cerrojo de la otra instancia quedó idéntico.
    expect(readFileSync(lockPath, "utf8")).toBe(foreign);
  }, 30_000);

  it("anuncia que sin exclusividad no toca nada y su código no es 0", async () => {
    const root = makeRoot();
    writeFileSync(join(root, SHARED_RESOURCES_LOCK_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const { code, err } = await run(["abc123", "--port=0"], root);
    expect(code).toBe(1);
    expect(err).toContain("no se tocó ningún archivo");
  });
});

/**
 * Contrato de rutas: el cerrojo tiene que cubrir EXACTAMENTE los recursos que la
 * herramienta escribe. Antes, `--shared-root`/`--media-dir` permitían tomar el
 * cerrojo de una raíz y escribir en otra (medios en un lado, logs en otro), así
 * que se podía correr junto a `npm start` sobre los mismos datos.
 */
describe("scripts/play-test.ts: coherencia del cerrojo con las rutas efectivas", () => {
  const originalEnv = process.env.VIUREWARDS_DATA_DIR;

  beforeEach(() => {
    delete process.env.VIUREWARDS_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VIUREWARDS_DATA_DIR;
    else process.env.VIUREWARDS_DATA_DIR = originalEnv;
  });

  /** Un directorio de datos con media/, logs/, .uploads/ y bin/. */
  function makeDataDir(): string {
    const data = mkdtempSync(join(tmpdir(), "viu-playtest-data-"));
    dirs.push(data);
    for (const dir of ["media", "logs", ".uploads", "bin"]) mkdirSync(join(data, dir), { recursive: true });
    return data;
  }

  /** Huella de un árbol: qué archivos hay en cada carpeta de recursos. */
  function snapshot(dir: string): Record<string, string[]> {
    return {
      media: readdirSync(join(dir, "media")),
      logs: readdirSync(join(dir, "logs")),
      uploads: readdirSync(join(dir, ".uploads")),
    };
  }

  it("rechaza VIUREWARDS_DATA_DIR + --shared-root del cwd ANTES de escribir o descargar", async () => {
    const cwd = makeRoot();
    const data = makeDataDir();
    process.env.VIUREWARDS_DATA_DIR = data;
    const before = snapshot(data);
    const cwdLock = join(cwd, SHARED_RESOURCES_LOCK_FILE);

    // Una URL forzaría la descarga: si el rechazo no fuera previo, lanzaría
    // yt-dlp sobre `<datos>/media`.
    const { code, err } = await run(["https://youtu.be/abc", "--port=0", `--shared-root=${cwd}`], cwd);

    expect(code).toBe(1);
    expect(err).toContain("No se puede usar play-test");
    expect(err).toContain("--shared-root");
    expect(err).toContain(data);
    // No descargó, no creó el servidor ni el journal.
    expect(err).not.toContain("Descargando");
    expect(snapshot(data)).toEqual(before);
    // Ni dejó un cerrojo propio en el cwd: nunca se tomó uno ajeno ni se creó
    // uno para una raíz que no son los recursos.
    expect(existsSync(cwdLock)).toBe(false);
  }, 30_000);

  it("no modifica el cerrojo de otra instancia cuando rechaza por incoherencia", async () => {
    const cwd = makeRoot();
    const data = makeDataDir();
    process.env.VIUREWARDS_DATA_DIR = data;
    // Cerrojo ajeno VIVO en el cwd: el rechazo no debe tocarlo.
    const foreign = JSON.stringify({ pid: process.pid, at: Date.now() });
    writeFileSync(join(cwd, SHARED_RESOURCES_LOCK_FILE), foreign, "utf8");

    const { code, err } = await run(["abc123", "--port=0", `--shared-root=${cwd}`], cwd);

    expect(code).toBe(1);
    expect(err).toContain("--shared-root");
    expect(readFileSync(join(cwd, SHARED_RESOURCES_LOCK_FILE), "utf8")).toBe(foreign);
    // Tampoco tomó el cerrojo del directorio de datos (no hay ninguno).
    expect(existsSync(join(data, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
  }, 30_000);

  it("rechaza --media-dir que dejaría logs/uploads fuera del cerrojo y no toca nada", async () => {
    // Sin la variable: el media manda y logs/uploads van a su padre. Si además
    // se pide un --shared-root distinto, la combinación es incoherente.
    const cwd = makeRoot();
    const shared = makeRoot();
    const before = snapshot(shared);

    const { code, err } = await run(
      ["https://youtu.be/abc", "--port=0", `--media-dir=${join(shared, "media")}`, `--shared-root=${cwd}`],
      cwd,
    );

    expect(code).toBe(1);
    expect(err).toContain("--shared-root");
    expect(err).not.toContain("Descargando");
    expect(snapshot(shared)).toEqual(before);
    // El otro conjunto no quedó tocado: ni logs compartidos ni cerrojo propio.
    expect(existsSync(join(shared, "logs", "server.log"))).toBe(false);
    expect(existsSync(join(shared, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
    expect(existsSync(join(cwd, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
  }, 30_000);

  it("con opciones coherentes usa el directorio de datos y libera SU cerrojo al cerrar", async () => {
    const cwd = makeRoot();
    const data = makeDataDir();
    process.env.VIUREWARDS_DATA_DIR = data;

    let release: () => void = () => {};
    const waitForClose = (): Promise<void> => new Promise<void>((resolve) => (release = resolve));
    const out: string[] = [];
    const err: string[] = [];
    const pending = main({
      args: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--port=0", `--shared-root=${data}`],
      cwd,
      log: (m) => out.push(m),
      error: (m) => err.push(m),
      waitForClose,
    }).catch((caught: unknown) => {
      err.push(caught instanceof Error ? caught.message : String(caught));
      return 1;
    });

    const lockPath = join(data, SHARED_RESOURCES_LOCK_FILE);
    const deadline = Date.now() + 20_000;
    while (!existsSync(lockPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect({ out: out.join("\n"), err: err.join("\n") }).toEqual({
      out: expect.stringContaining("Servidor arriba"),
      err: "",
    });
    // El cerrojo está en el DIRECTORIO DE DATOS, no en el cwd.
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(cwd, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
    // Los recursos que escribió son los del directorio de datos.
    expect(existsSync(join(data, "logs", "server.log"))).toBe(true);

    release();
    expect(await pending).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 60_000);

  it("con --media-dir coherente (sin la variable) protege el padre del media", async () => {
    const cwd = makeRoot();
    const shared = makeRoot();

    let release: () => void = () => {};
    const waitForClose = (): Promise<void> => new Promise<void>((resolve) => (release = resolve));
    const out: string[] = [];
    const err: string[] = [];
    const pending = main({
      args: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--port=0", `--media-dir=${join(shared, "media")}`],
      cwd,
      log: (m) => out.push(m),
      error: (m) => err.push(m),
      waitForClose,
    }).catch((caught: unknown) => {
      err.push(caught instanceof Error ? caught.message : String(caught));
      return 1;
    });

    const lockPath = join(shared, SHARED_RESOURCES_LOCK_FILE);
    const deadline = Date.now() + 20_000;
    while (!existsSync(lockPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect({ out: out.join("\n"), err: err.join("\n") }).toEqual({
      out: expect.stringContaining("Servidor arriba"),
      err: "",
    });
    // El cerrojo y los logs están en el padre del media; el cwd no se tocó.
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(shared, "logs", "server.log"))).toBe(true);
    expect(readdirSync(join(cwd, "logs"))).toEqual([]);
    expect(existsSync(join(cwd, SHARED_RESOURCES_LOCK_FILE))).toBe(false);

    release();
    expect(await pending).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 60_000);
});
