/**
 * Exclusividad de instancia (limpieza de temporales al arrancar).
 *
 * La limpieza de temporales solo es segura si esta instancia tiene **derecho
 * exclusivo** sobre `data/` y `/media`: otra copia de VIUrewwards abierta por
 * error podría estar usando un `.upload` o una descarga de hace un rato.
 *
 * Antes no había ninguna garantía. Hoy la exclusividad se toma en un **archivo
 * cerrojo** aparte (`data/instance.lock`), no en la base:
 *
 *  - `fs.openSync` con `wx` (crear y no existe) es atómico y funciona igual en
 *    Windows y Unix. El archivo NO se borra al salir bien: se escribe `pid` y
 *    fecha, y si el proceso muere (por más abrupto que sea) queda un archivo
 *    viejo que aparenta estar en uso. Por eso un cerrojo se libera solo si su
 *    proceso ya no existe (`process.kill(pid, 0)` → `ESRCH`) o si pasó una
 *    antigüedad máxima (no se sabe de quién es). Si el proceso EXISTE se respeta
 *    aunque el archivo sea viejo: un pid puede reciclarse y se prefiere no
 *    limpiar de más.
 *
 * Se descartó usar un `BEGIN EXCLUSIVE` de SQLite (la versión anterior): la
 * transacción quedaba abierta toda la vida del proceso, así que el servidor no
 * podía escribir mientras se tomaba el lock y una segunda instancia moría con
 * `SQLITE_BUSY` en vez de arrancar con un aviso. Además el lock se perdía al
 * cerrar la base, no al terminar el proceso.
 *
 * Ese cerrojo solo separa a las copias que comparten `data/`. Una copia con otro
 * `data/` pero el MISMO `media/` no lo vería, así que la exclusividad real se
 * toma sobre el **directorio de recursos compartidos**
 * (`acquireSharedResourcesLock`): un cerrojo oculto (`.viurewards.lock`) en la
 * raíz que contiene `media/`, `<raíz>/.uploads` y `<raíz>/logs`. Si falta, el
 * arranque NO sigue (ver `SharedDataInUseError`).
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface InstanceLock {
  /** ¿Esta instancia tiene la exclusividad? */
  acquired: boolean;
  /** Motivo legible (en español) si el lock se tomó o no. */
  message: string;
  /** Libera el lock (idempotente). Lo llama el dueño del ciclo de vida. */
  release(): void;
}

/** Nombre del archivo cerrojo dentro de `data/`. */
export const INSTANCE_LOCK_FILE = "instance.lock";

/**
 * Nombre del cerrojo de recursos compartidos, en la raíz que contiene `media/`.
 *
 * Va oculto y con un nombre propio para no chocar con nada del usuario ni
 * confundirse con un archivo de medios.
 */
export const SHARED_RESOURCES_LOCK_FILE = ".viurewards.lock";

/** Antigüedad después de la cual un cerrojo de un pid desconocido se libera (7 días). */
export const DEFAULT_LOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface InstanceLockOptions {
  /** Ruta del cerrojo. Por defecto `<carpeta de la base>/instance.lock`. */
  path?: string;
  /** Reloj inyectable. */
  now?: () => number;
  /** Antigüedad máxima de un cerrojo sin proceso vivo. */
  maxAgeMs?: number;
  /** ¿Sigue vivo ese pid? Inyectable en tests. */
  isAlive?: (pid: number) => boolean;
  /** Registro de lo que se descarta (un cerrojo viejo liberado). */
  log?: (message: string) => void;
}

interface LockContents {
  pid: number;
  at: number;
}

function parseContents(text: string): LockContents | null {
  try {
    const data = JSON.parse(text) as { pid?: unknown; at?: unknown };
    if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) return null;
    if (typeof data.at !== "number" || !Number.isFinite(data.at)) return null;
    return { pid: data.pid, at: data.at };
  } catch {
    return null;
  }
}

