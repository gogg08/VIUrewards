/* Página de acceso: crear la contraseña la primera vez, o entrar (Fase 3). */

// `init()` es un método mágico de Alpine: se llama solo al inicializar el
// componente, por eso no hace falta `x-init`. Los nombres de las propiedades
// evitan chocar con globales del navegador (p. ej. `confirm` -> `confirmPassword`).
function authApp() {
  return {
    mode: "loading",
    password: "",
    confirmPassword: "",
    error: "",
    busy: false,

    get title() {
      if (this.mode === "setup") return "Creá tu contraseña";
      if (this.mode === "login") return "Entrá al dashboard";
      return "VIUrewards";
    },
    get hint() {
      if (this.mode === "setup") {
        return "La primera vez: elegí una contraseña para proteger el panel. Se guarda solo cifrada.";
      }
      if (this.mode === "login") return "Ingresá tu contraseña local.";
      return "Cargando…";
    },
    get buttonLabel() {
      if (this.mode === "setup") return "Crear y entrar";
      return "Entrar";
    },

    async init() {
      try {
        const response = await fetch("/api/auth/status");
        const authState = await response.json();
        if (authState.authenticated) {
          window.location.href = "/";
          return;
        }
        this.mode = authState.configured ? "login" : "setup";
      } catch {
        this.error = "No se pudo hablar con el servidor.";
        this.mode = "login";
      }
    },

    async submit() {
      this.error = "";
      if (this.mode === "setup" && this.password !== this.confirmPassword) {
        this.error = "Las contraseñas no coinciden.";
        return;
      }

      this.busy = true;
      try {
        const endpoint = this.mode === "setup" ? "/api/auth/setup" : "/api/auth/login";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: this.password }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.ok) {
          window.location.href = "/";
          return;
        }
        this.error = this.messageFor(response.status, data.reason);
      } catch {
        this.error = "No se pudo hablar con el servidor.";
      } finally {
        this.busy = false;
      }
    },

    messageFor(httpStatus, reason) {
      if (reason === "ALREADY_CONFIGURED") return "Ya hay una contraseña configurada.";
      if (httpStatus === 429) return "Demasiados intentos. Esperá un momento.";
      if (httpStatus === 401) return "Contraseña incorrecta.";
      if (httpStatus === 400) return "La contraseña debe tener al menos 8 caracteres.";
      return "No se pudo completar la operación.";
    },
  };
}