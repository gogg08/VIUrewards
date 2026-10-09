/**
 * Tabla `settings` (clave/valor) con el acceso tipado que usa la app (Fase 3).
 */

import type { SqliteDatabase } from "./database.ts";

/** Clave del hash de la contraseña local. */
export const SETTING_AUTH_PASSWORD = "auth.password";
/** Clave del token secreto del overlay. */
export const SETTING_OVERLAY_KEY = "overlay.key";

interface SettingRow {
  value: string;
}

export function getSetting(db: SqliteDatabase, key: string): string | null {
  const row = db.prepare<SettingRow>("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setSetting(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function deleteSetting(db: SqliteDatabase, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** Devuelve el valor existente o lo genera y guarda la primera vez. */
export function getOrCreateSecret(
  db: SqliteDatabase,
  key: string,
  generate: () => string,
): string {
  const existing = getSetting(db, key);
  if (existing !== null) return existing;
  const value = generate();
  setSetting(db, key, value);
  return value;
}