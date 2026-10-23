/**
 * Contrato de rutas de `scripts/play-test.ts` (Fase de distribución, Etapa 1).
 *
 * La herramienta escribe en recursos COMPARTIDOS con `npm start`: descarga y
 * convierte dentro de `media/`, y `createServer` crea `logs/server.log` y
 * `logs/pending-media.txt`. Por eso toma un único cerrojo sobre la raíz que
 * CONTIENE esos directorios y rechaza cualquier configuración en la que un
 * recurso quedaría fuera de esa raíz (o sea, protegido por un cerrojo que no es
 * el que se toma).
 *
 * Estos tests ejercen `resolvePlayTestPaths` (puro: no crea ni toca nada). Los
 * casos con `main()` real están en `play-test-lock.test.ts`.
 *
 * Precedencia verificada:
 *  1. `VIUREWARDS_DATA_DIR` (manda sobre todo).
 *  2. `--media-dir` (sin la variable; los demás recursos van al padre).
 *  3. Sin nada: rutas heredadas del directorio de trabajo.
 *
 * `--shared-root` es SOLO validación de coherencia: nunca redirige el cerrojo.
 *
 * Todo corre en carpetas temporales: nunca `data/`, `media/` ni `logs/` reales.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePlayTestPaths } from "../../scripts/play-test.ts";

const dirs: string[] = [];

/** `VIUREWARDS_DATA_DIR` del entorno real no debe influir en los tests. */
const originalEnv = process.env.VIUREWARDS_DATA_DIR;
const originalRuntime = process.env.VIUREWARDS_NODE_RUNTIME;

