/**
 * Verificación estática de la UI (Fase 4B).
 *
 * Sin navegador no se puede probar el dashboard de verdad: acá comprobamos
 * leyendo los archivos que:
 * (a) cada handler `@click` que usa el HTML está definido en el JS del
 *     componente (regresión del bug clásico "X is not a function", que apareció
 *     al dejar métodos referenciados pero sin definir);
 * (b) la sección Plataformas existe con la gestión de recompensas;
 * (c) no hay material sensible (tokens de OAuth) en los assets del frontend.
 *
 * No reemplaza una prueba real de navegador: ver docs/dashboard.md.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));
const overlayDir = fileURLToPath(new URL("../../overlay", import.meta.url));

function read(file: string): string {
  return readFileSync(join(webDir, file), "utf8");
}

/** Identificadores de las funciones invocadas en `@click="name(...)"` / `@change="name(...)"`. */
function handlerCalls(html: string): string[] {
  return [...html.matchAll(/@(?:click|change)="([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
}

/** ¿El JS define `name(...)` como método (no como `this.name(...)`)? */
function defines(js: string, name: string): boolean {
  return new RegExp(`\\n\\s*(?:async\\s+)?${name}\\s*\\(`).test(js);
}

/**
 * Nombres de los MÉTODOS definidos en el objeto Alpine (no los `get`). Se
 * obtienen de las claves seguidas de `(` en app.js, excluyendo `get nombre`.
 */
function methodNames(js: string): string[] {
  const names = new Set<string>();
  // Métodos: `nombre(` al inicio de una línea (indentados), sin `async`/`get`.
  for (const match of js.matchAll(/^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Encuentra usos de un método de app.js SIN paréntesis de llamada en los
 * atributos de Alpine (`x-*`, `:*`, `@*`) de index.html.
 *
 * Límite: es un análisis de tokens por regex, no un parser de expresiones
 * Alpine. Detecta `nombre` seguido de algo que no sea `(` (p. ej. fin de
 * expresión, operador o `}}`), que es exactamente el bug real (la función se
 * convierte a texto). No analiza métodos invocados a través de `$el`, llamadas
 * con espacios raros ni métodos usados como referencia deliberada (p. ej.
 * pasados a otra función); en la práctica la UI no hace eso.
 */
function methodRefsWithoutCall(html: string, methods: string[]): string[] {
  const problems = new Set<string>();
  // Atributos de Alpine: nombre="..." (incluye x-*, :*, @*, x-effect, x-show...).
  const attrRe = /(?:^|\s)(?:x-[\w.:-]+|:[\w.:-]+|@[\w.:-]+)\s*=\s*"([^"]*)"/g;
  let attr: RegExpExecArray | null;
  while ((attr = attrRe.exec(html)) !== null) {
    const expr = attr[1];
    for (const name of methods) {
      // `nombre` NO seguido de `(` (permitiendo espacios) y no parte de otro id.
      const re = new RegExp(`(^|[^\\w$])${name}(?!\\w)(?!\\s*\\()`);
      if (re.test(expr)) problems.add(name);
    }
  }
  return [...problems];
}

/**
 * Estado que arranca en `null` (o puede serlo) y cuyas propiedades NO se deben
 * leer fuera de un `<template x-if="...">`. Con `x-show` el subárbol sigue en el
 * DOM y Alpine evalúa igual sus expresiones, así que `rewardForm.algo` con
 * `rewardForm === null` rompe la consola (bug real de la Etapa 4B).
 */
const NULLABLE_STATE = [
  "rewardForm",
  "rewardDelete",
  "rewardPending",
  "diagnostics",
  "activePlatform",
  "settingsCloseConfirm",
];

/**
 * Recorre el HTML manteniendo una pila de `<template>` y anota los accesos
 * `variable.propiedad` que no están dentro de un `<template x-if>` que garantice
 * que esa variable no es null.
 */
function unguardedPropertyReads(html: string, vars: string[]): string[] {
  const tokenRe = /<template\b[^>]*>|<\/template>|\b([A-Za-z_$][\w$]*)\./g;
  const guards: (string | null)[] = [];
  const problems: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    const token = match[0];
    if (token === "</template>") {
      guards.pop();
      continue;
    }
    if (token.startsWith("<template")) {
      const guard = /x-if="\s*([A-Za-z_$][\w$]*)/.exec(token);
      guards.push(guard ? guard[1] : null);
      continue;
    }
    const name = match[1];
    if (vars.includes(name) && !guards.includes(name)) problems.push(name);
  }
  return problems;
}

describe("UI del dashboard (plataformas)", () => {
  const html = read("index.html");
  const app = read("app.js");

  it("cada handler @click/@change del dashboard está definido en app.js", () => {
    const names = new Set(handlerCalls(html));
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(defines(app, name), `app.js no define ${name}()`).toBe(true);
    }
  });

  it("login.html: cada handler @submit está definido en login.js", () => {
    const loginHtml = read("login.html");
    const loginJs = read("login.js");
    const names = [...loginHtml.matchAll(/@submit(?:\.\w+)?="([A-Za-z_$][\w$]*)\s*\(/g)].map(
      (match) => match[1],
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of new Set(names)) {
      expect(defines(loginJs, name), `login.js no define ${name}()`).toBe(true);
    }
  });

  it("incluye la sección Plataformas con gestión de recompensas", () => {
    expect(html).toContain("Plataformas");
    expect(html).toContain("Recompensas del canal");
    expect(html).toContain("Vincular cuenta");
    expect(html).toContain("Diagnóstico");
    // La URL del overlay se muestra enmascarada por defecto.
    expect(app).toContain("maskedOverlayUrl");
  });

  it("la interfaz de recompensas no expone la palabra 'regla'", () => {
    // El creador nunca ve la regla interna 1:1 de cada recompensa.
    expect(html).not.toMatch(/regla/i);
    expect(html).not.toContain("URL del espectador");
    // La ventana de crear/editar recompensa y su interruptor accesible.
    expect(html).toContain("Nueva recompensa");
    expect(html).toMatch(/role="switch"/);
    expect(html).toContain("Opciones avanzadas");
  });

  it("no quedó el 'Cooldown por usuario' ni en la vista ni en el JS", () => {
    expect(html).not.toMatch(/cooldown por usuario/i);
    expect(app).not.toContain("userCooldownSec");
    // El modo de repetición (queue/overlap) sí está en el formulario.
    expect(app).toContain("repetition");
    expect(html).toContain("Repetición");
  });

  it("no expone tokens de OAuth en los assets del frontend", () => {
    for (const asset of [html, app, read("login.js")]) {
      expect(asset).not.toMatch(/access_token|refresh_token|client_secret/i);
    }
  });

  it("no lee estado nullable fuera de un <template x-if>", () => {
    // El bug de la Etapa 4B fue leer `rewardForm.clipId` bajo un x-show.
    expect(html).toMatch(/<template x-if="rewardForm">/);
    expect(html).toMatch(/<template x-if="rewardDelete">/);
    expect(html).toMatch(/<template x-if="rewardPending">/);
    expect(unguardedPropertyReads(html, NULLABLE_STATE)).toEqual([]);
  });

  it("el detector de accesos nullable no es vacuo", () => {
    const unguarded = `<div x-show="rewardForm"><span x-text="rewardForm.clipId"></span></div>`;
    expect(unguardedPropertyReads(unguarded, ["rewardForm"])).toEqual(["rewardForm"]);
    const guarded = `<template x-if="rewardForm"><span x-text="rewardForm.clipId"></span></template>`;
    expect(unguardedPropertyReads(guarded, ["rewardForm"])).toEqual([]);
  });

  it("Apariencia permite elegir el modo del logo (Automático/Dinámico/Estático)", () => {
    expect(html).toContain("Apariencia");
    expect(html).toContain("Automático");
    expect(html).toContain("Dinámico");
    expect(html).toContain("Estático");
    expect(defines(app, "setLogoMode"), "app.js no define setLogoMode()").toBe(true);
    expect(app).toContain("logoMode");
  });

  it("el logo tiene los tres modos y guarda la preferencia en localStorage", () => {
    const logo = read("logo.js");
    expect(logo).toContain('"auto"');
    expect(logo).toContain('"dynamic"');
    expect(logo).toContain('"static"');
    expect(logo).toContain("viurewards.logoMode");
    expect(logo).toContain("localStorage");
    // Rutas locales de /web (nunca un CDN).
    expect(logo).toContain("/web/assets/VIUrewards-dark.png");
    expect(logo).toContain("/web/assets/VIUrewards-dark.webp");
    // Duración del ciclo del WebP, medida del archivo (69 cuadros, 5.040 s).
    expect(logo).toContain("VIU_LOGO_CYCLE_MS = 5040");
  });

  it("los estilos del logo y de Apariencia no usan colores literales", () => {
    const css = read("style.css");
    const blocks =
      css.match(/\.(?:brand-logo|brand-text|option-list|option|option-text)\b[^{]*\{[^}]*\}/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("el scroll es fino y oscuro con variables y respaldo dentro de @supports not", () => {
    const css = read("style.css");
    // Variables del scroll en :root (sin colores literales en las reglas).
    expect(css).toMatch(/--scrollbar-thumb:/);
    expect(css).toMatch(/--scrollbar-thumb-hover:/);
    expect(css).toMatch(/--scrollbar-track:/);
    // Propiedades estándar con variables.
    expect(css).toMatch(/scrollbar-width:\s*thin/);
    expect(css).toMatch(/scrollbar-color:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-track\)/);
    // color-scheme oscuro para los controles nativos.
    expect(css).toMatch(/color-scheme:\s*dark/);
    // El respaldo ::-webkit-scrollbar va DENTRO de @supports not (anula las
    // estándar en Chromium reciente si queda afuera).
    const supportsIndex = css.indexOf("@supports not (scrollbar-color: auto)");
    expect(supportsIndex).toBeGreaterThan(-1);
    const webkitRuleIndex = css.indexOf("::-webkit-scrollbar {");
    expect(webkitRuleIndex).toBeGreaterThan(supportsIndex);
    // No hay reglas ::-webkit-scrollbar (con llave) fuera del bloque.
    const beforeSupports = css.slice(0, supportsIndex);
    expect(beforeSupports).not.toMatch(/::-webkit-scrollbar\s*\{/);
  });

  it("los estilos de scroll no escriben colores literales en las reglas", () => {
    const css = read("style.css");
    const thumbRule =
      css.match(/::-webkit-scrollbar-thumb\s*\{[^}]*\}/)?.[0] ?? "";
    expect(thumbRule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(thumbRule).toMatch(/var\(--scrollbar-thumb\)/);
  });

  it("el overlay llena el viewport con object-fit: contain y barras transparentes", () => {
    const overlay = readFileSync(join(overlayDir, "index.html"), "utf8");
    expect(overlay).toMatch(/object-fit:\s*contain/);
    expect(overlay).toMatch(/#clip\s*\{[^}]*width:\s*100%/s);
    expect(overlay).toMatch(/#clip\s*\{[^}]*height:\s*100%/s);
    expect(overlay).toMatch(/#clip\s*\{[^}]*background:\s*transparent/s);
    // La posición X/Y ya no se aplica en el overlay (queda reservada).
    expect(overlay).not.toMatch(/anchor\.style\.left/);
  });

  it("el overlay usa la URL del mensaje (resuelve mp4 o m4a) en vez de fijar .mp4", () => {
    const overlay = readFileSync(join(overlayDir, "index.html"), "utf8");
    // La reproducción pasa la URL explícita del servidor (play y state); el
    // overlay nunca la arma ni fija una extensión.
    expect(overlay).toMatch(/play\(message\.item,\s*message\.url\)/);
    expect(overlay).toMatch(/play\(st\.current,\s*message\.url\)/);
    expect(overlay).toMatch(/function mediaUrl\(explicitUrl\)/);
    expect(overlay).not.toMatch(/\.mp4"/);
  });

  it("el panel Descargas quitar/limpiar usa el servidor y un contador de secuencia", () => {
    // Bug: "Quitar" y "Limpiar terminados" solo filtraban la lista en el
    // navegador y el polling de 1 s la reponía. Ahora son operaciones del
    // servidor y las respuestas viejas del polling se descartan con jobsSeq.
    expect(app).toContain("jobsAppliedSeq");
    expect(app).toMatch(/DELETE/);
    expect(app).toContain("/api/jobs/clear-finished");
    expect(app).toMatch(/async removeJob\b/);
    expect(app).toMatch(/async clearFinishedJobs\b/);
    expect(app).toContain("applyJobsResult");
  });

  it("la cola de subidas en espera arranca sola (no pide subir luego)", () => {
    expect(app).toContain("En cola: empieza cuando termine otra tarea");
    expect(app).not.toContain("esperá a que terminen");
    expect(app).toMatch(/pumpUploadQueue/);
    expect(app).toContain("UPLOAD_MAX_CONCURRENT");
  });

  it("el desplegable de clip del modal reafirma su valor tras renderizar las opciones", () => {
    // Regresión: con solo x-model el valor se aplicaba antes de que existieran
    // los <option> de x-for y al editar caía en "Elegí un clip".
    expect(html).toMatch(/<select[^>]*x-model="rewardForm\.clipId"[^>]*x-effect=/s);
    expect(html).toMatch(/x-effect="[^"]*rewardForm\.clipId/);
  });

  it("el cuadradito de color de la tarjeta usa change (no input) y una sola solicitud", () => {
    // La tarjeta comparte su markup (rewardCardHtml): el input de color usa
    // data-action="color-input" y el change se atiende por delegación (no por
    // input, que se dispara mientras se arrastra).
    expect(app).toMatch(/data-action="color-input"/);
    expect(app).toMatch(/onRewardCardChange\(reward, event\)/);
    expect(app).not.toMatch(/addEventListener\(["']input["']/);
    expect(app).toContain("rewardColorSaving");
    // Botón accesible con aria-label "Cambiar color".
    expect(app).toContain('aria-label="Cambiar color"');
    expect(defines(app, "openRewardColor"), "app.js no define openRewardColor()").toBe(true);
    expect(defines(app, "applyRewardColor"), "app.js no define applyRewardColor()").toBe(true);
  });

  it("la tarjeta no muestra 'Clip no disponible' para las recompensas de otra app", () => {
    // rewardClipLabel solo devuelve ese texto si hay clipId (recompensa propia).
    expect(app).toMatch(/if \(!reward\.clipId\) return "";/);
  });

  // --- Sección 2: "Solo audio" por recompensa -------------------------------

  it("la biblioteca ya no tiene el interruptor 'Solo audio' del clip", () => {
    // "Solo audio" pasó de ser marca del clip a opción de cada recompensa.
    const library = html.slice(html.indexOf("Biblioteca"));
    expect(library).not.toContain("toggleClipAudioOnly");
    expect(app).not.toContain("toggleClipAudioOnly");
    // La marca del clip ya no existe: el modelo expone hasVideo.
    expect(app).not.toContain("clip.audioOnly");
  });

  it("las opciones avanzadas de la recompensa siguen el orden acordado", () => {
    const start = html.indexOf("rewardAdvancedOpen");
    const block = html.slice(start, html.indexOf("</template>", html.indexOf("Animación de salida")));
    const order = ["Repetición", "Solo audio", "Volumen", "Duración máxima", "Cooldown global", "Animación de entrada"];
    let last = -1;
    for (const label of order) {
      const index = block.indexOf(label);
      expect(index, `falta "${label}" en las opciones avanzadas`).toBeGreaterThan(-1);
      expect(index, `"${label}" quedó fuera de orden`).toBeGreaterThan(last);
      last = index;
    }
    // El cooldown se oculta en Superponer.
    expect(block).toMatch(/x-show="rewardForm\.repetition !== 'overlap'"/);
  });

  it("la posición X/Y no se muestra en la interfaz (queda reservada)", () => {
    expect(html).not.toMatch(/[Pp]osición\s*[XY]/);
    expect(html).not.toContain("positionX");
    expect(html).not.toContain("positionY");
    expect(app).not.toContain("positionX");
    expect(app).not.toContain("positionY");
  });

  it("la recompensa tiene la opción 'solo audio' en el formulario y en el modelo", () => {
    expect(app).toContain("audioOnly");
    // Superponer fuerza y bloquea "solo audio".
    expect(app).toContain("rewardAudioOnlyLocked");
    expect(app).toContain("syncRewardAudioOnly");
    // El parlante de la tarjeta se dibuja en el markup compartido.
    expect(app).toMatch(/reward\.audioOnly/);
  });

  // --- Correcciones de la UI (revisión en el navegador) ---------------------

  it("ninguna expresión Alpine usa un método de app.js sin invocarlo", () => {
    // Bug real: `x-text="'X' + rewardAudioOnlyHint"` (sin paréntesis) imprime el
    // código de la función en pantalla. Los getters de app.js se usan SIN
    // paréntesis, por eso el detector solo mira los métodos (los `get`).
    const methods = methodNames(app);
    expect(methods.length).toBeGreaterThan(20);
    // Control: el detector marca el bug si aparece.
    expect(
      methodRefsWithoutCall('<span x-text="\'X\' + rewardAudioOnlyHint"></span>', ["rewardAudioOnlyHint"]),
    ).toEqual(["rewardAudioOnlyHint"]);
    // Y no marca la llamada correcta ni el uso de un getter (los `get` no están
    // en la lista de métodos, así que no se analizan).
    expect(
      methodRefsWithoutCall('<span x-text="rewardAudioOnlyHint()"></span>', ["rewardAudioOnlyHint"]),
    ).toEqual([]);
    expect(methods).not.toContain("rewardAudioOnlyLocked");
    expect(methods).toContain("rewardAudioOnlyHint");
    expect(methodRefsWithoutCall(html, methods)).toEqual([]);
  });

  it("el markup de la tarjeta de recompensa se define una sola vez y lo usan los dos lugares", () => {
    // Una sola definición (rewardCardHtml en app.js) y dos contenedores (panel
    // vertical y ventana grande) que la pintan con x-html.
    expect(defines(app, "rewardCardHtml")).toBe(true);
    const uses = [...html.matchAll(/x-html="rewardCardHtml\(reward/g)];
    expect(uses.length).toBe(2);
    // El markup viejo (clases de tarjeta) ya no está duplicado en index.html.
    expect(html).not.toMatch(/class="reward-card-top"/);
    expect(html).not.toMatch(/class="reward-card-bottom"/);
    expect(html).not.toMatch(/class="reward-name"/);
  });

  it("la ventana grande de recompensas tiene el marco y la accesibilidad pedidos", () => {
    expect(html).toMatch(/<template x-if="rewardsWindowOpen">/);
    expect(html).toMatch(/class="modal-window rewards-window"/);
    expect(html).toMatch(/role="dialog"[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="rewards-window-title"/);
    expect(html).toContain('id="rewards-window-title"');
    expect(html).toMatch(/@keydown\.tab="trapRewardsWindowFocus\(\$event\)"/);
    expect(defines(app, "trapRewardsWindowFocus")).toBe(true);
    expect(defines(app, "closeRewardsWindowBackdrop")).toBe(true);
    // Estado vacío y grilla.
    expect(html).toContain("Todavía no creaste ninguna");
    expect(html).toMatch(/class="reward-grid"/);
  });

  it("la grilla y el panel comparten el ancho de tarjeta por variable CSS", () => {
    const css = read("style.css");
    expect(css).toMatch(/--reward-card-width:/);
    expect(css).toMatch(/\.reward-grid\s*\{[^}]*repeat\(auto-fill, var\(--reward-card-width\)\)/s);
    expect(css).toMatch(/\.reward-grid\s*\{[^}]*justify-content:\s*start/s);
    expect(css).toMatch(/\.reward-grid\s*\{[^}]*gap:\s*var\(--space-4\)/s);
    expect(css).toMatch(/\.reward-list \.reward-card,[\s\S]*\.reward-grid \.reward-card\s*\{[^}]*width:\s*var\(--reward-card-width\)/s);
  });

  it("la ventana grande define su tamaño una sola vez por variable (gana la cascada)", () => {
    // Causa real del bug: `.modal-window` (posterior en el archivo, misma
    // especificidad) fijaba width/height y ganaba. Ahora `.modal-window` usa
    // variables y `.rewards-window` solo las sobreescribe.
    const css = read("style.css");
    // La base usa las variables.
    expect(css).toMatch(/\.modal-window\s*\{[^}]*width:\s*var\(--modal-width/s);
    expect(css).toMatch(/\.modal-window\s*\{[^}]*height:\s*var\(--modal-height/s);
    // `.rewards-window` NO fija width/height ni max-width/max-height: solo variables.
    // En pantallas anchas ocupa el 90 % del espacio disponible.
    const rule = css.match(/\.rewards-window\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/--modal-width:\s*calc\(\(100vw - 3rem\) \* 0\.9\)/);
    expect(rule).toMatch(/--modal-height:\s*calc\(\(100vh - 3rem\) \* 0\.9\)/);
    expect(rule).not.toMatch(/^\s*width:/m);
    expect(rule).not.toMatch(/^\s*height:/m);
    expect(rule).not.toMatch(/max-width|max-height/);
    // Solo una regla define el ancho de esta ventana en el archivo.
    const windowRules = [...css.matchAll(/\.modal-window\.rewards-window|\.rewards-window\s*\{/g)];
    expect(windowRules.length).toBe(2); // la base + la del media query angosto
    // Sin tamaño fijo en px (1200px/800px serían la regresión).
    expect(css).not.toMatch(/\.rewards-window[^}]*\b(1200|800)px/);
    // Sin estilo inline en el elemento del diálogo.
    const dialogTag = html.match(/class="modal-window rewards-window"[^>]*>/)?.[0] ?? "";
    expect(dialogTag).not.toMatch(/style=/);
    // El media query angosto también usa variables (margen de 1rem).
    expect(css).toMatch(/@media[^{]*1024px[\s\S]*\.rewards-window\s*\{[^}]*--modal-width:\s*calc\(100vw - 2rem\)/);
    expect(css).toMatch(/@media[^{]*1024px[\s\S]*\.rewards-window\s*\{[^}]*--modal-height:\s*calc\(100vh - 2rem\)/);
  });

  it("el markup de la tarjeta es idéntico en las dos vistas (sin parámetro extra)", () => {
    // rewardCardHtml tiene una única firma de un parámetro: el markup no cambia
    // entre el panel vertical y la ventana (nada de líneas extra que alteren la
    // altura de la tarjeta).
    expect(app).toMatch(/rewardCardHtml\(reward\)\s*\{/);
    expect(app).not.toContain("showNoDate");
    expect(app).not.toMatch(/sin fecha<\/span>/);
    // Las dos vistas invocan con el mismo argumento.
    const uses = [...html.matchAll(/x-html="rewardCardHtml\(([^)]*)\)"/g)].map((m) => m[1]);
    expect(uses).toEqual(["reward", "reward"]);
  });

  it("el control de orden de la ventana reutiliza la estética del selector de la biblioteca", () => {
    // El disparador y el botón de dirección usan la clase base `.segmented`
    // (mismo borde, fondo, radios, padding y activo/hover), sin estilos nuevos.
    expect(html).toMatch(/class="segmented rewards-sort-trigger"/);
    expect(html).toMatch(/class="segmented rewards-sort-dir"/);
    // El desplegable ofrece los dos criterios.
    expect(html).toMatch(/role="listbox"[^>]*aria-label="Ordenar por"/s);
    expect(defines(app, "rewardSortLabel")).toBe(true);
    expect(app).toMatch(/Fecha añadida/);
    expect(app).toMatch(/Puntos/);
    // Dirección con aria-label y estado claro.
    expect(html).toMatch(/:aria-label="rewardsSortDirectionLabel"/);
    expect(defines(app, "toggleRewardsSortDirection")).toBe(true);
    expect(app).toMatch(/get rewardsSortDirectionLabel\(\)/);
    // El desplegable es accesible (aria-expanded, listbox/option, aria-selected).
    expect(html).toMatch(/:aria-expanded="rewardsSortOpen \? 'true' : 'false'"/);
    expect(html).toMatch(/role="option"/);
    expect(html).toMatch(/:aria-selected="rewardsSort\.field === field/);
  });

  it("la estética del control de orden: altura compartida y chevron centrado", () => {
    const css = read("style.css");
    // Altura común por variable, compartida por disparador, dirección y el
    // selector de la biblioteca (no se inventa otro valor).
    expect(css).toMatch(/--control-height:/);
    const trigger = css.match(/\.rewards-sort-trigger\s*\{[^}]*\}/)?.[0] ?? "";
    expect(trigger).toMatch(/min-height:\s*var\(--control-height\)/);
    expect(trigger).toMatch(/display:\s*inline-flex/);
    expect(trigger).toMatch(/align-items:\s*center/);
    expect(trigger).toMatch(/gap:\s*var\(--space-2\)/);
    expect(trigger).toMatch(/padding-inline:\s*var\(--space-3\)/);
    expect(trigger).toMatch(/white-space:\s*nowrap/);
    const dir = css.match(/\.rewards-sort-dir\s*\{[^}]*\}/)?.[0] ?? "";
    expect(dir).toMatch(/min-height:\s*var\(--control-height\)|height:\s*var\(--control-height\)/);
    // El chevron está centrado por el flex; NO usa position: absolute.
    const chevron = css.match(/\.rewards-sort-chevron\s*\{[^}]*\}/)?.[0] ?? "";
    expect(chevron).toMatch(/flex:\s*0 0 auto/);
    expect(chevron).toMatch(/display:\s*block/);
    expect(chevron).not.toMatch(/position:\s*absolute/);
    // Gira al abrir; con reduced-motion no hay transición.
    expect(css).toMatch(/\.rewards-sort-trigger\[aria-expanded="true"\][^}]*rotate\(180deg\)/);
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*\.rewards-sort-chevron\s*\{[^}]*transition:\s*none/);
    // El texto secundario y el valor primario.
    expect(html).toMatch(/class="rewards-sort-caption"/);
    expect(html).toMatch(/class="rewards-sort-value"/);
    // La lista: alineada a la derecha del disparador, ítems con padding e izquierda.
    const menu = css.match(/\.rewards-sort-menu\s*\{[^}]*\}/)?.[0] ?? "";
    expect(menu).toMatch(/right:\s*0/);
    expect(menu).toMatch(/min-width:\s*100%/);
    const option = css.match(/\.rewards-sort-option\s*\{[^}]*\}/)?.[0] ?? "";
    expect(option).toMatch(/padding:\s*var\(--space-2\) var\(--space-3\)/);
    expect(option).toMatch(/text-align:\s*left/);
  });

  it("el botón de dirección es un flex centrado con el SVG como bloque", () => {
    const css = read("style.css");
    // Causa real del descentrado: `.segmented button` no fija display, así que el
    // botón era de bloque y el SVG inline quedaba sobre la línea base (arriba).
    const dir = css.match(/\.rewards-sort-dir\s*\{[^}]*\}/)?.[0] ?? "";
    expect(dir).toMatch(/display:\s*inline-flex/);
    expect(dir).toMatch(/align-items:\s*center/);
    expect(dir).toMatch(/justify-content:\s*center/);
    expect(dir).toMatch(/padding:\s*0/);
    expect(dir).toMatch(/width:\s*var\(--control-height\)/);
    expect(dir).toMatch(/height:\s*var\(--control-height\)/);
    expect(dir).toMatch(/line-height:\s*1/);
    // El SVG del botón es bloque, sin desplazamientos.
    const svgRule = css.match(/\.rewards-sort-dir svg\s*\{[^}]*\}/)?.[0] ?? "";
    expect(svgRule).toMatch(/display:\s*block/);
    expect(svgRule).not.toMatch(/position:\s*absolute/);
    expect(svgRule).not.toMatch(/transform:/);
    expect(svgRule).toMatch(/margin:\s*0\s*;/);
    // El SVG del chevron también es bloque.
    const chevron = css.match(/\.rewards-sort-chevron\s*\{[^}]*\}/)?.[0] ?? "";
    expect(chevron).toMatch(/display:\s*block/);
  });

  it("las flechas del botón de dirección están centradas en su viewBox", () => {
    // Verifica que los paths de cada flecha tengan una caja centrada en el
    // viewBox 0 0 24 24 (centro 12,12) con tolerancia. Límite: se evalúan los
    // extremos declarados en los `d` (M/L/l/v/h absolutos y relativos simples);
    // no es un cálculo geométrico completo de curvas.
    const svgs = [...html.matchAll(/<svg[^>]*x-show="rewardsSort\.direction === '(asc|desc)'"[\s\S]*?<\/svg>/g)];
    expect(svgs.length).toBe(2);
    for (const match of svgs) {
      const block = match[0];
      const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(block);
      expect(viewBox).not.toBeNull();
      const [, vbW, vbH] = viewBox as RegExpExecArray;
      const cx = Number(vbW) / 2;
      const cy = Number(vbH) / 2;
      // Extremos nominales de las flechas (línea + punta en el viewBox 0 0 24 24).
      const xs: number[] = [];
      const ys: number[] = [];
      const dAttrs = [...block.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
      for (const d of dAttrs) {
        if (d === "M12 19V5" || d === "M12 5v14") {
          xs.push(12);
          ys.push(5, 19);
        } else if (d === "M5 12l7-7 7 7" || d === "M19 12l-7 7-7-7") {
          xs.push(5, 19);
          ys.push(12, 7, 19);
        }
      }
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      expect(Math.abs((minX + maxX) / 2 - cx)).toBeLessThanOrEqual(1);
      expect(Math.abs((minY + maxY) / 2 - cy)).toBeLessThanOrEqual(1);
    }
  });

  it("el control de orden se guarda en localStorage y la ventana ordena solo a ella", () => {
    expect(app).toContain("viurewards.rewardsSort");
    expect(app).toMatch(/get sortedRewardsForWindow\(\)/);
    expect(defines(app, "selectRewardsSort")).toBe(true);
    // La ventana usa la lista ordenada; el panel vertical usa `rewards` directo.
    expect(html).toMatch(/x-for="reward in sortedRewardsForWindow"/);
    expect(html).toMatch(/x-for="reward in rewards"/);
  });

  it("la fila inferior de la tarjeta tiene botones e interruptor en el mismo contenedor", () => {
    // El markup compartido arma un solo `.reward-card-bottom` con las acciones y
    // el switch dentro; el estilo los separa a los extremos (space-between).
    expect(app).toContain('class="reward-card-bottom"');
    expect(app).toContain('class="reward-card-actions"');
    const block = app.slice(app.indexOf('class="reward-card-bottom"'));
    const end = block.indexOf("data-action=\"toggle\"");
    const row = block.slice(0, end);
    expect(row).toContain('data-action="edit"');
    expect(row).toContain('data-action="delete"');
    expect(block).toMatch(/role=\"switch\"/);
    const css = read("style.css");
    const rule = css.match(/\.reward-card-bottom\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/justify-content:\s*space-between/);
  });

  it("la etiqueta de estado no comparte fila con los botones ni con el interruptor", () => {
    // La tarjeta pone la etiqueta en su propia línea (`.reward-card-state`), que
    // se cierra antes de la fila inferior.
    expect(app).toContain('class="reward-card-state"');
    const block = app.slice(app.indexOf('class="reward-card-state"'));
    const stateEnd = block.indexOf("</div>");
    const stateLine = block.slice(0, stateEnd);
    expect(stateLine).toContain("rewardStateLabel");
    expect(stateLine).not.toContain('data-action="toggle"');
    // La fila inferior (actions + switch) aparece después, en su propio bloque.
    const bottom = app.slice(app.indexOf('class="reward-card-bottom"'));
    const row = bottom.slice(0, bottom.indexOf("data-action=\"toggle\""));
    expect(row).not.toContain("rewardStateLabel");
  });

  it("la fila de acciones está anclada abajo y el texto de ayuda va arriba", () => {
    // La tarjeta es flex en columna y se estira a su celda; el pie (separador +
    // fila de acciones) se empuja abajo con `margin-top: auto`.
    const css = read("style.css");
    const card =
      [...css.matchAll(/\.reward-card\s*\{[^}]*\}/g)].map((m) => m[0]).find((r) => r.includes("flex-direction")) ?? "";
    expect(card).toMatch(/display:\s*flex/);
    expect(card).toMatch(/flex-direction:\s*column/);
    expect(card).toMatch(/height:\s*100%/);
    const foot = css.match(/\.reward-card-foot\s*\{[^}]*\}/)?.[0] ?? "";
    expect(foot).toMatch(/margin-top:\s*auto/);
    // El markup del pie (separador + fila) está definido una sola vez.
    expect([...app.matchAll(/class="reward-card-foot"/g)].length).toBe(1);
    expect([...app.matchAll(/class="reward-card-bottom"/g)].length).toBe(1);
    expect(app).toMatch(/data-action="toggle"/);
    // En el markup, el texto de ayuda (foreign / sin sincronizar / apply_failed)
    // aparece ANTES del pie y de la fila de acciones.
    const iHint = app.indexOf("La creó otra aplicación");
    const iFoot = app.indexOf('class="reward-card-foot"');
    const iBottom = app.indexOf('class="reward-card-bottom"');
    expect(iHint).toBeGreaterThan(0);
    expect(iHint).toBeLessThan(iFoot);
    expect(iFoot).toBeLessThan(iBottom);
    // El separador va dentro del pie, antes de la fila de acciones.
    const sepIdx = app.indexOf('class="reward-card-sep"');
    expect(sepIdx).toBeGreaterThan(iFoot);
    expect(sepIdx).toBeLessThan(iBottom);
  });

  it("la ventana de recompensa usa una sola columna y los tokens de espaciado", () => {
    const css = read("style.css");
    // Ancho pedido y cuerpo con padding/separación por tokens.
    expect(css).toMatch(/\.reward-modal\s*\{[^}]*width:\s*min\(600px, calc\(100vw - 2rem\)\)/s);
    expect(css).toMatch(/\.reward-modal-body\s*\{[^}]*padding:\s*var\(--space-6\)/s);
    expect(css).toMatch(/\.reward-modal-body\s*\{[^}]*gap:\s*var\(--space-5\)/s);
    expect(css).toMatch(/\.reward-fields\s*\{[^}]*gap:\s*var\(--space-5\)/s);
    expect(css).toMatch(/\.reward-advanced\s*\{[^}]*gap:\s*var\(--space-5\)/s);
    // Filas explícitas de dos columnas iguales, no grillas auto-fit en la ventana.
    expect(css).toMatch(/\.reward-row\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
    // Los tokens de espaciado existen hasta --space-8.
    for (let i = 1; i <= 8; i++) expect(css).toContain(`--space-${i}:`);
  });

  it("el selector de color de la ventana queda en la misma fila que el hex", () => {
    // Bug real: con `.field input { width: 100% }` y `flex-wrap: wrap`, el hex
    // ocupaba todo el ancho y el cuadradito caía a una segunda línea. La fila
    // propia `.color-row` (sin wrap) los mantiene juntos.
    const modal = html.slice(html.indexOf("reward-modal"));
    const colorBlock = modal.slice(modal.indexOf("Color"), modal.indexOf("Descripción"));
    expect(colorBlock).toMatch(/class="color-row"/);
    expect(colorBlock).toMatch(/class="color-hex"/);
    expect(colorBlock).toMatch(/class="color-picker"/);
    // El hex y el cuadradito son hijos DIRECTOS del mismo contenedor flex.
    const row = colorBlock.slice(colorBlock.indexOf("color-row"));
    expect(row).toMatch(/<input[^>]*class="color-hex"[^>]*\/>\s*<input[^>]*class="color-picker"/s);
    const css = read("style.css");
    const rule = css.match(/\.color-row\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/align-items:\s*center/);
    expect(rule).toMatch(/flex-wrap:\s*nowrap/);
    // .color-row ya no usa `.field-row` (que hace wrap).
    expect(colorBlock).not.toMatch(/class="field-row"/);
  });

  it("el cuadradito del modal y el chip de la tarjeta usan variables de tamaño", () => {
    const css = read("style.css");
    expect(css).toMatch(/--color-picker-size:/);
    expect(css).toMatch(/--reward-swatch-size:/);
    expect(css).toMatch(/\.color-row \.color-picker\s*\{[^}]*width:\s*var\(--color-picker-size\)/s);
    expect(css).toMatch(/\.reward-swatch\s*\{[^}]*width:\s*var\(--reward-swatch-size\)/s);
  });

  it("la cola muestra el nombre del ítem con queueItemName (nunca el id del clip)", () => {
    // El nombre del clip lo resuelve el servidor en `title`; el JS lo compone.
    expect(defines(app, "queueItemName")).toBe(true);
    expect(app).toMatch(/queueItemName\(item\)/);
    // La vista usa el helper para el ítem actual y para los "En espera".
    expect(html).toMatch(/x-text="queue\.current \? queueItemName\(queue\.current\)/);
    expect(html).toMatch(/x-text="queueItemName\(item\)"/);
    // Nunca se imprime `item.clipId` ni `queue.current.clipId` como texto.
    expect(html).not.toMatch(/x-text="[^"]*\.clipId/);
    expect(html).not.toMatch(/x-text="[^"]*\bclipId\b/);
  });

  it("los ítems de la cola marcan los audios con un ícono de parlante", () => {
    // El ícono aparece solo si el ítem es de solo audio, en el actual y en espera.
    const icons = [...html.matchAll(/class="queue-audio-icon"/g)];
    expect(icons.length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/x-show="[^"]*params[^"]*audioOnly"/);
    const css = read("style.css");
    expect(css).toMatch(/\.queue-item-name\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  });

  it("el selector Cola / Historial es compacto y centrado, no de ancho completo", () => {
    // El contenedor usa su propio ancho (fit-content) y se centra; NO se estira
    // a todo el ancho de la caja (sin width: 100% ni flex: 1).
    expect(html).toMatch(/class="segmented queue-tabs"[^>]*role="tablist"/);
    const css = read("style.css");
    const rule = css.match(/\.queue-tabs\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/width:\s*fit-content/);
    expect(rule).toMatch(/margin-inline:\s*auto/);
    expect(rule).not.toMatch(/width:\s*100%/);
    expect(rule).not.toMatch(/flex:\s*1\b/);
  });

  it("las dos pestañas del selector comparten el mismo ancho", () => {
    // Grilla de dos columnas iguales, con un mínimo cómodo por variable, para
    // que el botón activo no cambie de tamaño al alternar.
    const css = read("style.css");
    const rule = css.match(/\.queue-tabs\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(var\(--queue-tab-min\),\s*1fr\)\)/);
    expect(css).toMatch(/--queue-tab-min:/);
    const tabRule = css.match(/\.queue-tabs button\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tabRule).toMatch(/white-space:\s*nowrap/);
    expect(tabRule).toMatch(/text-align:\s*center/);
  });

  it("el selector Cola / Historial expone los roles de pestañas y las flechas", () => {
    // role=tablist con su etiqueta, dos role=tab con aria-selected, y navegación
    // por flechas izquierda/derecha entre las dos pestañas.
    expect(html).toMatch(/role="tablist"/);
    const tabs = [...html.matchAll(/role="tab"/g)];
    expect(tabs.length).toBe(2);
    expect(html).toMatch(/:aria-selected="rightTab === 'queue'"/);
    expect(html).toMatch(/:aria-selected="rightTab === 'history'"/);
    expect(html).toMatch(/@keydown\.arrow-left[^>]*setRightTab/);
    expect(html).toMatch(/@keydown\.arrow-right[^>]*setRightTab/);
    expect(app).toMatch(/setRightTab\(/);
  });

  it("el encabezado de Recompensas usa íconos, no un botón de texto Recargar", () => {
    // Ya no hay un botón de texto "Recargar": ahora es un ícono con aria-label.
    expect(html).not.toMatch(/>\s*Recargar\s*</);
    expect(html).toMatch(/aria-label="Recargar recompensas"/);
    expect(html).toMatch(/aria-label="Ver todas las recompensas"/);
    expect(html).toMatch(/class="reward-head-actions"/);
  });

  it("Recargar gira mientras carga (aria-busy) y respeta prefers-reduced-motion", () => {
    expect(html).toMatch(/:class="{ spinning: rewardReloading }"/);
    expect(html).toMatch(/:aria-busy="rewardReloading \? 'true' : 'false'"/);
    expect(app).toMatch(/rewardReloading: false/);
    expect(app).toMatch(/this\.rewardReloading = true/);
    expect(app).toMatch(/this\.rewardReloading = false/);
    const css = read("style.css");
    expect(css).toMatch(/\.icon-btn\.spinning svg\s*\{[^}]*animation:/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.icon-btn\.spinning svg\s*\{[^}]*animation:\s*none/s);
  });

  it("el botón Ver todas queda deshabilitado sin Kick vinculado", () => {
    // El botón de la ventana grande depende de rewardsLocked (sin vínculo o
    // requiere revincular); con caída temporal sigue habilitado.
    const block = html.slice(html.indexOf("Ver todas las recompensas") - 400, html.indexOf("Ver todas las recompensas") + 200);
    expect(block).toMatch(/:disabled="rewardsLocked"/);
    expect(html).toMatch(/openRewardsWindow\(\)/);
    expect(defines(app, "openRewardsWindow")).toBe(true);
    expect(defines(app, "closeRewardsWindow")).toBe(true);
  });

  it("cada indicador del encabezado abre Ajustes en su pestaña", () => {
    // Overlay → pestaña overlay, Kick → pestaña kick.
    expect(html).toMatch(/@click="openSettings\('overlay'\)"/);
    expect(html).toMatch(/@click="openSettings\('kick'\)"/);
    // El engranaje abre Ajustes sin forzar una pestaña.
    expect(html).toMatch(/@click="openSettings\(\)"/);
    expect(defines(app, "openSettings")).toBe(true);
  });

  it("el cierre de Ajustes avisa por pestaña y ofrece Descartar/Seguir editando/Guardar todo", () => {
    expect(html).toMatch(/<template x-if="settingsCloseConfirm">/);
    expect(html).toContain("Seguir editando");
    expect(html).toContain("Descartar");
    expect(html).toContain("Guardar todo");
    for (const name of ["confirmDiscardSettings", "cancelCloseSettings", "saveAllSettings"]) {
      expect(defines(app, name), `app.js no define ${name}()`).toBe(true);
    }
  });

  it("el diálogo aclara que Guardar todo solo toca las pestañas con Guardar", () => {
    expect(html).toMatch(/solo guarda las pestañas con botón Guardar/);
    expect(defines(app, "pendingActionTabs")).toBe(true);
    // Menciona aparte las pestañas que se guardan con sus propias acciones.
    expect(html).toMatch(/pendingActions\.length > 0/);
    expect(app).toContain("tiene credenciales sin guardar");
  });

  it("la última pestaña de Ajustes se recuerda en localStorage", () => {
    expect(app).toContain("viurewards.settingsTab");
    expect(defines(app, "openSettings")).toBe(true);
    // Lectura con try/catch y lista de pestañas válidas; valor inválido se ignora.
    expect(app).toMatch(/function readSettingsTab\(\)/);
    expect(app).toMatch(/SETTINGS_TABS\.indexOf\(value\) !== -1/);
  });

  it("el resultado del guardado es por pestaña (no un solo mensaje global)", () => {
    expect(defines(app, "tabMessage")).toBe(true);
    expect(defines(app, "tabSaved")).toBe(true);
    expect(defines(app, "fieldError")).toBe(true);
    // Ya no hay un settingsMessage/settingsSaved global en la vista.
    expect(html).not.toMatch(/x-text="settingsMessage"/);
    expect(html).not.toContain('x-show="settingsSaved"');
    // Cada pestaña con Guardar usa su propio tabSaved/tabMessage.
    for (const tab of ["alerts", "library", "advanced"]) {
      expect(html).toContain(`tabSaved('${tab}')`);
      expect(html).toContain(`tabMessage('${tab}')`);
    }
  });

  // --- Etapa 5, Parte B: contenido de las pestañas ---------------------------

  it("Overlay y OBS: alerta de prueba y versión del overlay", () => {
    expect(html).toMatch(/@click="testOverlayAlert\(\)"/);
    expect(defines(app, "testOverlayAlert")).toBe(true);
    // Muestra la versión del overlay conectado.
    expect(html).toMatch(/overlay\.version/);
    // La URL se enmascara y hay aviso de no mostrarla en stream.
    expect(html).toContain("No muestres esta URL en pantalla durante un stream");
  });

  it("Alertas: audios simultáneos máximos (1–20) con su explicación", () => {
    expect(html).toContain("Audios simultáneos máximos");
    expect(html).toMatch(/min="1"\s+max="20"/);
    expect(html).toContain("Si se supera, se corta el audio más antiguo");
  });

  it("Biblioteca y descargas: yt-dlp, espacio, limpieza con vista previa y revisar archivos", () => {
    // yt-dlp: versión + botón Actualizar (acción explícita).
    expect(defines(app, "updateYtdlp")).toBe(true);
    expect(html).toMatch(/@click="updateYtdlp\(\)"/);
    expect(html).toContain("Actualizar yt-dlp");
    // Espacio ocupado y formateo de bytes.
    expect(defines(app, "formatBytes")).toBe(true);
    expect(defines(app, "loadLibraryUsage")).toBe(true);
    // Limpieza de caché con vista previa previa y confirmación.
    expect(defines(app, "openCleanupPreview")).toBe(true);
    expect(defines(app, "confirmCleanup")).toBe(true);
    expect(defines(app, "cancelCleanup")).toBe(true);
    expect(html).toMatch(/<template x-if="cleanupPreview">/);
    expect(html).toContain("Los archivos locales y los clips");
    // Revisión de archivos a demanda.
    expect(defines(app, "reconcileNow")).toBe(true);
    expect(html).toMatch(/@click="reconcileNow\(\)"/);
    // Se reutiliza "Generar miniaturas faltantes".
    expect(html).toContain("Generar miniaturas faltantes");
  });

  it("Avanzado queda marcado como para casos puntuales y puerto avisa del reinicio", () => {
    expect(html).toContain("para casos puntuales");
    expect(html).toContain("actualizá la redirect URI en la app de Kick");
  });

  it("Avanzado: visor de logs con filtro de nivel, auto-actualización y copiar para soporte", () => {
    expect(html).toContain("Log del servidor");
    for (const name of ["loadLogs", "setLogLevel", "toggleLogAutoRefresh", "copySupportSummary", "stopLogAutoRefresh"]) {
      expect(defines(app, name), `app.js no define ${name}()`).toBe(true);
    }
    expect(html).toMatch(/@click="loadLogs\(\)"/);
    expect(html).toMatch(/@change="setLogLevel\(\$event\.target\.value\)"/);
    expect(html).toMatch(/@change="toggleLogAutoRefresh\(\)"/);
    expect(html).toMatch(/@click="copySupportSummary\(\)"/);
    // El visor es solo lectura y usa `x-for` (sin expresión que use métodos sin llamar).
    expect(html).toContain('class="log-view"');
    expect(html).toContain("sin secretos");
    // El CSS del visor usa variables (sin colores literales).
    const css = read("style.css");
    expect(css).toMatch(/\.log-view\s*\{[^}]*font-family:\s*var\(--font-mono\)/s);
  });

  it("la biblioteca de Ajustes se refresca al abrir la pestaña", () => {
    expect(defines(app, "refreshTabData")).toBe(true);
    expect(app).toMatch(/tab === "library"\) this\.loadLibraryUsage\(\)/);
  });

  it("las herramientas faltantes se explican con el qué hacer, no con un texto interno", () => {
    expect(defines(app, "toolsMissingMessage")).toBe(true);
    expect(html).toMatch(/x-text="toolsMissingMessage\(\)"/);
    // Nunca se muestra el texto interno del ejecutor.
    expect(html).not.toContain("ejecutor de procesos");
    expect(app).not.toContain("ejecutor de procesos");
    // Menciona la carpeta bin/ como alternativa.
    expect(app).toContain("carpeta bin/");
  });

  // --- Parte 1: Client ID, secret y diálogo de cierre -----------------------

  it("el campo del Client Secret evita el autocompletado del navegador", () => {
    expect(html).toMatch(/autocomplete="new-password"/);
    expect(html).toContain("data-1p-ignore");
    expect(html).toContain('data-lpignore="true"');
    // El secret tiene name/id propios (no los de un login).
    expect(html).toContain("viu-kick-client-secret");
    // El Client ID se precarga (no es secreto) y se limpia el secret al abrir.
    expect(defines(app, "clearBrowserFilledSecret")).toBe(true);
    expect(defines(app, "syncPlatformForm")).toBe(true);
  });

  it("el diálogo de cierre muestra cada sección solo si hay algo que mostrar", () => {
    expect(html).toMatch(/x-if="settingsCloseConfirm\.tabs\.length > 0"/);
    expect(html).toMatch(/x-if="settingsCloseConfirm\.pendingActions\.length > 0"/);
    // "Guardar todo" y su aclaración siguen a `canSaveAll`.
    expect(html).toMatch(/settingsCloseConfirm\.canSaveAll/);
    expect(defines(app, "pendingActionTabs")).toBe(true);
  });

  // --- Parte 2: errores de OAuth, confirmaciones propias y yt-dlp -----------

  it("los errores de OAuth se muestran en la pestaña Kick, no como JSON", () => {
    expect(defines(app, "kickLinkError")).toBe(true);
    // El mensaje del vínculo se rinde con el traductor en español.
    expect(html).toMatch(/x-text="kickLinkError\(activePlatform\)"/);
    // El traductor conoce la pista de la redirect URI.
    expect(app).toContain("redirect URI");
    expect(app).toContain("invalid authorization request");
  });

  it("existe un diálogo de confirmación propio (no window.confirm)", () => {
    expect(defines(app, "askConfirm")).toBe(true);
    expect(defines(app, "cancelConfirm")).toBe(true);
    expect(defines(app, "acceptConfirm")).toBe(true);
    expect(html).toMatch(/<template x-if="settingsConfirm">/);
    expect(html).toMatch(/x-text="settingsConfirm\.title"/);
  });

  it("borrar credenciales y actualizar yt-dlp ya no usan window.confirm", () => {
    // Se aíslan los cuerpos de esas funciones para no chocar con los otros
    // window.confirm legítimos (que se migrarán aparte).
    const clear = app.slice(app.indexOf("clearCredentials(platform)"), app.indexOf("runClearCredentials"));
    expect(clear).not.toContain("window.confirm");
    expect(clear).toContain("askConfirm");
    const upd = app.slice(app.indexOf("updateYtdlp()"), app.indexOf("runYtdlpUpdate"));
    expect(upd).not.toContain("window.confirm");
    expect(upd).toContain("askConfirm");
    // La limpieza de caché ya usaba su propio modal de vista previa.
    expect(html).toMatch(/<template x-if="cleanupPreview">/);
  });

  it("borrar credenciales avisa que también desvincula", () => {
    expect(app).toContain("También se desvincula la cuenta");
  });
});