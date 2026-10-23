/**
 * Runtime de Node para yt-dlp con una ruta EXPLÍCITA (distribución portable).
 *
 * Verificado contra el yt-dlp real instalado (2026.08.19):
 *
 *   --js-runtimes RUNTIME[:PATH]   Additional JavaScript runtime to enable, with
 *                                  an optional location for the runtime (either
 *                                  the path to the binary or its containing
 *                                  directory).
 *
 * Por eso la forma correcta es `node:<ruta>` en UN SOLO elemento de argv: la
 * ruta nunca se concatena ni pasa por una shell.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildYtdlpArgs } from "./args.ts";

const TEMPLATE = "/tmp/%(id)s.%(ext)s";
const LIMITS = { maxBytes: 1024, maxDurationSec: 60 } as const;

describe("--js-runtimes con ruta explícita", () => {
  it("usa `node` a secas cuando no hay ruta", () => {
    const args = buildYtdlpArgs("https://example.invalid/v", TEMPLATE, { ...LIMITS, jsRuntime: "node" });
    const index = args.indexOf("--js-runtimes");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("node");
  });

  it("usa `node:<ruta>` cuando se indica el runtime portable", () => {
    const runtime = join("C:", "VIUrewards", "runtime", "node.exe");
    const args = buildYtdlpArgs("https://example.invalid/v", TEMPLATE, {
      ...LIMITS,
      jsRuntime: `node:${runtime}`,
    });
    const index = args.indexOf("--js-runtimes");
    expect(args[index + 1]).toBe(`node:${runtime}`);
    // Un único elemento: con espacios en la ruta no se parte en dos argumentos.
    expect(args.filter((arg) => arg.includes(runtime))).toHaveLength(1);
  });

  it("una ruta con espacios sigue siendo un solo argumento", () => {
    const runtime = join("C:", "Mis Programas", "Node Portable", "node.exe");
    const args = buildYtdlpArgs("https://example.invalid/v", TEMPLATE, {
      ...LIMITS,
      jsRuntime: `node:${runtime}`,
    });
    const value = args[args.indexOf("--js-runtimes") + 1];
    expect(value).toBe(`node:${runtime}`);
    expect(value.startsWith("node:")).toBe(true);
  });

  it("sin runtime no se agrega el flag", () => {
    const args = buildYtdlpArgs("https://example.invalid/v", TEMPLATE, LIMITS);
    expect(args).not.toContain("--js-runtimes");
  });
});
