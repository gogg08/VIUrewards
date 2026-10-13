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
  "job",
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
});