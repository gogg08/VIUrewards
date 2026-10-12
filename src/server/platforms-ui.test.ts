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

/** Identificadores de las funciones invocadas en `@click="name(...)"`. */
function handlerCalls(html: string): string[] {
  return [...html.matchAll(/@click="([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]);
}

/** ¿El JS define `name(...)` como método (no como `this.name(...)`)? */
function defines(js: string, name: string): boolean {
  return new RegExp(`\\n\\s*(?:async\\s+)?${name}\\s*\\(`).test(js);
}

describe("UI del dashboard (plataformas)", () => {
  const html = read("index.html");
  const app = read("app.js");

  it("cada handler @click del dashboard está definido en app.js", () => {
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

  it("no expone tokens de OAuth en los assets del frontend", () => {
    for (const asset of [html, app, read("login.js")]) {
      expect(asset).not.toMatch(/access_token|refresh_token|client_secret/i);
    }
  });
});