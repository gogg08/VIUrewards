/**
 * Log del servidor y visor de logs / resumen de soporte (Etapa 5, Parte C).
 *
 * - `createFileLogger`: escribe líneas `fecha [nivel] mensaje` a un archivo, con
 *   rotación simple por tamaño (renombra a `.1`). Solo usa `node:fs`, sin
 *   dependencias. El logger NUNCA recibe secretos del código, pero igual se
 *   redacta al leer (defensa en profundidad).
 * - `readLogTail`: lee SOLO el final del archivo (con un límite de bytes), para
 *   no cargar un archivo entero en memoria; devuelve las últimas N líneas.
 * - `redactSecrets`: reemplaza por `***` cualquier valor secreto conocido y los
 *   que aparezcan en patrones como `key=`, `token=`, `secret=`, `password=`.
 * - `buildSupportSummary`: arma un resumen apto para soporte, sin secretos.
 *
 * El visor de logs vive en Ajustes → Avanzado (ver UI-DESIGN.md §7.3).
 */

import { closeSync, existsSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Niveles que el visor puede filtrar (incluye "aviso" en español → warn). */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Tamaño por defecto del archivo de log antes de rotar (2 MiB). */
export const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** Límite por defecto de bytes que se leen del final del archivo (256 KiB). */
export const DEFAULT_READ_MAX_BYTES = 256 * 1024;

export interface FileLogger {
  /** Ruta del archivo de log. */
  path: string;
  /** Escribe una línea con nivel. Nunca lanza. */
  log(level: LogLevel, message: string): void;
  /** Atajo de conveniencia. */
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Cierra el descriptor (por si el proceso quiere soltarlo). */
  close(): void;
}

export interface FileLoggerOptions {
  /** Ruta del archivo de log (se crea la carpeta si no existe la sesión). */
  path: string;
  /** Tamaño máximo antes de rotar; por defecto 2 MiB. */
  maxBytes?: number;
  /** Marca de tiempo; inyectable en tests. */
  now?: () => Date;
  /** Escritura de bajo nivel; inyectable en tests. */
  write?: (fd: number, text: string) => void;
  /** Métricas inyectables para los tests de rotación. */
  sizeOf?: (path: string) => number;
  rotate?: (path: string) => void;
}

function formatLine(level: LogLevel, message: string, now: Date): string {
  const stamp = now.toISOString();
  return `${stamp} [${level}] ${message}\n`;
}

/**
 * Crea el logger de archivo. Si no se puede abrir el archivo (permisos, disco
 * lleno), degrada a un logger que no hace nada: nunca rompe la app por un log.
 */
export function createFileLogger(options: FileLoggerOptions): FileLogger {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const sizeOf = options.sizeOf ?? ((path: string) => (existsSync(path) ? statSync(path).size : 0));
  const rotate = options.rotate ?? ((path: string) => renameSync(path, `${path}.1`));

  let fd: number | null = null;
  let size = 0;
  try {
    // `a` = append; crea el archivo si no existe.
    fd = openSync(options.path, "a");
    size = sizeOf(options.path);
  } catch {
    fd = null;
  }

  const write =
    options.write ??
    ((descriptor: number, text: string) => {
      writeSync(descriptor, text);
    });

  const emit = (level: LogLevel, message: string): void => {
    if (fd === null) return;
    const line = formatLine(level, message, now());
    try {
      if (size > maxBytes) {
        try {
          closeSync(fd);
        } catch {
          // sigue: intentamos rotar igual
        }
        try {
          rotate(options.path);
        } catch {
          // si no se puede rotar, seguimos escribiendo en el mismo archivo
        }
        try {
          fd = openSync(options.path, "a");
        } catch {
          fd = null;
          return;
        }
        size = 0;
      }
      write(fd, line);
      size += Buffer.byteLength(line);
    } catch {
      // Un fallo de escritura no debe romper la app.
    }
  };

  return {
    path: options.path,
    log: emit,
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
    close: () => {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // nada
        }
        fd = null;
      }
    },
  };
}

export interface LogQuery {
  /** Máximo de líneas a devolver (por defecto 200). */
  limit?: number;
  /** Filtro por nivel; sin valor, devuelve todos. */
  level?: LogLevel;
  /** Límite de bytes a leer del final del archivo. */
  maxBytes?: number;
}

