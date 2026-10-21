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

  it("los pasos tienen ids estables guia-paso-N y cada uno busca SUS capturas por número", () => {
    for (let n = 1; n <= 6; n += 1) {
      expect(html, `falta guia-paso-${n}`).toContain(`id="guia-paso-${n}"`);
    }
    // Convención: el NN del nombre es el NÚMERO DE PASO. Cada paso pide sus
    // capturas con `stepShots('guia-paso-N')` (varias por paso, orden del server).
    const steps = [...html.matchAll(/stepShots\('(guia-paso-\d+)'\)/g)].map((m) => m[1]);
    expect(new Set(steps)).toEqual(new Set([1, 2, 3, 4, 5, 6].map((n) => `guia-paso-${n}`)));
    // El bloque de capturas solo se muestra si el paso tiene al menos una.
    expect([...html.matchAll(/x-show="hasShots\('guia-paso-\d+'\)"/g)].length).toBe(6);
    // Ya no hay nombres de captura hardcodeados en el HTML: salen de la lista
    // pública del servidor, así un nombre nuevo no exige tocar la página (solo
    // puede aparecer en un ejemplo dentro de un comentario).
    expect(html).not.toMatch(/shot\('guia-\d/);
    const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(withoutComments).not.toMatch(/guia-\d\d-[a-z0-9-]+\.(?:png|webp|jpg)/);
    // El componente resuelve el número de paso y filtra por prefijo.
    expect(js).toMatch(/function guideStepNumber\(/);
    expect(js).toMatch(/stepShots\(stepId\)/);
  });

  it("no hay estilos inline ni colores literales en el HTML", () => {
    // Sin `style="..."` (el sistema de diseño vive en style.css).
    expect(html).not.toMatch(/\sstyle="/);
    // Sin hex/rgb literales.
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b|rgba?\(/);
  });

  it("cada handler de la página está definido en guia.js y las expresiones Alpine invocan métodos", () => {
    for (const match of html.matchAll(/@(?:click|change|input|submit|keydown|keyup)(?:\.\w+)*="([A-Za-z_$][\w$]*)\s*\(/g)) {
      expect(defines(js, match[1]), `guia.js no define ${match[1]}()`).toBe(true);
    }
    // Las expresiones se INVOCAN (con paréntesis), no se pasa la función.
    expect(html).toMatch(/x-show="hasShots\('guia-/);
    expect(html).toMatch(/x-show="lightboxSrc"/);
    for (const name of ["hasShots", "stepShots", "shotUrl", "trapLightboxFocus"]) {
      expect(js, `guia.js no define ${name}()`).toMatch(new RegExp(`\\b${name}\\s*\\(`));
    }
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

  it("las capturas se manejan por la lista pública del servidor y el visor es accesible", () => {
    // El JS pide la lista pública (no una API protegida).
    expect(js).toMatch(/fetch\("\/api\/guide-shots"\)/);
    expect(js).not.toMatch(/\/api\/(?:clips|state|settings|logs|platforms)/);
    // La captura se amplía con un BOTÓN accesible (no con `@click` en la <img>,
    // que no se puede enfocar con el teclado).
    expect(html).toMatch(/<button\s+type="button"\s+class="guide-shot-open"/);
    expect(html).not.toMatch(/<img[^>]*@click=/);
    expect(html).toMatch(/:aria-expanded="lightboxSrc === shotUrl\(name\)/);
    expect(html).toMatch(/aria-label="Ampliar captura: /);
    // Visor: diálogo, se cierra con Esc, clic afuera y botón X; el foco queda adentro.
    expect(html).toMatch(/class="lightbox"[^>]*role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/@keydown\.escape\.stop="closeLightbox\(\)"/);
    expect(html).toMatch(/@keydown\.tab="trapLightboxFocus\(\$event\)"/);
    expect(html).toMatch(/@click="closeLightboxBackdrop\(\$event\)"/);
    expect(html).toMatch(/class="lightbox-close" aria-label="Cerrar captura ampliada"/);
    expect(html).toMatch(/x-effect="if \(lightboxSrc\) focusLightbox\(\)"/);
    expect(js).toMatch(/closeLightbox\s*\(\s*\)/);
    // El visor y la página comparten UN componente: el estado se comparte.
    expect([...html.matchAll(/x-data="guideApp\(\)"/g)].length).toBe(1);
    // Se usa la URL que arma el botón (no `$event.target.src`).
    expect(html).toMatch(/@click="openLightbox\(shotUrl\(name\), '/);
    // Aviso "Copiado" accesible (aria-live).
    expect(html).toMatch(/aria-live="polite"/);
    expect(js).toContain("Copiado");
  });

  it("el paso 3 avisa que se revisen los permisos, con el estilo de atención", () => {
    const step3 = html.slice(html.indexOf('id="guia-paso-3"'), html.indexOf('id="guia-paso-4"'));
    // Agrega el aviso: va DESPUÉS del bloque de capturas y ANTES del pie de paso.
    const shotsAt = step3.indexOf('class="guide-shots"');
    const warnAt = step3.indexOf('<p class="guide-warn attention">');
    const footAt = step3.indexOf('<p class="guide-foot">');
    expect(shotsAt).toBeGreaterThan(-1);
    expect(warnAt).toBeGreaterThan(shotsAt);
    expect(warnAt).toBeLessThan(footAt);
    // Aviso de tipo atención (--color-warn), con ícono SVG y texto (nunca solo color).
    const warnBody = step3.slice(warnAt, step3.indexOf("</p>", warnAt));
    expect(warnBody).toMatch(/<svg class="guide-icon"/);
    expect(warnBody).toMatch(/aria-hidden="true"/);
    expect(css).toMatch(/\.guide-warn\.attention \{[^}]*color: var\(--color-warn\)/);
    expect(css).toMatch(/\.guide-warn\.attention \{[^}]*border-color: var\(--color-warn\)/);
    expect(css).toMatch(/\.guide-warn\.attention \{[^}]*background: var\(--color-warn-bg\)/);
    // Texto pedido (redacción final). No se afirma nada sobre scopes de MÁS.
    const text = warnBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Revisá los permisos:");
    expect(text).toContain("«Scopes solicitadas»");
    expect(text).toContain("los mismos que ves tildados en la captura");
    expect(text).toContain("Si falta alguno, VIUrewards no va a poder funcionar completo.");
    expect(text).not.toMatch(/de más|sobrante|extra/i);
    // Sin colores literales ni estilos inline.
    expect(warnBody).not.toMatch(/\sstyle="|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it("el paso 3 aclara que los webhooks de Kick no se usan (nota info aparte)", () => {
    const step3 = html.slice(html.indexOf('id="guia-paso-3"'), html.indexOf('id="guia-paso-4"'));
    // Es una nota info aparte; cita el texto literal del panel de Kick.
    const infoAt = step3.indexOf('<p class="guide-warn info">');
    expect(infoAt).toBeGreaterThan(step3.indexOf('<p class="guide-warn attention">'));
    const infoBody = step3.slice(infoAt, step3.indexOf("</p>", infoAt));
    expect(infoBody).toContain("«Habilitar webhooks» apagado");
    expect(infoBody).toContain("VIUrewards no los usa");
    // Y el paso sigue cerrando con el pie de foto de siempre.
    expect(step3).toMatch(/<p class="guide-foot">\s*Los nombres exactos de los botones/);
  });

  it("la captura del paso 3 va en un <figure> con alt, pie de foto, radio y borde", () => {
    const step3 = html.slice(html.indexOf('id="guia-paso-3"'), html.indexOf('id="guia-paso-4"'));
    expect(step3).toMatch(/<figure class="guide-shot">/);
    expect(step3).toMatch(/<figcaption>/);
    // Texto exacto pedido para el paso 3.
    expect(step3).toContain(
      'alt="Pantalla “Tu aplicación” de Kick, con el ID del cliente, el Secreto del Cliente, la URL de redirección y los permisos."',
    );
    expect(step3).toContain(
      "Así se ve tu app en kick.com/settings/developer. El ID del cliente y el Secreto son privados: no los",
    );
    expect(step3).toContain("muestres en pantalla.");
    // Se reserva el alto real (1055×1017) para que el layout no salte al cargar.
    expect(step3).toMatch(/width="1055"\s+height="1017"/);
    expect(step3).toMatch(/loading="lazy"/);
    expect(step3).toMatch(/decoding="async"/);
    // El botón de ampliar es accesible y usa el mismo alt.
    expect(step3).toMatch(/aria-label="Ampliar captura: Pantalla “Tu aplicación” de Kick/);
    // Radio y borde por variables (el radio de las capturas es --radius).
    expect(css).toMatch(/\.guide-shot-open \{[^}]*border: 1px solid var\(--color-border\)/);
    expect(css).toMatch(/\.guide-shot-open \{[^}]*border-radius: var\(--radius\)/);
    expect(css).toMatch(/\.guide-shot-open \{[^}]*overflow: hidden/);
    expect(css).toMatch(/\.guide-shot-open \{[^}]*display: block/);
    expect(css).toMatch(/\.guide-shot-open img \{[^}]*max-width: 100%/);
    expect(css).toMatch(/\.guide-shot-open img \{[^}]*height: auto/);
    // El visor limita la imagen al viewport y usa object-fit: contain.
    expect(css).toMatch(/\.lightbox-img \{[^}]*max-width: calc\(100vw - 2rem\)/);
    expect(css).toMatch(/\.lightbox-img \{[^}]*max-height: calc\(100dvh - 4rem\)/);
    expect(css).toMatch(/\.lightbox-img \{[^}]*object-fit: contain/);
  });

  it("el paso 2 pide tildar los tres scopes con el nombre exacto de Kick (Parte 2)", () => {
    const step2 = html.slice(html.indexOf('id="guia-paso-2"'), html.indexOf('id="guia-paso-3"'));
    expect(step2).toContain("Scopes solicitadas");
    expect(step2).toContain("Leer información de usuario (incluyendo la dirección de correo electrónico)");
    expect(step2).toContain("Lee más información sobre los Puntos del Canal en un canal");
    expect(step2).toContain("Lee, agrega, edita y borra las recompensas de los Puntos del Canal de un canal");
    expect(step2).toMatch(/no hace falta\s+ningún otro/);
    // Lo que no está en la documentación de Kick queda como TODO no visible.
    expect(step2).toMatch(/<!-- TODO\(verificar\): /);
    // El paso 5 (pantalla de consentimiento) no cambia sus tres permisos.
    const step5 = html.slice(html.indexOf('id="guia-paso-5"'), html.indexOf('id="guia-paso-6"'));
    expect(step5).toContain("<code>user:read</code>");
    expect(step5).toContain("<code>channel:rewards:read</code>");
    expect(step5).toContain("<code>channel:rewards:write</code>");
  });

  it("el ancla de la URL se respeta después de montar (Parte 3)", () => {
    // El paso se ubica a la vista aunque las capturas cambien la altura al cargar.
    expect(js).toMatch(/scrollToHash\(\)/);
    expect(js).toMatch(/getElementById\(id\)/);
    expect(js).toMatch(/scrollIntoView/);
    // Se llama al final de `init`, tras esperar el render de las capturas.
    const init = js.slice(js.indexOf("async init()"), js.indexOf("scrollToHash() {"));
    expect(init).toMatch(/afterRenderAsync\(/);
    expect(init.indexOf("afterRenderAsync(")).toBeLessThan(init.lastIndexOf("this.scrollToHash();"));
    // Los pasos dejan aire arriba al saltar (`scroll-margin-top`) y la página
    // nunca tiene scroll horizontal.
    expect(css).toMatch(/\.guide-card \{[^}]*scroll-margin-top: var\(--space-4\)/);
  });

  it("el CSS de la guía no usa colores literales y es legible desde 360px", () => {
    const start = css.indexOf(".guide-wrap {");
    expect(start, "no está el CSS de la guía").toBeGreaterThanOrEqual(0);
    const block = css.slice(start, css.indexOf("[x-cloak]", start));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    // Imágenes que no desbordan.
    expect(block).toMatch(/\.guide-shot-open img \{[^}]*max-width: 100%/);
    // La columna de lectura tiene un ancho máximo cómodo.
    expect(css).toMatch(/--guide-width:\s*760px/);
    // Scroll suave solo si el sistema lo permite.
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
  });

  it("\"Volver\" es un enlace con aspecto de botón, flecha SVG y aria-label", () => {
    // Sigue siendo un enlace a "/" y no usa el carácter "←".
    expect(html).toMatch(/<a class="guide-back" href="\/" aria-label="Volver al inicio">/);
    expect(html).not.toContain("←");
    // La flecha es un SVG inline con currentColor (sin imagen externa).
    const back = html.slice(html.indexOf('class="guide-back"'));
    const anchor = back.slice(0, back.indexOf("</a>"));
    expect(anchor).toMatch(/<svg\b/);
    expect(anchor).toMatch(/stroke="currentColor"/);
    expect(anchor).toMatch(/aria-hidden="true"/);
    expect(anchor).toMatch(/width="16" height="16"/);
    // Estilos de botón por variables, sin literales.
    expect(css).toMatch(/\.guide-back \{[^}]*display: inline-flex/);
    expect(css).toMatch(/\.guide-back \{[^}]*min-height: var\(--control-height\)/);
    expect(css).toMatch(/\.guide-back \{[^}]*border: 1px solid var\(--color-border\)/);
    expect(css).toMatch(/\.guide-back \{[^}]*border-radius: var\(--radius\)/);
    expect(css).toMatch(/\.guide-back \{[^}]*background: transparent/);
    expect(css).toMatch(/\.guide-back \{[^}]*color: var\(--color-text\)/);
    expect(css).toMatch(/\.guide-back \{[^}]*text-decoration: none/);
    expect(css).toMatch(/\.guide-back:hover,\s*\n\.guide-back:focus-visible \{[^}]*border-color: var\(--color-accent\)/);
    expect(css).toMatch(/\.guide-back:focus-visible \{[^}]*background: var\(--color-accent-soft\)/);
    // La flecha no usa position absolute ni márgenes sueltos.
    expect(css).toMatch(/\.guide-back-icon \{[^}]*display: block/);
    expect(css).toMatch(/\.guide-back-icon \{[^}]*flex: none/);
  });

  it("las entradas del índice son botones dentro del <nav> y de una lista ordenada", () => {
    const nav = html.slice(html.indexOf('<nav class="guide-index"'));
    const navBody = nav.slice(0, nav.indexOf("</nav>"));
    expect(navBody).toMatch(/<ol class="guide-index-list">/);
    // Todas las entradas del índice son enlaces con la clase de botón.
    const links = [...navBody.matchAll(/<a class="guide-index-link" href="#([\w-]+)">/g)].map((m) => m[1]);
    expect(links.length).toBe(7);
    for (const id of links) {
      expect(html, `falta el id #${id}`).toMatch(new RegExp(`id="${id}"`));
    }
    // El título de la sección queda como encabezado y el nav lo referencia.
    expect(navBody).toMatch(/<h2 id="guia-indice-titulo">PASOS<\/h2>/);
    expect(html).toMatch(/<nav class="guide-index"[^>]*aria-labelledby="guia-indice-titulo"/);
    // Círculo numerado con acento y tinta del acento (y la variante de ayuda).
    expect(css).toMatch(/\.guide-index-badge \{[^}]*background: var\(--color-accent\)/);
    expect(css).toMatch(/\.guide-index-badge \{[^}]*color: var\(--color-accent-ink\)/);
    expect(navBody).toMatch(/guide-index-badge guide-index-badge--help/);
    // La entrada se ve como botón: borde, radio y superficie del tema.
    expect(css).toMatch(/\.guide-index-link \{[^}]*display: flex/);
    expect(css).toMatch(/\.guide-index-link \{[^}]*border: 1px solid var\(--color-border\)/);
    expect(css).toMatch(/\.guide-index-link \{[^}]*border-radius: var\(--radius\)/);
    expect(css).toMatch(/\.guide-index-link \{[^}]*color: var\(--color-text\)/);
    expect(css).toMatch(/\.guide-index-link \{[^}]*text-decoration: none/);
    expect(css).toMatch(/\.guide-index-link \{[^}]*height: 100%/);
    // Una columna por defecto y dos desde 700 px (misma altura en la fila).
    expect(css).toMatch(/@media \(min-width: 700px\) \{\s*\.guide-index-list \{[^}]*grid-template-columns: repeat\(2/);
    expect(css).toMatch(/\.guide-index-list \{[^}]*display: grid/);
    // Transición corta, anulada con prefers-reduced-motion.
    expect(css).toMatch(/\.guide-index-link \{[^}]*transition: border-color/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.guide-back,\s*\n  \.guide-index-link,\s*\n  \.guide-shot-open \{\s*\n    transition: none/,
    );
  });

  it("el índice y \"Volver\" no usan estilos inline y el orden de scripts no cambia", () => {
    const nav = html.slice(html.indexOf('<nav class="guide-index"'));
    const navBody = nav.slice(0, nav.indexOf("</nav>"));
    expect(navBody).not.toMatch(/\sstyle="|#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(html.slice(html.indexOf('class="guide-back"') - 20)).not.toMatch(/^[^>]*style="/);
    // Los scripts siguen en el mismo orden: theme.js en el head, después los
    // componentes y Alpine al final.
    const themeAt = html.indexOf("<script src=\"/web/theme.js\"></script>");
    const logoAt = html.indexOf("/web/logo.js");
    const guiaAt = html.indexOf("/web/guia.js");
    const alpineAt = html.indexOf("/web/alpine.min.js");
    expect(themeAt).toBeGreaterThan(-1);
    expect(themeAt).toBeLessThan(logoAt);
    expect(logoAt).toBeLessThan(guiaAt);
    expect(guiaAt).toBeLessThan(alpineAt);
  });
});
