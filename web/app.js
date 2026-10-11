/* Dashboard (Fase 3): clips, recorte, cola en vivo, overlay y configuración. */

const BYTES_PER_MB = 1024 * 1024;

// Evita que un campo numérico vacío viaje como "" al servidor.
function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Lista de roles de un input de texto (separados por espacios o comas).
function parseRoles(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((role) => role.trim())
    .filter(Boolean);
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
    feedTimer: null,

    // --- Interfaz (Etapa 2 del rediseño) -------------------------------------
    settingsOpen: false,
    settingsTab: "kick",
    rightTab: "queue",
    downloadsOpen: false,
    dirty: false,

    queue: { status: "idle", current: null, pending: [], size: 0, overlay: { connected: false, clients: 0 } },

    settings: {
      globalVolume: 100,
      defaultMaxDurationSec: 30,
      watchdogMarginSec: 10,
      maxVideoDurationSec: 120,
      port: 8787,
      eventHistoryMax: 500,
      redemptionsPollIntervalMs: 5000,
      redemptionsOnSkip: "leave_pending",
      redemptionsOldMinutes: 10,
      redemptionsOldAction: "ignore",
    },
    settingsForm: { maxVideoMb: 100, domainsText: "" },
    settingsMessage: "",
    settingsSaved: false,
    settingsRestart: false,

    passwordForm: { current: "", next: "", repeat: "" },
    passwordMessage: "",
    passwordSaved: false,

    rules: [],
    sources: [],
    eventLog: [],
    simulateForm: {
      type: "chat_command",
      userName: "Espectador",
      userId: "sim-user",
      rolesText: "",
      command: "alerta",
      argsText: "",
      rewardId: "",
      rewardTitle: "Recompensa",
      userInput: "",
    },
    simulateMessage: "",

    // --- Plataformas (Fase 4B) ------------------------------------------------
    platforms: [],
    activePlatformId: "",
    platformForm: { clientId: "", clientSecret: "" },
    platformMessage: "",
    platformNotice: "",
    rewards: [],
    rewardForm: null,
    rewardMessage: "",
    oldRedemptions: [],
    redemptionMessage: "",
    diagnostics: null,

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

    // Tipos de evento soportados por las fuentes conectadas (el dashboard oculta
    // los que ninguna plataforma soporta). Orden estable para el selector.
    get eventTypes() {
      const known = ["chat_command", "reward_redeemed", "sub", "gift", "follow", "manual"];
      const available = new Set();
      for (const source of this.sources) {
        for (const type of source.capabilities?.types ?? []) available.add(type);
      }
      const ordered = known.filter((type) => available.has(type));
      return ordered.length > 0 ? ordered : known;
    },

    // Plataforma seleccionada en la sección Plataformas (por defecto, la primera).
    get activePlatform() {
      return this.platforms.find((item) => item.id === this.activePlatformId) ?? this.platforms[0] ?? null;
    },

    // --- Estado de la interfaz -----------------------------------------------

    // El panel de Recompensas solo es interactivo con Kick vinculado y conectado.
    get isKickConnected() {
      return this.activePlatform !== null && this.activePlatform.state === "connected";
    },

    get overlayStatusLabel() {
      return this.queue.overlay && this.queue.overlay.connected ? "Overlay conectado" : "Overlay sin conexión";
    },

    get overlayStatusClass() {
      return this.queue.overlay && this.queue.overlay.connected ? "ok" : "error";
    },

    get kickStatusLabel() {
      const platform = this.activePlatform;
      if (!platform) return "Kick: sin configurar";
      switch (platform.state) {
        case "connected":
          return "Kick: conectado";
        case "requires_relink":
          return "Kick: requiere volver a vincular";
        default:
          return "Kick: no vinculado";
      }
    },

    get kickStatusClass() {
      const platform = this.activePlatform;
      if (!platform) return "";
      if (platform.state === "connected") return "ok";
      if (platform.state === "requires_relink") return "error";
      return "";
    },

    get downloadStatusClass() {
      if (this.job && this.job.status === "error") return "error";
      return this.downloading ? "ok" : "";
    },

    // --- Ajustes (ventana flotante) ------------------------------------------

    openSettings(tab) {
      if (tab) this.settingsTab = tab;
      this.settingsOpen = true;
      this.downloadsOpen = false;
      this.dirty = false;
    },

    closeSettings() {
      if (this.dirty && !window.confirm("Hay cambios sin guardar. ¿Cerrar igual?")) return;
      this.settingsOpen = false;
      this.dirty = false;
    },

    closeIfBackdrop($event) {
      if ($event.target === $event.currentTarget) this.closeSettings();
    },

    setSettingsTab(tab) {
      this.settingsTab = tab;
    },

    setRightTab(tab) {
      this.rightTab = tab;
    },

    toggleDownloads() {
      this.downloadsOpen = !this.downloadsOpen;
    },

    markDirty() {
      this.dirty = true;
    },

    // Esc cierra lo que esté abierto arriba de todo (desplegable, luego Ajustes).
    onEscape() {
      if (this.downloadsOpen) {
        this.downloadsOpen = false;
        return;
      }
      if (this.settingsOpen) this.closeSettings();
    },

    async init() {
      await Promise.all([
        this.loadClips(),
        this.loadOverlay(),
        this.loadSettings(),
        this.loadQueue(),
        this.loadRules(),
        this.loadEvents(),
        this.loadPlatforms(),
      ]);
      // Datos de la plataforma activa (recompensas y canjes pendientes antiguos).
      await this.loadRewards(this.activePlatform);
      await this.loadOldRedemptions(this.activePlatform);
      // La cola se refresca cada segundo: es una app local de un solo usuario y
      // el costo es despreciable. Ver docs/dashboard.md.
      this.queueTimer = setInterval(() => this.loadQueue(), 1000);
      // Historial y canjes pendientes, un poco más lento (polling).
      this.feedTimer = setInterval(() => {
        void this.loadEvents();
        void this.loadOldRedemptions(this.activePlatform);
      }, 2000);
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
        eventHistoryMax: Number(this.settings.eventHistoryMax),
        redemptionsPollIntervalMs: Number(this.settings.redemptionsPollIntervalMs),
        redemptionsOnSkip: this.settings.redemptionsOnSkip,
        redemptionsOldMinutes: Number(this.settings.redemptionsOldMinutes),
        redemptionsOldAction: this.settings.redemptionsOldAction,
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
      this.dirty = false;
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

    // --- Reglas internas (no visibles) -----------------------------------------

    // Las reglas se crean solas al crear una recompensa (vínculo 1:1). El dashboard
    // solo las lee para mostrar qué clip reproduce cada recompensa.
    async loadRules() {
      const response = await api("/api/rules");
      if (!response.ok) return;
      const data = await response.json();
      this.rules = data.rules ?? [];
      this.sources = data.sources ?? [];
    },

    // --- Historial de eventos --------------------------------------------------

    async loadEvents() {
      const response = await api("/api/events?limit=100");
      if (!response.ok) return;
      const data = await response.json();
      this.eventLog = data.events ?? [];
    },

    // --- Simulación de eventos (sin plataforma) --------------------------------

    async simulate() {
      const form = this.simulateForm;
      this.simulateMessage = "";
      const body = {
        type: form.type,
        userId: form.userId,
        userName: form.userName,
        roles: parseRoles(form.rolesText),
      };
      if (form.type === "chat_command") {
        body.command = form.command;
        body.args = form.argsText.trim() ? form.argsText.trim().split(/\s+/) : [];
      } else if (form.type === "reward_redeemed") {
        body.rewardId = form.rewardId;
        body.rewardTitle = form.rewardTitle;
        body.userInput = form.userInput;
      }

      const response = await api("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.simulateMessage = data.message || "No se pudo simular el evento.";
        return;
      }
      this.simulateMessage = "Evento enviado.";
      await this.loadEvents();
      await this.loadQueue();
      setTimeout(() => (this.simulateMessage = ""), 2500);
    },

    async manual() {
      this.simulateMessage = "";
      const response = await api("/api/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userName: this.simulateForm.userName || "Manual",
          roles: parseRoles(this.simulateForm.rolesText),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.simulateMessage = data.message || "No se pudo disparar el evento manual.";
        return;
      }
      this.simulateMessage = "Evento manual enviado.";
      await this.loadEvents();
      await this.loadQueue();
      setTimeout(() => (this.simulateMessage = ""), 2500);
    },

    // --- Plataformas (Fase 4B) ------------------------------------------------

    async loadPlatforms() {
      const response = await api("/api/platforms");
      if (!response.ok) return;
      const data = await response.json();
      this.platforms = data.platforms ?? [];
      if (!this.activePlatformId && this.platforms.length > 0) {
        this.activePlatformId = this.platforms[0].id;
      }
    },

    selectPlatform(platform) {
      if (this.activePlatformId === platform.id) return;
      this.activePlatformId = platform.id;
      this.rewards = [];
      this.rewardForm = null;
      this.oldRedemptions = [];
      this.diagnostics = null;
      this.platformMessage = "";
      this.platformNotice = "";
      void this.loadRewards(platform);
      void this.loadOldRedemptions(platform);
    },

    platformStateLabel(platform) {
      switch (platform.state) {
        case "connected":
          return "Conectado";
        case "requires_relink":
          return "Requiere volver a vincular";
        default:
          return "No vinculado";
      }
    },

    platformStateClass(platform) {
      if (platform.state === "connected") return "ok";
      if (platform.state === "requires_relink") return "error";
      return "off";
    },

    async saveCredentials(platform) {
      this.platformMessage = "";
      this.platformNotice = "";
      const payload = { clientId: String(this.platformForm.clientId || "").trim() };
      if (this.platformForm.clientSecret) payload.clientSecret = this.platformForm.clientSecret;
      const response = await api("/api/platforms/" + encodeURIComponent(platform.id) + "/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.platformMessage = data.message || "No se pudieron guardar las credenciales.";
        return;
      }
      this.platformForm.clientSecret = "";
      this.platformNotice = "Credenciales guardadas.";
      await this.loadPlatforms();
      setTimeout(() => (this.platformNotice = ""), 2500);
    },

    async beginLink(platform) {
      this.platformMessage = "";
      this.platformNotice = "";
      const response = await api("/api/platforms/" + encodeURIComponent(platform.id) + "/link", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.authorizeUrl) {
        this.platformMessage = data.message || "No se pudo iniciar el vínculo.";
        return;
      }
      // Se abre la página de la plataforma; al volver, el callback redirige al dashboard.
      window.location.href = data.authorizeUrl;
    },

    async unlink(platform) {
      if (!window.confirm("¿Desvincular la cuenta de " + platform.name + "?")) return;
      await api("/api/platforms/" + encodeURIComponent(platform.id) + "/unlink", { method: "POST" });
      this.rewards = [];
      await this.loadPlatforms();
    },

    async clearCredentials(platform) {
      if (!window.confirm("¿Borrar las credenciales de " + platform.name + "?")) return;
      await api("/api/platforms/" + encodeURIComponent(platform.id) + "/credentials", { method: "DELETE" });
      this.rewards = [];
      await this.loadPlatforms();
    },

    async testConnection(platform) {
      this.platformMessage = "";
      this.platformNotice = "";
      const response = await api("/api/platforms/" + encodeURIComponent(platform.id) + "/test", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        this.platformMessage = data.message || "No se pudo conectar con la plataforma.";
        return;
      }
      let notice = "Conexión correcta";
      if (data.accountName) notice += " como " + data.accountName;
      if (data.rewards !== null && data.rewards !== undefined) notice += " · " + data.rewards + " recompensa(s)";
      this.platformNotice = notice;
      await this.loadPlatforms();
      setTimeout(() => (this.platformNotice = ""), 4000);
    },

    async loadDiagnostics(platform) {
      const response = await api("/api/platforms/" + encodeURIComponent(platform.id) + "/diagnostics");
      if (!response.ok) return;
      const data = await response.json();
      this.diagnostics = data.diagnostics ?? null;
    },

    latencyLabel() {
      const d = this.diagnostics;
      if (!d) return "—";
      const fmt = (value) => (value === null || value === undefined ? "—" : value);
      return (
        fmt(d.latencyLastMs) + " / " + fmt(d.latencyMinMs) + " / " + fmt(d.latencyTypicalMs) + " / " + fmt(d.latencyMaxMs)
      );
    },

    rateLimitHeadersLabel() {
      const headers = (this.diagnostics && this.diagnostics.lastRateLimitHeaders) || {};
      const keys = Object.keys(headers);
      return keys.length === 0 ? "—" : keys.map((key) => key + "=" + headers[key]).join(" · ");
    },

    // --- Recompensas del canal ------------------------------------------------

    async loadRewards(platform) {
      if (!platform || platform.state !== "connected") {
        this.rewards = [];
        return;
      }
      const response = await api("/api/platforms/" + encodeURIComponent(platform.id) + "/rewards");
      if (!response.ok) {
        this.rewards = [];
        return;
      }
      const data = await response.json();
      this.rewards = data.rewards ?? [];
    },

    // Busca la regla asociada a una recompensa (trigger reward_redeemed por id).
    findRewardRule(reward) {
      return (
        this.rules.find(
          (rule) => rule.trigger.type === "reward_redeemed" && rule.trigger.rewardId === reward.id,
        ) ?? null
      );
    },

    rewardRuleLabel(reward) {
      const rule = this.findRewardRule(reward);
      return rule ? this.actionLabel(rule) : "Sin regla";
    },

    newReward() {
      this.rewardMessage = "";
      this.rewardForm = {
        id: null,
        title: "",
        cost: 100,
        description: "",
        color: "#00e701",
        enabled: true,
        userInputRequired: false,
        skipRequestQueue: false,
        clipId: "",
        volume: 1,
        maxDurationSec: 30,
        cooldownSec: 0,
      };
    },

    // Editar solo cambia los campos de la recompensa; la regla se define al crear.
    editReward(reward) {
      this.rewardMessage = "";
      this.rewardForm = {
        id: reward.id,
        title: reward.title,
        cost: reward.cost,
        description: reward.description ?? "",
        color: reward.color ?? "#00e701",
        enabled: reward.enabled,
        userInputRequired: reward.userInputRequired,
        skipRequestQueue: reward.skipRequestQueue,
        clipId: "",
        volume: 1,
        maxDurationSec: 30,
        cooldownSec: 0,
      };
    },

    cancelReward() {
      this.rewardForm = null;
      this.rewardMessage = "";
    },

    async saveReward(platform) {
      const form = this.rewardForm;
      if (!form || !platform) return;
      this.rewardMessage = "";

      const title = String(form.title || "").trim();
      if (!title) {
        this.rewardMessage = "Escribí un título para la recompensa.";
        return;
      }
      const cost = Math.round(Number(form.cost));
      if (!Number.isFinite(cost) || cost < 1) {
        this.rewardMessage = "El costo debe ser un número mayor o igual a 1.";
        return;
      }

      const body = {
        title,
        cost,
        description: String(form.description || "").trim(),
        color: String(form.color || "").trim(),
        enabled: form.enabled === true,
        userInputRequired: form.userInputRequired === true,
        skipRequestQueue: form.skipRequestQueue === true,
      };

      let method;
      let path;
      if (form.id) {
        method = "PATCH";
        path = "/api/platforms/" + encodeURIComponent(platform.id) + "/rewards/" + encodeURIComponent(form.id);
      } else {
        // La recompensa reproduce un clip fijo: se arma su regla interna.
        if (!form.clipId) {
          this.rewardMessage = "Elegí un clip de la biblioteca.";
          return;
        }
        const rule = { mode: "play_clip", clipId: String(form.clipId) };
        rule.volume = numberOrNull(form.volume) ?? 1;
        if (numberOrNull(form.maxDurationSec) !== null) rule.maxDurationSec = Number(form.maxDurationSec);
        rule.cooldownSec = Number(form.cooldownSec) || 0;
        body.rule = rule;
        method = "POST";
        path = "/api/platforms/" + encodeURIComponent(platform.id) + "/rewards";
      }

      const response = await api(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.rewardMessage = data.message || "No se pudo guardar la recompensa.";
        return;
      }
      if (data.ruleWarning) this.rewardMessage = data.ruleWarning;
      this.rewardForm = null;
      await this.loadRewards(platform);
      await this.loadRules();
    },

    async deleteReward(platform, reward) {
      if (!window.confirm('¿Borrar la recompensa "' + reward.title + '"?')) return;
      const response = await api(
        "/api/platforms/" + encodeURIComponent(platform.id) + "/rewards/" + encodeURIComponent(reward.id),
        { method: "DELETE" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.rewardMessage = data.message || "No se pudo borrar la recompensa.";
        return;
      }
      await this.loadRewards(platform);
      await this.loadRules();
    },

    // --- Canjes pendientes antiguos -------------------------------------------

    async loadOldRedemptions(platform) {
      if (!platform) {
        this.oldRedemptions = [];
        return;
      }
      const response = await api("/api/platforms/" + encodeURIComponent(platform.id) + "/redemptions");
      if (!response.ok) return;
      const data = await response.json();
      this.oldRedemptions = data.redemptions ?? [];
    },

    async rejectAllOld(platform) {
      if (!window.confirm("¿Rechazar todos los canjes pendientes antiguos?")) return;
      this.redemptionMessage = "";
      const response = await api(
        "/api/platforms/" + encodeURIComponent(platform.id) + "/redemptions/reject-all",
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.redemptionMessage = data.message || "No se pudieron rechazar los canjes.";
        return;
      }
      await this.loadOldRedemptions(platform);
      setTimeout(() => (this.redemptionMessage = ""), 2500);
    },

    async processOld(platform) {
      this.redemptionMessage = "";
      const response = await api(
        "/api/platforms/" + encodeURIComponent(platform.id) + "/redemptions/process-now",
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        this.redemptionMessage = data.message || "No se pudieron procesar los canjes.";
        return;
      }
      await this.loadOldRedemptions(platform);
      await this.loadClips();
      await this.loadQueue();
      setTimeout(() => (this.redemptionMessage = ""), 2500);
    },

    async logout() {
      await api("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
    },

    // --- Etiquetas para la UI --------------------------------------------------

    triggerLabel(rule) {
      const trigger = rule.trigger;
      switch (trigger.type) {
        case "chat_command":
          return "Comando !" + String(trigger.command || "").replace(/^!/, "");
        case "reward_redeemed":
          return "Canje de recompensa" + (trigger.rewardId ? " (" + trigger.rewardId + ")" : "");
        case "sub":
          return "Suscripción";
        case "gift":
          return "Gift sub";
        case "follow":
          return "Follow";
        case "manual":
          return "Manual";
        default:
          return String(trigger.type);
      }
    },

    conditionsLabel(rule) {
      const conditions = rule.conditions;
      const permission =
        conditions.permission === "subs"
          ? "solo subs"
          : conditions.permission === "mods"
            ? "solo mods"
            : "todos";
      const parts = [permission];
      if (conditions.cooldownSec > 0) parts.push("cooldown " + conditions.cooldownSec + "s");
      if (conditions.userCooldownSec > 0) parts.push("por usuario " + conditions.userCooldownSec + "s");
      return parts.join(" · ");
    },

    actionLabel(rule) {
      const action = rule.action;
      const clip = this.clips.find((item) => item.id === action.clipId);
      return "Reproducir: " + (clip ? clip.title : action.clipId);
    },

    outcomeLabel(outcome) {
      switch (outcome) {
        case "fired":
          return "Disparó";
        case "skipped":
          return "Omitido";
        case "error":
          return "Error";
        case "no_match":
          return "Sin regla";
        case "duplicate":
          return "Duplicado";
        default:
          return String(outcome);
      }
    },

    eventTypeLabel(type) {
      switch (type) {
        case "chat_command":
          return "Comando de chat";
        case "reward_redeemed":
          return "Canje de recompensa";
        case "sub":
          return "Suscripción";
        case "gift":
          return "Gift sub";
        case "follow":
          return "Follow";
        case "manual":
          return "Manual";
        default:
          return String(type);
      }
    },

    formatTime(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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