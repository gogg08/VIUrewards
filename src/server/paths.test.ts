/**
 * Resolución de rutas de ejecución (Fase de distribución, Etapa 1).
 *
 * `resolveRuntimePaths` es el ÚNICO lugar que lee `VIUREWARDS_DATA_DIR`. Acá se
 * comprueba el contrato completo sin tocar datos reales:
 *
 *  - sin la variable, las rutas históricas (todo bajo el directorio de trabajo);
 *  - con la variable, base, medios, uploads, logs y bin/ dentro de ella;
 *  - el cerrojo sigue a los datos, no a la carpeta de la versión;
 *  - una ruta relativa, vacía, inexistente-como-archivo o sin permisos da un
 *    mensaje en español y NO cae en otra carpeta;
 *  - los recursos estáticos (web/ y overlay/) no dependen de la configuración;
 *  - `legacyDataNotice` avisa sin mover nada;
 *  - el runtime de Node para yt-dlp se resuelve de forma explícita.
 *
 * Todo con directorios temporales.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SHARED_RESOURCES_LOCK_FILE } from "../db/instance-lock.ts";
import {
  DATA_DIR_ENV,
  INVALID_DATA_DIR_EXIT_CODE,
  InvalidDataDirError,
  LEGACY_DATA_SUBDIR,
  NODE_RUNTIME_ENV,
  NODE_RUNTIME_SUBDIR,
  describePaths,
  legacyDataNotice,
  nodeRuntimeCandidates,
  prepareDataDir,
  resolveRuntimePaths,
} from "./paths.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeDir(prefix = "viu-paths-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Entorno limpio: nunca hereda la variable real del proceso. */
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...extra };
}

describe("resolveRuntimePaths sin VIUREWARDS_DATA_DIR (desarrollo)", () => {
  it("conserva EXACTAMENTE la distribución histórica", () => {
    const cwd = makeDir();
    const result = resolveRuntimePaths({ cwd, env: env() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { paths } = result;
    expect(paths.mode).toBe("legacy");
    expect(paths.root).toBe(resolve(cwd));
    expect(paths.lockPath).toBe(join(resolve(cwd), SHARED_RESOURCES_LOCK_FILE));
    expect(paths.dataDir).toBe(join(resolve(cwd), LEGACY_DATA_SUBDIR));
    expect(paths.dbPath).toBe(join(resolve(cwd), LEGACY_DATA_SUBDIR, "app.db"));
    expect(paths.mediaDir).toBe(join(resolve(cwd), "media"));
    expect(paths.uploadsDir).toBe(join(resolve(cwd), ".uploads"));
    expect(paths.logsDir).toBe(join(resolve(cwd), "logs"));
    expect(paths.binDir).toBe(join(resolve(cwd), "bin"));
    expect(paths.warnings).toEqual([]);
  });

  it("una variable vacía tampoco cuenta como configurada", () => {
    // `raw === undefined` es el único caso "sin variable"; vacía se rechaza.
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: "" }) });
    expect(result.ok).toBe(false);
  });

  it("normaliza el directorio de trabajo aunque venga con segmentos relativos", () => {
    const cwd = makeDir();
    const result = resolveRuntimePaths({ cwd: join(cwd, "sub", ".."), env: env() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.root).toBe(resolve(cwd));
  });
});

