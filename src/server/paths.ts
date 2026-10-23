/**
 * Rutas de ejecución de la app (Fase de distribución, Etapa 1).
 *
 * Hasta acá todas las rutas mutables se derivaban del **directorio de trabajo**
 * (`process.cwd()`), así que la app solo funcionaba si el cwd era la carpeta del
 * proyecto. Para distribuir hace falta separar tres cosas:
 *
 *  1. **Directorio de aplicación** (código, `web/`, `overlay/`, dependencias):
 *     pertenece a una versión y se puede reemplazar al actualizar. Lo resuelve
 *     `import.meta.url` y NO depende de esta configuración: cambiar el directorio
 *     de datos nunca debe afectar a los recursos estáticos.
 *  2. **Directorio de datos** (base, medios, uploads, logs): debe persistir entre
 *     versiones. Lo define `VIUREWARDS_DATA_DIR`.
 *  3. **Directorio de herramientas administradas** (`bin/`): binarios como
 *     `yt-dlp` que se actualizan por fuera del código (el botón del dashboard).
 *
 * Este módulo es el **único** lugar que lee `VIUREWARDS_DATA_DIR`: el resto de la
 * app recibe las rutas ya resueltas (`scripts/start.ts` → `createServer`).
 *
 * - **Sin la variable** se conserva EXACTAMENTE la distribución histórica
 *   (todo bajo el cwd: `media/`, `.uploads/`, `logs/`, `data/app.db`, `bin/`).
 * - **Con la variable** todos los recursos mutables viven dentro de esa carpeta,
 *   que debe ser una ruta **absoluta**; una ruta relativa o imposible de usar da
 *   un error claro en español en vez de inicializar en silencio en otra carpeta.
 */

import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { SHARED_RESOURCES_LOCK_FILE } from "../db/instance-lock.ts";

/** Variable que define un directorio de datos externo (y persistente). */
export const DATA_DIR_ENV = "VIUREWARDS_DATA_DIR";

/**
 * Variable opcional con la ruta del runtime de Node que yt-dlp debe usar como
 * runtime JS (`--js-runtimes node:<ruta>`). En distribución apunta al Node
 * portable incluido en el paquete; en desarrollo se omite y se usa el Node que
 * corre la app (comportamiento histórico).
 */
export const NODE_RUNTIME_ENV = "VIUREWARDS_NODE_RUNTIME";

/** Código de salida del arranque cuando `VIUREWARDS_DATA_DIR` es inválida. */
export const INVALID_DATA_DIR_EXIT_CODE = 2;

/** Subcarpeta de datos dentro del directorio heredado (solo en modo histórico). */
export const LEGACY_DATA_SUBDIR = "data";

/** Error de arranque: la configuración de rutas no es utilizable. */
export class InvalidDataDirError extends Error {
  /** Mensaje en español, listo para la consola. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "InvalidDataDirError";
    this.reason = reason;
  }
}

export interface RuntimePaths {
  /** `legacy`: la distribución histórica (todo bajo el cwd). `configured`: `VIUREWARDS_DATA_DIR`. */
  mode: "legacy" | "configured";
  /**
   * Raíz de la instalación: la carpeta que CONTIENE `media/`, `.uploads/` y
   * `logs/`. Es donde vive el cerrojo de recursos compartidos y, por lo tanto,
   * el conjunto que queda bajo exclusividad de una sola instancia.
   */
  root: string;
  /** Cerrojo de recursos compartidos (`.viurewards.lock`). */
  lockPath: string;
  /** Base SQLite. */
  dbPath: string;
  /** Carpeta que contiene la base (y el cerrojo de diagnóstico `instance.lock`). */
  dataDir: string;
  /** Biblioteca de clips (incluye `media/thumbs/`). */
  mediaDir: string;
  /** Temporales de las subidas de archivos locales. */
  uploadsDir: string;
  /** Logs y `pending-media.txt`. */
  logsDir: string;
  /** Directorio de herramientas administradas (yt-dlp actualizado desde el dashboard). */
  binDir: string;
  /** Runtime de Node para yt-dlp, si se conoce (ver `NODE_RUNTIME_ENV`). */
  nodeRuntime?: string;
  /** Avisos no fatales de la resolución (p. ej. una variable ignorada). */
  warnings: string[];
}

