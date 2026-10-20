/* VIUrewards — logo con modos configurables (Parte C) y logo por tema (Parte 2).
   Compartido por el dashboard (index.html) y el login (login.html).
   Sin dependencias y sin paso de build. */

// Ciclo de la animación del WebP: 69 cuadros que suman 5.040 s (medido del
// propio archivo). Ver UI-DESIGN.md §3.
var VIU_LOGO_CYCLE_MS = 5040;

// En modo "Automático" el WebP se muestra hasta este momento y después el PNG.
// En vez de cortar a los 60 s exactos, se corta al FIN DEL CICLO de animación que
// cruza los 60 s: ceil(60000 / 5040) * 5040 = 60480 ms. El último cuadro del WebP
// dura 504 ms y el PNG es idéntico a él, así que el cambio es imperceptible aun con
// unos milisegundos de desfase entre el temporizador y la animación real.
var VIU_LOGO_AUTO_SWITCH_MS = Math.ceil(60000 / VIU_LOGO_CYCLE_MS) * VIU_LOGO_CYCLE_MS;

var VIU_LOGO_KEY = "viurewards.logoMode";
var VIU_LOGO_MODES = ["auto", "dynamic", "static"];

// Juegos de archivos por tema. "dark" (Noche y OLED) y "light" (Día) son los
// archivos canónicos del logo. Si el archivo del tema no carga, se cae UNA sola
// vez al juego oscuro, sin repetir el 404.
var VIU_LOGO_FALLBACK = {
  png: "/web/assets/VIUrewards-dark.png",
  webp: "/web/assets/VIUrewards-dark.webp",
};
var VIU_LOGO_SETS = {
  night: { png: "/web/assets/VIUrewards-dark.png", webp: "/web/assets/VIUrewards-dark.webp" },
  oled: { png: "/web/assets/VIUrewards-dark.png", webp: "/web/assets/VIUrewards-dark.webp" },
  day: { png: "/web/assets/VIUrewards-light.png", webp: "/web/assets/VIUrewards-light.webp" },
};

// Temas cuyo logo se comprobó ausente (respaldo recordado por carga de página).
var VIU_LOGO_MISSING = {};

var VIULogo = {
  CYCLE_MS: VIU_LOGO_CYCLE_MS,
  AUTO_SWITCH_MS: VIU_LOGO_AUTO_SWITCH_MS,
  KEY: VIU_LOGO_KEY,
  MODES: VIU_LOGO_MODES,
  FALLBACK: VIU_LOGO_FALLBACK,
  SETS: VIU_LOGO_SETS,
  // Compatibilidad con tests/HTML existentes: rutas del logo actual.
  PNG: VIU_LOGO_FALLBACK.png,
  WEBP: VIU_LOGO_FALLBACK.webp,

  // Preferencia guardada en este navegador; "Automático" si falta o es inválida.
  readMode: function () {
    try {
      var value = window.localStorage.getItem(VIU_LOGO_KEY);
      return VIU_LOGO_MODES.indexOf(value) !== -1 ? value : "auto";
    } catch (error) {
      // localStorage no disponible: se usa "Automático" sin fallar.
      return "auto";
    }
  },

  // Guarda el modo y avisa a los componentes para que se aplique al instante.
  writeMode: function (mode) {
    if (VIU_LOGO_MODES.indexOf(mode) === -1) return;
    try {
      window.localStorage.setItem(VIU_LOGO_KEY, mode);
    } catch (error) {
      // No poder guardar no debe romper la app.
    }
    window.dispatchEvent(new CustomEvent("viu-logo-mode", { detail: mode }));
  },

  prefersReducedMotion: function () {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (error) {
      return false;
    }
  },

  // Tema efectivo ahora mismo (lo puso theme.js como `data-theme` en <html>).
  currentTheme: function () {
    try {
      var value = document.documentElement.getAttribute("data-theme");
      return VIU_LOGO_SETS[value] ? value : "night";
    } catch (error) {
      return "night";
    }
  },

  // Ruta del archivo para un tema y una variante ("png" | "webp"). Si el archivo
  // del tema se supo ausente, devuelve el del logo actual (respaldo recordado).
  pathFor: function (theme, kind) {
    if (VIU_LOGO_MISSING[theme]) return VIU_LOGO_FALLBACK[kind];
    var set = VIU_LOGO_SETS[theme] || VIU_LOGO_FALLBACK;
    return set[kind] || VIU_LOGO_FALLBACK[kind];
  },

  // Marca que el logo de un tema no existe: desde ahora se usa el respaldo sin
  // volver a pedirlo (así no se repite el 404).
  markMissing: function (theme) {
    if (theme && VIU_LOGO_SETS[theme]) VIU_LOGO_MISSING[theme] = true;
  },

  // Qué archivo corresponde: `elapsedMs` es el tiempo desde que cargó la página.
  // `theme` (opcional) elige el juego de archivos del tema activo.
  resolve: function (mode, elapsedMs, theme) {
    var kind = "png";
    if (mode === "dynamic") {
      kind = "webp";
    } else if (mode !== "static" && !this.prefersReducedMotion()) {
      // Automático: animado al principio, estático después.
      kind = elapsedMs >= VIU_LOGO_AUTO_SWITCH_MS ? "png" : "webp";
    }
    return this.pathFor(theme || this.currentTheme(), kind);
  },
};

