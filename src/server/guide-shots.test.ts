/**
 * Capturas de la guía pública: solo nombres válidos, sin traversal, y `[]` si la
 * carpeta todavía no existe (no debe haber 404 ni error).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GUIDE_SHOT_PATTERN, listGuideShots } from "./guide-shots.ts";

const dirs: string[] = [];

function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "guide-shots-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("capturas de la guía (listGuideShots)", () => {
  it("devuelve [] si la carpeta no existe (sin lanzar)", () => {
    const webDir = makeWebDir();
    expect(listGuideShots(webDir)).toEqual([]);
  });

  it("devuelve solo los nombres que matchean el patrón, ordenados", () => {
    const webDir = makeWebDir();
    const guideDir = join(webDir, "assets", "guide");
    mkdirSync(guideDir, { recursive: true });
    writeFileSync(join(guideDir, "guia-02-crear-app.png"), "x");
    writeFileSync(join(guideDir, "guia-01-kick-developer.webp"), "x");
    writeFileSync(join(guideDir, "guia-03-redirect-url.jpg"), "x");
    // Ruido que NO debe salir: mayúsculas, sin patrón, otro formato, subcarpeta.
    writeFileSync(join(guideDir, "logo.png"), "x");
    writeFileSync(join(guideDir, "guia-1-corto.png"), "x");
    writeFileSync(join(guideDir, "guia-04-mayusculas.PNG"), "x");
    writeFileSync(join(guideDir, "guia-05-foto.gif"), "x");
    mkdirSync(join(guideDir, "guia-06-sub"), { recursive: true });

    expect(listGuideShots(webDir)).toEqual([
      "guia-01-kick-developer.webp",
      "guia-02-crear-app.png",
      "guia-03-redirect-url.jpg",
    ]);
  });

  it("devuelve [] si `assets/guide` existe pero no es una carpeta", () => {
    const webDir = makeWebDir();
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "guide"), "soy un archivo");
    expect(listGuideShots(webDir)).toEqual([]);
  });

  it("lista la captura del paso 3 y rechaza el nombre viejo y el traversal", () => {
    const webDir = makeWebDir();
    const guideDir = join(webDir, "assets", "guide");
    mkdirSync(guideDir, { recursive: true });
    // Convención: NN = número de paso.
    writeFileSync(join(guideDir, "guia-03-credenciales.png"), "x");
    writeFileSync(join(guideDir, "guia-03-otra-vista.webp"), "x");
    // El nombre viejo no matchea el patrón: no se lista (y la página no lo pide).
    writeFileSync(join(guideDir, "kick-app-preview.png"), "x");
    // Intentos de salir de la carpeta: no se listan (son nombres, no rutas).
    writeFileSync(join(guideDir, "..guia-01-x.png"), "x");
    writeFileSync(join(guideDir, "guia-01-x..png"), "x");

    const listed = listGuideShots(webDir);
    expect(listed).toEqual(["guia-03-credenciales.png", "guia-03-otra-vista.webp"]);
    expect(listed).not.toContain("kick-app-preview.png");
    for (const name of listed) {
      expect(name).not.toContain("/");
      expect(name).not.toContain("..");
    }
  });

  it("el patrón rechaza rutas y traversal (y el nombre viejo)", () => {
    expect(GUIDE_SHOT_PATTERN.test("../secreto.png")).toBe(false);
    expect(GUIDE_SHOT_PATTERN.test("sub/guia-01-x.png")).toBe(false);
    expect(GUIDE_SHOT_PATTERN.test("guia-01-x.png")).toBe(true);
    // Fuera de la convención (NN = número de paso, resto en minúsculas).
    expect(GUIDE_SHOT_PATTERN.test("kick-app-preview.png")).toBe(false);
    expect(GUIDE_SHOT_PATTERN.test("guia-01-x..png")).toBe(false);
  });
});
