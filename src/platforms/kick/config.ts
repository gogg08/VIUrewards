/**
 * Constantes y valores por defecto del adaptador de Kick (Fase 4B).
 *
 * Verificados en docs/kick-research.md: endpoints (Sección 1), scopes (1.4),
 * recompensas y canjes (Sección 8), alta de app (1.5).
 */

/** Servidor de identidad/OAuth. */
export const KICK_ID_BASE_URL = "https://id.kick.com";
/** Servidor de API. */
export const KICK_API_BASE_URL = "https://api.kick.com";

export const KICK_AUTHORIZE_PATH = "/oauth/authorize";
export const KICK_TOKEN_PATH = "/oauth/token";

/** Scopes necesarios para vincular la cuenta y gestionar recompensas. */
export const KICK_SCOPES = ["user:read", "channel:rewards:read", "channel:rewards:write"] as const;

/** Intervalo de polling por defecto y mínimo tolerado (configurable). */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const MIN_POLL_INTERVAL_MS = 1_000;

/** Kick acepta como máximo 25 ids por llamada a accept/reject. */
export const MAX_RESOLVE_BATCH = 25;

/** Ruta del callback registrada en la app de Kick. */
export const KICK_CALLBACK_PATH = "/callback";
export const DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";

/** Ventana de validez de un intento de vínculo (state + code_verifier). */
export const LINK_ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** Cuántas latencias de detección se recuerdan para las estadísticas. */
export const LATENCY_WINDOW = 50;

export const MAX_REDEMPTION_PAGES = 20;

/** Nombre visible de la plataforma. */
export const KICK_DISPLAY_NAME = "Kick";

/** Tamaño máximo del texto del usuario que se guarda (input no confiable). */
export const MAX_USER_INPUT_STORED = 2048;