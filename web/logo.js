/* VIUrewards — logo con modos configurables (Parte C).
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
var VIU_LOGO_PNG = "/web/assets/VIUrewards.png";
var VIU_LOGO_WEBP = "/web/assets/VIUrewards.webp";

var VIULogo = {
  CYCLE_MS: VIU_LOGO_CYCLE_MS,
  AUTO_SWITCH_MS: VIU_LOGO_AUTO_SWITCH_MS,
  KEY: VIU_LOGO_KEY,
  MODES: VIU_LOGO_MODES,
  PNG: VIU_LOGO_PNG,
  WEBP: VIU_LOGO_WEBP,

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

  // Qué archivo corresponde: `elapsedMs` es el tiempo desde que cargó la página.
  resolve: function (mode, elapsedMs) {
    if (mode === "static") return VIU_LOGO_PNG;
    if (mode === "dynamic") return VIU_LOGO_WEBP;
    // Automático: animado al principio, estático después. Con menos movimiento
    // pedido por el sistema, directo el estático.
    if (this.prefersReducedMotion()) return VIU_LOGO_PNG;
    return elapsedMs >= VIU_LOGO_AUTO_SWITCH_MS ? VIU_LOGO_PNG : VIU_LOGO_WEBP;
  },
};

// Precarga el PNG para que el cambio de WebP a PNG no parpadee.
try {
  var viuLogoPreload = new Image();
  viuLogoPreload.src = VIU_LOGO_PNG;
} catch (error) {
  // Sin `Image` (entorno raro): se sigue igual.
}

// Componente Alpine del logo. Va en el encabezado del dashboard y en el login.
function logoBadge() {
  return {
    logoSrc: VIU_LOGO_PNG,
    logoFailed: false,
    _mode: "auto",
    _startedAt: 0,
    _timer: null,

    init: function () {
      this._startedAt = Date.now();
      this._apply(VIULogo.readMode());
      window.addEventListener("viu-logo-mode", function (event) {
        // Al cambiar de modo, el reloj de "Automático" vuelve a empezar.
        this._startedAt = Date.now();
        this._apply(event.detail);
      }.bind(this));
    },

    _apply: function (mode) {
      this._mode = mode;
      // Limpia el temporizador anterior: cambiar de modo no deja duplicados.
      if (this._timer !== null) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      var elapsed = Date.now() - this._startedAt;
      this.logoSrc = VIULogo.resolve(mode, elapsed);
      if (mode === "auto" && !VIULogo.prefersReducedMotion() && this.logoSrc === VIU_LOGO_WEBP) {
        var remaining = VIU_LOGO_AUTO_SWITCH_MS - elapsed;
        this._timer = setTimeout(
          function () {
            this._timer = null;
            this.logoSrc = VIU_LOGO_PNG;
          }.bind(this),
          remaining
        );
      }
    },
  };
}