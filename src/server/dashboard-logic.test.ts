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
function makeApp(port = "8787", storage?: { getItem?: (k: string) => string | null; setItem?: (k: string, v: string) => void }): Record<string, unknown> {
  const context = createContext({
    window: {
      localStorage: {
        getItem: storage?.getItem ?? (() => null),
        setItem: storage?.setItem ?? (() => {}),
      },
      location: { href: "", port },
      confirm: () => true,
    },
    // `api()` usa el `fetch` GLOBAL del contexto; lo exponemos para reemplazarlo.
    fetch: () => Promise.reject(new Error("no fetch")),
    document: { getElementById: () => null, activeElement: null, querySelector: () => null },
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

describe("Parte 3: ventana grande de recompensas", () => {
  /** Instancia con Kick vinculado y una recompensa editable. */
  function withRewards(): Record<string, unknown> {
    const app = makeApp();
    app.platforms = [{ ...PLATFORM }];
    app.activePlatformId = "kick";
    app.rewardsPlatformState = "connected";
    app.rewards = [{ id: "r1", localId: "r1", title: "Goku", cost: 100, enabled: true }];
    return app;
  }

  it("openRewardsWindow abre la ventana y closeRewardsWindow la cierra", () => {
    const app = withRewards();
    (app.openRewardsWindow as () => void).call(app);
    expect(app.rewardsWindowOpen).toBe(true);
    (app.closeRewardsWindow as () => void).call(app);
    expect(app.rewardsWindowOpen).toBe(false);
  });

  it("no abre si la plataforma no está vinculada (rewardsLocked)", () => {
    const app = makeApp();
    app.rewardsPlatformState = "unlinked";
    (app.openRewardsWindow as () => void).call(app);
    expect(app.rewardsWindowOpen).toBe(false);
  });

  it("cerrar devuelve el foco al elemento que abrió la ventana", () => {
    const app = withRewards();
    let focused = 0;
    const origin = {
      focus: () => {
        focused += 1;
      },
    };
    (app as { rewardsFocusOrigin?: unknown }).rewardsFocusOrigin = origin;
    (app.closeRewardsWindow as () => void).call(app);
    expect(focused).toBe(1);
  });

  it("backdrop cierra solo sin capas encima", () => {
    const app = withRewards();
    app.rewardsWindowOpen = true;
    const event = { target: {}, currentTarget: {} };
    // target === currentTarget para pasar el primer control.
    event.target = event.currentTarget;
    app.rewardForm = { id: null };
    (app.closeRewardsWindowBackdrop as (e: unknown) => void).call(app, event);
    expect(app.rewardsWindowOpen).toBe(true);
    app.rewardForm = null;
    (app.closeRewardsWindowBackdrop as (e: unknown) => void).call(app, event);
    expect(app.rewardsWindowOpen).toBe(false);
  });

  it("Esc cierra de a una capa: confirmación, edición, ventana grande", () => {
    const app = withRewards();
    app.rewardsWindowOpen = true;
    app.rewardForm = { id: null };
    app.settingsConfirm = { title: "t" };
    (app.onEscape as () => void).call(app);
    expect(app.settingsConfirm).toBeNull();
    expect(app.rewardForm).not.toBeNull();
    expect(app.rewardsWindowOpen).toBe(true);

    (app.onEscape as () => void).call(app);
    expect(app.rewardForm).toBeNull();
    expect(app.rewardsWindowOpen).toBe(true);

    (app.onEscape as () => void).call(app);
    expect(app.rewardsWindowOpen).toBe(false);
  });

  it("la ventana se cierra si la plataforma deja de estar vinculada", async () => {
    const app = withRewards();
    app.rewardsWindowOpen = true;
    (app.setGlobalFetch as (fn: () => Promise<unknown>) => void)(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rewards: [], connected: false, offline: false, platformState: "unlinked" }),
      }),
    );
    await (app.loadRewards as (p: unknown) => Promise<void>).call(app, { id: "kick", state: "connected" });
    expect(app.rewardsPlatformState).toBe("unlinked");
    expect(app.rewardsWindowOpen).toBe(false);
  });

  it("rewardReloading se activa y se limpia aunque la carga falle", async () => {
    const app = withRewards();
    (app.setGlobalFetch as (fn: () => Promise<unknown>) => void)(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    );
    expect(app.rewardReloading).toBe(false);
    await (app.loadRewards as (p: unknown) => Promise<void>).call(app, { id: "kick", state: "connected" });
    expect(app.rewardReloading).toBe(false);
    expect(app.rewardsMessage).toContain("No se pudieron cargar");
  });

  it("rewardReloading queda en falso tras una carga exitosa", async () => {
    const app = withRewards();
    (app.setGlobalFetch as (fn: () => Promise<unknown>) => void)(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ rewards: [], connected: true, offline: false, platformState: "connected" }),
      }),
    );
    await (app.loadRewards as (p: unknown) => Promise<void>).call(app, { id: "kick", state: "connected" });
    expect(app.rewardReloading).toBe(false);
  });

  it("rewardCardHtml escapa los datos externos (título y color)", () => {
    const app = withRewards();
    const html = (app.rewardCardHtml as (r: unknown) => string).call(app, {
      id: "r1",
      title: '<img src=x onerror=alert(1)>',
      color: '"><script>',
      cost: 5,
      state: "enabled",
      managed: true,
      synced: true,
      localId: "r1",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("Parte 4: orden de la ventana grande de recompensas", () => {
  /** Instancia con recompensas variadas (fecha, costo, sin fecha). */
  function withSortRewards(): Record<string, unknown> {
    const app = makeApp();
    app.platforms = [{ ...PLATFORM }];
    app.activePlatformId = "kick";
    app.rewardsPlatformState = "connected";
    app.rewards = [
      { id: "a", localId: "a", title: "Zeta", cost: 100, createdAt: "2024-01-02T00:00:00.000Z" },
      { id: "b", localId: "b", title: "alfa", cost: 50, createdAt: "2024-01-03T00:00:00.000Z" },
      { id: "c", localId: "c", title: "Ñandú", cost: 50, createdAt: "2024-01-01T00:00:00.000Z" },
      { id: "d", localId: "d", title: "Bruja", cost: 10, createdAt: null },
      { id: "e", localId: "e", title: "Anca", cost: 10, createdAt: null },
    ];
    return app;
  }

  /** Extrae los ids en el orden en que los devuelve la ventana. */
  function ids(app: Record<string, unknown>): string[] {
    return (app.sortedRewardsForWindow as { id: string }[]).map((r) => r.id);
  }

  function setSort(app: Record<string, unknown>, field: string, direction: string): void {
    app.rewardsSort = { field, direction };
  }

  it("fecha añadida descendente (por defecto): más reciente primero", () => {
    const app = withSortRewards();
    // Sin fecha van al final, ordenadas por nombre (sin tildes/mayúsculas): Anca, Bruja.
    expect(ids(app)).toEqual(["b", "a", "c", "e", "d"]);
  });

  it("fecha añadida ascendente: más antigua primero", () => {
    const app = withSortRewards();
    setSort(app, "created", "asc");
    expect(ids(app)).toEqual(["c", "a", "b", "e", "d"]);
  });

  it("puntos descendente: mayor costo primero, empate por nombre", () => {
    const app = withSortRewards();
    setSort(app, "cost", "desc");
    // 100 (a), 50 (alfa antes que Ñandú), 10 (Anca antes que Bruja).
    expect(ids(app)).toEqual(["a", "b", "c", "e", "d"]);
  });

  it("puntos ascendente: menor costo primero", () => {
    const app = withSortRewards();
    setSort(app, "cost", "asc");
    expect(ids(app)).toEqual(["e", "d", "b", "c", "a"]);
  });

  it("el empate por nombre ignora mayúsculas y tildes", () => {
    const app = makeApp();
    app.rewards = [
      { id: "1", title: "Ñandú", cost: 5 },
      { id: "2", title: "alan", cost: 5 },
      { id: "3", title: "Alán", cost: 5 },
      { id: "4", title: "Zorro", cost: 5 },
    ];
    setSort(app, "cost", "asc");
    // alan/Alán (normalizados iguales) antes que Ñandú (n) y Zorro.
    expect(ids(app)).toEqual(["2", "3", "1", "4"]);
  });

  it("las recompensas sin fecha van al final en ambas direcciones", () => {
    const app = withSortRewards();
    setSort(app, "created", "desc");
    expect(ids(app).slice(-2)).toEqual(["e", "d"]);
    setSort(app, "created", "asc");
    expect(ids(app).slice(-2)).toEqual(["e", "d"]);
  });

  it("valor por defecto: fecha añadida descendente", () => {
    const app = makeApp();
    expect(app.rewardsSort).toEqual({ field: "created", direction: "desc" });
  });

  it("persistencia: selectRewardsSort y toggleRewardsSortDirection guardan en localStorage", () => {
    const saved: Record<string, string> = {};
    const app = makeApp("8787", {
      getItem: (k: string) => saved[k] ?? null,
      setItem: (k: string, v: string) => {
        saved[k] = v;
      },
    });
    (app.selectRewardsSort as (f: string) => void).call(app, "cost");
    expect(app.rewardsSort).toEqual({ field: "cost", direction: "desc" });
    expect(JSON.parse(saved["viurewards.rewardsSort"])).toEqual({ field: "cost", direction: "desc" });
    (app.toggleRewardsSortDirection as () => void).call(app);
    expect(app.rewardsSort).toEqual({ field: "cost", direction: "asc" });
    expect(JSON.parse(saved["viurewards.rewardsSort"])).toEqual({ field: "cost", direction: "asc" });
  });

  it("persistencia: un valor guardado válido se recupera al abrir", () => {
    const app = makeApp("8787", {
      getItem: () => JSON.stringify({ field: "cost", direction: "asc" }),
    });
    expect(app.rewardsSort).toEqual({ field: "cost", direction: "asc" });
  });

  it("persistencia: JSON basura cae al valor por defecto", () => {
    const app = makeApp("8787", { getItem: () => "{no es json" });
    expect(app.rewardsSort).toEqual({ field: "created", direction: "desc" });
  });

  it("persistencia: un campo o dirección inválidos se ignoran por separado", () => {
    const app = makeApp("8787", {
      getItem: () => JSON.stringify({ field: "inventado", direction: "lateral" }),
    });
    expect(app.rewardsSort).toEqual({ field: "created", direction: "desc" });
  });

  it("persistencia: si localStorage lanza, no rompe y usa el valor por defecto", () => {
    const app = makeApp("8787", {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    });
    expect(app.rewardsSort).toEqual({ field: "created", direction: "desc" });
    // Guardar no debe lanzar aunque localStorage falle.
    expect(() => (app.selectRewardsSort as (f: string) => void).call(app, "cost")).not.toThrow();
  });

  it("ordenar la ventana NO altera el orden del panel vertical", () => {
    const app = withSortRewards();
    const original = (app.rewards as { id: string }[]).map((r) => r.id);
    setSort(app, "cost", "asc");
    // Recalcular la lista ordenada no debe mutar el arreglo original.
    void ids(app);
    expect((app.rewards as { id: string }[]).map((r) => r.id)).toEqual(original);
  });

  it("Esc cierra primero el desplegable de orden abierto", () => {
    const app = withSortRewards();
    app.rewardsWindowOpen = true;
    (app.toggleRewardsSortOpen as () => void).call(app);
    expect(app.rewardsSortOpen).toBe(true);
    (app.onEscape as () => void).call(app);
    expect(app.rewardsSortOpen).toBe(false);
    expect(app.rewardsWindowOpen).toBe(true);
  });

  it("el desplegable de orden no se abre sin recompensas", () => {
    const app = makeApp();
    app.rewards = [];
    (app.toggleRewardsSortOpen as () => void).call(app);
    expect(app.rewardsSortOpen).toBe(false);
  });

  it("la etiqueta de la dirección refleja el estado actual", () => {
    const app = withSortRewards();
    setSort(app, "created", "desc");
    expect(app.rewardsSortDirectionLabel).toBe("Orden descendente");
    setSort(app, "created", "asc");
    expect(app.rewardsSortDirectionLabel).toBe("Orden ascendente");
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