export type ResolvePathsResult = { ok: true; paths: RuntimePaths } | { ok: false; message: string };

export interface ResolvePathsOptions {
  /** Directorio de trabajo a usar en modo histórico; por defecto `process.cwd()`. */
  cwd?: string;
  /** Entorno a leer; por defecto `process.env`. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Inyectables en tests (por defecto `fs`). */
  exists?: (path: string) => boolean;
  isDir?: (path: string) => boolean;
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Candidatos del runtime de Node dentro de `bin/` (en Windows solo `.exe`). */
export function nodeRuntimeCandidates(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["node.exe", "node"] : ["node"];
}

/**
 * Ruta del runtime de Node para yt-dlp.
 *
 * Prioridad: `VIUREWARDS_NODE_RUNTIME` (debe ser absoluta; una relativa se
 * ignora y se avisa) y, si no está, `<binDir>/node[.exe]` cuando existe. Si no
 * hay ninguna, devuelve `undefined` y la app usa el Node que la ejecuta.
 */
function resolveNodeRuntime(
  env: NodeJS.ProcessEnv,
  binDir: string,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  warnings: string[],
): string | undefined {
  const raw = env[NODE_RUNTIME_ENV];
  const explicit = raw?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    if (isAbsolute(explicit)) return resolve(explicit);
    warnings.push(
      `${NODE_RUNTIME_ENV} se ignoró porque no es una ruta absoluta ("${explicit}"): se usará el Node que ejecuta la app.`,
    );
  }
  for (const name of nodeRuntimeCandidates(platform)) {
    const candidate = join(binDir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Rutas históricas: TODO bajo el cwd (comportamiento anterior, sin cambios). */
function legacyPaths(
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): RuntimePaths {
  const warnings: string[] = [];
  const dataDir = join(cwd, LEGACY_DATA_SUBDIR);
  const binDir = join(cwd, "bin");
  return {
    mode: "legacy",
    root: cwd,
    lockPath: join(cwd, SHARED_RESOURCES_LOCK_FILE),
    dbPath: join(dataDir, "app.db"),
    dataDir,
    mediaDir: join(cwd, "media"),
    uploadsDir: join(cwd, ".uploads"),
    logsDir: join(cwd, "logs"),
    binDir,
    nodeRuntime: resolveNodeRuntime(env, binDir, platform, exists, warnings),
    warnings,
  };
}

/**
 * Resuelve todas las rutas mutables de la app.
 *
 * Nunca lanza: devuelve `ok: false` con el motivo en español cuando la
 * configuración no es utilizable.
 */
export function resolveRuntimePaths(options: ResolvePathsOptions = {}): ResolvePathsResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const isDir = options.isDir ?? defaultIsDir;

  const raw = env[DATA_DIR_ENV];
  if (raw === undefined) return { ok: true, paths: legacyPaths(cwd, env, platform, exists) };

  const value = raw.trim();
  if (value.length === 0) {
    return {
      ok: false,
      message: `${DATA_DIR_ENV} está definida pero vacía. Poné una ruta absoluta o quitá la variable para usar la configuración del directorio de trabajo.`,
    };
  }
  if (!isAbsolute(value)) {
    return {
      ok: false,
      message: `${DATA_DIR_ENV} tiene que ser una ruta ABSOLUTA (recibí "${value}"): una ruta relativa dependería del directorio de trabajo y podría usar una carpeta distinta de la esperada.`,
    };
  }

  const dataDir = resolve(value);
  if (exists(dataDir) && !isDir(dataDir)) {
    return {
      ok: false,
      message: `${DATA_DIR_ENV} apunta a "${dataDir}", que existe pero no es una carpeta. Elegí otra ruta o quitá la variable.`,
    };
  }

  const warnings: string[] = [];
  const binDir = join(dataDir, "bin");
  return {
    ok: true,
    paths: {
      mode: "configured",
      root: dataDir,
      lockPath: join(dataDir, SHARED_RESOURCES_LOCK_FILE),
      // En el modo configurado la base vive directamente en el directorio de
      // datos (no en una subcarpeta `data/`), junto a media/, .uploads/, logs/
      // y bin/.
      dbPath: join(dataDir, "app.db"),
      dataDir,
      mediaDir: join(dataDir, "media"),
      uploadsDir: join(dataDir, ".uploads"),
      logsDir: join(dataDir, "logs"),
      binDir,
      nodeRuntime: resolveNodeRuntime(env, binDir, platform, exists, warnings),
      warnings,
    },
  };
}

export type PrepareDataDirResult = { ok: true } | { ok: false; message: string };

/**
 * Asegura que el directorio de datos exista y sea escribible ANTES de tomar el
 * cerrojo y crear subcarpetas: así un problema de permisos se informa como tal y
 * no se confunde con "otra copia abierta".
 *
 * Se crean también `bin/` y `logs/`: en modo configurado las tres carpetas viven
 * dentro del directorio de datos y deben existir antes de que el arranque escriba
 * en ellas (el libro del journal y la detección de binarios no crean carpetas).
 */
export function prepareDataDir(dataDir: string): PrepareDataDirResult {
  for (const dir of [dataDir, join(dataDir, "bin"), join(dataDir, "logs")]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        message: `No se pudo crear el directorio "${dir}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    accessSync(dataDir, constants.R_OK | constants.W_OK);
  } catch (error) {
    return {
      ok: false,
      message: `El directorio de datos "${dataDir}" no se puede leer o escribir: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ok: true };
}

export interface LegacyDataNoticeOptions {
  /**
   * Directorio de trabajo donde vive la instalación heredada. Solo se usa con
   * instalaciones de tipo `legacy`; en modo `configured` la ubicación heredada
   * es siempre la del proceso (`process.cwd()`), porque es donde viviría la
   * copia de desarrollo/portable si se la arrancara sin la variable.
   */
  cwd?: string;
  exists?: (path: string) => boolean;
  sizeOf?: (path: string) => number;
}

/**
 * Aviso (no migración) para no "perder" datos en silencio.
 *
 * Si se configuró un directorio de datos externo y todavía no tiene base, pero
 * la ubicación heredada (`<cwd>/data/app.db`) sí tiene una con contenido, la app
 * arrancaría con una base nueva vacía. No se mueve ni se borra nada: se devuelve
 * un mensaje claro para que el usuario decida. Sin la variable, o si el
 * directorio configurado ya tiene base, devuelve `null`.
 */
export function legacyDataNotice(
  paths: RuntimePaths,
  options: LegacyDataNoticeOptions = {},
): string | null {
  if (paths.mode !== "configured") return null;
  const exists = options.exists ?? existsSync;
  const sizeOf = options.sizeOf ?? ((path: string): number => {
    try {
      const stats = statSync(path);
      return stats.isFile() ? stats.size : 0;
    } catch {
      return 0;
    }
  });
  const cwd = resolve(options.cwd ?? process.cwd());
  const legacyDb = join(cwd, LEGACY_DATA_SUBDIR, "app.db");
  if (!exists(legacyDb) || sizeOf(legacyDb) <= 0) return null;
  if (exists(paths.dbPath)) return null;
  return [
    `Aviso: hay una base de datos anterior en "${legacyDb}" y el directorio de datos`,
    `configurado ("${paths.dataDir}") todavía no tiene una, así que VIUrewards arrancó`,
    "con una base nueva y vacía. NO se movió ni se borró nada:",
    `  - para conservar esos datos, copiá "${dirname(legacyDb)}" (y su "media/") dentro de "${paths.dataDir}", o`,
    `  - quitá ${DATA_DIR_ENV} para seguir usando la instalación heredada.`,
  ].join(" ");
}

/** Resumen legible del mapa de rutas (para el log de arranque y soporte). */
export function describePaths(paths: RuntimePaths): string {
  const where = paths.mode === "configured" ? "datos en" : "datos (heredado) en";
  return `${where} ${paths.root} [base ${paths.dbPath}; medios ${paths.mediaDir}; logs ${paths.logsDir}; bin ${paths.binDir}]`;
}