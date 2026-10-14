/**
 * Verificación estática de los assets del dashboard (Tarea 0).
 *
 * No hay navegador en los tests, así que comprobamos leyendo el HTML:
 * (a) los scripts que definen los componentes se cargan ANTES de alpine.min.js
 *     (Alpine arranca en un microtask apenas se ejecuta);
 * (b) cada `src`/`href` que apunta a /web corresponde a un archivo existente.
 *
 * No reemplaza una prueba real de navegador: ver docs/dashboard.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));
const overlayDir = fileURLToPath(new URL("../../overlay", import.meta.url));

interface Page {
  file: string;
  componentScript: string;
}

const PAGES: Page[] = [
  { file: "login.html", componentScript: "/web/login.js" },
  { file: "index.html", componentScript: "/web/app.js" },
];

function read(file: string): string {
  return readFileSync(join(webDir, file), "utf8");
}

function scriptSources(html: string): Array<{ src: string; index: number }> {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => ({
    src: match[1],
    index: match.index ?? -1,
  }));
}

describe("assets del dashboard", () => {
  for (const page of PAGES) {
    it(`${page.file}: Alpine se carga después del script del componente`, () => {
      const html = read(page.file);
      const scripts = scriptSources(html);
      const alpine = scripts.find((script) => script.src.endsWith("/alpine.min.js"));
      const component = scripts.find((script) => script.src === page.componentScript);

      expect(alpine, "falta el script de Alpine").toBeDefined();
      expect(component, `falta el script ${page.componentScript}`).toBeDefined();
      // El componente debe aparecer ANTES que Alpine en el documento.
      expect(component!.index).toBeLessThan(alpine!.index);

      // Ningún script propio puede quedar después de Alpine.
      for (const script of scripts) {
        if (script.src.endsWith("/alpine.min.js")) continue;
        expect(script.index).toBeLessThan(alpine!.index);
      }
    });

    it(`${page.file}: todos los src/href de /web existen`, () => {
      const html = read(page.file);
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((ref) => ref.startsWith("/web/"));

      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        const relative = ref.slice("/web/".length);
        expect(existsSync(join(webDir, relative)), `no existe ${ref}`).toBe(true);
      }
    });

    it(`${page.file}: incluye favicon (evita el 404 de /favicon.ico)`, () => {
      expect(read(page.file)).toMatch(/<link\s+rel="icon"/);
    });
  }

  it("login.html usa los scripts propios y no referencia CDNs", () => {
    const refs = [...read("login.html").matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      expect(ref.startsWith("http"), `no debe haber recursos externos: ${ref}`).toBe(false);
    }
  });

  it("el logo está en los dos formatos y se carga en dashboard y login", () => {
    expect(existsSync(join(webDir, "assets/VIUrewards.png"))).toBe(true);
    expect(existsSync(join(webDir, "assets/VIUrewards.webp"))).toBe(true);
    for (const page of PAGES) {
      const html = read(page.file);
      expect(html, `${page.file} no usa el logo`).toContain("logoBadge()");
      expect(html, `${page.file} no apunta al PNG del logo`).toContain("/web/assets/VIUrewards.png");
      expect(html, `${page.file} no tiene el alt del logo`).toContain('alt="VIUrewards"');
    }
  });

  it("logo.js se carga antes del script del componente en cada página", () => {
    for (const page of PAGES) {
      const scripts = scriptSources(read(page.file));
      const logo = scripts.find((script) => script.src === "/web/logo.js");
      const component = scripts.find((script) => script.src === page.componentScript);
      expect(logo, `${page.file} no carga /web/logo.js`).toBeDefined();
      expect(logo!.index).toBeLessThan(component!.index);
    }
  });
});

describe("overlay (Browser Source)", () => {
  const html = readFileSync(join(overlayDir, "index.html"), "utf8");

  it("incluye favicon (evita el 404 dentro del Browser Source)", () => {
    expect(html).toMatch(/<link\s+rel="icon"/);
  });

  it("arma las URLs de /media con la clave del overlay (no sin key)", () => {
    // Regresión del bug B3: el `play` usaba /media/<id>.mp4 sin `?key=` y /media
    // respondía 401, así que el video nunca cargaba.
    expect(html).toMatch(/\/media\/.*key=/);
  });

  it("el modo 'solo audio' oculta la imagen sin usar display: none ni display: none en CSS", () => {
    // El video se oculta con `visibility: hidden` (sigue sonando el audio, el
    // recorte y la duración máxima aplican y llegan `ended`/`error`).
    expect(html).toMatch(/item\.params\.audioOnly\s*\?\s*"hidden"\s*:\s*"visible"/);
    expect(html).toMatch(/style\.visibility\s*=/);
    // Nunca se oculta la imagen de solo audio con `display: none`.
    expect(html).not.toMatch(/audioOnly[^;]*display\s*[:=]\s*"?none/i);
    // Sin animación de entrada/salida en solo audio.
    expect(html).toMatch(/params\.audioOnly\)\s*return;\s*\n\s*if \(anim\) anim\.cancel/);
  });
});