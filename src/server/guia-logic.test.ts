/**
 * Lógica de la guía pública (`/guia`) sin navegador.
 *
 * `web/guia.js` no es un módulo ES (es un script global para Alpine, sin build).
 * Se evalúa en un `vm` aislado con stubs mínimos de `window`/`document`/`fetch`
 * y se instancia el componente con `guideApp()`, así se ejercita el
 * comportamiento real:
 * - la redirect URI con el puerto de la barra de direcciones (vacío = 80);
 * - la convención de capturas (el NN del nombre es el NÚMERO DE PASO y un paso
 *   puede tener varias);
 * - el botón "Copiar" con un portapapeles que falla;
 * - el visor: se cierra con Esc, devuelve el foco al botón y atrapa el Tab;
 * - el desplazamiento al ancla de la URL tras montar la página.
 *
 * Límite: no se prueba el render ni Alpine de verdad; eso queda para el humo
 * con navegador (docs/dashboard.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));

interface FakeElement {
  id?: string;
  offsetParent: unknown;
  attributes: Record<string, string>;
  focus: () => void;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  scrollIntoView: () => void;
}

interface Ctx {
  window: { location: { port: string; hash: string } };
  document: {
    getElementById: (id: string) => FakeElement | null;
    querySelector: (selector: string) => FakeElement | null;
    body: { appendChild: () => void; removeChild: () => void };
    createElement: () => FakeElement;
    execCommand: () => boolean;
    activeElement: FakeElement | null;
  };
  navigator: { clipboard: { writeText: () => Promise<void> } };
  fetch: () => Promise<unknown>;
  setTimeout: typeof setTimeout;
  console: Console;
}

/** Instancia el componente con la lista de capturas que "existe" en el server. */
function makeGuide(
  options: { port?: string; hash?: string; shots?: string[]; clipboardFails?: boolean; execCommand?: () => boolean } = {},
): Record<string, unknown> {
  const shots = options.shots ?? [];
  // Ids de los pasos: existen como bloques desplazables.
  const elements: Record<string, FakeElement> = {};
  const scrolled: string[] = [];

  function makeElement(id?: string): FakeElement {
    const element: FakeElement = {
      id,
      offsetParent: {},
      attributes: {},
      focus: () => {
        context.document.activeElement = element;
      },
      setAttribute: (name, value) => {
        element.attributes[name] = value;
      },
      getAttribute: (name) => (name in element.attributes ? element.attributes[name] : null),
      scrollIntoView: () => {
        scrolled.push(id ?? "?");
      },
    };
    return element;
  }

  for (let n = 1; n <= 6; n += 1) elements[`guia-paso-${n}`] = makeElement(`guia-paso-${n}`);

  const context = createContext({
    window: {
      location: { port: options.port ?? "", hash: options.hash ?? "" },
      // El visor busca el botón que lo abrió.
      __opener: null,
    },
    document: {
      getElementById: (id: string) => (id in elements ? elements[id] : null),
      querySelector: (selector: string) =>
        selector.indexOf(".guide-shot-open") === 0
          ? ((context.window as { __opener: FakeElement | null }).__opener ?? null)
          : null,
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => makeElement(),
      execCommand: options.execCommand ?? (() => true),
      activeElement: null,
    },
    navigator: {
      clipboard: {
        writeText: options.clipboardFails ? () => Promise.reject(new Error("bloqueado")) : () => Promise.resolve(),
      },
    },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, shots }) }),
    setTimeout,
    clearTimeout,
    console,
  });

  runInContext(readFileSync(join(webDir, "guia.js"), "utf8"), context);
  const app = runInContext("guideApp()", context) as Record<string, unknown>;
  // Ayudas de prueba.
  app.__opener = (element: FakeElement) => {
    (context.window as unknown as { __opener: FakeElement }).__opener = element;
  };
  app.__scrolled = scrolled;
  app.__setActiveElement = (element: FakeElement) => {
    context.document.activeElement = element;
  };
  return app;
}

type App = Record<string, unknown>;

