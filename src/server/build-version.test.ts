import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeOverlayVersion } from "./build-version.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "version-test-"));
  dirs.push(dir);
  return dir;
}

describe("computeOverlayVersion", () => {
  it("es estable si no cambia el contenido", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "index.html"), "<html>hola</html>");
    expect(computeOverlayVersion({ paths: [dir] })).toBe(computeOverlayVersion({ paths: [dir] }));
  });

  it("cambia cuando cambia el contenido", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "index.html"), "uno");
    const first = computeOverlayVersion({ paths: [dir] });
    writeFileSync(join(dir, "index.html"), "dos");
    expect(computeOverlayVersion({ paths: [dir] })).not.toBe(first);
  });

  it("cambia con el seed (fecha de inicio) aunque el contenido sea igual", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "index.html"), "igual");
    expect(computeOverlayVersion({ paths: [dir], seed: "1" })).not.toBe(
      computeOverlayVersion({ paths: [dir], seed: "2" }),
    );
  });

  it("devuelve un hash corto de 12 hex y no falla con rutas inexistentes", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "a"), "x");
    const version = computeOverlayVersion({ paths: [dir, join(dir, "no-existe")] });
    expect(version).toMatch(/^[0-9a-f]{12}$/);
  });
});
