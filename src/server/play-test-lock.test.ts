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

import { afterEach, describe, expect, it } from "vitest";

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
