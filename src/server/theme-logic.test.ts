/**
 * Prueba de LÓGICA de temas y acento (Parte 2).
 *
 * `web/theme.js` no es un módulo ES (es un script global, sin build). Para
 * probar sus funciones puras sin navegador se evalúa en un `vm` aislado con
 * stubs mínimos de `window`/`document`. Se ejercita el comportamiento real de
 * la corrección de contraste, la elección del color de texto, la variante por
 * tema, la validación del hex y la persistencia con localStorage que falla.
 *
 * Límite: no se prueba el DOM ni el pintado; eso queda para la prueba de humo
 * con navegador (docs/dashboard.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));

interface ThemeApi {
  isHex: (value: unknown) => boolean;
  normalizeHex: (value: unknown) => string | null;
  contrast: (a: string, b: string) => number;
  luminance: (hex: string) => number;
  inkFor: (hex: string) => string;
  hexToHsl: (hex: string) => { h: number; s: number; l: number };
  hslToHex: (hsl: { h: number; s: number; l: number }) => string;
  accentForTheme: (hex: string, theme: string, fixContrast?: boolean) => string;
  accentContrastRatio: (hex: string, theme: string) => number | null;
  accentContrastWarning: (hex: string, theme: string) => boolean;
  accentVars: (hex: string, theme: string, fixContrast?: boolean) => Record<string, string>;
  resolveTheme: (preference: string, prefersDark: boolean) => string;
  prefersDark: (matchMedia?: (q: string) => { matches: boolean }) => boolean;
  readTheme: (storage?: StorageLike) => string;
  writeTheme: (mode: string, storage?: StorageLike) => void;
  readAccent: (storage?: StorageLike) => string;
  writeAccent: (hex: string, storage?: StorageLike) => void;
  readContrastFix: (storage?: StorageLike) => boolean;
  writeContrastFix: (enabled: boolean, storage?: StorageLike) => void;
  apply: (doc?: unknown, storage?: StorageLike) => { theme: string; preference: string; accent: string; fixContrast: boolean };
  PALETTE: Array<{ id: string; label: string; hex: string }>;
  DEFAULT_ACCENT: string;
  THEMES: string[];
  THEME_BG: Record<string, string>;
  CONTRAST_KEY: string;
  ACCENT_MIN_CONTRAST: number;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function makeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

/** Carga theme.js en un vm y devuelve el objeto global `VIUTheme`. */
function loadTheme(options: { prefersDark?: boolean; storage?: StorageLike } = {}): ThemeApi {
  const storage = options.storage ?? makeStorage();
  const context = createContext({
    window: {
      localStorage: storage,
      matchMedia: (query: string) => ({ matches: query.includes("dark") ? options.prefersDark !== false : false }),
      dispatchEvent: () => {},
    },
    document: {
      documentElement: {
        _attrs: {} as Record<string, string>,
        _style: {} as Record<string, string>,
        getAttribute(this: { _attrs: Record<string, string> }, name: string) {
          return this._attrs[name] ?? null;
        },
        setAttribute(this: { _attrs: Record<string, string> }, name: string, value: string) {
          this._attrs[name] = value;
        },
        style: {
          setProperty(prop: string, value: string) {
            (context as never as { document: { documentElement: { _style: Record<string, string> } } })
              .document.documentElement._style[prop] = value;
          },
        },
      },
    },
    CustomEvent: function (this: { type: string; detail: unknown }, type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    },
    console,
    Math,
    Object,
    Number,
    String,
    Array,
    parseInt,
    Image: function () {
      return {};
    },
  });
  runInContext(readFileSync(join(webDir, "theme.js"), "utf8"), context);
  return runInContext("VIUTheme", context) as ThemeApi;
}

