/**
 * Detección del punto de entrada (`src/server/entry-point.ts`).
 *
 * El defecto que cubre: con la comparación vieja
 * (`import.meta.url === pathToFileURL(argv[1]).href`) una instalación bajo un
 * enlace simbólico o una junction NUNCA arrancaba: `import.meta.url` trae la
 * ruta real y `argv[1]` la ruta dada, así que el servidor salía con código 0 sin
 * imprimir nada. Reproducido con el servidor real por `build/lnk/start.ts`.
 *
 * Todo se hace con directorios y archivos REALES en una carpeta temporal, con
 * una junction (Windows, no requiere administrador) o un symlink a directorio
 * (otros sistemas). Nunca se tocan `data/`, `media/` ni `logs/`.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isEntryPoint } from "./entry-point.ts";

const IS_WINDOWS = process.platform === "win32";

let root = "";
let targetDir = "";
let linkDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "viu-entry-point-"));
  targetDir = join(root, "scripts");
  linkDir = join(root, "lnk");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "start.ts"), "// entrada de prueba\n", "utf8");
  writeFileSync(join(targetDir, "otro.ts"), "// otro archivo\n", "utf8");
  // Junction en Windows (tipo de enlace que reportó el usuario; no pide admin).
  symlinkSync(targetDir, linkDir, IS_WINDOWS ? "junction" : "dir");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** `import.meta.url` de un archivo: el módulo se evalúa por su ruta REAL. */
function metaUrlOf(path: string): string {
  return pathToFileURL(path).href;
}

describe("isEntryPoint", () => {
  it("devuelve true con la ruta directa del archivo", () => {
    const file = join(targetDir, "start.ts");
    expect(isEntryPoint(metaUrlOf(file), file)).toBe(true);
  });

  it("devuelve true cuando argv[1] llega a través de una junction", () => {
    // Lo que pasa de verdad: el módulo se resolvió por `targetDir` (ruta real)
    // y argv[1] es el camino por la junction.
    const real = join(targetDir, "start.ts");
    const viaLink = join(linkDir, "start.ts");
    expect(isEntryPoint(metaUrlOf(real), viaLink)).toBe(true);
    // Y al revés (metaUrl por la junction): también tiene que dar true.
    expect(isEntryPoint(metaUrlOf(viaLink), real)).toBe(true);
  });

  it("devuelve false para otro archivo", () => {
    expect(isEntryPoint(metaUrlOf(join(targetDir, "start.ts")), join(targetDir, "otro.ts"))).toBe(false);
    // También por la junction: otro archivo sigue siendo otro archivo.
    expect(isEntryPoint(metaUrlOf(join(targetDir, "start.ts")), join(linkDir, "otro.ts"))).toBe(false);
  });

  it("devuelve false si argv[1] es undefined", () => {
    expect(isEntryPoint(metaUrlOf(join(targetDir, "start.ts")), undefined)).toBe(false);
    // Y no depende del archivo: nunca se resuelve nada.
    expect(isEntryPoint("no-es-una-url", undefined)).toBe(false);
  });

  it("devuelve false sin lanzar excepción si argv[1] no existe", () => {
    const missing = join(root, "no-existe", "start.ts");
    expect(() => isEntryPoint(metaUrlOf(join(targetDir, "start.ts")), missing)).not.toThrow();
    expect(isEntryPoint(metaUrlOf(join(targetDir, "start.ts")), missing)).toBe(false);
    // Un metaUrl que no es `file:` tampoco lanza: cae a la comparación vieja.
    expect(() => isEntryPoint("https://ejemplo.test/start.ts", missing)).not.toThrow();
    expect(isEntryPoint("https://ejemplo.test/start.ts", missing)).toBe(false);
  });

  it.runIf(IS_WINDOWS)("en Windows, otra capitalización de la ruta también es el mismo archivo", () => {
    const file = join(targetDir, "START.TS");
    expect(isEntryPoint(metaUrlOf(join(targetDir, "start.ts")), file)).toBe(true);
    // Con la junction y mayúsculas en las dos partes.
    expect(isEntryPoint(metaUrlOf(join(targetDir, "start.ts")), linkDir.toUpperCase() + "\\start.ts")).toBe(true);
  });
});
