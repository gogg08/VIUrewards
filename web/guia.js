/* Página de guía pública para conectar Kick con VIUrewards.
   Sin sesión, sin tokens ni datos de la cuenta: no llama a ninguna API
   protegida. Lo único que consulta es la lista pública de capturas que existan
   en `web/assets/guide/` (solo nombres, sin rutas ni metadatos), para no pedir
   imágenes que todavía no existen (y no generar 404).

   Convención de nombres: `guia-NN-<resto>.<ext>`, donde NN es el NÚMERO DE
   PASO de la página (guia-01 … guia-06; guia-07 son las preguntas frecuentes).
   Puede haber varias capturas por paso: se muestran en el orden alfabético del
   resto del nombre y se las ubica buscando por PREFIJO de paso.

   Los hechos de los pasos están contrastados con docs.kick.com, docs/kick-setup.md
   y el código real del adaptador (src/platforms/kick/config.ts). */

/** Ruta donde el creador pone las capturas (opcional: hoy no existen). */
var GUIDE_SHOTS_BASE = "/web/assets/guide/";

/** Paso (`guia-paso-3`) -> número de paso ("03"), para buscar sus capturas. */
function guideStepNumber(stepId) {
  var match = /^guia-paso-(\d{1,2})$/.exec(String(stepId));
  if (!match) return "";
  return match[1].length === 1 ? "0" + match[1] : match[1];
}

function guideApp() {
  return {
    // Puerto de la barra de direcciones: 80 si no se declara (URLs sin :puerto).
    port: "80",
    redirectUri: "http://localhost:80/callback",
    // Nombres de archivo de las capturas que EXISTEN en el servidor (vacío si no
    // existe ninguna). Así se decide si hay que mostrar el hueco.
    shots: [],
    copyMessage: "",
    /** URL de la captura ampliada (vacío = visor cerrado). */
    lightboxSrc: "",
    /** Texto alternativo de la captura ampliada. */
    lightboxAlt: "",

    async init() {
      this.port = window.location.port || "80";
      // localhost (no 127.0.0.1): es lo que registra la app de Kick y lo que usa
      // el adaptador (ver src/platforms/kick/config.ts, DEFAULT_REDIRECT_URI).
      this.redirectUri = "http://localhost:" + this.port + "/callback";
      try {
        const response = await fetch("/api/guide-shots");
        const data = await response.json().catch(() => ({}));
        this.shots = Array.isArray(data.shots) ? data.shots : [];
      } catch {
        // Sin lista de capturas, la página queda con el texto y los cuadros de
        // código; no es un error que deba romper la guía.
        this.shots = [];
      }
      // El navegador salta al ancla ANTES de que Alpine muestre las capturas (y
      // cambie la altura). Cuando termina de armarse, se vuelve a ubicar el paso.
      await this.afterRenderAsync(800);
      this.scrollToHash();
    },

    // Si la URL trae un ancla (`/guia#guia-paso-3`), deja ese bloque a la vista.
    // No hace nada si el id no existe o si no hay hash.
    scrollToHash() {
      const id = String(window.location.hash || "").replace(/^#/, "");
      if (!id) return;
      let target = null;
      try {
        target = document.getElementById(id);
      } catch {
        target = null;
      }
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "start" });
      }
    },

    /** Capturas de un paso (por su número), en orden alfabético. */
    stepShots(stepId) {
      const prefix = "guia-" + guideStepNumber(stepId) + "-";
      return this.shots.filter((name) => String(name).indexOf(prefix) === 0);
    },

    /** ¿Ese paso tiene al menos una captura? Solo entonces se muestra su bloque. */
    hasShots(stepId) {
      return this.stepShots(stepId).length > 0;
    },

    shotUrl(name) {
      return GUIDE_SHOTS_BASE + name;
    },

    // Copia la redirect URI al portapapeles con aviso accesible (aria-live) y
    // manejo del error (portapapeles bloqueado o sin soporte).
    async copyRedirect() {
      const text = this.redirectUri;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          this.copyFallback(text);
        }
        this.copyMessage = "Copiado";
      } catch {
        try {
          this.copyFallback(text);
          this.copyMessage = "Copiado";
        } catch {
          this.copyMessage = "No se pudo copiar: seleccioná el texto y copialo a mano.";
        }
      }
    },

    // Respaldo para navegadores sin API de portapapeles.
    copyFallback(text) {
      const field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(field);
      if (!ok) throw new Error("copy falló");
    },

    // Abre el visor. La captura tiene que venir del botón (no de `$event.target`,
    // que en un botón es el botón mismo y no la imagen).
    openLightbox(url, alt) {
      if (!url) return;
      this.lightboxSrc = url;
      this.lightboxAlt = alt || "";
    },

    // Cierra el visor y devuelve el foco al botón de la captura que lo abrió.
    closeLightbox() {
      if (!this.lightboxSrc) return;
      const opener = document.querySelector('.guide-shot-open[aria-expanded="true"]');
      this.lightboxSrc = "";
      this.lightboxAlt = "";
      if (opener) {
        opener.setAttribute("aria-expanded", "false");
        try {
          opener.focus();
        } catch {
          /* El visor ya se cerró igual. */
        }
      }
    },

    // Foco al abrir: el botón X del visor (su primer control).
    focusLightbox() {
      this.afterRender(() => {
        const close = document.querySelector(".lightbox-close");
        if (close) close.focus();
      });
    },

    // Trampa de foco simple: Tab cicla dentro del visor mientras está abierto.
    trapLightboxFocus(event) {
      if (event.key !== "Tab") return false;
      const windowEl = event.currentTarget;
      const focusables = windowEl.querySelectorAll("button, [href], [tabindex]:not([tabindex='-1'])");
      const list = Array.prototype.filter.call(focusables, (el) => !el.disabled && el.offsetParent !== null);
      if (list.length === 0) return false;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return false;
    },

    // Clic en el fondo (no en la imagen ni en el botón X): cierra.
    closeLightboxBackdrop(event) {
      if (event.target !== event.currentTarget) return;
      this.closeLightbox();
    },

    // Corre `fn` después de que Alpine aplique el cambio de `x-show`.
    afterRender(fn) {
      if (typeof this.$nextTick === "function") {
        this.$nextTick(fn);
      } else {
        setTimeout(fn, 0);
      }
    },

    // Igual que `afterRender` pero devuelve una promesa (para esperar el layout).
    // `fallbackMs` es el tope si `$nextTick` no llega (p. ej. sin Alpine).
    afterRenderAsync(fallbackMs) {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        setTimeout(finish, fallbackMs);
        const tick = this.$nextTick;
        if (typeof tick === "function") {
          try {
            tick.call(this, finish);
          } catch {
            /* Sin Alpine: queda el tope por tiempo. */
          }
        } else {
          setTimeout(finish, 0);
        }
      });
    },
  };
}