/** Antigüedad del archivo por su `mtime` (0 si no se puede leer). */
function fileAge(path: string, now: () => number): number {
  try {
    return Math.max(0, now() - statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

/** ¿El proceso existe? `EPERM` cuenta como vivo (existe pero es de otro usuario). */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code !== "ESRCH";
  }
}

/**
 * Toma la exclusividad de la instancia.
 *
 * Nunca lanza: devuelve `acquired: false` con el motivo si otra instancia está
 * viva o si algo falla. Quien llama decide (la limpieza NO corre sin
 * exclusividad, pero la app arranca igual).
 */
export function acquireInstanceLock(dbPath: string, options: InstanceLockOptions = {}): InstanceLock {
  const path = options.path ?? join(dirname(dbPath), INSTANCE_LOCK_FILE);
  const now = options.now ?? (() => Date.now());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_LOCK_MAX_AGE_MS;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const log = options.log ?? (() => {});

  let held = false;
  const release = (): void => {
    if (!held) return;
    held = false;
    try {
      rmSync(path, { force: true });
    } catch {
      // Si no se puede borrar, el cerrojo caduca por antigüedad (no bloquea para siempre).
    }
  };

  const notAcquired = (message: string): InstanceLock => ({ acquired: false, message, release });

  const tryCreate = (): boolean => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: now() } satisfies LockContents));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") return false;
      // Otro error (permisos, disco): no se tomó el cerrojo y se conserva lo que haya.
      return false;
    }
  };

  try {
    if (tryCreate()) {
      held = true;
      return { acquired: true, message: "Instancia exclusiva confirmada.", release };
    }

    // Hay un cerrojo: ¿es de un proceso que sigue vivo y es reciente?
    let contents: LockContents | null = null;
    try {
      contents = parseContents(readFileSync(path, "utf8"));
    } catch {
      contents = null;
    }
    // Si existe el cerrojo pero no se pudo leer el proceso (o el proceso ya no
    // existe), caduca por antigüedad: un cerrojo viejo no bloquea para siempre.
    const age = contents
      ? now() - contents.at
      : fileAge(path, now);
    if (contents && isAlive(contents.pid)) {
      return notAcquired("Otra copia de VIUrewards parece estar abierta con los mismos datos.");
    }
    if (!contents && age <= maxAgeMs) {
      // Sin datos del proceso no se puede asegurar que esté muerto: si es reciente,
      // se respeta; si no, se libera.
      return notAcquired("Hay otra copia de VIUrewards usando los mismos datos (cerrojo reciente).");
    }

    log(
      contents
        ? `Cerrojo de una ejecución anterior (pid ${contents.pid}) liberado.`
        : "Cerrojo ilegible de una ejecución anterior liberado.",
    );
    try {
      rmSync(path, { force: true });
    } catch {
      return notAcquired("Hay otra copia de VIUrewards usando los mismos datos (no se pudo liberar el cerrojo).");
    }
    if (tryCreate()) {
      held = true;
      return { acquired: true, message: "Instancia exclusiva confirmada.", release };
    }
    // Otra instancia lo tomó entre el borrado y el intento.
    return notAcquired("Otra copia de VIUrewards parece estar abierta con los mismos datos.");
  } catch (error) {
    return notAcquired(
      `No se pudo confirmar la exclusividad de la instancia: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Toma la exclusividad sobre los **recursos compartidos** (la raíz con
 * `media/`, `.uploads/` y `logs/`).
 *
 * Es el cerrojo que de verdad protege la distribución: dos copias con distintas
 * carpetas `data/` (y bases distintas) pero el mismo `media/` sí se ven entre
 * sí. La ruta se normaliza con `resolve()` para que `media/` y `./media/` sean
 * el mismo cerrojo.
 *
 * `sharedRoot` es la raíz de la instalación (la carpeta que CONTIENE `media/`,
 * `.uploads/` y `logs/`), no la carpeta de medios: el archivo queda al lado de
 * `media/`, nunca adentro (la carpeta de medios la recorre la reconciliación y
 * es la que apunta OBS).
 *
 * Reutiliza la misma mecánica que `acquireInstanceLock` (`wx` atómico, pid y
 * antigüedad); solo cambia la ruta y el mensaje. Nunca lanza: quien llama decide
 * si sale o sigue.
 */
export function acquireSharedResourcesLock(sharedRoot: string, options: InstanceLockOptions = {}): InstanceLock {
  const path = options.path ?? join(resolve(sharedRoot), SHARED_RESOURCES_LOCK_FILE);
  return acquireInstanceLock(path, {
    ...options,
    // El cerrojo no vive en `data/`, así que no se deriva de la base: se toma
    // sobre el archivo ya resuelto.
    path,
  });
}