describe("guía: redirect URI según el puerto", () => {
  it("sin puerto en la URL usa 80, siempre en localhost", async () => {
    const app = makeGuide({ port: "" });
    await (app.init as () => Promise<void>)();
    expect(app.port).toBe("80");
    expect(app.redirectUri).toBe("http://localhost:80/callback");
  });

  it("con el puerto 8787 lo usa tal cual", async () => {
    const app = makeGuide({ port: "8787" });
    await (app.init as () => Promise<void>)();
    expect(app.redirectUri).toBe("http://localhost:8787/callback");
  });

  it("con otro puerto también, con /callback sin barra final y sin 127.0.0.1", async () => {
    const app = makeGuide({ port: "3000" });
    await (app.init as () => Promise<void>)();
    expect(app.redirectUri).toBe("http://localhost:3000/callback");
    expect(app.redirectUri).not.toMatch(/\/callback\/$/);
    expect(app.redirectUri).not.toContain("127.0.0.1");
  });
});

describe("guía: convención de capturas (NN = número de paso)", () => {
  const stepShots = (app: App, id: string) => (app.stepShots as (id: string) => string[])(id);
  const hasShots = (app: App, id: string) => (app.hasShots as (id: string) => boolean)(id);

  it("agrupa por número de paso y conserva el orden del servidor", async () => {
    const app = makeGuide({
      shots: [
        "guia-01-kick-developer.png",
        "guia-02-crear-app.png",
        "guia-02-redirect-url.png",
        "guia-03-credenciales.png",
        "guia-07-problemas.png",
      ],
    });
    await (app.init as () => Promise<void>)();
    expect(stepShots(app, "guia-paso-1")).toEqual(["guia-01-kick-developer.png"]);
    expect(stepShots(app, "guia-paso-2")).toEqual(["guia-02-crear-app.png", "guia-02-redirect-url.png"]);
    expect(stepShots(app, "guia-paso-3")).toEqual(["guia-03-credenciales.png"]);
    expect(stepShots(app, "guia-paso-4")).toEqual([]);
    // Las preguntas frecuentes son el "paso 7" y no se mezclan con los pasos.
    expect(stepShots(app, "guia-paso-7")).toEqual(["guia-07-problemas.png"]);
    expect(hasShots(app, "guia-paso-4")).toBe(false);
    expect(hasShots(app, "guia-paso-3")).toBe(true);
  });

  it("un nombre viejo con el número equivocado no cae en el paso equivocado", async () => {
    // `guia-04-credenciales.png` (convención vieja) pertenece al paso 4, no al 3.
    const app = makeGuide({ shots: ["guia-04-credenciales.png"] });
    await (app.init as () => Promise<void>)();
    expect(stepShots(app, "guia-paso-3")).toEqual([]);
    expect(stepShots(app, "guia-paso-4")).toEqual(["guia-04-credenciales.png"]);
  });

  it("sin capturas (carpeta vacía) no muestra ningún bloque y no falla", async () => {
    const app = makeGuide({ shots: [] });
    await (app.init as () => Promise<void>)();
    for (let n = 1; n <= 6; n += 1) expect(hasShots(app, `guia-paso-${n}`)).toBe(false);
    expect(app.shots).toEqual([]);
  });

  it("si el endpoint falla, la página queda sin capturas (no se rompe)", async () => {
    const context = createContext({
      window: { location: { port: "8787", hash: "" } },
      document: {
        getElementById: () => null,
        querySelector: () => null,
        body: { appendChild: () => {}, removeChild: () => {} },
        createElement: () => ({}),
        execCommand: () => false,
        activeElement: null,
      },
      fetch: () => Promise.reject(new Error("sin red")),
      setTimeout,
      console,
    });
    runInContext(readFileSync(join(webDir, "guia.js"), "utf8"), context);
    const app = runInContext("guideApp()", context) as App;
    await (app.init as () => Promise<void>)();
    expect(app.shots).toEqual([]);
    for (let n = 1; n <= 6; n += 1) expect(hasShots(app, `guia-paso-${n}`)).toBe(false);
  });
});

describe("guía: botón Copiar", () => {
  it("copia con la API del portapapeles y avisa Copiado", async () => {
    const app = makeGuide();
    await (app.init as () => Promise<void>)();
    await (app.copyRedirect as () => Promise<void>)();
    expect(app.copyMessage).toBe("Copiado");
  });

  it("si el portapapeles falla y el respaldo también, avisa cómo copiar a mano", async () => {
    const app = makeGuide({ clipboardFails: true, execCommand: () => false });
    await (app.init as () => Promise<void>)();
    await (app.copyRedirect as () => Promise<void>)();
    expect(app.copyMessage).toMatch(/No se pudo copiar/);
  });
});

