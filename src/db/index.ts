/**
 * Acceso a la base local (Fase 3).
 */

export {
  migrate,
  openDatabase,
  openMemoryDatabase,
  SCHEMA_VERSION,
  type SqliteDatabase,
} from "./database.ts";

export {
  deleteSetting,
  getOrCreateSecret,
  getSetting,
  setSetting,
  SETTING_AUTH_PASSWORD,
  SETTING_OVERLAY_KEY,
} from "./settings.ts";

export {
  deleteClip,
  getClip,
  listClips,
  reconcileClips,
  renameClip,
  setClipTrim,
  upsertClip,
  type ClipRecord,
  type ReconcileResult,
} from "./clips.ts";