// Precarga los PNG (juegos por tema y respaldo) para que el cambio al pasar de
// WebP a PNG —y el cambio de tema— no parpadee.
try {
  var viuLogoPreloadSources = [
    VIU_LOGO_FALLBACK.png,
    VIU_LOGO_SETS.night.png,
    VIU_LOGO_SETS.day.png,
  ];
  for (var viuLogoIndex = 0; viuLogoIndex < viuLogoPreloadSources.length; viuLogoIndex++) {
    var viuLogoPreload = new Image();
    viuLogoPreload.src = viuLogoPreloadSources[viuLogoIndex];
  }
} catch (error) {
  // Sin `Image` (entorno raro): se sigue igual.
}

// Componente Alpine del logo. Va en el encabezado del dashboard y en el login.
function logoBadge() {
  return {
    logoSrc: VIU_LOGO_FALLBACK.png,
    logoFailed: false,
    _mode: "auto",
    _theme: "night",
    _startedAt: 0,
    _timer: null,
    _pendingKind: "png",

    init: function () {
      this._startedAt = Date.now();
      this._theme = VIULogo.currentTheme();
      this._apply(VIULogo.readMode());
      window.addEventListener("viu-logo-mode", function (event) {
        // Al cambiar de modo, el reloj de "Automático" vuelve a empezar.
        this._startedAt = Date.now();
        this._apply(event.detail);
      }.bind(this));
      // Cambio de tema: se actualiza el logo al instante sin reiniciar el reloj
      // (no se ve un parpadeo de la animación).
      window.addEventListener("viu-theme-change", function (event) {
        this._theme = (event.detail && event.detail.theme) || VIULogo.currentTheme();
        this._apply(this._mode);
      }.bind(this));
    },

    // Si el archivo del tema no existe, se recuerda y se cae al logo actual sin
    // repetir el 404. `_pendingKind` dice qué variante se estaba pidiendo.
    onLogoError: function () {
      VIULogo.markMissing(this._theme);
      this.logoSrc = VIULogo.pathFor(this._theme, this._pendingKind);
    },

    _apply: function (mode) {
      this._mode = mode;
      // Limpia el temporizador anterior: cambiar de modo no deja duplicados.
      if (this._timer !== null) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      var elapsed = Date.now() - this._startedAt;
      this.logoSrc = VIULogo.resolve(mode, elapsed, this._theme);
      this._pendingKind = this.logoSrc.indexOf(".webp") !== -1 ? "webp" : "png";
      if (mode === "auto" && !VIULogo.prefersReducedMotion() && this._pendingKind === "webp") {
        var remaining = VIU_LOGO_AUTO_SWITCH_MS - elapsed;
        this._timer = setTimeout(
          function () {
            this._timer = null;
            this.logoSrc = VIULogo.resolve("auto", VIU_LOGO_AUTO_SWITCH_MS, this._theme);
            this._pendingKind = "png";
          }.bind(this),
          remaining
        );
      }
    },
  };
}
