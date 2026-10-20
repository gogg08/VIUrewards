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
      // theme.js usa matchMedia y dispatchEvent al cargarse.
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      dispatchEvent: () => {},
    },
    // `api()` usa el `fetch` GLOBAL del contexto; lo exponemos para reemplazarlo.
    fetch: () => Promise.reject(new Error("no fetch")),
    document: {
      getElementById: () => null,
      activeElement: null,
      querySelector: () => null,
      documentElement: {
        _attrs: {},
        getAttribute: (name: string) => (name in (context as never as { document: { documentElement: { _attrs: Record<string, string> } } }).document.documentElement._attrs ? (context as never as { document: { documentElement: { _attrs: Record<string, string> } } }).document.documentElement._attrs[name] : null),
        setAttribute: (name: string, value: string) => {
          (context as never as { document: { documentElement: { _attrs: Record<string, string> } } }).document.documentElement._attrs[name] = value;
        },
        style: { setProperty: () => {} },
      },
    },
    CustomEvent: function (this: { type: string; detail: unknown }, type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    },
    Image: function () {
      return {};
    },
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
    parseInt,
    URLSearchParams,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
  });
  // `app.js` lee el global `VIUTheme`, que define `theme.js`; se carga primero.
  runInContext(readFileSync(join(webDir, "theme.js"), "utf8"), context);
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

  it("rewardCardHtml produce el MISMO HTML en el panel y en la ventana (una firma)", () => {
    const app = withRewards();
    const reward = { id: "r1", localId: "r1", title: "Goku", cost: 100, state: "enabled", synced: true };
    // Una sola firma: la misma recompensa rinde lo mismo sin importar dónde se pinte.
    expect((app.rewardCardHtml as (r: unknown) => string).length).toBe(1);
    const inPanel = (app.rewardCardHtml as (r: unknown) => string).call(app, reward);
    const inWindow = (app.rewardCardHtml as (r: unknown) => string).call(app, reward);
    expect(inPanel).toBe(inWindow);
  });

  it("una recompensa sin fecha NO agrega la línea 'sin fecha' a la tarjeta", () => {
    const app = withRewards();
    const html = (app.rewardCardHtml as (r: unknown) => string).call(app, {
      id: "r1",
      localId: "r1",
      title: "De otra app",
      cost: 5,
      state: "foreign",
      createdAt: null,
    });
    expect(html).not.toContain("sin fecha");
    // La información vive en el title de la etiqueta de estado.
    expect(html).toContain("Sin fecha de creación");
    expect(html).toContain("De otra app");
  });

  it("el texto de ayuda de una 'De otra app' aparece antes de la fila de acciones", () => {
    const app = withRewards();
    const html = (app.rewardCardHtml as (r: unknown) => string).call(app, {
      id: "r1",
      localId: "r1",
      title: "De otra app",
      cost: 5,
      state: "foreign",
      synced: true,
      enabled: true,
    });
    const help = html.indexOf("La creó otra aplicación");
    const foot = html.indexOf('class="reward-card-foot"');
    const bottom = html.indexOf('class="reward-card-bottom"');
    expect(help).toBeGreaterThan(-1);
    expect(foot).toBeGreaterThan(-1);
    expect(bottom).toBeGreaterThan(-1);
    // Orden: ayuda → pie (separador + acciones).
    expect(help).toBeLessThan(foot);
    expect(foot).toBeLessThan(bottom);
  });

  it("el texto de 'Falta en Kick' y el de sin sincronizar van antes de las acciones", () => {
    const app = withRewards();
    const missing = (app.rewardCardHtml as (r: unknown) => string).call(app, {
      id: "r1",
      localId: "r1",
      title: "X",
      cost: 5,
      state: "missing",
      synced: true,
    });
    const bottomMissing = missing.indexOf('class="reward-card-bottom"');
    expect(missing.indexOf("Quitar de la app")).toBeLessThan(bottomMissing);

    const unsynced = (app.rewardCardHtml as (r: unknown) => string).call(app, {
      id: "r2",
      localId: "r2",
      title: "Y",
      cost: 5,
      state: "enabled",
      synced: false,
    });
    const bottomUnsynced = unsynced.indexOf('class="reward-card-bottom"');
    expect(unsynced.indexOf("Datos sin sincronizar")).toBeLessThan(bottomUnsynced);
  });

  it("una tarjeta habilitada es idéntica en las dos vistas (mismo HTML)", () => {
    const app = withRewards();
    const reward = { id: "r1", localId: "r1", title: "Goku", cost: 100, state: "enabled", enabled: true, synced: true };
    const inPanel = (app.rewardCardHtml as (r: unknown) => string).call(app, reward);
    const inWindow = (app.rewardCardHtml as (r: unknown) => string).call(app, reward);
    expect(inPanel).toBe(inWindow);
    // La fila de acciones vive dentro del pie anclado abajo.
    expect(inPanel).toContain('class="reward-card-foot"');
    expect(inPanel.indexOf('class="reward-card-foot"')).toBeLessThan(
      inPanel.indexOf('class="reward-card-bottom"')
    );
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

describe("Parte 1: cooldown con espera (poner en cola)", () => {
  it("la política por defecto es 'queue' con los topes por defecto", () => {
    const app = makeApp();
    const settings = app.settings as Record<string, unknown>;
    expect(settings.redemptionsOnCooldown).toBe("queue");
    expect(settings.redemptionsWaitMax).toBe(20);
    expect(settings.redemptionsWaitTimeoutMin).toBe(10);
  });

  it("el historial muestra 'En espera por cooldown' y su descarte", () => {
    const app = makeApp();
    const outcomeLabel = app.outcomeLabel as (entry: Record<string, unknown>) => string;
    expect(outcomeLabel({ outcome: "waiting", reason: "En espera por cooldown (12 s)" })).toBe(
      "En espera por cooldown",
    );
    expect(outcomeLabel({ outcome: "waiting", reason: "espera descartada" })).toBe(
      "En espera por cooldown · descartada",
    );
  });

  it("la espera por cooldown usa la etiqueta de advertencia", () => {
    const app = makeApp();
    const badge = app.outcomeBadgeClass as (outcome: string) => string;
    expect(badge("waiting")).toBe("warn");
  });
});

describe("Parte 2: tema y acento", () => {
  it("setTheme guarda la preferencia y aplica el tema", () => {
    const written: Record<string, string> = {};
    const app = makeApp("8787", { setItem: (k, v) => (written[k] = v) });
    (app.setTheme as (mode: string) => void).call(app, "oled");
    expect(app.themePreference).toBe("oled");
    expect(written["viurewards.theme"]).toBe("oled");
  });

  it("setAccent acepta un hex válido y rechaza uno inválido con aviso", () => {
    const written: Record<string, string> = {};
    const app = makeApp("8787", { setItem: (k, v) => (written[k] = v) });
    (app.setAccent as (hex: string) => void).call(app, "#a78bfa");
    expect(app.accent).toBe("#a78bfa");
    expect(app.accentError).toBe("");
    expect(written["viurewards.accent"]).toBe("#a78bfa");
    (app.setAccent as (hex: string) => void).call(app, "no-es-hex");
    expect(app.accent).toBe("#a78bfa");
    expect(String(app.accentError)).toContain("hex");
  });

  it("accentIsActive compara con el color elegido y resetAccent vuelve al verde", () => {
    const app = makeApp();
    (app.setAccent as (hex: string) => void).call(app, "#60a5fa");
    const isActive = app.accentIsActive as (hex: string) => boolean;
    expect(isActive.call(app, "#60a5fa")).toBe(true);
    expect(isActive.call(app, "#53fc18")).toBe(false);
    (app.resetAccent as () => void).call(app);
    expect(app.accent).toBe("#53fc18");
  });

  it("la preferencia se lee con el helper de theme.js (tema y acento guardados)", () => {
    const stored: Record<string, string> = {
      "viurewards.theme": "day",
      "viurewards.accent": "#f472b6",
    };
    // El factory lee la misma clave que usa `init()`; se verifica el round-trip.
    const app = makeApp("8787", { getItem: (k) => (k in stored ? stored[k] : null) });
    expect(app.themePreference).toBe("auto");
    (app.setTheme as (mode: string) => void).call(app, "day");
    (app.setAccent as (hex: string) => void).call(app, "#f472b6");
    expect(app.themePreference).toBe("day");
    expect(app.accent).toBe("#f472b6");
  });

  it("cycleTheme recorre los temas en rueda con las flechas", () => {
    const app = makeApp();
    const cycle = app.cycleTheme as (option: string, delta: number) => void;
    (app.setTheme as (mode: string) => void).call(app, "auto");
    cycle.call(app, "auto", 1);
    expect(app.themePreference).toBe("night");
    cycle.call(app, "day", 1);
    expect(app.themePreference).toBe("auto"); // vuelve al principio
    cycle.call(app, "auto", -1);
    expect(app.themePreference).toBe("day"); // hacia atrás
  });

  it("cycleAccent recorre la paleta y accentSwatchTabindex marca un solo swatch", () => {
    const app = makeApp();
    (app.setAccent as (hex: string) => void).call(app, "#53fc18");
    const cycle = app.cycleAccent as (hex: string, delta: number) => void;
    cycle.call(app, "#53fc18", 1);
    expect(app.accent).toBe("#a78bfa");
    const tabindex = app.accentSwatchTabindex as (hex: string) => number;
    expect(tabindex.call(app, "#a78bfa")).toBe(0);
    expect(tabindex.call(app, "#53fc18")).toBe(-1);
    // Con un color libre fuera de la paleta, el primero sigue siendo alcanzable.
    (app.setAccent as (hex: string) => void).call(app, "#123456");
    expect(tabindex.call(app, "#53fc18")).toBe(0);
    expect(tabindex.call(app, "#a78bfa")).toBe(-1);
  });

  it("'Ajustar contraste' arranca ENCENDIDO y accentWarning solo avisa con el toggle apagado", () => {
    // Almacén real en memoria: así `apply()` lee lo que el método acaba de escribir.
    const store: Record<string, string> = { "viurewards.theme": "night" };
    const app = makeApp("8787", {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
      },
    });
    // Default ENCENDIDO (sin clave guardada).
    expect(app.accentContrastFix).toBe(true);
    // Un acento de bajo contraste sobre el fondo de Noche: con el toggle encendido
    // NO se avisa (se corrige solo).
    (app.setAccent as (hex: string) => void).call(app, "#101018");
    expect(app.activeTheme).toBe("night");
    expect(app.accentWarning).toBe(false);
    // Al apagarlo, aparece el aviso de bajo contraste.
    (app.setAccentContrastFix as (n: boolean) => void).call(app, false);
    expect(app.accentContrastFix).toBe(false);
    expect(store["viurewards.accentContrastFix"]).toBe("false");
    expect(app.accentWarning).toBe(true);
    // Se enciende de nuevo y desaparece el aviso.
    (app.setAccentContrastFix as (n: boolean) => void).call(app, true);
    expect(store["viurewards.accentContrastFix"]).toBe("true");
    expect(app.accentWarning).toBe(false);
  });

  it("con el default encendido, el verde en Día no dispara la advertencia", () => {
    // El verde exacto contrasta poco sobre Día, pero con el toggle encendido se
    // corrige solo, así que no hay nada que avisar.
    const store: Record<string, string> = { "viurewards.theme": "day" };
    const app = makeApp("8787", {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
      },
    });
    (app.setAccent as (hex: string) => void).call(app, "#53fc18");
    expect(app.activeTheme).toBe("day");
    expect(app.accentContrastFix).toBe(true);
    expect(app.accentWarning).toBe(false);
  });

  it("Restablecer vuelve el acento al verde y el toggle a su default encendido", () => {
    const store: Record<string, string> = { "viurewards.theme": "night" };
    const app = makeApp("8787", {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = v;
      },
    });
    (app.setAccent as (hex: string) => void).call(app, "#123456");
    (app.setAccentContrastFix as (n: boolean) => void).call(app, false);
    (app.resetAccent as () => void).call(app);
    expect(app.accent).toBe("#53fc18");
    expect(app.accentContrastFix).toBe(true);
    expect(store["viurewards.accent"]).toBe("#53fc18");
    expect(store["viurewards.accentContrastFix"]).toBe("true");
  });

  it("accentContrastText devuelve el ratio con dos decimales", () => {
    const app = makeApp();
    (app.setAccent as (hex: string) => void).call(app, "#101018");
    expect(String(app.accentContrastText)).toMatch(/^\d+\.\d{2}$/);
  });

  it("el gris claro es un preset más y entra en la rueda de las flechas", () => {
    const app = makeApp();
    const palette = app.accentPalette as Array<{ id: string; hex: string }>;
    expect(palette).toHaveLength(7);
    expect(palette.some((color) => color.hex === "#d1d5db")).toBe(true);
    // Desde el último preset, la flecha hacia adelante vuelve al verde.
    (app.setAccent as (hex: string) => void).call(app, "#d1d5db");
    (app.cycleAccent as (hex: string, d: number) => void).call(app, "#d1d5db", 1);
    expect(app.accent).toBe("#53fc18");
  });
});
