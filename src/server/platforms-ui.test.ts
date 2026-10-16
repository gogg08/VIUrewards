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
    expect(logo).toContain("/web/assets/VIUrewards.png");
    expect(logo).toContain("/web/assets/VIUrewards.webp");
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
    expect(html).toMatch(/@change="applyRewardColor\(reward, \$event\)"/);
    expect(html).not.toMatch(/@input="applyRewardColor/);
    // Botón accesible con aria-label "Cambiar color".
    expect(html).toMatch(/aria-label="Cambiar color"/);
    expect(defines(app, "openRewardColor"), "app.js no define openRewardColor()").toBe(true);
    expect(defines(app, "applyRewardColor"), "app.js no define applyRewardColor()").toBe(true);
    expect(app).toContain("rewardColorSaving");
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
    expect(html).toMatch(/x-show="reward\.audioOnly"/);
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

  it("la fila inferior de la tarjeta tiene botones e interruptor en el mismo contenedor", () => {
    // Un solo `.reward-card-bottom` con las acciones y el switch dentro, y el
    // estilo los separa a los extremos (space-between).
    expect(html).toMatch(/class="reward-card-bottom"/);
    expect(html).toMatch(/class="reward-card-actions"/);
    const block = html.slice(html.indexOf('class="reward-card-bottom"'));
    const end = block.indexOf("</div>", block.indexOf("switch-knob"));
    const row = block.slice(0, end);
    expect(row).toContain("Editar");
    expect(row).toContain("Borrar");
    expect(row).toMatch(/role="switch"/);
    const css = read("style.css");
    const rule = css.match(/\.reward-card-bottom\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/justify-content:\s*space-between/);
  });

  it("la etiqueta de estado no comparte fila con los botones ni con el interruptor", () => {
    // La tarjeta pone la etiqueta en su propia línea (`.reward-card-state`) y la
    // fila inferior solo tiene acciones + switch.
    expect(html).toMatch(/class="reward-card-state"/);
    const bottom = html.slice(html.indexOf('class="reward-card-bottom"'));
    const row = bottom.slice(0, bottom.indexOf("</div>", bottom.indexOf("switch-knob")));
    expect(row).not.toContain("rewardStateLabel");
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
});