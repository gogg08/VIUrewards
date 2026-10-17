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
function makeApp(port = "8787"): Record<string, unknown> {
  const context = createContext({
    window: {
      localStorage: { getItem: () => null, setItem: () => {} },
      location: { href: "", port },
    },
    // `api()` usa el `fetch` GLOBAL del contexto; lo exponemos para reemplazarlo.
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
    URLSearchParams,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  });
  const source = readFileSync(join(webDir, "app.js"), "utf8");
  runInContext(source, context);
  const factory = runInContext("dashboardApp()", context) as Record<string, unknown>;
  // Permite reemplazar el `fetch` global que usa `api()` desde los tests.
  factory.setGlobalFetch = (fn: () => Promise<unknown>) => {
    (context as Record<string, unknown>).fetch = fn;
  };
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

describe("Parte 2: errores de OAuth en español (kickLinkError)", () => {
  it("traduce 'invalid authorization request' a la pista de la redirect URI", () => {
    const app = makeApp("8787");
    const message = (app.kickLinkError as (p: unknown) => string).call(app, {
      lastError: "invalid authorization request",
    });
    expect(message).toContain("redirect URI");
    expect(message).toContain("http://localhost:8787/callback");
    expect(message).toContain("sin barra final");
  });

  it("menciona la redirect URI si el error habla de 'redirect'", () => {
    const app = makeApp("8787");
    const message = (app.kickLinkError as (p: unknown) => string).call(app, {
      lastError: "redirect_uri_mismatch",
    });
    expect(message).toContain("redirect URI");
  });

  it("un error desconocido se devuelve tal cual; sin error, mensaje genérico en español", () => {
    const app = makeApp();
    const raw = (app.kickLinkError as (p: unknown) => string).call(app, { lastError: "boom raro" });
    expect(raw).toBe("boom raro");
    const generic = (app.kickLinkError as (p: unknown) => string).call(app, { lastError: null });
    expect(generic).toContain("No se pudo vincular");
  });
});

describe("Parte 2: diálogo de confirmación propio", () => {
  it("askConfirm abre el diálogo y acceptConfirm ejecuta la acción", async () => {
    const app = makeApp();
    let ran = 0;
    (app.askConfirm as (c: unknown) => void).call(app, {
      title: "Título",
      body: "Cuerpo",
      confirmLabel: "Aceptar",
      onConfirm: () => {
        ran += 1;
      },
    });
    expect((app.settingsConfirm as { title: string }).title).toBe("Título");
    await (app.acceptConfirm as () => Promise<void>).call(app);
    expect(ran).toBe(1);
    expect(app.settingsConfirm).toBeNull();
  });

  it("cancelConfirm cierra sin ejecutar la acción", async () => {
    const app = makeApp();
    let ran = 0;
    (app.askConfirm as (c: unknown) => void).call(app, {
      title: "t",
      body: "b",
      confirmLabel: "ok",
      onConfirm: () => {
        ran += 1;
      },
    });
    (app.cancelConfirm as () => void).call(app);
    expect(app.settingsConfirm).toBeNull();
    await (app.acceptConfirm as () => Promise<void>).call(app);
    expect(ran).toBe(0);
  });

  it("clearCredentials usa el diálogo propio (no window.confirm)", () => {
    const app = makeApp();
    (app.clearCredentials as (p: unknown) => void).call(app, { id: "kick", name: "Kick" });
    const confirm = app.settingsConfirm as { danger: boolean; confirmLabel: string; body: string };
    expect(confirm.danger).toBe(true);
    expect(confirm.body).toContain("desvincula");
  });

  it("updateYtdlp abre el diálogo propio", () => {
    const app = makeApp();
    (app.updateYtdlp as () => void).call(app);
    const confirm = app.settingsConfirm as { title: string; confirmLabel: string };
    expect(confirm.title).toContain("yt-dlp");
    expect(confirm.confirmLabel).toBe("Actualizar");
  });
});

describe("Parte 3: visor de logs", () => {
  it("loadLogs guarda las líneas y el estado disponible", async () => {
    const app = makeApp();
    (app.setGlobalFetch as (fn: () => Promise<unknown>) => void)(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, lines: ["l1", "l2"], count: 2, available: true }),
      }),
    );
    await (app.loadLogs as () => Promise<void>).call(app);
    expect(app.logLines).toEqual(["l1", "l2"]);
    expect(app.logCount).toBe(2);
    expect(app.logAvailable).toBe(true);
    expect(app.logLoading).toBe(false);
  });

  it("loadLogs maneja el error sin romper", async () => {
    const app = makeApp();
    (app.setGlobalFetch as (fn: () => Promise<unknown>) => void)(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    );
    await (app.loadLogs as () => Promise<void>).call(app);
    expect(app.logMessage).toContain("No se pudo leer el log");
  });

  it("toggleLogAutoRefresh enciende y apaga el temporizador", () => {
    const app = makeApp();
    (app.toggleLogAutoRefresh as () => void).call(app);
    expect(app.logAutoRefresh).toBe(true);
    expect(app.logTimer).not.toBeNull();
    (app.toggleLogAutoRefresh as () => void).call(app);
    expect(app.logAutoRefresh).toBe(false);
    expect(app.logTimer).toBeNull();
  });
});
