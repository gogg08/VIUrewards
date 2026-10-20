/**
 * Verificación estática de temas, color de acento y logo por tema (Parte 2).
 *
 * Sin navegador no se puede probar el pintado real: acá comprobamos leyendo los
 * archivos que:
 * (a) cada tema (`night`/`oled`/`day`) define el MISMO juego de variables
 *     `--color-*` que el `:root` de respaldo (sin JS) — si a un tema le falta
 *     una variable, la regla que la usa quedaría sin color;
 * (b) `color-scheme` es coherente con cada tema (oscuro/claro);
 * (c) ninguna regla escribe colores literales fuera de una declaración de
 *     variable (`--nombre:`), como pide el sistema de diseño;
 * (d) `theme.js` se carga SÍNCRONO en el `<head>` antes de `style.css` (sin
 *     `defer`/`async`), para que el tema se aplique antes de pintar;
 * (e) el selector de Tema y la paleta de acento exponen los roles de
 *     accesibilidad (`radiogroup`/`radio`/`aria-checked`);
 * (f) el logo por tema vive SOLO en `logo.js` (archivos opcionales) con respaldo
 *     recordado (no se repite el 404), y el HTML usa el respaldo;
 * (g) las claves de localStorage, los tres temas más `auto`, la paleta de 6 y el
 *     acento por defecto son los acordados;
 * (h) cada handler usado en la sección Apariencia está definido en `app.js`.
 *
 * No reemplaza una prueba real de navegador: ver docs/dashboard.md.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));

function read(file: string): string {
  return readFileSync(join(webDir, file), "utf8");
}

const PAGES = ["index.html", "login.html"] as const;

/**
 * Extrae el contenido de un bloque de regla CSS que empieza en `selector {` y
 * termina en la llave de cierre. Se busca el selector literal (`:root[...]`) al
 * inicio del bloque; el cuerpo no debe contener una llave anidada (en `style.css`
 * los bloques de tema son planos). Devuelve "" si no se encuentra.
 */
function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector + " {");
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  if (open === -1 || close === -1) return "";
  return css.slice(open + 1, close);
}

/**
 * Nombres de las variables `--color-*` declaradas dentro de un bloque de regla.
 * Solo mira las líneas que son declaraciones (`--nombre:`), así un
 * `color-scheme: dark` o un comentario no cuentan.
 */