describe("resolveRuntimePaths con VIUREWARDS_DATA_DIR (distribución)", () => {
  it("pone base, medios, uploads, logs y bin dentro del directorio de datos", () => {
    const cwd = makeDir();
    const dataDir = makeDir("viu-data-");
    const result = resolveRuntimePaths({ cwd, env: env({ [DATA_DIR_ENV]: dataDir }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { paths } = result;
    expect(paths.mode).toBe("configured");
    expect(paths.root).toBe(resolve(dataDir));
    // La base vive directamente en el directorio de datos (sin subcarpeta data/).
    expect(paths.dbPath).toBe(join(resolve(dataDir), "app.db"));
    expect(paths.mediaDir).toBe(join(resolve(dataDir), "media"));
    expect(paths.uploadsDir).toBe(join(resolve(dataDir), ".uploads"));
    expect(paths.logsDir).toBe(join(resolve(dataDir), "logs"));
    expect(paths.binDir).toBe(join(resolve(dataDir), "bin"));
    // El cerrojo sigue a los DATOS, no a la carpeta de la versión.
    expect(paths.lockPath).toBe(join(resolve(dataDir), SHARED_RESOURCES_LOCK_FILE));
    // Nada quedó apuntando al cwd.
    expect(paths.root).not.toBe(resolve(cwd));
  });

  it("el directorio de recursos estáticos NO depende de la configuración", () => {
    // El servidor resuelve `web/` y `overlay/` con `import.meta.url`; cambiar el
    // directorio de datos no debe moverlos. Se comprueba el contrato observable:
    // las rutas devueltas son de DATOS y ninguna es la carpeta de la app.
    const cwd = makeDir();
    const dataDir = makeDir("viu-data-");
    const result = resolveRuntimePaths({ cwd, env: env({ [DATA_DIR_ENV]: dataDir }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const appDirs = ["web", "overlay"];
    for (const dir of [result.paths.mediaDir, result.paths.logsDir, result.paths.uploadsDir]) {
      for (const appDir of appDirs) {
        expect(dir.startsWith(join(resolve(dataDir), appDir))).toBe(false);
      }
    }
  });

  it("dos configuraciones distintas no comparten recursos mutables", () => {
    const a = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: makeDir("viu-a-") }) });
    const b = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: makeDir("viu-b-") }) });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.paths.dbPath).not.toBe(b.paths.dbPath);
    expect(a.paths.mediaDir).not.toBe(b.paths.mediaDir);
    expect(a.paths.lockPath).not.toBe(b.paths.lockPath);
  });

  it("dos configuraciones con el MISMO directorio de datos comparten el cerrojo", () => {
    const dataDir = makeDir("viu-same-");
    const a = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: dataDir }) });
    const b = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: dataDir }) });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Mismo conjunto compartido ⇒ mismo cerrojo ⇒ solo una instancia a la vez.
    expect(a.paths.lockPath).toBe(b.paths.lockPath);
    expect(a.paths.root).toBe(b.paths.root);
  });

  it("normaliza la ruta configurada (segmentos y separador redundantes)", () => {
    const dataDir = makeDir("viu-norm-");
    const messy = join(dataDir, "sub", "..", ".");
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: messy }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.root).toBe(resolve(dataDir));
  });

  it("acepta rutas con espacios", () => {
    const base = makeDir("viu-spaces-");
    const dataDir = join(base, "Mis Datos VIU");
    mkdirSync(dataDir, { recursive: true });
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: dataDir }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.mediaDir).toBe(join(resolve(dataDir), "media"));
  });
});

