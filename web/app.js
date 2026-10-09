/* Dashboard (Fase 3): clips, recorte, cola en vivo, overlay y configuración. */

const BYTES_PER_MB = 1024 * 1024;

// Evita que un campo numérico vacío viaje como "" al servidor.
function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthenticated");
  }
  return response;
}

function dashboardApp() {
  return {
    url: "",
    clips: [],
    overlay: { key: "", url: "" },
    overlayRevealed: false,
    job: null,
    message: "",
    copied: false,
    editingId: null,
    editTitle: "",
    pollTimer: null,
    queueTimer: null,

    queue: { status: "idle", current: null, pending: [], size: 0, overlay: { connected: false, clients: 0 } },

    settings: {
      globalVolume: 100,
      defaultMaxDurationSec: 30,
      watchdogMarginSec: 10,
      maxVideoDurationSec: 120,
      port: 8787,
    },
    settingsForm: { maxVideoMb: 100, domainsText: "" },
    settingsMessage: "",
    settingsSaved: false,
    settingsRestart: false,

    passwordForm: { current: "", next: "", repeat: "" },
    passwordMessage: "",
    passwordSaved: false,

    get downloading() {
      return this.job !== null && ["queued", "downloading", "converting"].includes(this.job.status);
    },

    get jobLabel() {
      if (!this.job) return "";
      switch (this.job.status) {
        case "queued":
          return "En cola...";
        case "downloading":
          return "Descargando...";
        case "converting":
          return "Convirtiendo...";
        case "ready":
          return "Listo";
        case "error":
          return this.job.message || "No se pudo descargar.";
        default:
          return "";
      }
    },

    get maskedOverlayUrl() {
      return (this.overlay.url || "").replace(/key=[^&]+/, "key=••••••");
    },

    async init() {
      await Promise.all([this.loadClips(), this.loadOverlay(), this.loadSettings(), this.loadQueue()]);
      // La cola se refresca cada segundo: es una app local de un solo usuario y
      // el costo es despreciable. Ver docs/dashboard.md.
      this.queueTimer = setInterval(() => this.loadQueue(), 1000);
    },

    async loadClips() {
      const response = await api("/api/clips");
      const data = await response.json();
      this.clips = data.clips ?? [];
    },

    async loadOverlay() {
      const response = await api("/api/overlay");
      const data = await response.json();
      if (data.ok) this.overlay = data.overlay;
    },

    async loadQueue() {
      const response = await api("/api/state");
      if (!response.ok) return;
      this.queue = await response.json();
    },

    async startDownload() {
      if (!this.url.trim()) return;
      this.message = "";
      const response = await api("/api/download", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: this.url.trim() }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        this.message = "No se pudo iniciar la descarga.";
        return;
      }
      this.job = data.job;
      this.pollJob(data.job.id);
    },

    pollJob(id) {
      if (this.pollTimer !== null) clearTimeout(this.pollTimer);
      this.pollTimer = setTimeout(async () => {
        const response = await api("/api/jobs/" + encodeURIComponent(id));
        const data = await response.json();
        if (!data.ok) {
          this.job = { status: "error", message: "No se encontró el trabajo." };
          return;
        }
        this.job = data.job;
        if (this.job.status === "ready") {
          this.url = "";
          await this.loadClips();
        } else if (this.job.status !== "error") {
          this.pollJob(id);
        }
      }, 1000);
    },

    startRename(clip) {
      this.editingId = clip.id;
      this.editTitle = clip.title;
    },

    async saveRename(clip) {
      const title = this.editTitle.trim();
      if (!title) return;
      const response = await api("/api/clips/" + encodeURIComponent(clip.id) + "/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (response.ok) {
        clip.title = title;
        this.editingId = null;
      }
    },

    async remove(clip) {
      if (!window.confirm("¿Borrar el clip \"" + clip.title + "\"? Esta acción no se puede deshacer.")) {
        return;
      }
      const response = await api("/api/clips/" + encodeURIComponent(clip.id), { method: "DELETE" });
      if (response.ok) await this.loadClips();
    },

    // --- Recorte no destructivo ------------------------------------------------

    useCurrentTime(clip, which) {
      const video = document.getElementById("clip-video-" + clip.id);
      if (!video) return;
      const seconds = Math.round(video.currentTime * 10) / 10;
      if (which === "start") clip.trimStart = seconds;
      else clip.trimEnd = seconds;
    },

    async saveTrim(clip) {
      const response = await api("/api/clips/" + encodeURIComponent(clip.id) + "/trim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trimStart: numberOrNull(clip.trimStart),
          trimEnd: numberOrNull(clip.trimEnd),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.message = data.message || "No se pudo guardar el recorte.";
        return;
      }
      clip.trimStart = data.clip.trimStart;
      clip.trimEnd = data.clip.trimEnd;
      clip.trimSaved = true;
      setTimeout(() => (clip.trimSaved = false), 1500);
    },

    async resetTrim(clip) {
      clip.trimStart = null;
      clip.trimEnd = null;
      await this.saveTrim(clip);
    },

    async play(clip) {
      this.message = "";
      const response = await api("/api/clips/" + encodeURIComponent(clip.id) + "/play", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trimStart: numberOrNull(clip.trimStart),
          trimEnd: numberOrNull(clip.trimEnd),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.message = data.message || "No se pudo probar la alerta.";
        return;
      }
      this.message = "Alerta enviada a la cola.";
      await this.loadQueue();
      setTimeout(() => (this.message = ""), 2500);
    },

    // --- Cola ------------------------------------------------------------------

    async skipQueue() {
      await api("/api/skip", { method: "POST" });
      await this.loadQueue();
    },
    async pauseQueue() {
      await api("/api/pause", { method: "POST" });
      await this.loadQueue();
    },
    async resumeQueue() {
      await api("/api/resume", { method: "POST" });
      await this.loadQueue();
    },
    async clearQueue() {
      await api("/api/clear", { method: "POST" });
      await this.loadQueue();
    },

    // --- Overlay ---------------------------------------------------------------

    toggleOverlay() {
      this.overlayRevealed = !this.overlayRevealed;
    },

    async copyOverlay() {
      try {
        await navigator.clipboard.writeText(this.overlay.url);
      } catch {
        const input = this.$refs.overlayInput;
        if (input) {
          input.focus();
          input.select();
          document.execCommand("copy");
        }
      }
      this.copied = true;
      setTimeout(() => (this.copied = false), 2000);
    },

    async regenerate() {
      if (!window.confirm("Se generará una clave nueva. Vas a tener que actualizar la URL en OBS. ¿Seguir?")) {
        return;
      }
      const response = await api("/api/overlay/regenerate", { method: "POST" });
      const data = await response.json();
      if (data.ok) {
        this.overlay = data.overlay;
        this.overlayRevealed = true;
      }
    },

    // --- Configuración ---------------------------------------------------------

    async loadSettings() {
      const response = await api("/api/settings");
      const data = await response.json();
      if (!data.ok) return;
      this.settings = data.settings;
      this.settingsForm.maxVideoMb = Math.round(data.settings.maxVideoBytes / BYTES_PER_MB);
      this.settingsForm.domainsText = (data.settings.allowedDomains || []).join("\n");
    },

    async saveSettings() {
      this.settingsMessage = "";
      this.settingsSaved = false;
      this.settingsRestart = false;

      const domains = this.settingsForm.domainsText
        .split(/[\s,]+/)
        .map((domain) => domain.trim())
        .filter(Boolean);

      const payload = {
        globalVolume: Number(this.settings.globalVolume),
        defaultMaxDurationSec: Number(this.settings.defaultMaxDurationSec),
        watchdogMarginSec: Number(this.settings.watchdogMarginSec),
        maxVideoDurationSec: Number(this.settings.maxVideoDurationSec),
        maxVideoBytes: Math.round(Number(this.settingsForm.maxVideoMb) * BYTES_PER_MB),
        allowedDomains: domains,
        port: Number(this.settings.port),
      };

      const response = await api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.settingsMessage = data.message || "No se pudo guardar la configuración.";
        return;
      }

      this.settings = data.settings;
      this.settingsForm.maxVideoMb = Math.round(data.settings.maxVideoBytes / BYTES_PER_MB);
      this.settingsForm.domainsText = (data.settings.allowedDomains || []).join("\n");
      this.settingsRestart = Boolean(data.restartRequired);
      this.settingsSaved = true;
      setTimeout(() => (this.settingsSaved = false), 2000);
    },

    async changePassword() {
      this.passwordMessage = "";
      this.passwordSaved = false;
      if (this.passwordForm.next !== this.passwordForm.repeat) {
        this.passwordMessage = "Las contraseñas nuevas no coinciden.";
        return;
      }
      const response = await api("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: this.passwordForm.current,
          newPassword: this.passwordForm.next,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.passwordMessage =
          response.status === 401 ? "La contraseña actual es incorrecta." : data.message || "No se pudo cambiar.";
        return;
      }
      this.passwordForm = { current: "", next: "", repeat: "" };
      this.passwordSaved = true;
      setTimeout(() => (this.passwordSaved = false), 3000);
    },

    async logout() {
      await api("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    },

    formatDuration(seconds) {
      const total = Number(seconds) || 0;
      const minutes = Math.floor(total / 60);
      const rest = Math.floor(total % 60);
      return minutes + ":" + String(rest).padStart(2, "0");
    },

    formatSize(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024 * 1024) return Math.round(value / 1024) + " KB";
      return (value / (1024 * 1024)).toFixed(1) + " MB";
    },
  };
}