describe("temas y acento (lógica en vm)", () => {
  it("la paleta tiene 7 colores y el verde actual es el valor por defecto", () => {
    const theme = loadTheme();
    expect(theme.PALETTE).toHaveLength(7);
    expect(theme.PALETTE.map((color) => color.id)).toEqual([
      "green",
      "violet",
      "blue",
      "pink",
      "orange",
      "cyan",
      "gray",
    ]);
    // El gris claro es un preset más, pensado para OLED, con nombre accesible.
    const gray = theme.PALETTE.find((color) => color.id === "gray");
    expect(gray?.hex).toBe("#d1d5db");
    expect(gray?.label).toBe("Gris claro");
    expect(theme.PALETTE[0].hex).toBe("#53fc18");
    expect(theme.DEFAULT_ACCENT).toBe("#53fc18");
  });

  it("valida el hex #RRGGBB (con # opcional, mayúsculas) y rechaza lo demás", () => {
    const theme = loadTheme();
    expect(theme.isHex("#53fc18")).toBe(true);
    expect(theme.isHex("53FC18")).toBe(true);
    expect(theme.isHex("#FFF")).toBe(false);
    expect(theme.isHex("#12345")).toBe(false);
    expect(theme.isHex("#GGGGGG")).toBe(false);
    expect(theme.isHex("red")).toBe(false);
    expect(theme.isHex(null)).toBe(false);
    expect(theme.isHex(123)).toBe(false);
    expect(theme.normalizeHex("53FC18")).toBe("#53fc18");
    expect(theme.normalizeHex("#53fc18")).toBe("#53fc18");
    expect(theme.normalizeHex("nope")).toBeNull();
  });

  it("calcula el contraste WCAG con casos conocidos", () => {
    const theme = loadTheme();
    // Blanco sobre negro = 21:1; un color consigo mismo = 1:1.
    expect(theme.contrast("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(theme.contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(theme.contrast("#123456", "#123456")).toBeCloseTo(1, 5);
    // Referencia conocida: #767676 sobre #ffffff ≈ 4.54:1.
    expect(theme.contrast("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // La simetría del contraste.
    expect(theme.contrast("#53fc18", "#12141a")).toBeCloseTo(theme.contrast("#12141a", "#53fc18"), 5);
    // La luminancia del blanco es 1 y la del negro 0.
    expect(theme.luminance("#ffffff")).toBeCloseTo(1, 3);
    expect(theme.luminance("#000000")).toBeCloseTo(0, 3);
  });

  it("elige el color de texto sobre el acento por contraste (mínimo 4,5:1)", () => {
    const theme = loadTheme();
    // Acento claro -> texto negro; acento oscuro -> texto blanco.
    expect(theme.inkFor("#53fc18")).toBe("#000000");
    expect(theme.inkFor("#00004a")).toBe("#ffffff");
    // La tinta se calcula sobre el acento APLICADO (exacto o corregido) y con
    // cualquiera de los dos modos el par elegido supera 4,5:1.
    for (const color of theme.PALETTE) {
      for (const fixContrast of [false, true]) {
        const accent = theme.accentForTheme(color.hex, "night", fixContrast);
        const ink = theme.inkFor(accent);
        expect(theme.contrast(accent, ink)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("con 'Ajustar contraste' APAGADO aplica el hex EXACTO (verde en Día, gris claro en OLED)", () => {
    const theme = loadTheme();
    // El flag explícitamente apagado devuelve el hex tal cual, en todo tema.
    for (const color of theme.PALETTE) {
      for (const themeName of theme.THEMES) {
        expect(theme.accentForTheme(color.hex, themeName, false)).toBe(color.hex);
      }
    }
    // Casos puntuales pedidos: el verde y el gris claro, tal cual.
    expect(theme.accentForTheme("#53fc18", "day", false)).toBe("#53fc18");
    expect(theme.accentForTheme("#d1d5db", "oled", false)).toBe("#d1d5db");
    // La tinta sigue eligiéndose por contraste, independiente del flag.
    expect(theme.inkFor(theme.accentForTheme("#d1d5db", "oled", false))).toBe("#000000");
  });

  it("con el tercer argumento OMITIDO 'Ajustar contraste' se trata como ENCENDIDO", () => {
    const theme = loadTheme();
    // El default es corregir: omitir el flag equivale a encendido.
    for (const color of theme.PALETTE) {
      for (const themeName of theme.THEMES) {
        expect(theme.accentForTheme(color.hex, themeName)).toBe(theme.accentForTheme(color.hex, themeName, true));
      }
    }
    // El caso visible: el verde en Día se corrige y llega a 2:1.
    const accent = theme.accentForTheme("#53fc18", "day");
    expect(accent).not.toBe("#53fc18");
    expect(theme.contrast(accent, theme.THEME_BG.day)).toBeGreaterThanOrEqual(theme.ACCENT_MIN_CONTRAST);
  });

  it("con 'Ajustar contraste' corrige la luminosidad y alcanza 2:1 contra el fondo", () => {
    const theme = loadTheme();
    // El umbral vive en una constante única compartida por el aviso y la corrección.
    expect(theme.ACCENT_MIN_CONTRAST).toBe(2);
    for (const color of theme.PALETTE) {
      for (const themeName of theme.THEMES) {
        const accent = theme.accentForTheme(color.hex, themeName, true);
        expect(theme.isHex(accent)).toBe(true);
        const bg = theme.THEME_BG[themeName];
        expect(theme.contrast(accent, bg)).toBeGreaterThanOrEqual(theme.ACCENT_MIN_CONTRAST);
      }
    }
    // El verde en Día SÍ se corrige cuando el flag está encendido.
    expect(theme.accentForTheme("#53fc18", "day", true)).not.toBe("#53fc18");
    // Es determinística.
    expect(theme.accentForTheme("#a78bfa", "day", true)).toBe(theme.accentForTheme("#a78bfa", "day", true));
    // Un hex inválido cae al acento por defecto.
    expect(theme.accentForTheme("no", "night", true)).toBe(theme.accentForTheme(theme.DEFAULT_ACCENT, "night", true));
  });

  it("la corrección es la MÁS SUAVE: apenas supera 2:1 y no sobrecorrige", () => {
    const theme = loadTheme();
    // El verde en Día es el caso más visible: con el flag encendido se oscurece
    // solo lo justo para llegar al objetivo, no hasta un extremo oscuro.
    const fixedDay = theme.accentForTheme("#53fc18", "day", true);
    const ratioDay = theme.contrast(fixedDay, theme.THEME_BG.day);
    expect(ratioDay).toBeGreaterThanOrEqual(theme.ACCENT_MIN_CONTRAST);
    // Margen pequeño: no se pasa demasiado del objetivo (antes llegaba a 3:1).
    expect(ratioDay).toBeLessThan(theme.ACCENT_MIN_CONTRAST + 0.2);
    // El gris claro en Día también queda apenas por encima del objetivo.
    const fixedGray = theme.accentForTheme("#d1d5db", "day", true);
    const ratioGray = theme.contrast(fixedGray, theme.THEME_BG.day);
    expect(ratioGray).toBeGreaterThanOrEqual(theme.ACCENT_MIN_CONTRAST);
    expect(ratioGray).toBeLessThan(theme.ACCENT_MIN_CONTRAST + 0.2);
  });

  it("un acento que ya cumple el objetivo se devuelve IDÉNTICO con el flag encendido", () => {
    const theme = loadTheme();
    // El verde por defecto contrasta de sobra sobre Noche y OLED: no se toca.
    expect(theme.contrast(theme.DEFAULT_ACCENT, theme.THEME_BG.night)).toBeGreaterThanOrEqual(
      theme.ACCENT_MIN_CONTRAST,
    );
    expect(theme.accentForTheme(theme.DEFAULT_ACCENT, "night", true)).toBe(theme.DEFAULT_ACCENT);
    expect(theme.accentForTheme("#ffffff", "oled", true)).toBe("#ffffff");
    expect(theme.accentForTheme("#000000", "day", true)).toBe("#000000");
    // El gris claro ya contrasta de sobra sobre OLED (≈14:1): no se toca. Es
    // importante porque es un preset pensado para OLED.
    expect(theme.contrast("#d1d5db", theme.THEME_BG.oled)).toBeGreaterThanOrEqual(theme.ACCENT_MIN_CONTRAST);
    expect(theme.accentForTheme("#d1d5db", "oled", true)).toBe("#d1d5db");
  });

  it("avisa del contraste bajo solo con el acento exacto (ratio < objetivo)", () => {
    const theme = loadTheme();
    // Un violeta apenas visible sobre el fondo oscuro de Noche.
    expect(theme.accentContrastWarning("#101018", "night")).toBe(true);
    // El verde por defecto contrasta de sobra.
    expect(theme.accentContrastWarning(theme.DEFAULT_ACCENT, "night")).toBe(false);
    // El ratio se expone para el texto de la advertencia.
    expect(theme.accentContrastRatio("#101018", "night")).toBeLessThan(theme.ACCENT_MIN_CONTRAST);
    expect(theme.accentContrastRatio("#53fc18", "night")).toBeGreaterThan(theme.ACCENT_MIN_CONTRAST);
    expect(theme.accentContrastRatio("no-es-hex", "night")).toBeNull();
    // El gris claro apenas contrasta sobre Día (fondo claro): avisa ahí.
    expect(theme.accentContrastWarning("#d1d5db", "day")).toBe(true);
    // El umbral de la advertencia es el MISMO que el de la corrección: apenas
    // por debajo avisa y apenas por encima no, usando la constante compartida.
    const bg = theme.THEME_BG.night;
    const hsl = theme.hexToHsl(theme.DEFAULT_ACCENT);
    let below: string | null = null;
    let above: string | null = null;
    for (let i = 0; i <= 400; i += 1) {
      const candidate = theme.hslToHex({ h: hsl.h, s: hsl.s, l: i / 400 });
      const ratio = theme.contrast(candidate, bg);
      if (ratio < theme.ACCENT_MIN_CONTRAST) below = candidate;
      else if (above === null) above = candidate;
    }
    expect(below).not.toBeNull();
    expect(above).not.toBeNull();
    expect(theme.accentContrastWarning(below as string, "night")).toBe(true);
    expect(theme.accentContrastWarning(above as string, "night")).toBe(false);
  });

  it("deriva las variables del acento (base, texto, hover, fondo suave)", () => {
    const theme = loadTheme();
    // Sin el flag (default ENCENDIDO), la base es la variante corregida; el verde
    // en Noche ya cumple 2:1, así que coincide con el hex.
    const vars = theme.accentVars("#53fc18", "night");
    expect(vars["--color-accent"]).toBe(theme.accentForTheme("#53fc18", "night"));
    expect(theme.isHex(vars["--color-accent-hover"])).toBe(true);
    expect(theme.isHex(vars["--color-accent-soft"])).toBe(true);
    expect(theme.isHex(vars["--color-accent-soft-border"])).toBe(true);
    // Explícitamente apagado, la base es el hex EXACTO.
    expect(theme.accentVars("#53fc18", "day", false)["--color-accent"]).toBe("#53fc18");
    // Con el flag, la base es la variante corregida.
    const fixed = theme.accentVars("#53fc18", "day", true);
    expect(fixed["--color-accent"]).toBe(theme.accentForTheme("#53fc18", "day", true));
    // El texto sobre el acento es blanco o negro, siempre por contraste.
    expect(["#000000", "#ffffff"]).toContain(vars["--color-accent-ink"]);
    expect(vars["--color-accent-ink"]).toBe(theme.inkFor(vars["--color-accent"]));
    expect(vars["--color-focus"]).toBe(vars["--color-accent"]);
  });

  it("resuelve el tema: Automático sigue al sistema (oscuro -> Noche, no OLED)", () => {
    const theme = loadTheme();
    expect(theme.resolveTheme("auto", true)).toBe("night");
    expect(theme.resolveTheme("auto", false)).toBe("day");
    expect(theme.resolveTheme("oled", false)).toBe("oled");
    expect(theme.resolveTheme("day", true)).toBe("day");
  });

  it("lee el tema y el acento con valores inválidos (cae al valor por defecto)", () => {
    const theme = loadTheme();
    const storage = makeStorage({
      "viurewards.theme": "neon-inventado",
      "viurewards.accent": "no-es-hex",
    });
    expect(theme.readTheme(storage)).toBe("auto");
    expect(theme.readAccent(storage)).toBe(theme.DEFAULT_ACCENT);
    // Guardar valores válidos y volver a leerlos.
    theme.writeTheme("oled", storage);
    theme.writeAccent("#ff00ff", storage);
    expect(theme.readTheme(storage)).toBe("oled");
    expect(theme.readAccent(storage)).toBe("#ff00ff");
    // Un modo de tema inválido no se guarda.
    theme.writeTheme("neon", storage);
    expect(theme.readTheme(storage)).toBe("oled");
  });

  it("persiste aunque localStorage lance (no rompe la app)", () => {
    const theme = loadTheme();
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(theme.readTheme(throwing)).toBe("auto");
    expect(theme.readAccent(throwing)).toBe(theme.DEFAULT_ACCENT);
    // Si localStorage no está disponible, "Ajustar contraste" se asume encendido.
    expect(theme.readContrastFix(throwing)).toBe(true);
    expect(() => theme.writeTheme("day", throwing)).not.toThrow();
    expect(() => theme.writeAccent("#123456", throwing)).not.toThrow();
    expect(() => theme.writeContrastFix(true, throwing)).not.toThrow();
  });

  it("lee y escribe 'Ajustar contraste' (por defecto ENCENDIDO; tolera valores raros)", () => {
    const theme = loadTheme();
    const storage = makeStorage();
    // Sin nada guardado, ENCENDIDO.
    expect(theme.readContrastFix(storage)).toBe(true);
    // Solo un apagado explícito lo desactiva.
    storage.data[theme.CONTRAST_KEY] = "false";
    expect(theme.readContrastFix(storage)).toBe(false);
    storage.data[theme.CONTRAST_KEY] = "0";
    expect(theme.readContrastFix(storage)).toBe(false);
    storage.data[theme.CONTRAST_KEY] = "off";
    expect(theme.readContrastFix(storage)).toBe(false);
    // "1" y cualquier valor basura se leen como encendido.
    storage.data[theme.CONTRAST_KEY] = "1";
    expect(theme.readContrastFix(storage)).toBe(true);
    storage.data[theme.CONTRAST_KEY] = "true";
    expect(theme.readContrastFix(storage)).toBe(true);
    storage.data[theme.CONTRAST_KEY] = "basura";
    expect(theme.readContrastFix(storage)).toBe(true);
    // Escribir y volver a leer.
    theme.writeContrastFix(false, storage);
    expect(theme.readContrastFix(storage)).toBe(false);
    theme.writeContrastFix(true, storage);
    expect(theme.readContrastFix(storage)).toBe(true);
  });

  it("aplica el tema y el acento al elemento raíz sin lanzar", () => {
    const theme = loadTheme({ storage: makeStorage({ "viurewards.theme": "day" }) });
    const result = theme.apply();
    expect(result.theme).toBe("day");
    expect(["night", "oled", "day"]).toContain(result.theme);
    expect(theme.isHex(result.accent)).toBe(true);
    // Sin clave guardada, el default es encendido.
    expect(result.fixContrast).toBe(true);
  });

  it("apply devuelve fixContrast y respeta el flag guardado", () => {
    const off = loadTheme({ storage: makeStorage({ "viurewards.accentContrastFix": "false" }) });
    expect(off.apply().fixContrast).toBe(false);
    const on = loadTheme({ storage: makeStorage({ "viurewards.accentContrastFix": "true" }) });
    expect(on.apply().fixContrast).toBe(true);
  });

  it("si el DOM falla, apply devuelve el tema por defecto sin lanzar", () => {
    const theme = loadTheme();
    const broken = {
      documentElement: {
        setAttribute: () => {
          throw new Error("sin DOM");
        },
      },
    };
    const result = theme.apply(broken);
    expect(result).toEqual({ theme: "night", preference: "auto", accent: theme.DEFAULT_ACCENT, fixContrast: true });
  });
});
