/* Página de guía pública para conectar Kick con VIUrewards.
   Sin sesión, sin tokens ni datos de la cuenta: no llama a ninguna API
   protegida. Lo único que consulta es la lista pública de capturas que existan
   en `web/assets/guide/` (solo nombres, sin rutas ni metadatos), para no pedir
   imágenes que todavía no existen (y no generar 404).

   Los hechos de los pasos están contrastados con docs.kick.com, docs/kick-setup.md
   y el código real del adaptador (src/platforms/kick/config.ts). */

/** Ruta donde el creador pone las capturas (opcional: hoy no existen). */
var GUIDE_SHOTS_BASE = "/web/assets/guide/";

function guideApp() {
  return {
    // Puerto de la barra de direcciones: 80 si no se declara (URLs sin :puerto).
    port: "80",
    redirectUri: "http://localhost:80/callback",
    // Nombres de archivo de las capturas que EXISTEN en el servidor (vacío si no
    // existe ninguna). Así `shot()` decide si hay que mostrar el hueco.
    shots: [],
    copyMessage: "",
    lightboxSrc: "",

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
    },

    // ¿Existe esa captura? Solo entonces se muestra su lugar.
    shot(name) {
      return this.shots.indexOf(name) !== -1;
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

    openLightbox(src) {
      if (!src) return;
      this.lightboxSrc = src;
    },

    closeLightbox() {
      this.lightboxSrc = "";
    },
  };
}
