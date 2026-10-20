/**
 * Verificación estática del login (botón "Guía" y logo) y de la página de la
 * guía pública (`/guia`).
 *
 * Sin navegador no se puede probar el render real: acá comprobamos leyendo los
 * archivos que:
 * (a) el botón "Guía" del login existe, apunta a `/guia` y usa el acento, sin
 *     colores literales, con la misma caja que "Entrar" y en el modo de primer uso;
 * (b) el logo del login va centrado y con su propia altura;
 * (c) la guía carga `theme.js` antes de pintar, tiene un solo `h1`, sus anclas
 *     apuntan a ids existentes, sus handlers están definidos y no contiene
 *     secretos ni dominios externos salvo kick.com;
 * (d) la guía no referencia ninguna captura que no exista en `web/assets/guide/`.
 *
 * No reemplaza una prueba real de navegador: ver docs/dashboard.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));

function read(file: string): string {
  return readFileSync(join(webDir, file), "utf8");
}

/** ¿El JS define `name(...)` como método? */
function defines(js: string, name: string): boolean {
  return new RegExp(`\\n\\s*(?:async\\s+)?${name}\\s*\\(`).test(js);
}

describe("login: logo centrado y botón Guía (Parte 1)", () => {
  const html = read("login.html");
  const css = read("style.css");

  it("el logo va centrado y con su propia altura (más grande que en el dashboard)", () => {
    // La variable propia del login existe y es mayor que la del dashboard.
    expect(css).toMatch(/--logo-height-login:\s*72px/);
    expect(css).toMatch(/--logo-height:\s*52px/);
    // El contenedor del logo en el login se centra y el logo usa su altura.
    expect(css).toMatch(/\.auth-wrap \.brand\s*\{[^}]*justify-content:\s*center/);
    expect(css).toMatch(/\.auth-wrap \.brand-logo\s*\{[^}]*height:\s*var\(--logo-height-login\)/);
    expect(css).toMatch(/\.auth-wrap \.brand-logo\s*\{[^}]*margin-inline:\s*auto/);
    // Conserva el respaldo de texto si la imagen no carga y los modos del logo.
    expect(html).toMatch(/x-show="logoFailed"/);
    expect(html).toContain("logoBadge()");
  });

  it("el botón Guía es un enlace a /guia con apariencia secundaria (acento, sin relleno)", () => {
    // Es un <a> (misma pestaña) con href /guia y aria-label en español.
    expect(html).toMatch(/<a class="btn-secondary" href="\/guia" aria-label="Guía para conectar Kick">Guía<\/a>/);
    // Sin target="_blank" (abre en la misma pestaña).
    expect(html).not.toMatch(/btn-secondary[^>]*target=/);
    // Comparte fila con "Entrar", separados a los extremos.
    expect(html).toMatch(/class="auth-actions"[\s\S]*class="primary"[\s\S]*class="btn-secondary"/);
    expect(css).toMatch(/\.auth-actions\s*\{[^}]*justify-content:\s*space-between/);
    expect(css).toMatch(/\.auth-actions\s*\{[^}]*align-items:\s*center/);
    // Borde y texto con la variable de acento y fondo transparente.
    expect(css).toMatch(/a\.btn-secondary\s*\{[^}]*border:\s*1px solid var\(--color-accent\)/);
    expect(css).toMatch(/a\.btn-secondary\s*\{[^}]*color:\s*var\(--color-accent\)/);
    expect(css).toMatch(/a\.btn-secondary\s*\{[^}]*background:\s*transparent/);
    // Misma caja (padding, radio y fuente) que el botón "Entrar".
    expect(css).toMatch(/a\.btn-secondary\s*\{[^}]*border-radius:\s*var\(--radius\)/);
    expect(css).toMatch(/a\.btn-secondary\s*\{[^}]*padding:\s*var\(--space-2\) var\(--space-4\)/);
    // Hover y active con el fondo suave del acento (sin colores literales).
    expect(css).toMatch(/a\.btn-secondary:hover\s*\{[^}]*background:\s*var\(--color-accent-soft\)/);
    expect(css).toMatch(/a\.btn-secondary:active\s*\{[^}]*background:\s*var\(--color-accent-soft-border\)/);
  });

  it("el bloque del botón Guía no usa colores literales", () => {
    const start = css.indexOf("a.btn-secondary {");
    const end = css.indexOf(".auth-actions", start);
    // Se toma desde el bloque del enlace hasta la regla siguiente que lo cierra.
    const block = css.slice(start, end > start ? end : start + 800);
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("en ancho menor a 360px los botones pasan a una columna (sin partirse)", () => {
    const mq = css.slice(css.indexOf("@media (max-width: 360px)"));
    expect(mq).toMatch(/\.auth-actions\s*\{[^}]*flex-direction:\s*column/);
    expect(mq).toMatch(/\.auth-actions\s*\{[^}]*align-items:\s*stretch/);
  });
});

describe("página de la guía (/guia) (Parte 2)", () => {
  const html = read("guia.html");
  const js = read("guia.js");
  const css = read("style.css");

  it("existe y carga theme.js antes de pintar, y los scripts antes de Alpine", () => {
    expect(existsSync(join(webDir, "guia.html"))).toBe(true);
    const head = html.slice(0, html.indexOf("</head>"));
    // theme.js sincrónico (sin defer/async) en el <head>, antes de style.css.
    const tag = head.match(/<script\b[^>]*\bsrc="\/web\/theme\.js"[^>]*>/);
    expect(tag, "no carga /web/theme.js en el <head>").not.toBeNull();
    expect(tag![0]).not.toMatch(/\b(?:defer|async)\b/);
    expect(html.indexOf("/web/theme.js")).toBeLessThan(html.indexOf("/web/style.css"));

    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => ({ src: m[1], i: m.index ?? 0 }));
    const alpine = scripts.find((s) => s.src.endsWith("/alpine.min.js"));
    expect(alpine).toBeDefined();
    for (const script of scripts) {
      if (script.src.endsWith("/alpine.min.js")) continue;
      expect(script.i, `${script.src} debe ir antes de Alpine`).toBeLessThan(alpine!.i);
    }
    // logo.js (juegos por tema + respaldo) y guia.js (el componente).
    expect(scripts.some((s) => s.src === "/web/logo.js")).toBe(true);
    expect(scripts.some((s) => s.src === "/web/guia.js")).toBe(true);
  });

  it("tiene un solo h1 y encabezados ordenados con landmarks", () => {
    expect([...html.matchAll(/<h1\b/g)].length).toBe(1);
    expect(html).toMatch(/<main\b/);
    expect(html).toMatch(/<nav\b/);
    // El índice es un <nav> con aria-label.
    expect(html).toMatch(/<nav class="guide-index" aria-label=/);
  });

  it("las anclas del índice apuntan a ids que existen", () => {
    const anchors = [...html.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const id of anchors) {
      expect(html, `falta el id #${id}`).toMatch(new RegExp(`id="${id}"`));
    }
  });

  it("los pasos tienen ids estables guia-paso-N y las capturas su nombre acordado", () => {
    for (let n = 1; n <= 6; n += 1) {
      expect(html, `falta guia-paso-${n}`).toContain(`id="guia-paso-${n}"`);
    }
    // Los nombres de captura usados en la página siguen el patrón acordado.
    const shots = [...html.matchAll(/shot\('(guia-[^']+)'\)/g)].map((m) => m[1]);
    expect(shots.length).toBeGreaterThan(0);
    for (const shot of shots) {
      expect(/^guia-\d\d-[a-z0-9-]+$/.test(shot), `nombre de captura raro: ${shot}`).toBe(true);
    }
  });

  it("no hay estilos inline ni colores literales en el HTML", () => {
    // Sin `style="..."` (el sistema de diseño vive en style.css).
    expect(html).not.toMatch(/\sstyle="/);
    // Sin hex/rgb literales.
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b|rgba?\(/);
  });

  it("cada handler de la página está definido en guia.js y las expresiones Alpine invocan métodos", () => {
    for (const match of html.matchAll(/@(?:click|change|input|submit)(?:\.\w+)*="([A-Za-z_$][\w$]*)\s*\(/g)) {
      expect(defines(js, match[1]), `guia.js no define ${match[1]}()`).toBe(true);
    }
    // `x-show="shot('...')"` se invoca (con paréntesis), no se pasa la función.
    expect(html).toMatch(/x-show="shot\('guia-/);
    expect(js).toMatch(/\bshot\s*\(/);
  });

  it("la página no contiene tokens, claves ni secretos de ejemplo reales", () => {
    expect(html).not.toMatch(/client[_-]?secret\s*[:=]\s*["']/i);
    expect(html).not.toMatch(/\b(?:access|refresh)_token\b/i);
    expect(html).not.toMatch(/key=[A-Za-z0-9_-]{16,}/);
    // El secreto se MENCIONA como aviso (correcto), pero nunca con un valor.
    expect(html).toContain("Secreto del Cliente");
  });

  it("el único dominio externo es kick.com", () => {
    const externals = [...html.matchAll(/https?:\/\/([^/"'\s]+)/g)].map((m) => m[1].toLowerCase());
    for (const host of externals) {
      expect(host === "kick.com" || host.endsWith(".kick.com"), `dominio externo no permitido: ${host}`).toBe(true);
    }
    // El único enlace saliente va con rel="noopener noreferrer".
    const anchors = [...html.matchAll(/<a\b[^>]*href="https?:\/\/[^"]+"[^>]*>/g)].map((m) => m[0]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor, `enlace saliente sin rel: ${anchor}`).toMatch(/rel="noopener noreferrer"/);
    }
  });

  it("la guía no referencia ninguna captura que no exista en web/assets/guide/", () => {
    // Los recursos propios referenciados por el HTML existen (mismo criterio que
    // web-assets.test.ts, pero tolerando las capturas opcionales: esas se piden
    // por JS con la lista del servidor, nunca como `src` fijo).
    const refs = [...html.matchAll(/(?:src|href)="(\/web\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((ref) => !ref.endsWith("/"));
    for (const ref of refs) {
      if (ref === "/web/theme.js" || ref === "/web/style.css") continue;
      const relative = ref.slice("/web/".length);
      expect(existsSync(join(webDir, relative)), `no existe ${ref}`).toBe(true);
    }
    // Ninguna captura se referencia como `src`/`href` fijo en el HTML.
    expect(html).not.toMatch(/(?:src|href)="[^"]*assets\/guide\//);
  });

  it("las capturas se manejan por la lista pública del servidor y el lightbox es accesible", () => {
    // El JS pide la lista pública (no una API protegida).
    expect(js).toMatch(/fetch\("\/api\/guide-shots"\)/);
    expect(js).not.toMatch(/\/api\/(?:clips|state|settings|logs|platforms)/);
    // Lightbox: se cierra con Esc y con un clic.
    expect(html).toMatch(/@keydown\.escape\.window="closeLightbox\(\)"/);
    expect(html).toMatch(/@click="closeLightbox\(\)"/);
    expect(js).toMatch(/closeLightbox\s*\(\s*\)/);
    // Aviso "Copiado" accesible (aria-live).
    expect(html).toMatch(/aria-live="polite"/);
    expect(js).toContain("Copiado");
  });

  it("el CSS de la guía no usa colores literales y es legible desde 360px", () => {
    const start = css.indexOf(".guide-wrap {");
    expect(start, "no está el CSS de la guía").toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf("[x-cloak]", start));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    // Imágenes que no desbordan.
    expect(block).toMatch(/\.guide-shot img\s*\{[^}]*max-width:\s*100%/);
    // La columna de lectura tiene un ancho máximo cómodo.
    expect(css).toMatch(/--guide-width:\s*760px/);
    // Scroll suave solo si el sistema lo permite.
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
  });
});