beforeEach(() => {
  delete process.env.VIUREWARDS_DATA_DIR;
  delete process.env.VIUREWARDS_NODE_RUNTIME;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (originalEnv === undefined) delete process.env.VIUREWARDS_DATA_DIR;
  else process.env.VIUREWARDS_DATA_DIR = originalEnv;
  if (originalRuntime === undefined) delete process.env.VIUREWARDS_NODE_RUNTIME;
  else process.env.VIUREWARDS_NODE_RUNTIME = originalRuntime;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Un cwd con los tres directorios de recursos, como la instalación real. */
function makeCwd(): string {
  const cwd = tempDir("viu-playtest-paths-");
  for (const name of ["media", "logs", ".uploads", "bin"]) {
    mkdirSync(join(cwd, name), { recursive: true });
  }
  return cwd;
}

function dataDirWithResources(): string {
  const data = tempDir("viu-playtest-data-");
  for (const name of ["media", "logs", ".uploads", "bin"]) {
    mkdirSync(join(data, name), { recursive: true });
  }
  return data;
}

/** Aserción que además estrecha el tipo del resultado. */
function expectOk(result: ReturnType<typeof resolvePlayTestPaths>) {
  if (!result.ok) throw new Error(`Se esperaba un resultado válido, pero falló: ${result.message}`);
  return result.paths;
}

function expectRejected(result: ReturnType<typeof resolvePlayTestPaths>, hints: string[] = []): string {
  if (result.ok) throw new Error("Se esperaba un rechazo, pero la configuración fue aceptada.");
  expect(result.message.length).toBeGreaterThan(0);
  for (const hint of hints) expect(result.message).toContain(hint);
  return result.message;
}

describe("resolvePlayTestPaths: caso predeterminado (sin variable ni opciones)", () => {
  it("usa la raíz del directorio de trabajo para el cerrojo y todos los recursos", () => {
    const cwd = makeCwd();
    const paths = expectOk(resolvePlayTestPaths({ args: ["abc123"], cwd }));

    expect(paths.root).toBe(resolve(cwd));
    expect(paths.mediaDir).toBe(join(resolve(cwd), "media"));
    expect(paths.logsDir).toBe(join(resolve(cwd), "logs"));
    expect(paths.uploadsDir).toBe(join(resolve(cwd), ".uploads"));
    expect(paths.binDir).toBe(join(resolve(cwd), "bin"));
  });

  it("normaliza un cwd con `.` y `..` a la misma raíz (no confunde carpetas distintas)", () => {
    const cwd = makeCwd();
    const messy = join(cwd, "media", "..");

    expect(expectOk(resolvePlayTestPaths({ args: ["abc123"], cwd: messy })).root).toBe(resolve(cwd));
  });
});

describe("resolvePlayTestPaths: VIUREWARDS_DATA_DIR", () => {
  it("todos los recursos y el cerrojo salen del directorio de datos, no del cwd", () => {
    const cwd = makeCwd();
    const data = dataDirWithResources();
    process.env.VIUREWARDS_DATA_DIR = data;

    const paths = expectOk(resolvePlayTestPaths({ args: ["abc123"], cwd }));

    expect(paths.root).toBe(resolve(data));
    expect(paths.mediaDir).toBe(join(resolve(data), "media"));
    expect(paths.logsDir).toBe(join(resolve(data), "logs"));
    expect(paths.uploadsDir).toBe(join(resolve(data), ".uploads"));
    expect(paths.binDir).toBe(join(resolve(data), "bin"));
    expect(paths.root).not.toBe(resolve(cwd));
  });

  it("acepta --media-dir cuando apunta EXACTAMENTE a los medios del directorio de datos", () => {
    const cwd = makeCwd();
    const data = dataDirWithResources();
    process.env.VIUREWARDS_DATA_DIR = data;

    const paths = expectOk(
      resolvePlayTestPaths({ args: ["abc123", `--media-dir=${join(data, "media")}`], cwd }),
    );
    expect(paths.mediaDir).toBe(join(resolve(data), "media"));
    expect(paths.root).toBe(resolve(data));
  });

  it("rechaza --media-dir cuando apunta a OTRO media (el cerrojo protegería otra raíz)", () => {
    const cwd = makeCwd();
    const other = tempDir("viu-playtest-other-");
    process.env.VIUREWARDS_DATA_DIR = dataDirWithResources();

    const message = expectRejected(
      resolvePlayTestPaths({ args: ["abc123", `--media-dir=${join(other, "media")}`], cwd }),
      ["--media-dir", "VIUREWARDS_DATA_DIR"],
    );
    expect(message).toContain(resolve(other));
  });

  it("rechaza --shared-root apuntando al cwd: nunca redirige el cerrojo de los datos", () => {
    const cwd = makeCwd();
    const data = dataDirWithResources();
    process.env.VIUREWARDS_DATA_DIR = data;

    const message = expectRejected(
      resolvePlayTestPaths({ args: ["abc123", `--shared-root=${cwd}`], cwd }),
      ["--shared-root"],
    );
    expect(message).toContain(resolve(data));
  });

  it("acepta --shared-root cuando coincide con el directorio de datos", () => {
    const cwd = makeCwd();
    const data = dataDirWithResources();
    process.env.VIUREWARDS_DATA_DIR = data;

    const paths = expectOk(
      resolvePlayTestPaths({ args: ["abc123", `--shared-root=${data}`], cwd }),
    );
    expect(paths.root).toBe(resolve(data));
  });

  it("propaga una variable inválida (relativa) como rechazo, sin inventar una raíz", () => {
    const cwd = makeCwd();
    process.env.VIUREWARDS_DATA_DIR = "./datos-relativos";

    expectRejected(resolvePlayTestPaths({ args: ["abc123"], cwd }), ["ABSOLUTA"]);
  });

  it("propaga una variable vacía como rechazo", () => {
    const cwd = makeCwd();
    process.env.VIUREWARDS_DATA_DIR = "   ";

    expectRejected(resolvePlayTestPaths({ args: ["abc123"], cwd }), ["VIUREWARDS_DATA_DIR"]);
  });
});

describe("resolvePlayTestPaths: --media-dir sin la variable", () => {
  it("deriva media, logs, uploads y bin de la MISMA raíz (el padre del media)", () => {
    // Reproduce el defecto del informe: antes logs/uploads se derivaban del
    // media pero el cerrojo se tomaba en el cwd, así que podían quedar en
    // carpetas distintas.
    const cwd = makeCwd();
    const shared = tempDir("viu-playtest-shared-");
    mkdirSync(join(shared, "media"), { recursive: true });

    const paths = expectOk(resolvePlayTestPaths({ args: ["abc123", `--media-dir=${join(shared, "media")}`], cwd }));

    expect(paths.root).toBe(resolve(shared));
    expect(paths.logsDir).toBe(join(resolve(shared), "logs"));
    expect(paths.uploadsDir).toBe(join(resolve(shared), ".uploads"));
    expect(paths.binDir).toBe(join(resolve(shared), "bin"));
    // Nada queda bajo el cwd: no hay recursos protegidos por otro cerrojo.
    expect(paths.root).not.toBe(resolve(cwd));
  });

  it("acepta --shared-root cuando coincide con el padre del media", () => {
    const cwd = makeCwd();
    const shared = tempDir("viu-playtest-shared-");
    mkdirSync(join(shared, "media"), { recursive: true });

    const paths = expectOk(
      resolvePlayTestPaths({
        args: ["abc123", `--media-dir=${join(shared, "media")}`, `--shared-root=${shared}`],
        cwd,
      }),
    );
    expect(paths.root).toBe(resolve(shared));
  });

  it("rechaza --shared-root del cwd cuando el media vive en otra raíz", () => {
    const cwd = makeCwd();
    const shared = tempDir("viu-playtest-shared-");
    mkdirSync(join(shared, "media"), { recursive: true });

    const message = expectRejected(
      resolvePlayTestPaths({
        args: ["abc123", `--media-dir=${join(shared, "media")}`, `--shared-root=${cwd}`],
        cwd,
      }),
      ["--shared-root"],
    );
    expect(message).toContain(resolve(shared));
  });

  it("normaliza `..` en --media-dir antes de comparar", () => {
    const cwd = makeCwd();
    const shared = tempDir("viu-playtest-shared-");
    mkdirSync(join(shared, "media"), { recursive: true });

    const paths = expectOk(
      resolvePlayTestPaths({
        args: ["abc123", `--media-dir=${join(shared, "media", "..", "media")}`, `--shared-root=${join(shared, ".")}`],
        cwd,
      }),
    );
    expect(paths.root).toBe(resolve(shared));
  });
});