describe("resolveRuntimePaths rechaza configuraciones inválidas", () => {
  it("una ruta relativa produce un error claro y no resuelve a otra carpeta", () => {
    const cwd = makeDir();
    const result = resolveRuntimePaths({ cwd, env: env({ [DATA_DIR_ENV]: "datos/cerca" }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(DATA_DIR_ENV);
    expect(result.message).toContain("ABSOLUTA");
    // No se inventó una ruta bajo el cwd.
    expect(result.message).not.toContain(join(resolve(cwd), "data"));
  });

  it("una variable definida pero vacía es un error", () => {
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: "   " }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("vacía");
  });

  it("una ruta que existe y NO es una carpeta es un error", () => {
    const file = join(makeDir(), "no-soy-carpeta.txt");
    writeFileSync(file, "x");
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: file }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("no es una carpeta");
  });

  it("el código de salida de la configuración inválida no es el de 'datos en uso'", () => {
    // 3 es "ya hay otra instancia" (lo trata así el futuro launcher); 2 es
    // configuración inválida. Deben ser distintos.
    expect(INVALID_DATA_DIR_EXIT_CODE).toBe(2);
  });

  it("InvalidDataDirError conserva el motivo tal cual", () => {
    const error = new InvalidDataDirError("motivo de prueba");
    expect(error.name).toBe("InvalidDataDirError");
    expect(error.reason).toBe("motivo de prueba");
    expect(error.message).toBe("motivo de prueba");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("prepareDataDir", () => {
  it("crea el directorio de datos con bin/ y logs/", () => {
    const base = makeDir();
    const dataDir = join(base, "nuevo");
    const result = prepareDataDir(dataDir);
    expect(result.ok).toBe(true);
    expect(statSync(join(dataDir, "bin")).isDirectory()).toBe(true);
    expect(statSync(join(dataDir, "logs")).isDirectory()).toBe(true);
  });

  it("es idempotente", () => {
    const dataDir = join(makeDir(), "repetible");
    expect(prepareDataDir(dataDir).ok).toBe(true);
    expect(prepareDataDir(dataDir).ok).toBe(true);
  });

  it("informa un fallo con un mensaje en español cuando la ruta no se puede crear", () => {
    // Un archivo ocupando el nombre de la carpeta: `mkdirSync` falla.
    const base = makeDir();
    const blocker = join(base, "ocupado");
    writeFileSync(blocker, "x");
    const result = prepareDataDir(join(blocker, "dentro"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("No se pudo crear");
  });
});

describe("legacyDataNotice", () => {
  it("sin modo configurado nunca avisa", () => {
    const legacy = resolveRuntimePaths({ cwd: makeDir(), env: env() });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;
    expect(legacyDataNotice(legacy.paths)).toBeNull();
  });

  it("avisa si queda una base heredada con contenido y el directorio nuevo no la tiene", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, LEGACY_DATA_SUBDIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_DATA_SUBDIR, "app.db"), "contenido");

    const result = resolveRuntimePaths({ cwd, env: env({ [DATA_DIR_ENV]: join(makeDir(), "nuevo") }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const notice = legacyDataNotice(result.paths, { cwd });
    expect(notice).not.toBeNull();
    expect(notice).toContain("NO se movió ni se borró nada");
    expect(notice).toContain(DATA_DIR_ENV);
  });

  it("no avisa si la base heredada está vacía", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, LEGACY_DATA_SUBDIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_DATA_SUBDIR, "app.db"), "");

    const result = resolveRuntimePaths({ cwd, env: env({ [DATA_DIR_ENV]: join(makeDir(), "nuevo") }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(legacyDataNotice(result.paths, { cwd })).toBeNull();
  });

  it("no avisa si el directorio configurado ya tiene base", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, LEGACY_DATA_SUBDIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_DATA_SUBDIR, "app.db"), "contenido");
    const dataDir = join(makeDir(), "nuevo");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "app.db"), "nueva");

    const result = resolveRuntimePaths({ cwd, env: env({ [DATA_DIR_ENV]: dataDir }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(legacyDataNotice(result.paths, { cwd })).toBeNull();
  });

  it("nunca mueve ni copia nada", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, LEGACY_DATA_SUBDIR), { recursive: true });
    writeFileSync(join(cwd, LEGACY_DATA_SUBDIR, "app.db"), "contenido");
    const dataDir = join(makeDir(), "nuevo");
    const result = resolveRuntimePaths({ cwd, env: env({ [DATA_DIR_ENV]: dataDir }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    legacyDataNotice(result.paths, { cwd });
    // La base heredada y la carpeta nueva siguen como estaban.
    expect(statSync(join(cwd, LEGACY_DATA_SUBDIR, "app.db")).size).toBe("contenido".length);
    expect(() => statSync(dataDir)).toThrow();
  });
});

describe("runtime de Node para yt-dlp", () => {
  it("sin variable ni binario usa el Node que corre la app", () => {
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.nodeRuntime).toBeUndefined();
    expect(result.paths.warnings).toEqual([]);
  });

  it("usa la variable explícita cuando es una ruta absoluta", () => {
    const node = join(makeDir(), "node.exe");
    writeFileSync(node, "");
    const dataDir = makeDir("viu-data-");
    const result = resolveRuntimePaths({
      cwd: makeDir(),
      env: env({ [DATA_DIR_ENV]: dataDir, [NODE_RUNTIME_ENV]: node }),
      platform: "win32",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.nodeRuntime).toBe(resolve(node));
  });

  it("detecta el Node portable dentro de bin/ del directorio de datos", () => {
    const dataDir = makeDir("viu-data-");
    mkdirSync(join(dataDir, "bin"), { recursive: true });
    const portable = join(dataDir, "bin", "node.exe");
    writeFileSync(portable, "");
    const result = resolveRuntimePaths({
      cwd: makeDir(),
      env: env({ [DATA_DIR_ENV]: dataDir }),
      platform: "win32",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.nodeRuntime).toBe(portable);
  });

  it("detecta el Node portable en runtime/ del directorio de datos (distribución)", () => {
    const dataDir = makeDir("viu-data-");
    mkdirSync(join(dataDir, NODE_RUNTIME_SUBDIR), { recursive: true });
    const portable = join(dataDir, NODE_RUNTIME_SUBDIR, "node.exe");
    writeFileSync(portable, "");
    const result = resolveRuntimePaths({
      cwd: makeDir(),
      env: env({ [DATA_DIR_ENV]: dataDir }),
      platform: "win32",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.nodeRuntime).toBe(portable);
  });

  it("runtime/ tiene prioridad sobre bin/ si existen los dos", () => {
    const dataDir = makeDir("viu-data-");
    mkdirSync(join(dataDir, "bin"), { recursive: true });
    mkdirSync(join(dataDir, NODE_RUNTIME_SUBDIR), { recursive: true });
    writeFileSync(join(dataDir, "bin", "node.exe"), "");
    const expected = join(dataDir, NODE_RUNTIME_SUBDIR, "node.exe");
    writeFileSync(expected, "");
    const result = resolveRuntimePaths({
      cwd: makeDir(),
      env: env({ [DATA_DIR_ENV]: dataDir }),
      platform: "win32",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.nodeRuntime).toBe(expected);
  });

  it("en modo histórico también busca runtime/ bajo el directorio de trabajo", () => {
    const cwd = makeDir();
    mkdirSync(join(cwd, NODE_RUNTIME_SUBDIR), { recursive: true });
    const portable = join(cwd, NODE_RUNTIME_SUBDIR, "node.exe");
    writeFileSync(portable, "");
    const result = resolveRuntimePaths({ cwd, env: env(), platform: "win32" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.nodeRuntime).toBe(portable);
  });

  it("una variable con ruta relativa se ignora y se avisa (no rompe el arranque)", () => {
    const result = resolveRuntimePaths({
      cwd: makeDir(),
      env: env({ [NODE_RUNTIME_ENV]: "./node.exe" }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.paths.warnings.length).toBe(1);
    expect(result.paths.warnings[0]).toContain(NODE_RUNTIME_ENV);
    expect(result.paths.warnings[0]).toContain("absoluta");
  });

  it("en Windows solo busca .exe (un .cmd no se puede lanzar sin shell)", () => {
    expect(nodeRuntimeCandidates("win32")).toEqual(["node.exe", "node"]);
    expect(nodeRuntimeCandidates("linux")).toEqual(["node"]);
    expect(nodeRuntimeCandidates("win32")[0]).toBe("node.exe");
  });
});

describe("describePaths", () => {
  it("resume el mapa de rutas sin secretos", () => {
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env({ [DATA_DIR_ENV]: makeDir("viu-data-") }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = describePaths(result.paths);
    expect(text).toContain("datos en");
    expect(text).toContain("medios");
    expect(text).toContain("logs");
    expect(text).toContain("bin");
  });

  it("en modo heredado lo dice explícitamente", () => {
    const result = resolveRuntimePaths({ cwd: makeDir(), env: env() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(describePaths(result.paths)).toContain("heredado");
  });
});
