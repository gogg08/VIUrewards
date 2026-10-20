/* VIUrewards — temas, color de acento y logo por tema (Parte 2).
   Sin dependencias y sin paso de build. Se carga SÍNCRONAMENTE en el <head> de
   index.html y login.html, antes de pintar, para que no haya destello al cargar:
   define `data-theme` y las variables del acento en <html> y el resto de la
   página ya pinta con el tema correcto. Al ser chico y sin dependencias, un
   script bloqueante en el head no afecta la percepción de carga.

   Todo lo que es decisión (contraste, elección del color de texto sobre el
   acento, corrección de luminosidad por tema, validación del hex, lectura y
   escritura de la preferencia) vive acá como función pura y se prueba en
   `src/server/theme-logic.test.ts`. */

// Preferencia del tema y del acento: viven en el localStorage de ESTE navegador,
// no en la base (el tema es una preferencia de pantalla, no de la instalación).
var VIU_THEME_KEY = "viurewards.theme";
var VIU_ACCENT_KEY = "viurewards.accent";
// "Ajustar contraste" (booleano): por defecto ENCENDIDO, así el acento elegido
// se corrige solo si no llega a 2:1 contra el fondo. Solo un valor explícito de
// apagado lo desactiva.
var VIU_CONTRAST_KEY = "viurewards.accentContrastFix";

// Temas. "auto" sigue al sistema; el resto son valores de `data-theme`.
var VIU_THEME_MODES = ["auto", "night", "oled", "day"];
var VIU_THEMES = ["night", "oled", "day"];

// Paleta de acento predefinida. El verde actual es el valor por defecto y no
// debe cambiar de aspecto. "Gris claro" está pensado para OLED.
var VIU_ACCENT_PALETTE = [
  { id: "green", label: "Verde", hex: "#53fc18" },
  { id: "violet", label: "Violeta", hex: "#a78bfa" },
  { id: "blue", label: "Azul", hex: "#60a5fa" },
  { id: "pink", label: "Rosa", hex: "#f472b6" },
  { id: "orange", label: "Naranja", hex: "#fb923c" },
  { id: "cyan", label: "Cian", hex: "#22d3ee" },
  { id: "gray", label: "Gris claro", hex: "#d1d5db" },
];
var VIU_ACCENT_DEFAULT = "#53fc18";

// Fondo base de cada tema. El acento se corrige contra este color para que se
// vea legible; también es el color con el que se mide el contraste del acento.
var VIU_THEME_BG = {
  night: "#12141a",
  oled: "#000000",
  day: "#f1efe9",
};

function viuClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** ¿Es un hex #RRGGBB válido? (Se acepta con o sin #, mayúsculas o minúsculas.) */
function viuIsHex(value) {
  return typeof value === "string" && /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

/** Normaliza a `#rrggbb` (minúsculas, con #); null si no es un hex válido. */
function viuNormalizeHex(value) {
  if (!viuIsHex(value)) return null;
  var hex = value.trim().replace(/^#/, "").toLowerCase();
  return "#" + hex;
}

/** #rrggbb -> { r, g, b } (0..255). Asume un hex ya normalizado. */
function viuHexToRgb(hex) {
  var value = hex.replace(/^#/, "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** { r, g, b } (0..255) -> #rrggbb. */
function viuRgbToHex(rgb) {
  var toHex = function (channel) {
    return viuClamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0");
  };
  return "#" + toHex(rgb.r) + toHex(rgb.g) + toHex(rgb.b);
}

/** Canal sRGB (0..1) -> lineal, como pide la WCAG. */
function viuLinearChannel(channel) {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Luminancia relativa (WCAG 2.x) de un #rrggbb. */
function viuLuminance(hex) {
  var rgb = viuHexToRgb(hex);
  var r = viuLinearChannel(rgb.r / 255);
  var g = viuLinearChannel(rgb.g / 255);
  var b = viuLinearChannel(rgb.b / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Relación de contraste WCAG entre dos #rrggbb (1..21). */
function viuContrast(a, b) {
  var la = viuLuminance(a);
  var lb = viuLuminance(b);
  var lighter = Math.max(la, lb);
  var darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Color de texto sobre el acento: negro o blanco, el que dé mejor contraste.
 * (Igual se exige un mínimo razonable; con la corrección por tema el acento
 * siempre queda en un rango donde alguno de los dos supera 4,5:1.)
 */
function viuInkFor(accentHex) {
  var black = "#000000";
  var white = "#ffffff";
  return viuContrast(accentHex, black) >= viuContrast(accentHex, white) ? black : white;
}

/** #rrggbb -> { h, s, l } con h en grados (0..360) y s, l en 0..1. */
function viuHexToHsl(hex) {
  var rgb = viuHexToRgb(hex);
  var r = rgb.r / 255;
  var g = rgb.g / 255;
  var b = rgb.b / 255;
  var max = Math.max(r, g, b);
  var min = Math.min(r, g, b);
  var delta = max - min;
  var l = (max + min) / 2;
  var h = 0;
  var s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h: h, s: s, l: l };
}

/** { h, s, l } -> #rrggbb. */
function viuHslToHex(hsl) {
  var h = ((hsl.h % 360) + 360) % 360;
  var s = viuClamp(hsl.s, 0, 1);
  var l = viuClamp(hsl.l, 0, 1);
  var c = (1 - Math.abs(2 * l - 1)) * s;
  var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  var m = l - c / 2;
  var rgb;
  if (h < 60) rgb = { r: c, g: x, b: 0 };
  else if (h < 120) rgb = { r: x, g: c, b: 0 };
  else if (h < 180) rgb = { r: 0, g: c, b: x };
  else if (h < 240) rgb = { r: 0, g: x, b: c };
  else if (h < 300) rgb = { r: x, g: 0, b: c };
  else rgb = { r: c, g: 0, b: x };
  return viuRgbToHex({
    r: (rgb.r + m) * 255,
    g: (rgb.g + m) * 255,
    b: (rgb.b + m) * 255,
  });
}

/**
 * Contraste mínimo (WCAG para componentes y texto grande) que persigue
 * "Ajustar contraste" y que dispara la advertencia cuando el toggle está
 * apagado. Es una constante ÚNICA para que el aviso y la corrección sean
 * coherentes. Deliberadamente suave: solo se busca que el acento se distinga
 * del fondo, no la legibilidad de texto (2:1 es el mínimo de contraste no
 * textual de WCAG 1.4.11/1.4.3 para elementos de interfaz).
 */
var VIU_ACCENT_MIN_CONTRAST = 2.0;

/**
 * Variante del acento para un tema. Con `fixContrast` APAGADO (solo si se pasa
 * explícitamente apagado) el acento se aplica EXACTO: misma tonalidad, misma
 * saturación, misma luminosidad. Con `fixContrast` ENCENDIDO —y también si se
 * omite, porque es el comportamiento por defecto— se aplica la corrección MÁS
 * SUAVE posible: si el acento ya alcanza `VIU_ACCENT_MIN_CONTRAST` contra el
 * fondo del tema, se devuelve idéntico; si no, se aparta la luminosidad
 * (manteniendo tono y saturación) por pasos pequeños hasta alcanzar el objetivo,
 * con el MENOR desplazamiento necesario (hacia arriba en temas oscuros, hacia
 * abajo en Día). Es pura: el mismo hex, tema y flag dan siempre el mismo
 * resultado.
 */
function viuAccentForTheme(accentHex, theme, fixContrast) {
  var normalized = viuNormalizeHex(accentHex) || VIU_ACCENT_DEFAULT;
  // Por defecto (tercer argumento omitido) el contraste SE AJUSTA.
  if (fixContrast === false) return normalized;

  var bg = VIU_THEME_BG[theme] || VIU_THEME_BG.night;
  // Si ya cumple el objetivo, el acento no se toca en absoluto.
  if (viuContrast(normalized, bg) >= VIU_ACCENT_MIN_CONTRAST) return normalized;

  var hsl = viuHexToHsl(normalized);
  // Se parte de la luminosidad REAL del acento (no de un objetivo por tema):
  // así el desplazamiento es el mínimo imprescindible.
  var make = function (l) {
    return viuHslToHex({ h: hsl.h, s: hsl.s, l: viuClamp(l, 0, 1) });
  };

  // En fondos oscuros se aclara (acercándose al blanco) y en fondos claros se
  // oscurece, que es lo que siempre sube el contraste con estos fondos.
  var direction = viuLuminance(bg) < 0.5 ? 1 : -1;
  var step = 0.005;
  var l = hsl.l;
  var candidate = normalized;
  for (var i = 0; i < 200; i++) {
    l = viuClamp(l + direction * step, 0, 1);
    candidate = make(l);
    if (viuContrast(candidate, bg) >= VIU_ACCENT_MIN_CONTRAST) return candidate;
    if ((direction > 0 && l >= 1) || (direction < 0 && l <= 0)) break;
  }
  return candidate;
}

/**
 * Relación de contraste del acento EXACTO contra el fondo del tema (sin
 * corregir). Es la que se muestra en la advertencia cuando "Ajustar contraste"
 * está apagado. Devuelve null si el hex no es válido.
 */
function viuAccentContrastRatio(accentHex, theme) {
  var normalized = viuNormalizeHex(accentHex);
  if (!normalized) return null;
  var bg = VIU_THEME_BG[theme] || VIU_THEME_BG.night;
  return viuContrast(normalized, bg);
}

/** ¿El acento (tal cual, sin corregir) contrasta poco contra el fondo del tema? */
function viuAccentContrastWarning(accentHex, theme) {
  var ratio = viuAccentContrastRatio(accentHex, theme);
  return ratio !== null && ratio < VIU_ACCENT_MIN_CONTRAST;
}

/** Tema efectivo a partir de la preferencia y el sistema. */
function viuResolveTheme(preference, prefersDark) {
  if (preference === "night" || preference === "oled" || preference === "day") return preference;
  // Automático: oscuro -> Noche (no OLED); claro -> Día.
  return prefersDark ? "night" : "day";
}

/** Lee el tema guardado; si falta o es inválido, "auto". */
function viuReadTheme(storage) {
  try {
    var value = (storage || window.localStorage).getItem(VIU_THEME_KEY);
    return VIU_THEME_MODES.indexOf(value) !== -1 ? value : "auto";
  } catch (error) {
    return "auto";
  }
}

/** Guarda el tema; si no se puede, no falla. */
function viuWriteTheme(mode, storage) {
  if (VIU_THEME_MODES.indexOf(mode) === -1) return;
  try {
    (storage || window.localStorage).setItem(VIU_THEME_KEY, mode);
  } catch (error) {
    /* No poder guardar no debe romper la app. */
  }
}

/** Lee el acento guardado; si falta o es inválido, el verde por defecto. */
function viuReadAccent(storage) {
  try {
    var value = (storage || window.localStorage).getItem(VIU_ACCENT_KEY);
    return viuNormalizeHex(value) || VIU_ACCENT_DEFAULT;
  } catch (error) {
    return VIU_ACCENT_DEFAULT;
  }
}

/** Guarda el acento (solo si es un hex válido); si no se puede, no falla. */
function viuWriteAccent(accentHex, storage) {
  var normalized = viuNormalizeHex(accentHex);
  if (!normalized) return;
  try {
    (storage || window.localStorage).setItem(VIU_ACCENT_KEY, normalized);
  } catch (error) {
    /* No poder guardar no debe romper la app. */
  }
}

/** Lee "Ajustar contraste". Por defecto APAGADO; solo el literal "true" lo enciende. */
function viuReadContrastFix(storage) {
  try {
    // Default ENCENDIDO: solo un apagado explícito ("false"/"0"/"off") lo
    // desactiva; clave ausente o valor inválido se leen como encendido.
    var raw = (storage || window.localStorage).getItem(VIU_CONTRAST_KEY);
    return !(raw === "false" || raw === "0" || raw === "off");
  } catch (error) {
    // Si localStorage no está disponible, también se asume encendido.
    return true;
  }
}

/** Guarda "Ajustar contraste"; si no se puede, no falla. */
function viuWriteContrastFix(enabled, storage) {
  try {
    (storage || window.localStorage).setItem(VIU_CONTRAST_KEY, enabled ? "true" : "false");
  } catch (error) {
    /* No poder guardar no debe romper la app. */
  }
}

/** `prefers-color-scheme: dark` del sistema (falso si no se puede consultar). */
function viuPrefersDark(matchMedia) {
  try {
    var query = matchMedia || window.matchMedia;
    return query("(prefers-color-scheme: dark)").matches;
  } catch (error) {
    return true;
  }
}

/**
 * Variables CSS del acento para un tema: el acento (exacto o corregido según
 * `fixContrast`), el color de texto sobre él y las variantes derivadas (hover,
 * activo, fondo suave, borde). Se calculan acá para no depender de `color-mix()`
 * (soporte desparejo) y quedan como variables que el CSS ya usa. La tinta sobre
 * el acento (`--color-accent-ink`) se elige por contraste SIEMPRE, sin importar
 * el flag.
 */
function viuAccentVars(accentHex, theme, fixContrast) {
  var base = viuAccentForTheme(accentHex, theme, fixContrast);
  var hsl = viuHexToHsl(base);
  var lighten = theme === "day" ? -0.08 : 0.08;
  var hover = viuHslToHex({ h: hsl.h, s: hsl.s, l: viuClamp(hsl.l + lighten, 0, 1) });
  var active = viuHslToHex({ h: hsl.h, s: hsl.s, l: viuClamp(hsl.l - lighten, 0, 1) });
  var soft = viuHslToHex({ h: hsl.h, s: hsl.s, l: theme === "day" ? 0.9 : 0.22 });
  var softBorder = viuHslToHex({ h: hsl.h, s: hsl.s, l: theme === "day" ? 0.78 : 0.34 });
  return {
    "--color-accent": base,
    "--color-accent-hover": hover,
    "--color-accent-active": active,
    "--color-accent-soft": soft,
    "--color-accent-soft-border": softBorder,
    "--color-accent-ink": viuInkFor(base),
    "--color-focus": base,
  };
}

/**
 * Aplica el tema y el acento a un elemento (por defecto <html>): pone
 * `data-theme` y las variables del acento. Pura respecto del DOM salvo por el
 * `setProperty`/`setAttribute`. Nunca lanza: si algo falla, el tema por defecto.
 */
function viuApplyPreferences(doc, storage) {
  try {
    var target = (doc || document).documentElement;
    var preference = viuReadTheme(storage);
    var theme = viuResolveTheme(preference, viuPrefersDark());
    var accent = viuReadAccent(storage);
    var fixContrast = viuReadContrastFix(storage);
    var previous = target.getAttribute("data-theme");
    target.setAttribute("data-theme", theme);
    var vars = viuAccentVars(accent, theme, fixContrast);
    for (var name in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, name)) target.style.setProperty(name, vars[name]);
    }
    // Avisa a los componentes (el logo cambia de juego sin parpadear).
    try {
      if (previous !== theme && typeof window !== "undefined" && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent("viu-theme-change", { detail: { theme: theme } }));
      }
    } catch (error) {
      /* Sin CustomEvent: no es crítico. */
    }
    return { theme: theme, preference: preference, accent: accent, fixContrast: fixContrast };
  } catch (error) {
    return { theme: "night", preference: "auto", accent: VIU_ACCENT_DEFAULT, fixContrast: true };
  }
}

var VIUTheme = {
  KEY: VIU_THEME_KEY,
  ACCENT_KEY: VIU_ACCENT_KEY,
  CONTRAST_KEY: VIU_CONTRAST_KEY,
  MODES: VIU_THEME_MODES,
  THEMES: VIU_THEMES,
  PALETTE: VIU_ACCENT_PALETTE,
  DEFAULT_ACCENT: VIU_ACCENT_DEFAULT,
  ACCENT_MIN_CONTRAST: VIU_ACCENT_MIN_CONTRAST,
  THEME_BG: VIU_THEME_BG,
  isHex: viuIsHex,
  normalizeHex: viuNormalizeHex,
  contrast: viuContrast,
  luminance: viuLuminance,
  inkFor: viuInkFor,
  hexToHsl: viuHexToHsl,
  hslToHex: viuHslToHex,
  accentForTheme: viuAccentForTheme,
  accentContrastRatio: viuAccentContrastRatio,
  accentContrastWarning: viuAccentContrastWarning,
  accentVars: viuAccentVars,
  resolveTheme: viuResolveTheme,
  prefersDark: viuPrefersDark,
  readTheme: viuReadTheme,
  writeTheme: viuWriteTheme,
  readAccent: viuReadAccent,
  writeAccent: viuWriteAccent,
  readContrastFix: viuReadContrastFix,
  writeContrastFix: viuWriteContrastFix,
  apply: viuApplyPreferences,
};

// Se carga SÍNCRONAMENTE en el <head> (antes de pintar) para que no haya
// destello: aplica el tema y el acento ya mismo y queda escuchando el cambio de
// preferencia del sistema mientras el tema sea "Automático".
try {
  if (typeof document !== "undefined" && document.documentElement) {
    viuApplyPreferences();
    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        if (viuReadTheme() === "auto") viuApplyPreferences();
      });
    } catch (error) {
      /* Sin matchMedia: no es crítico. */
    }
  }
} catch (error) {
  /* Sin DOM (tests en vm): no hace nada; el tema por defecto queda en el CSS. */
}
