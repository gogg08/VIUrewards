/**
 * Prueba de LÓGICA del dashboard (Parte 1: Client ID y diálogo de cierre).
 *
 * `web/app.js` no es un módulo ES (es un script global para Alpine, sin build).
 * Para probar métodos reales sin navegador se evalúa el archivo en un `vm`
 * aislado con stubs mínimos de `window`/`fetch`, y se instancia el componente
 * con `dashboardApp()`. Así se ejercita el comportamiento verdadero (no un
 * espejo estático) de `pendingActionTabs`, `syncPlatformForm` y `closeSettings`.
 *
 * Límite: no se prueba el DOM ni Alpine; eso queda para la prueba de humo con
 * navegador (docs/dashboard.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));

/** Crea una instancia del componente Alpine evaluando app.js en un vm. */
function makeApp(): Record<string, unknown> {
  const context = createContext({
    window: { localStorage: { getItem: () => null, setItem: () => {} }, location: { href: "" } },
    fetch: () => Promise.reject(new Error("no fetch")),
    document: { getElementById: () => null },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
  });
  const source = readFileSync(join(webDir, "app.js"), "utf8");
  runInContext(source, context);
  const factory = runInContext("dashboardApp()", context) as Record<string, unknown>;
  return factory;
}

/** Arma una plataforma mínima como la que devuelve /api/platforms. */
const PLATFORM = { id: "kick", name: "Kick", clientId: "cid-guardado", hasCredentials: true, state: "connected" };

/** Instancia con la plataforma activa y el formulario sincronizado. */
function withPlatform(clientId = "cid-guardado"): Record<string, unknown> {
  const app = makeApp();
  app.platforms = [{ ...PLATFORM, clientId }];
  app.activePlatformId = "kick";
  (app.syncPlatformForm as () => void).call(app);
  return app;
}

describe("Parte 1: Client ID y aviso de cambios del Kick", () => {
  it("abrir Ajustes con datos guardados NO marca cambios pendientes", () => {
    const app = withPlatform();
    const pending = (app.pendingActionTabs as () => string[]).call(app);
    expect(pending).toEqual([]);
  });

  it("syncPlatformForm precarga el Client ID guardado y marca la línea base", () => {
    const app = makeApp();
    expect((app.platformForm as { clientId: string }).clientId).toBe("");
    app.platforms = [{ ...PLATFORM }];
    app.activePlatformId = "kick";
    (app.syncPlatformForm as () => void).call(app);
    expect((app.platformForm as { clientId: string }).clientId).toBe("cid-guardado");
    expect((app.platformFormBase as { clientId: string }).clientId).toBe("cid-guardado");
    expect(app.platformFormLoaded).toBe(true);
    // El secret SIEMPRE arranca vacío (la API solo dice si hay uno).
    expect((app.platformForm as { clientSecret: string }).clientSecret).toBe("");
  });

  it("mientras los datos no llegaron, no se calcula ningún aviso", () => {
    const app = makeApp();
    // Sin `platformFormLoaded`, nunca hay aviso aunque el campo tenga texto.
    (app.platformForm as { clientId: string }).clientId = "algo-escrito";
    expect((app.pendingActionTabs as () => string[]).call(app)).toEqual([]);
  });

  it("modificar el Client ID marca cambios; revertirlo a la base los borra", () => {
    const app = withPlatform();
    (app.platformForm as { clientId: string }).clientId = "cid-nuevo";
    let pending = (app.pendingActionTabs as () => string[]).call(app);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain("Kick");
    expect(pending[0]).toContain("sin guardar");

    // Revertir al valor guardado: deja de contar como cambio.
    (app.platformForm as { clientId: string }).clientId = "cid-guardado";
    pending = (app.pendingActionTabs as () => string[]).call(app);
    expect(pending).toEqual([]);
  });

  it("un cambio de solo espacios no cuenta (se compara recortado)", () => {
    const app = withPlatform();
    (app.platformForm as { clientId: string }).clientId = "  cid-guardado  ";
    expect((app.pendingActionTabs as () => string[]).call(app)).toEqual([]);
  });

  it("escribir el Secret cuenta como cambio; borrarlo lo deshace", () => {
    const app = withPlatform();
    (app.platformForm as { clientSecret: string }).clientSecret = "s3cr3t";
    const pending = (app.pendingActionTabs as () => string[]).call(app);
    expect(pending).toHaveLength(1);

    (app.platformForm as { clientSecret: string }).clientSecret = "";
    expect((app.pendingActionTabs as () => string[]).call(app)).toEqual([]);
  });

  it("el aviso de Seguridad es independiente del de Kick", () => {
    const app = withPlatform();
    (app.passwordForm as { next: string }).next = "nueva";
    const pending = (app.pendingActionTabs as () => string[]).call(app);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContain("Seguridad");
  });
});

describe("Parte 1: diálogo de cierre", () => {
  it("sin cambios pendientes no hay diálogo", () => {
    const app = withPlatform();
    (app.closeSettings as () => void).call(app);
    expect(app.settingsCloseConfirm).toBeNull();
    expect(app.settingsOpen).toBe(false);
  });

  it("solo campos sin aplicar (Kick): no ofrece Guardar todo", () => {
    const app = withPlatform();
    (app.platformForm as { clientId: string }).clientId = "otro";
    (app.closeSettings as () => void).call(app);
    const confirm = app.settingsCloseConfirm as { tabs: string[]; pendingActions: string[]; canSaveAll: boolean };
    expect(confirm.tabs).toEqual([]);
    expect(confirm.pendingActions).toHaveLength(1);
    expect(confirm.canSaveAll).toBe(false);
  });

  it("solo pestañas con Guardar: ofrece Guardar todo y no lista campos sin aplicar", () => {
    const app = withPlatform();
    (app.dirtyTabs as Record<string, boolean>).alerts = true;
    (app.closeSettings as () => void).call(app);
    const confirm = app.settingsCloseConfirm as { tabs: string[]; pendingActions: string[]; canSaveAll: boolean };
    expect(confirm.tabs).toEqual(["Alertas"]);
    expect(confirm.pendingActions).toEqual([]);
    expect(confirm.canSaveAll).toBe(true);
  });

  it("ambas cosas a la vez: lista las dos y ofrece Guardar todo", () => {
    const app = withPlatform();
    (app.dirtyTabs as Record<string, boolean>).library = true;
    (app.platformForm as { clientSecret: string }).clientSecret = "x";
    (app.closeSettings as () => void).call(app);
    const confirm = app.settingsCloseConfirm as { tabs: string[]; pendingActions: string[]; canSaveAll: boolean };
    expect(confirm.tabs).toEqual(["Biblioteca y descargas"]);
    expect(confirm.pendingActions).toHaveLength(1);
    expect(confirm.canSaveAll).toBe(true);
  });
});