function colorVars(block: string): string[] {
  const names = new Set<string>();
  for (const match of block.matchAll(/(?<![\w-])(--color-[a-zA-Z0-9-]+)\s*:/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

describe("temas y acento (estático)", () => {
  const css = read("style.css");
  const index = read("index.html");
  const login = read("login.html");
  const theme = read("theme.js");
  const logo = read("logo.js");
  const app = read("app.js");

  it("los tres temas y el respaldo :root definen el mismo juego de --color-*", () => {
    const root = colorVars(cssBlock(css, ":root"));
    const night = colorVars(cssBlock(css, ':root[data-theme="night"]'));
    const oled = colorVars(cssBlock(css, ':root[data-theme="oled"]'));
    const day = colorVars(cssBlock(css, ':root[data-theme="day"]'));

    // Sanidad: hay variables en los cuatro y el respaldo no está vacío.
    expect(root.length).toBeGreaterThan(10);
    expect(night.length).toBeGreaterThan(10);
    expect(oled.length).toBeGreaterThan(10);
    expect(day.length).toBeGreaterThan(10);

    // Mismo juego (comparado como conjunto ordenado) entre los tres temas.
    expect(night).toEqual(oled);
    expect(oled).toEqual(day);
    expect(day).toEqual(night);
    // El respaldo sin JS (`:root`) cubre todo lo que usan los temas: puede
    // tener tokens extra (p. ej. `--color-picker-size`, que es un tamaño y no un
    // color), pero nunca debe faltarle un color que un tema sí define.
    expect(root).toEqual(expect.arrayContaining(night));

    // Un par de variables clave que la Parte 2 introdujo o movió.
    expect(night).toContain("--color-accent");
    expect(night).toContain("--color-accent-soft");
    expect(night).toContain("--color-success");
  });

  it("color-scheme por tema: oscuro en night/oled, claro en day", () => {
    expect(cssBlock(css, ':root[data-theme="night"]')).toMatch(/color-scheme:\s*dark/);
    expect(cssBlock(css, ':root[data-theme="oled"]')).toMatch(/color-scheme:\s*dark/);
    expect(cssBlock(css, ':root[data-theme="day"]')).toMatch(/color-scheme:\s*light/);
    // El respaldo (sin JS) usa el del tema Noche.
    expect(cssBlock(css, ":root")).toMatch(/color-scheme:\s*dark/);
  });

  it("ninguna regla escribe colores literales fuera de una declaración de variable", () => {
    // Solo se permiten hex/rgb/hsl en las líneas que declaran `--nombre: ...`.
    // `color-mix(in srgb, ...)`, `transparent` y los `var(--...)` quedan fuera.
    const literal = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;
    const offences: string[] = [];
    css.split(/\r?\n/).forEach((line, i) => {
      literal.lastIndex = 0;
      if (literal.test(line) && !/--[a-zA-Z0-9-]+\s*:/.test(line)) {
        offences.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(offences, `colores literales fuera de variables:\n${offences.join("\n")}`).toEqual([]);
  });

  it("theme.js se carga en <head> sin defer/async y antes de style.css", () => {
    for (const page of PAGES) {
      const html = read(page);
      const head = html.slice(0, html.indexOf("</head>"));
      // El tag de theme.js es sincrónico (sin defer ni async) y va en el <head>.
      const tagMatch = head.match(/<script\b[^>]*\bsrc="\/web\/theme\.js"[^>]*>/);
      expect(tagMatch, `${page} no carga /web/theme.js en el <head>`).not.toBeNull();
      expect(tagMatch![0], `${page} carga theme.js con defer/async`).not.toMatch(/\b(?:defer|async)\b/);
      // Y aparece ANTES de la hoja de estilos (para pintar ya con el tema).
      const themeIndex = html.indexOf("/web/theme.js");
      const cssIndex = html.indexOf("/web/style.css");
      expect(themeIndex, `${page} no enlaza style.css`).toBeGreaterThanOrEqual(0);
      expect(cssIndex, `${page} no enlaza style.css`).toBeGreaterThanOrEqual(0);
      expect(themeIndex, `${page}: theme.js debe ir antes de style.css`).toBeLessThan(cssIndex);
    }
  });

  it("el selector de Tema y la paleta de acento exponen roles de accesibilidad", () => {
    // Dos grupos de radios: Tema y Color de acento.
    const groups = [...index.matchAll(/role="radiogroup"/g)].length;
    expect(groups).toBeGreaterThanOrEqual(2);

    // El bloque de Tema: `radiogroup` con hijos `radio` y `:aria-checked`.
    const themeGridStart = index.indexOf('role="radiogroup" aria-label="Tema"');
    expect(themeGridStart, "no está el radiogroup del Tema").toBeGreaterThanOrEqual(0);
    const accentStart = index.indexOf('role="radiogroup" aria-label="Color de acento"');
    expect(accentStart, "no está el radiogroup del acento").toBeGreaterThanOrEqual(0);

    // Del grupo de Tema hasta el del acento hay `role="radio"` + `:aria-checked`.
    const themeBlock = index.slice(themeGridStart, accentStart);
    expect(themeBlock).toMatch(/role="radio"/);
    expect(themeBlock).toMatch(/:aria-checked=/);
    expect(themeBlock).toMatch(/@click="setTheme\(/);

    // El bloque del acento: `role="radio"`, `:aria-checked` y `accentIsActive`.
    const accentBlock = index.slice(accentStart, index.indexOf("Logo", accentStart));
    expect(accentBlock).toMatch(/role="radio"/);
    expect(accentBlock).toMatch(/:aria-checked="accentIsActive\(/);
    expect(accentBlock).toMatch(/@click="setAccent\(/);

    // Navegación por flechas dentro de cada grupo (patrón radiogroup): el foco
    // se mueve y aplica el valor al instante, como un clic.
    expect(themeBlock).toMatch(/@keydown\.arrow-right\.prevent="cycleTheme\(/);
    expect(themeBlock).toMatch(/@keydown\.arrow-left\.prevent="cycleTheme\(/);
    expect(accentBlock).toMatch(/@keydown\.arrow-right\.prevent="cycleAccent\(/);
    expect(accentBlock).toMatch(/@keydown\.arrow-left\.prevent="cycleAccent\(/);
    // Un solo elemento del grupo entra en el orden de tabulación.
    expect(themeBlock).toMatch(/:tabindex=/);
    expect(accentBlock).toMatch(/:tabindex="accentSwatchTabindex\(/);
  });

  it("la fila del acento tiene el toggle 'Ajustar contraste' y la advertencia con el ratio", () => {
    // El toggle usa el mismo componente `.switch`, con `role="switch"` y `aria-checked`.
    expect(index).toMatch(/@click="setAccentContrastFix\(!accentContrastFix\)"/);
    expect(index).toMatch(/role="switch"[\s\S]{0,600}?aria-label="Ajustar contraste"/);
    expect(index).toMatch(/<span class="switch-label">Ajustar contraste<\/span>/);
    // La advertencia muestra el ratio y sugiere activar el toggle.
    expect(index).toMatch(/x-show="accentWarning"/);
    expect(index).toMatch(/x-text="accentContrastText"/);
    expect(index).toMatch(/Ajustar contraste/);
    // El toggle sale marcado por defecto (default ENCENDIDO): el estado inicial
    // de app.js es `true` y el título del toggle no dice "apagado".
    expect(app).toMatch(/accentContrastFix:\s*true/);
    expect(app).not.toMatch(/accentContrastFix:\s*false/);
    // La fila del acento marca el hex como ancho fijo (no `flex: 1`).
    expect(css).toMatch(/\.color-row--accent \.color-hex\s*\{[^}]*width:\s*10ch/);
    expect(css).toMatch(/\.color-row--accent\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("logo.js define los juegos por tema y el respaldo, y el HTML usa el respaldo", () => {
    // Los juegos por tema: oscuro para night/oled, claro para day.
    expect(logo).toMatch(/VIU_LOGO_SETS\s*=/);
    expect(logo).toMatch(/night:\s*\{[^}]*VIUrewards-dark\.png/);
    expect(logo).toMatch(/oled:\s*\{[^}]*VIUrewards-dark\.png/);
    expect(logo).toMatch(/day:\s*\{[^}]*VIUrewards-light\.png/);
    // El respaldo al juego oscuro (el que existe de verdad y es el del HTML).
    expect(logo).toMatch(/VIU_LOGO_FALLBACK\s*=\s*\{[^}]*VIUrewards-dark\.png/);
    expect(logo).toMatch(/VIU_LOGO_FALLBACK\s*=\s*\{[^}]*VIUrewards-dark\.webp/);

    // El componente recuerda el 404 (no lo repite) y cae al respaldo.
    expect(logo).toMatch(/onLogoError:\s*function/);
    expect(logo).toMatch(/VIULogo\.markMissing\(this\._theme\)/);
    expect(logo).toMatch(/markMissing:\s*function/);
    expect(logo).toMatch(/pathFor:\s*function/);

    // El HTML usa el juego oscuro como `src` fijo y engancha el error.
    for (const page of PAGES) {
      const html = read(page);
      expect(html, `${page} no apunta al PNG del logo`).toMatch(
        /src="\/web\/assets\/VIUrewards-dark\.png"/,
      );
      expect(html, `${page} no maneja el error del logo`).toMatch(/@error="onLogoError\(\)"/);
    }
  });

  it("el logo por tema usa los nombres esperados y el HTML apunta al juego oscuro", () => {
    // Se buscan todas las rutas de assets del logo definidas en logo.js.
    const paths = [...logo.matchAll(/"(\/web\/assets\/VIUrewards[^"]*)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("/web/assets/"), `ruta fuera de /web/assets: ${path}`).toBe(true);
      expect(path.endsWith(".png") || path.endsWith(".webp")).toBe(true);
      // Sin nombre raro: solo el logo por tema (dark/light).
      expect(/^\/web\/assets\/VIUrewards(?:-(?:dark|light))?\.(?:png|webp)$/.test(path)).toBe(true);
    }
    // Los juegos del tema (dark/light) están presentes; el oscuro es el respaldo.
    expect(paths).toContain("/web/assets/VIUrewards-dark.png");
    expect(paths).toContain("/web/assets/VIUrewards-dark.webp");
    expect(paths).toContain("/web/assets/VIUrewards-light.png");
    expect(paths).toContain("/web/assets/VIUrewards-light.webp");
    // El HTML apunta SOLO al juego oscuro (el claro lo elige logo.js según el tema).
    for (const page of PAGES) {
      const html = read(page);
      expect(html, `${page} no apunta al logo oscuro`).toMatch(/src="\/web\/assets\/VIUrewards-dark\.png"/);
      expect(html, `${page} no debe referenciar el logo claro`).not.toMatch(/VIUrewards-light\./);
    }
  });

  it("theme.js usa las claves de localStorage acordadas, los tres temas más auto y la paleta de 7", () => {
    expect(theme).toMatch(/VIU_THEME_KEY\s*=\s*"viurewards\.theme"/);
    expect(theme).toMatch(/VIU_ACCENT_KEY\s*=\s*"viurewards\.accent"/);
    // Clave del toggle "Ajustar contraste".
    expect(theme).toMatch(/VIU_CONTRAST_KEY\s*=\s*"viurewards\.accentContrastFix"/);
    // Tres temas efectivos más la preferencia "auto".
    expect(theme).toMatch(/VIU_THEMES\s*=\s*\[\s*"night",\s*"oled",\s*"day"\s*\]/);
    expect(theme).toMatch(/VIU_THEME_MODES\s*=\s*\[[^\]]*"auto"/);
    expect(theme).toMatch(/VIU_THEME_MODES\s*=\s*\[[^\]]*"night"/);
    expect(theme).toMatch(/VIU_THEME_MODES\s*=\s*\[[^\]]*"oled"/);
    expect(theme).toMatch(/VIU_THEME_MODES\s*=\s*\[[^\]]*"day"/);
    // Acento por defecto: el verde actual.
    expect(theme).toMatch(/VIU_ACCENT_DEFAULT\s*=\s*"#53fc18"/);
    // La paleta tiene 7 colores (7 entradas con `hex:`), incluido el gris claro.
    const palette = theme.slice(theme.indexOf("VIU_ACCENT_PALETTE"), theme.indexOf("VIU_ACCENT_DEFAULT"));
    const entries = [...palette.matchAll(/hex:\s*"#/g)].length;
    expect(entries).toBe(7);
    expect(palette).toMatch(/hex:\s*"#53fc18"/);
    expect(palette).toMatch(/id:\s*"gray", label: "Gris claro", hex: "#d1d5db"/);
  });

  it("el respaldo :root y cada tema dejan --color-success como alias del acento", () => {
    // `--color-success` ya NO es un verde fijo: es `var(--color-accent)`, para que
    // los estados "positivos" (habilitada, conectado) sigan al acento.
    for (const selector of [":root", ':root[data-theme="night"]', ':root[data-theme="oled"]', ':root[data-theme="day"]']) {
      const block = cssBlock(css, selector);
      expect(block, `${selector} no define --color-success`).toMatch(/--color-success:\s*var\(--color-accent\)/);
      expect(block, `${selector} no define --color-success-ink`).toMatch(
        /--color-success-ink:\s*var\(--color-accent-ink\)/,
      );
    }
    // Los estados "positivos" usan el acento, no `--color-success` literal.
    expect(css).toMatch(/\.ok\s*\{[^}]*color:\s*var\(--color-accent\)/);
    expect(css).toMatch(/\.badge\.ok\s*\{[^}]*background:\s*var\(--color-accent\)/);
    expect(css).toMatch(/\.status-pill\.ok \.dot\s*\{[^}]*background:\s*var\(--color-accent\)/);
    expect(css).toMatch(/\.dot\.ok\s*\{[^}]*background:\s*var\(--color-accent\)/);
    // `danger` y `warn` siguen semánticos (no alias del acento).
    expect(css).not.toMatch(/--color-danger:\s*var\(--color-accent\)/);
    expect(css).not.toMatch(/--color-warn:\s*var\(--color-accent\)/);
  });

  it("cada handler de la sección Apariencia está definido en app.js", () => {
    // La sección Apariencia va desde su <section> hasta el cierre de Ajustes.
    const start = index.indexOf("<!-- ---- Apariencia ---- -->");
    expect(start, "no está la sección Apariencia").toBeGreaterThanOrEqual(0);
    const end = index.indexOf("<!-- ---- Avanzado ---- -->", start);
    expect(end, "no está el final de la sección Apariencia").toBeGreaterThan(start);
    const section = index.slice(start, end);

    // Handlers de `@click`/`@change`/`@input`/`@submit` con nombre(…).
    const names = new Set<string>();
    for (const match of section.matchAll(/@(?:click|change|input|submit)\b[\w.:-]*="([A-Za-z_$][\w$]*)\s*\(/g)) {
      names.add(match[1]);
    }
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      // Definido como método del objeto Alpine (`nombre(` al inicio de una línea).
      const defined = new RegExp(`\\n\\s*(?:async\\s+)?${name}\\s*\\(`).test(app);
      expect(defined, `app.js no define ${name}()`).toBe(true);
    }

    // Los métodos de esta sección existen por nombre.
    for (const name of ["setTheme", "setAccent", "resetAccent", "accentIsActive", "accentSwatchTabindex", "cycleTheme", "cycleAccent", "setAccentContrastFix"]) {
      expect(app, `app.js no define ${name}()`).toMatch(new RegExp(`\\n\\s*${name}\\s*\\(`));
    }
  });

  it("la línea de estado (punto + texto) comparte la clase de estado y color", () => {
    // Overlay y OBS: el contenedor lleva la clase de estado y el punto depende de ella.
    expect(index).toMatch(/class="status-line"\s+:class="overlayStatusClass"/);
    const lineBlock = index.slice(index.indexOf('class="status-line"'), index.indexOf('class="status-line"') + 400);
    expect(lineBlock).toMatch(/<span class="dot"><\/span>/);
    expect(lineBlock).toMatch(/class="status-line-label"/);
    // El color sale de la MISMA clase en el contenedor (no de clases separadas).
    expect(css).toMatch(/\.status-line\s*\{[^}]*align-items:\s*center/);
    expect(css).toMatch(/\.status-line\.ok\s*\{[^}]*color:\s*var\(--color-accent\)/);
    expect(css).toMatch(/\.status-line\.error\s*\{[^}]*color:\s*var\(--color-danger\)/);
    // El punto de la línea de estado sigue la misma clase del contenedor.
    expect(css).toMatch(/\.status-line\.error \.dot\s*\{/);
    expect(css).toMatch(/\.status-line\.ok \.dot\s*\{/);
  });

  it("la barra superior usa el mismo componente punto+texto (.status-pill + .dot)", () => {
    // Overlay y Kick comparten `.status-pill`; el punto sigue la clase `.ok`/`.error`.
    const pillCount = [...index.matchAll(/class="status-pill"/g)].length;
    expect(pillCount).toBeGreaterThanOrEqual(2);
    expect(css).toMatch(/\.status-pill\.ok \.dot\s*\{[^}]*background:\s*var\(--color-accent\)/);
    expect(css).toMatch(/\.status-pill\.error \.dot\s*\{[^}]*background:\s*var\(--color-danger\)/);
    // El pill no se parte en varias líneas y tiene altura fija.
    expect(css).toMatch(/\.status-pill\s*\{[^}]*align-items:\s*center/);
  });

  it("los campos de Seguridad tienen ancho máximo 360px", () => {
    expect(index).toMatch(/class="stack password-form"/);
    expect(css).toMatch(/\.password-form input\s*\{[^}]*width:\s*100%[^}]*max-width:\s*360px/);
    expect(css).toMatch(/\.password-form-actions\s*\{[^}]*max-width:\s*360px/);
  });

  it("la tabla de canjes pendientes tiene más aire y no rompe el modal", () => {
    expect(index).toMatch(/class="old-redemptions"/);
    // Separadores de fila + encabezado con margen inferior.
    expect(css).toMatch(/table\.grid td\s*\{[^}]*border-bottom:\s*1px solid/);
    // El contenedor de la tabla scrollea en horizontal dentro del modal.
    expect(css).toMatch(/\.old-redemptions \.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.old-redemptions-actions\s*\{[^}]*margin-top:/);
  });

  it("reglas responsive: logo oculto, pills nowrap y panel de descargas acotado", () => {
    // En <= 600px el logo desaparece.
    const mq600 = css.slice(css.indexOf("@media (max-width: 600px)"));
    expect(mq600).toMatch(/\.brand\s*\{\s*display:\s*none/);
    expect(mq600).toMatch(/\.status-pill\s*\{[^}]*white-space:\s*nowrap/);
    expect(mq600).toMatch(/\.dropdown-menu-wide\s*\{[^}]*position:\s*fixed/);
    expect(mq600).toMatch(/\.dropdown-menu-wide\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)/);
    expect(mq600).toMatch(/\.dropdown-menu-wide\s*\{[^}]*max-height:\s*calc\(100dvh - 80px\)/);
    // En <= 480px se oculta la palabra de estado y Salir pasa a ícono.
    const mq480 = css.slice(css.indexOf("@media (max-width: 480px)"));
    expect(mq480).toMatch(/\.status-pill-state\s*\{\s*display:\s*none/);
    expect(index).toMatch(/class="status-pill-state"/);
    expect(index).toMatch(/class="logout-btn"/);
    // El estado queda accesible por title/aria-label.
    expect(index).toMatch(/:aria-label="'Overlay: '/);
  });

  it("las pestañas de Ajustes tienen la misma caja y la navegación no se estira", () => {
    // Borde transparente base + altura mínima y line-height fijos.
    expect(css).toMatch(/\.tabs button\s*\{[^}]*border:\s*1px solid transparent/);
    expect(css).toMatch(/\.tabs button\s*\{[^}]*min-height:\s*var\(--control-height\)/);
    expect(css).toMatch(/\.tabs button\s*\{[^}]*line-height:/);
    // La nav no depende de la altura del panel.
    expect(css).toMatch(/\.tabs\s*\{[^}]*align-content:\s*start/);
    expect(css).toMatch(/\.tabs\s*\{[^}]*flex:\s*none/);
    // En <= 720px pasa a una fila con scroll horizontal.
    const mq720 = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(mq720).toMatch(/\.tabs\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(mq720).toMatch(/\.tabs\s*\{[^}]*overflow-x:\s*auto/);
    // El modal de Ajustes tiene altura estable entre pestañas.
    expect(index).toMatch(/class="modal-window settings-window"/);
    expect(css).toMatch(/\.settings-window\s*\{[^}]*--modal-height:/);
  });
});