/**
 * Lee las últimas `limit` líneas del archivo (o del final, acotado a `maxBytes`),
 * filtrando por nivel. Nunca carga el archivo entero en memoria.
 */
export function readLogTail(path: string, query: LogQuery = {}): string[] {
  const limit = Math.max(1, Math.min(query.limit ?? 200, 5000));
  const maxBytes = Math.max(1024, query.maxBytes ?? DEFAULT_READ_MAX_BYTES);

  if (!existsSync(path)) return [];

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }

  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    // Si cortamos en medio de una línea, descartamos el primer fragmento parcial.
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    const lines = text.split("\n").filter((line) => line.length > 0);
    const filtered = query.level ? lines.filter((line) => lineMatchesLevel(line, query.level!)) : lines;
    return filtered.slice(-limit);
  } catch {
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nada
    }
  }
}

/** ¿La línea pertenece al nivel pedido? El formato es `... [nivel] mensaje`. */
export function lineMatchesLevel(line: string, level: LogLevel): boolean {
  return line.includes(`[${level}]`);
}

export interface RedactOptions {
  /** Valores secretos conocidos a redactar sí o sí. */
  secrets?: readonly (string | null | undefined)[];
}

/** Patrones `clave=valor` / `clave: valor` para claves sensibles. */
const SECRET_KEY_PATTERN =
  /((?:key|token|secret|password|passwd|pwd|authorization|access_token|refresh_token|client_secret|apikey|api_key)["']?\s*[=:]\s*)(["']?)([^\s"'&,)}]+)(\2)/gi;

/** Patrón de query string `?key=...` / `&token=...`. */
const REDACT_PLACEHOLDER = "***";

/**
 * Redacta secretos en una línea: primero los valores conocidos (los más largos
 * primero, para no dejar fragmentos), y luego los patrones `clave=valor`.
 * Nunca revienta con valores cortos o vacíos.
 */
export function redactSecrets(text: string, options: RedactOptions = {}): string {
  let out = text;
  const known = (options.secrets ?? [])
    .filter((value): value is string => typeof value === "string" && value.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) {
    out = out.split(secret).join(REDACT_PLACEHOLDER);
  }
  out = out.replace(SECRET_KEY_PATTERN, (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACT_PLACEHOLDER}${quote}`);
  return out;
}

export interface LogsResponse {
  /** Líneas ya redactadas, de la más vieja a la más nueva. */
  lines: string[];
  /** Cantidad de líneas devueltas. */
  count: number;
  /** Si el archivo de log existe. */
  available: boolean;
}

/** Arma la respuesta del visor de logs: lee el final y redacta. */
export function readLogsForViewer(path: string, query: LogQuery, secrets: readonly (string | null | undefined)[]): LogsResponse {
  const raw = readLogTail(path, query);
  const lines = raw.map((line) => redactSecrets(line, { secrets }));
  return { lines, count: lines.length, available: existsSync(path) };
}

export interface SupportSummaryInput {
  appVersion: string;
  overlayVersion: string;
  tools: { ytDlp: string | null; ffmpeg: string | null; ffprobe: string | null };
  platform: string;
  os: string;
  port: number;
  overlayConnected: boolean;
  overlayClients: number;
  recentErrors: string[];
}

/**
 * Resumen para soporte: texto plano con datos útiles y SIN secretos. Los
 * `recentErrors` se redactan igual que las líneas del visor.
 */
export function buildSupportSummary(input: SupportSummaryInput, secrets: readonly (string | null | undefined)[] = []): string {
  const tool = (value: string | null): string => (value ? value.split("\n")[0].trim() : "no detectada");
  const errors = input.recentErrors.length > 0
    ? input.recentErrors.map((line) => redactSecrets(line, { secrets }))
    : ["(sin errores recientes)"];
  return [
    `VIUrewards ${input.appVersion}`,
    `Sistema: ${input.os}`,
    `Puerto: ${input.port}`,
    `Overlay: ${input.overlayConnected ? `conectado (${input.overlayClients})` : "desconectado"} · build ${input.overlayVersion}`,
    `Plataforma: ${input.platform}`,
    `yt-dlp: ${tool(input.tools.ytDlp)}`,
    `ffmpeg: ${tool(input.tools.ffmpeg)}`,
    `ffprobe: ${tool(input.tools.ffprobe)}`,
    "Últimos errores:",
    ...errors.map((line) => `  ${line}`),
  ].join("\n");
}
