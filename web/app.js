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
    // En ventana angosta se muestra una columna por vez (Recompensas/Clips/Cola).
    mobileTab: "rewards",
    // Pestañas de Ajustes con cambios sin guardar (el aviso es por pestaña).
    dirtyTabs: {},
    // El punto de Descargas se pone rojo si hubo un error que todavía no se vio.
    downloadErrorUnseen: false,
    // Modo del logo (Parte C): "auto" | "dynamic" | "static". Vive en localStorage.
    logoMode: "auto",

    queue: { status: "idle", current: null, pending: [], size: 0, overlay: { connected: false, clients: 0 } },

    settings: {
      globalVolume: 100,
      defaultMaxDurationSec: 30,
      maxAudioVoices: 8,
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
    // --- Recompensas (rediseño, Etapa 4B) ------------------------------------
    rewards: [],
    // Vista unificada: estado del vínculo y de la consulta a la plataforma.
    rewardsConnected: false,
    rewardsOffline: false,
    rewardsPlatformState: "unlinked",
    rewardsMessage: "",
    // Formulario de crear/editar recompensa (modal). `null` = cerrado.
    rewardForm: null,
    // Una vez elegido un clip la ventana crece y no se vuelve a achicar.
    rewardExpanded: false,
    // El título se completa solo con el del clip hasta que el creador lo edite.
    rewardTitleTouched: false,
    rewardAdvancedOpen: false,
    rewardMessage: "",
    // Fotografía del formulario al abrirlo: para avisar cambios sin guardar.
    rewardSnapshot: "",
    // Confirmación base antes de borrar.
    rewardDelete: null,
    // Flujo de canjes pendientes al desactivar o borrar (nunca silencioso).
    rewardPending: null,
    // Id de la recompensa cuyo color se está guardando (una sola solicitud en vuelo).
    rewardColorSaving: null,
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

    // --- Recompensas (Etapa 4B) ---------------------------------------------

    // Sin vínculo (no vinculado o requiere volver a vincular): panel en gris.
    get rewardsLocked() {
      return this.rewardsPlatformState === "unlinked" || this.rewardsPlatformState === "requires_relink";
    },

    // La ventana de recompensa ya creció (clip elegido). No se vuelve a achicar.
    get rewardFormExpanded() {
      return this.rewardExpanded;
    },

    // Título de la ventana flotante de recompensa.
    get rewardModalTitle() {
      return this.rewardForm && this.rewardForm.id ? "Editar recompensa" : "Nueva recompensa";
    },

    // El formulario cambió respecto de cómo se abrió (para el aviso sin guardar).
    get rewardFormDirty() {
      if (!this.rewardForm) return false;
      return JSON.stringify(this.rewardForm) !== this.rewardSnapshot;
    },

    // Texto de la acción de la ventana de canjes pendientes.
    get rewardPendingActionLabel() {
      const pending = this.rewardPending;
      if (!pending) return "";
      const verb = pending.kind === "delete" ? "Borrar" : "Deshabilitar";
      return pending.failed && pending.failed.length > 0 ? verb + " igual" : "Continuar";
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
      if (this.downloading) return "ok";
      if (this.job && this.job.status === "error" && this.downloadErrorUnseen) return "error";
      // Cadena vacía: no se muestra el punto.
      return "";
    },

    // Tooltip del indicador de Overlay cuando no hay nada conectado.
    get overlayStatusTitle() {
      return this.queue.overlay && this.queue.overlay.connected
        ? "El overlay está conectado."
        : "Revisá la fuente en OBS.";
    },

    // --- Cambios sin guardar (por pestaña de Ajustes) ------------------------

    get hasUnsavedTabs() {
      return Object.values(this.dirtyTabs).some(Boolean);
    },

    get dirtyTabNames() {
      const labels = {
        kick: "Kick",
        overlay: "Overlay y OBS",
        alerts: "Alertas",
        library: "Biblioteca y descargas",
        security: "Seguridad",
        appearance: "Apariencia",
        advanced: "Avanzado",
      };
      return Object.keys(this.dirtyTabs)
        .filter((tab) => this.dirtyTabs[tab])
        .map((tab) => labels[tab] ?? tab);
    },

    // --- Ajustes (ventana flotante) ------------------------------------------

    openSettings(tab) {
      if (tab) this.settingsTab = tab;
      this.settingsOpen = true;
      this.downloadsOpen = false;
    },

    closeSettings() {
      if (this.hasUnsavedTabs) {
        const names = this.dirtyTabNames.join(", ");
        if (!window.confirm("Hay cambios sin guardar en: " + names + ". ¿Cerrar igual?")) return;
      }
      this.settingsOpen = false;
      this.dirtyTabs = {};
    },

    closeIfBackdrop($event) {
      if ($event.target === $event.currentTarget) this.closeSettings();
    },

    setSettingsTab(tab) {
      this.settingsTab = tab;
    },

    // Modo del logo: se guarda en este navegador y se aplica al instante.
    setLogoMode(mode) {
      this.logoMode = mode;
      VIULogo.writeMode(mode);
    },

    setRightTab(tab) {
      this.rightTab = tab;
    },

    // Barra de pestañas para ventana angosta (una columna por vez).
    setMobileTab(tab) {
      this.mobileTab = tab;
    },

    toggleDownloads() {
      this.downloadsOpen = !this.downloadsOpen;
      // Abrir el panel marca el error como visto.
      if (this.downloadsOpen) this.downloadErrorUnseen = false;
    },

    // Marca la pestaña actual de Ajustes como con cambios sin guardar.
    markDirty() {
      this.dirtyTabs[this.settingsTab] = true;
    },

    tabDirty(tab) {
      return this.dirtyTabs[tab] === true;
    },

    // Esc cierra lo que esté abierto arriba de todo (ventanas de recompensa,
    // desplegable y luego Ajustes).
    onEscape() {
      if (this.rewardPending) {
        this.cancelRewardPending();
        return;
      }
      if (this.rewardDelete) {
        this.cancelRewardDelete();
        return;
      }
      if (this.rewardForm) {
        this.closeReward();
        return;
      }
      if (this.downloadsOpen) {
        this.downloadsOpen = false;
        return;
      }
      if (this.settingsOpen) this.closeSettings();
    },

    async init() {
      this.logoMode = VIULogo.readMode();
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
      this.downloadErrorUnseen = false;
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
        } else if (this.job.status === "error") {
          this.downloadErrorUnseen = true;
        } else {
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

    // Corta todas las voces superpuestas de los overlays conectados (Parte B).
    async stopAudios() {
      await api("/api/audio/stop", { method: "POST" });
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
        maxAudioVoices: Number(this.settings.maxAudioVoices),
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
      // Solo se limpia el aviso de la pestaña que se guardó.
      this.dirtyTabs[this.settingsTab] = false;
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

    // Carga las reglas y las capacidades de las fuentes conectadas (para el
    // selector de eventos del simulador). Las reglas se crean solas al crear una
    // recompensa (vínculo 1:1) y el creador no las ve.
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
      if (!platform) {
        this.rewards = [];
        this.rewardsConnected = false;
        this.rewardsOffline = false;
        this.rewardsPlatformState = "unlinked";
        this.rewardsMessage = "";
        return;
      }
      const response = await api("/api/platforms/" + encodeURIComponent(platform.id) + "/rewards");
      if (!response.ok) {
        this.rewards = [];
        this.rewardsConnected = false;
        this.rewardsOffline = true;
        this.rewardsPlatformState = platform.state;
        this.rewardsMessage = "No se pudieron cargar las recompensas.";
        return;
      }
      const data = await response.json();
      this.rewards = data.rewards ?? [];
      this.rewardsConnected = data.connected === true;
      this.rewardsOffline = data.offline === true;
      this.rewardsPlatformState = data.platformState ?? platform.state;
      this.rewardsMessage = data.message ?? "";
    },

    // Ruta de una recompensa local dentro de la API de la plataforma.
    rewardPath(platform, reward) {
      return (
        "/api/platforms/" +
        encodeURIComponent(platform.id) +
        "/rewards/" +
        encodeURIComponent(reward.localId)
      );
    },

    clipById(id) {
      return this.clips.find((clip) => clip.id === id) ?? null;
    },

    // Opción del desplegable de clip: nombre y duración.
    rewardClipOption(clip) {
      return clip.title + " · " + this.formatDuration(clip.durationSec);
    },

    // Nombre y duración del clip de una recompensa (para la tarjeta colapsada).
    // Devuelve "" cuando no hay clip local (las recompensas de otra app no muestran
    // nada del clip); "Clip no disponible" es sólo para una propia cuyo clip se borró.
    rewardClipLabel(reward) {
      if (!reward.clipId) return "";
      const clip = this.clipById(reward.clipId);
      if (clip) return clip.title + " · " + this.formatDuration(clip.durationSec);
      return "Clip no disponible";
    },

    // Nombre a mostrar de un ítem de la cola (actual o en espera). El servidor
    // resuelve el nombre del clip en `title` para todos los caminos (canje real,
    // simulador, Probar alerta), y pone el título de la recompensa en `label`.
    // Nunca se muestra el id del clip.
    queueItemName(item) {
      if (!item) return "";
      const clipName = item.title || "Clip no disponible";
      const rewardName = item.label || "";
      if (rewardName && rewardName !== clipName) return clipName + " · " + rewardName;
      return clipName;
    },

    // ¿El clip de la recompensa sigue existiendo en la biblioteca?
    rewardClipExists() {
      const form = this.rewardForm;
      return !!(form && form.clipId && this.clipById(form.clipId));
    },

    // ¿El clip elegido en el formulario tiene imagen? (si no se conoce, se asume que sí)
    rewardClipHasVideo() {
      const form = this.rewardForm;
      if (!form || !form.clipId) return true;
      const clip = this.clipById(form.clipId);
      return clip ? clip.hasVideo !== false : true;
    },

    // Superponer ya no exige un clip de solo audio: solo hace falta un clip elegido
    // (el modo fuerza "solo audio").
    get rewardOverlapAllowed() {
      const form = this.rewardForm;
      return !!(form && form.clipId && this.clipById(form.clipId));
    },

    // El interruptor "Solo audio" queda bloqueado y encendido si lo fuerza el modo
    // superpuesto o un clip sin imagen.
    get rewardAudioOnlyLocked() {
      const form = this.rewardForm;
      if (!form) return false;
      return form.repetition === "overlap" || !this.rewardClipHasVideo();
    },

    rewardAudioOnlyHint() {
      const form = this.rewardForm;
      if (!form) return "";
      if (form.repetition === "overlap") return "Superponer siempre es solo audio";
      if (!this.rewardClipHasVideo()) return "Este clip no tiene imagen";
      return "";
    },

    rewardOverlapTitle() {
      return this.rewardOverlapAllowed ? "Superponer los audios" : "Elegí un clip primero";
    },

    setRewardRepetition(mode) {
      if (!this.rewardForm) return;
      if (mode === "overlap" && !this.rewardOverlapAllowed) return;
      this.rewardForm.repetition = mode === "overlap" ? "overlap" : "queue";
      this.syncRewardAudioOnly();
    },

    toggleRewardAudioOnly() {
      if (!this.rewardForm) return;
      if (this.rewardAudioOnlyLocked) return;
      this.rewardForm.audioOnly = !this.rewardForm.audioOnly;
      this.rewardAudioOnlyChoice = this.rewardForm.audioOnly;
    },

    // Mantiene el interruptor coherente con lo forzado (overlap / clip sin imagen).
    // Al volver de Superponer, recupera lo que el creador había elegido (guardado
    // en `rewardAudioOnlyChoice`).
    syncRewardAudioOnly() {
      const form = this.rewardForm;
      if (!form) return;
      if (form.repetition === "overlap") {
        form.audioOnly = true;
        return;
      }
      if (!this.rewardClipHasVideo()) {
        form.audioOnly = true;
        return;
      }
      form.audioOnly = !!this.rewardAudioOnlyChoice;
    },

    // Texto secundario de la tarjeta colapsada: modo de repetición.
    rewardModeLabel(reward) {
      if (reward.repetition === "overlap") return "superpuesto";
      const seconds = Number(reward.cooldownSec) || 0;
      return seconds > 0 ? "cooldown " + seconds + " s" : "";
    },

    rewardStateLabel(reward) {
      switch (reward.state) {
        case "enabled":
          return "Habilitada";
        case "disabled":
          return "Deshabilitada";
        case "missing":
          return "Falta en Kick";
        case "foreign":
          return "De otra app";
        case "offline":
          return "Sin conexión";
        case "apply_failed":
          return "No se pudo aplicar";
        default:
          return String(reward.state);
      }
    },

    rewardStateBadgeClass(reward) {
      switch (reward.state) {
        case "enabled":
          return "ok";
        case "missing":
          return "warn";
        case "apply_failed":
          return "error";
        default:
          return "off";
      }
    },

    // El interruptor no se puede usar si la recompensa no está sincronizada, la
    // administra otra app, falta en Kick o no se pudo consultar la plataforma.
    rewardToggleBlocked(reward) {
      return (
        !reward.managed ||
        !reward.synced ||
        reward.state === "foreign" ||
        reward.state === "missing" ||
        reward.state === "offline"
      );
    },

    // Explicación del bloqueo del interruptor (tooltip).
    rewardToggleHint(reward) {
      if (!reward.synced) return "Datos sin sincronizar";
      if (reward.state === "foreign") return "La creó otra app: Kick no permite editarla desde acá";
      if (reward.state === "missing") return "Falta en Kick. Recreala o quitala de la app.";
      if (reward.state === "offline") return "Sin conexión con Kick";
      return "No se puede cambiar el estado";
    },

    // Solo se puede editar una recompensa propia, sincronizada y presente en Kick.
    rewardEditable(reward) {
      if (!reward.managed || !reward.synced || !reward.localId) return false;
      return reward.state === "enabled" || reward.state === "disabled" || reward.state === "apply_failed";
    },

    // El color de la tarjeta se puede cambiar en los mismos estados que Editar.
    rewardColorEditable(reward) {
      return this.rewardEditable(reward) && this.rewardColorSaving !== reward.id;
    },

    // Abre el selector de color nativo del cuadradito (input oculto de la tarjeta).
    openRewardColor(reward, event) {
      if (!this.rewardColorEditable(reward)) return;
      const input = event.currentTarget.parentElement.querySelector(".reward-color-input");
      if (input) input.click();
    },

    // Guarda el color al terminar el selector nativo (evento change: no se dispara
    // mientras se arrastra). Una sola solicitud en vuelo y nada si no cambió.
    async applyRewardColor(reward, event) {
      const next = String(event.target.value || "").toLowerCase();
      if (!/^#[0-9a-fA-F]{6}$/.test(next)) return;
      if (next === String(reward.color || "").toLowerCase()) return;
      if (this.rewardColorSaving === reward.id) return;
      const platform = this.activePlatform;
      if (!platform) return;

      const previous = reward.color;
      this.rewardColorSaving = reward.id;
      reward.color = next;
      try {
        const response = await api(this.rewardPath(platform, reward), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ color: next }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          reward.color = previous;
          this.message = data.message || "No se pudo cambiar el color.";
          setTimeout(() => (this.message = ""), 4000);
          return;
        }
        await this.loadRewards(platform);
      } catch {
        reward.color = previous;
        this.message = "No se pudo cambiar el color.";
        setTimeout(() => (this.message = ""), 4000);
      } finally {
        this.rewardColorSaving = null;
      }
    },

    animationLabel(name) {
      switch (name) {
        case "fade":
          return "Desvanecer";
        case "slide-up":
          return "Deslizar hacia arriba";
        case "slide-down":
          return "Deslizar hacia abajo";
        case "zoom":
          return "Zoom";
        default:
          return "Sin animación";
      }
    },

    newReward() {
      this.rewardMessage = "";
      this.rewardPending = null;
      this.rewardDelete = null;
      this.rewardExpanded = false;
      this.rewardTitleTouched = false;
      this.rewardAdvancedOpen = false;
      this.rewardAudioOnlyChoice = false;
      this.rewardForm = {
        id: null,
        title: "",
        cost: 100,
        description: "",
        color: "#00e701",
        enabled: true,
        clipId: "",
        volumePercent: 100,
        maxDurationSec: null,
        cooldownSec: 0,
        repetition: "queue",
        audioOnly: false,
        enterAnimation: "none",
        exitAnimation: "none",
      };
      this.rewardSnapshot = JSON.stringify(this.rewardForm);
    },

    // El clip y las opciones de reproducción son solo locales; el nombre, el costo,
    // el color y la descripción también se envían a la plataforma.
    editReward(reward) {
      if (!this.rewardEditable(reward)) return;
      this.rewardMessage = "";
      this.rewardPending = null;
      this.rewardDelete = null;
      this.rewardExpanded = true;
      this.rewardTitleTouched = true;
      this.rewardAdvancedOpen = false;
      this.rewardAudioOnlyChoice = reward.audioOnly === true;
      this.rewardForm = {
        id: reward.localId,
        title: reward.title,
        cost: reward.cost,
        description: reward.description ?? "",
        color: reward.color ?? "#00e701",
        enabled: reward.enabled,
        clipId: reward.clipId ?? "",
        volumePercent: Math.round((reward.volume ?? 1) * 100),
        maxDurationSec: reward.maxDurationSec ?? null,
        cooldownSec: reward.cooldownSec ?? 0,
        repetition: reward.repetition ?? "queue",
        audioOnly: reward.audioOnly === true,
        enterAnimation: reward.enterAnimation ?? "none",
        exitAnimation: reward.exitAnimation ?? "none",
      };
      this.rewardSnapshot = JSON.stringify(this.rewardForm);
    },

    // Cierra la ventana (avisa si hay cambios sin guardar).
    closeReward() {
      if (this.rewardFormDirty && !window.confirm("Hay cambios sin guardar en la recompensa. ¿Cerrar igual?")) {
        return;
      }
      this.rewardForm = null;
      this.rewardMessage = "";
      this.rewardPending = null;
    },

    closeRewardBackdrop(event) {
      if (event.target === event.currentTarget) this.closeReward();
    },

    toggleRewardAdvanced() {
      this.rewardAdvancedOpen = !this.rewardAdvancedOpen;
    },

    toggleRewardEnabled() {
      if (!this.rewardForm) return;
      this.rewardForm.enabled = !this.rewardForm.enabled;
    },

    // Al elegir un clip, la ventana crece y el nombre se completa solo (mientras el
    // creador no lo haya editado a mano).
    onRewardClipChange() {
      if (!this.rewardForm) return;
      const clip = this.clipById(this.rewardForm.clipId);
      if (!clip) return;
      this.rewardExpanded = true;
      if (!this.rewardTitleTouched) {
        this.rewardForm.title = clip.suggestedTitle || clip.title;
      }
      // Si el nuevo clip no tiene imagen, "Solo audio" queda forzado y se
      // recuerda lo que el creador había elegido para cuando vuelva a un clip con
      // imagen. El modo de repetición no cambia: Superponer siempre es solo audio.
      this.syncRewardAudioOnly();
    },

    markRewardTitleTouched() {
      this.rewardTitleTouched = true;
    },

    async saveReward(platform) {
      const form = this.rewardForm;
      if (!form || !platform) return;
      this.rewardMessage = "";

      if (!form.clipId || !this.clipById(form.clipId)) {
        this.rewardMessage = "Elegí un clip de la biblioteca.";
        return;
      }
      const title = String(form.title || "").trim();
      if (!title) {
        this.rewardMessage = "Escribí un nombre para la alerta.";
        return;
      }
      if (title.length > 50) {
        this.rewardMessage = "El nombre no puede superar los 50 caracteres.";
        return;
      }
      const cost = Math.round(Number(form.cost));
      if (!Number.isFinite(cost) || cost < 1) {
        this.rewardMessage = "El costo debe ser un número mayor o igual a 1.";
        return;
      }
      const color = String(form.color || "").trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        this.rewardMessage = "El color debe tener el formato #RRGGBB.";
        return;
      }

      const body = {
        title,
        cost,
        description: String(form.description || "").trim(),
        color,
        clipId: String(form.clipId),
        volume: Math.min(1, Math.max(0, (numberOrNull(form.volumePercent) ?? 100) / 100)),
        maxDurationSec: numberOrNull(form.maxDurationSec),
        cooldownSec: form.repetition === "overlap" ? 0 : Math.round(Number(form.cooldownSec) || 0),
        repetition: form.repetition === "overlap" ? "overlap" : "queue",
        audioOnly: form.repetition === "overlap" ? true : form.audioOnly === true,
        enterAnimation: form.enterAnimation || "none",
        exitAnimation: form.exitAnimation || "none",
      };

      let method;
      let path;
      if (form.id) {
        method = "PATCH";
        path = "/api/platforms/" + encodeURIComponent(platform.id) + "/rewards/" + encodeURIComponent(form.id);
      } else {
        body.enabled = form.enabled === true;
        method = "POST";
        path = "/api/platforms/" + encodeURIComponent(platform.id) + "/rewards";
      }

      const response = await api(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        this.rewardMessage = data.message || "No se pudo guardar la recompensa.";
        return;
      }
      this.rewardForm = null;
      this.rewardPending = null;
      await this.loadRewards(platform);
    },

    // "Probar alerta": reproduce con la configuración actual, sin guardar.
    async testReward(platform) {
      const form = this.rewardForm;
      if (!form || !form.clipId || !this.clipById(form.clipId)) {
        this.rewardMessage = "Elegí un clip para probar la alerta.";
        return;
      }
      this.rewardMessage = "";
      const response = await api("/api/clips/" + encodeURIComponent(form.clipId) + "/play", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          volume: Math.min(1, Math.max(0, (numberOrNull(form.volumePercent) ?? 100) / 100)),
          maxDurationSec: numberOrNull(form.maxDurationSec) ?? undefined,
          repetition: form.repetition === "overlap" ? "overlap" : "queue",
          audioOnly: form.repetition === "overlap" ? true : form.audioOnly === true,
          enterAnimation: form.enterAnimation || "none",
          exitAnimation: form.exitAnimation || "none",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        this.rewardMessage = data.message || "No se pudo probar la alerta.";
        return;
      }
      this.rewardMessage = "Alerta enviada al overlay.";
    },

    // Alterna activa/desactiva desde la tarjeta (refleja `is_enabled`).
    async toggleReward(platform, reward) {
      if (this.rewardToggleBlocked(reward)) return;
      if (reward.enabled) await this.disableReward(platform, reward);
      else await this.enableReward(platform, reward);
    },

    async enableReward(platform, reward) {
      if (!reward.localId) return;
      this.rewardMessage = "";
      const response = await api(this.rewardPath(platform, reward) + "/enable", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        this.rewardMessage = data.message || "No se pudo activar la recompensa.";
        return;
      }
      await this.loadRewards(platform);
    },

    async disableReward(platform, reward) {
      await this.rewardPendingOperation(platform, reward, "disable", false);
    },

    // Borrar pide una confirmación base primero (el clip no se borra).
    deleteReward(reward) {
      if (!reward.localId) return;
      this.rewardMessage = "";
      this.rewardPending = null;
      this.rewardDelete = { reward };
    },

    cancelRewardDelete() {
      this.rewardDelete = null;
    },

    async confirmRewardDelete(platform) {
      const pendingDelete = this.rewardDelete;
      if (!pendingDelete) return;
      this.rewardDelete = null;
      await this.rewardPendingOperation(platform, pendingDelete.reward, "delete", false);
    },

    // Ejecuta desactivar o borrar con el flujo de canjes pendientes. Con
    // `force` se aplica igual aunque queden rechazos fallidos.
    async rewardPendingOperation(platform, reward, kind, force) {
      if (!reward.localId || !platform) return;
      this.rewardMessage = "";
      const path = this.rewardPath(platform, reward);
      const url = kind === "delete" ? path : path + "/disable";
      const method = kind === "delete" ? "DELETE" : "POST";
      const response = await api(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, force: force === true }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        this.rewardPending = null;
        await this.loadRewards(platform);
        return;
      }
      if (data.needsConfirm) {
        this.rewardPending = {
          kind,
          reward,
          pending: data.pending ?? 0,
          failed: null,
          message: data.message ?? "",
        };
        return;
      }
      if (Array.isArray(data.failed) && data.failed.length > 0) {
        this.rewardPending = {
          kind,
          reward,
          pending: 0,
          failed: data.failed,
          message: data.message ?? "No se pudieron rechazar algunos canjes y no se aplicó el cambio.",
        };
        return;
      }
      this.rewardMessage = data.message || "No se pudo completar la operación.";
    },

    // El primer paso ya pidió confirmación (needsConfirm) o reintenta con force.
    // Se vuelve a llamar: si había pendientes, ahora se rechazan y se aplica.
    async confirmRewardPending(platform) {
      const pending = this.rewardPending;
      if (!pending) return;
      const force = Array.isArray(pending.failed) && pending.failed.length > 0;
      await this.rewardPendingOperation(platform, pending.reward, pending.kind, force);
    },

    cancelRewardPending() {
      this.rewardPending = null;
    },

    // "Falta en Kick": recrear con otro id (conserva la regla local).
    async recreateReward(platform, reward) {
      if (!reward.localId) return;
      this.rewardMessage = "";
      const response = await api(this.rewardPath(platform, reward) + "/recreate", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        this.rewardMessage = data.message || "No se pudo recrear la recompensa.";
        return;
      }
      await this.loadRewards(platform);
    },

    // "Falta en Kick": quitar de la app (borra la fila local y su regla).
    async detachReward(platform, reward) {
      if (!reward.localId) return;
      if (!window.confirm("¿Quitar \"" + reward.title + "\" de la app? Se borra su configuración local.")) return;
      this.rewardMessage = "";
      const response = await api(this.rewardPath(platform, reward) + "/detach", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        this.rewardMessage = data.message || "No se pudo quitar la recompensa.";
        return;
      }
      await this.loadRewards(platform);
    },

    openKickSettings() {
      this.openSettings("kick");
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

    // --- Historial (filas de dos líneas) ---------------------------------------

    // Parsea el payload del evento (llega serializado como JSON en `payloadJson`).
    eventPayload(entry) {
      if (typeof entry.payloadJson !== "string") return null;
      try {
        const parsed = JSON.parse(entry.payloadJson);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    },

    // Título de la recompensa si el evento lo trae; si no, el tipo en español.
    historyTitle(entry) {
      const payload = this.eventPayload(entry);
      if (payload && typeof payload.rewardTitle === "string" && payload.rewardTitle.trim()) {
        return payload.rewardTitle;
      }
      return this.eventTypeLabel(entry.type);
    },

    outcomeBadgeClass(outcome) {
      switch (outcome) {
        case "fired":
          return "ok";
        case "skipped":
        case "duplicate":
          return "warn";
        case "error":
          return "error";
        default:
          return "off";
      }
    },

    outcomeLabel(entry) {
      switch (entry.outcome) {
        case "fired":
          return entry.reason === "superpuesto" ? "Disparó · superpuesto" : "Disparó";
        case "skipped":
          return "Omitido";
        case "error":
          return "Error";
        case "no_match":
          return "Sin regla";
        case "duplicate":
          return "Duplicado";
        default:
          return String(entry.outcome);
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
      // Hora corta en 24 h (por ejemplo 18:59).
      return date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
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