describe("guía: visor de capturas", () => {
  /** Botón que abre el visor, con foco observable. */
  function makeOpener(): { focus: () => void; focused: () => boolean; attributes: Record<string, string> } {
    const state = { focused: false };
    const attributes: Record<string, string> = {};
    return {
      focus: () => {
        state.focused = true;
      },
      focused: () => state.focused,
      attributes,
    };
  }

  function register(app: App, opener: { focus: () => void; attributes: Record<string, string> }): void {
    const element = {
      offsetParent: {},
      focus: opener.focus,
      setAttribute: (name: string, value: string) => {
        opener.attributes[name] = value;
      },
      getAttribute: (name: string) => (name in opener.attributes ? opener.attributes[name] : null),
      scrollIntoView: () => {},
    };
    (app.__opener as (el: unknown) => void)(element);
  }

  it("abre con la URL y el alt, y al cerrar devuelve el foco al botón", async () => {
    const app = makeGuide();
    await (app.init as () => Promise<void>)();
    const opener = makeOpener();
    register(app, opener);
    (app.openLightbox as (url: string, alt: string) => void)("/web/assets/guide/guia-03-credenciales.png", "alt");
    expect(app.lightboxSrc).toBe("/web/assets/guide/guia-03-credenciales.png");
    expect(app.lightboxAlt).toBe("alt");
    (app.closeLightbox as () => void)();
    expect(app.lightboxSrc).toBe("");
    expect(app.lightboxAlt).toBe("");
    expect(opener.attributes["aria-expanded"]).toBe("false");
    expect(opener.focused()).toBe(true);
  });

  it("no abre sin URL y cerrar dos veces no falla", async () => {
    const app = makeGuide();
    await (app.init as () => Promise<void>)();
    (app.openLightbox as (url: string, alt: string) => void)("", "");
    expect(app.lightboxSrc).toBe("");
    (app.closeLightbox as () => void)();
    (app.closeLightbox as () => void)();
    expect(app.lightboxSrc).toBe("");
  });

  it("el clic en el fondo cierra y el clic en la imagen no", async () => {
    const app = makeGuide();
    await (app.init as () => Promise<void>)();
    (app.openLightbox as (url: string, alt: string) => void)("/x.png", "x");
    const backdrop = {};
    (app.closeLightboxBackdrop as (e: unknown) => void)({ target: {}, currentTarget: backdrop });
    expect(app.lightboxSrc).toBe("/x.png");
    (app.closeLightboxBackdrop as (e: unknown) => void)({ target: backdrop, currentTarget: backdrop });
    expect(app.lightboxSrc).toBe("");
  });

  it("la trampa de foco lleva el Tab del último al primero y viceversa", async () => {
    const app = makeGuide();
    await (app.init as () => Promise<void>)();
    let focused = "";
    const first = { disabled: false, offsetParent: {}, focus: () => (focused = "first") };
    const last = { disabled: false, offsetParent: {}, focus: () => (focused = "last") };
    const container = { querySelectorAll: () => [first, last] };
    const trap = app.trapLightboxFocus as (e: unknown) => boolean;

    // Con el foco en el primero y Shift+Tab, va al último.
    (app.__setActiveElement as (el: unknown) => void)(first);
    trap({ key: "Tab", shiftKey: true, currentTarget: container, preventDefault: () => {} });
    expect(focused).toBe("last");

    // Con el foco en el último y Tab, va al primero.
    (app.__setActiveElement as (el: unknown) => void)(last);
    trap({ key: "Tab", shiftKey: false, currentTarget: container, preventDefault: () => {} });
    expect(focused).toBe("first");

    // Otra tecla no hace nada.
    focused = "";
    trap({ key: "Escape", shiftKey: false, currentTarget: container, preventDefault: () => {} });
    expect(focused).toBe("");
  });
});

describe("guía: ancla de la URL (Parte 3)", () => {
  it("si la URL trae #guia-paso-3, lleva ese bloque a la vista al montar", async () => {
    const app = makeGuide({ hash: "#guia-paso-3" });
    await (app.init as () => Promise<void>)();
    expect(app.__scrolled).toEqual(["guia-paso-3"]);
  });

  it("ignora un ancla inexistente y la ausencia de hash (sin errores)", async () => {
    const missing = makeGuide({ hash: "#no-existe" });
    await (missing.init as () => Promise<void>)();
    expect(missing.__scrolled).toEqual([]);

    const none = makeGuide({ hash: "" });
    await (none.init as () => Promise<void>)();
    expect(none.__scrolled).toEqual([]);
  });
});
