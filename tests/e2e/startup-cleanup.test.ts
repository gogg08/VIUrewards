/**
 * Prueba de INTEGRACIÓN del arranque REAL: `scripts/start.ts` como proceso hijo,
 * con todas las carpetas y la base redirigidas a un directorio temporal.
 *
 * Qué comprueba de verdad (en la plataforma donde corre, hoy Windows):
 *
 *  1. El punto de entrada arranca, toma la exclusividad de la instancia y queda
 *     accesible por HTTP.
 *  2. La limpieza de arranque corre ANTES de levantar el servidor: borra un
 *     temporal viejo de `.uploads/` y una salida de conversión interrumpida (con
 *     evidencia en `logs/pending-media.txt`), y conserva un clip registrado y un
 *     archivo ajeno.
 *  3. Al pedir el cierre, sale con código 0 dentro del plazo y la base temporal
 *     se puede reabrir.
 *  4. Una segunda instancia con los mismos datos NO obtiene la exclusividad:
 *     sale con código 3 (SharedDataInUseError) sin levantar el servidor, sin
 *     reconciliar la biblioteca, sin borrar temporales de la primera y sin
 *     tocar su cerrojo.
 *  5. Dos copias con carpetas `data/` DISTINTAS pero el mismo `media/` tampoco
 *     conviven (el cerrojo compartido vive en la raíz de recursos).
 *
 * Cómo se pide el cierre: en Windows, Node no puede entregar SIGINT/SIGTERM a
 * otro proceso (`child.kill` lo mata sin ejecutar el manejador), así que un
 * arnés importa `main()` del punto de entrada real (no arranca nada al
 * importarse) y REENVÍA el aviso de IPC a un manejador REAL instalado con
 * `process.on` (mismo camino que una señal del sistema). Un Ctrl+C real de la
 * consola sigue siendo una prueba MANUAL.
 *
 * El puerto lo elige SIEMPRE la prueba (uno libre, consultado al sistema) y se
 * pasa con `PORT`: sin él, el arranque usaría el puerto de los ajustes (8787)
 * y chocaría con una instancia real del usuario. El puerto que IMPRIME el
 * servidor se lee igual, así se verifica que usó el pedido.
 *
 * NO corre con `npm test`. Se corre con: `npm run test:e2e`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { openDatabase } from "../../src/db/database.ts";
import { upsertClip } from "../../src/db/clips.ts";
import { SHARED_RESOURCES_LOCK_FILE } from "../../src/db/instance-lock.ts";
import {
  captureBaseline,
  describeSurvivors,
  killOwnTree,
  spyOnChildProcess,
} from "./helpers/proc-tree.ts";

// Lista blanca ANTES de cualquier test: ningún pid previo (ni la instalación
// real del usuario) se toca por aparecer en la tabla de procesos.
captureBaseline();
spyOnChildProcess();

/**
 * Cada test deja rastro de lo creado: los `ChildProcess` del arnés. El `finally`
 * NO señaliza: la limpieza es `killOwnTree`, que va por parentesco y verifica
 * el estado antes de matar (ver `helpers/proc-tree.ts`).
 */
const created: ChildProcess[] = [];

const HOUR = 60 * 60 * 1000;
const CLIP_ID = "9a3b1c4d5e6f708192a3b4c5d6e7f801";
const OTHER_ID = "c0ffee00deadbeefc0ffee00deadbeef";
const STALE_SOURCE_ID = "deadbeefdeadbeefdeadbeefdeadbeef";
const UUID = "0d9b1f6e-1f2a-4a3c-9d19-7f5b6c0e2a44";

/** Arnés: importa `main()` y traduce el aviso de cierre a la señal real. */
const HARNESS = String.raw`
const { main, SharedDataInUseError, SHARED_DATA_IN_USE_EXIT_CODE } = await import(process.env.START_MODULE);
const { InvalidDataDirError, INVALID_DATA_DIR_EXIT_CODE } = await import(process.env.PATHS_MODULE);

process.on("message", (message) => {
  if (message === "close") process.emit("SIGINT");
});

// Mismo manejo que el punto de entrada real (isEntryPoint en scripts/start.ts):
// sin él, un arranque denegado saldría con el código genérico de Node.
try {
  await main();
} catch (error) {
  if (error instanceof SharedDataInUseError) {
    console.error("No se puede arrancar VIUrewards: " + error.reason);
    process.exit(SHARED_DATA_IN_USE_EXIT_CODE);
  }
  if (error instanceof InvalidDataDirError) {
    console.error("No se puede arrancar VIUrewards: " + error.reason);
    process.exit(INVALID_DATA_DIR_EXIT_CODE);
  }
  throw error;
}
process.send?.({ ready: true, pid: process.pid });
// El servidor mantiene el proceso vivo; esto solo evita salir si algo se cierra.
setInterval(() => {}, 1000);
`;

interface Env {
  root: string;
  mediaDir: string;
  uploadsDir: string;
  logsDir: string;
  dataDir: string;
}

const roots: string[] = [];

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "viu-e2e-startup-"));
  roots.push(root);
  const env: Env = {
    root,
    mediaDir: join(root, "media"),
    uploadsDir: join(root, ".uploads"),
    logsDir: join(root, "logs"),
    dataDir: join(root, "data"),
  };
  for (const dir of [env.mediaDir, env.uploadsDir, env.logsDir, env.dataDir]) mkdirSync(dir, { recursive: true });
  return env;
}

function writeAged(path: string, ageHours: number, content = "x"): void {
  writeFileSync(path, content, "utf8");
  const when = new Date(Date.now() - ageHours * HOUR);
  utimesSync(path, when, when);
}

/**
 * Siembra la base con una fila usando el MISMO `openDatabase` de la app
 * (migraciones incluidas). Es una base temporal: nunca `data/app.db`.
 */
function seedDatabase(env: Env): void {
  const db = openDatabase(join(env.dataDir, "app.db"));
  try {
    upsertClip(db, {
      id: CLIP_ID,
      sourceUrl: "https://www.youtube.com/watch?v=x",
      title: "Clip registrado",
      durationSec: 5,
      sizeBytes: 1,
      file: `${CLIP_ID}.mp4`,
      createdAt: new Date().toISOString(),
      trimStart: null,
      trimEnd: null,
      hasVideo: true,
      missing: false,
    });
  } finally {
    db.close();
  }
}

interface Running {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  exitedEarly: () => { code: number | null; signal: string | null } | null;
}

/**
 * Puerto libre que el sistema acaba de confirmar. Permite arrancar la instancia
 * de prueba en un puerto PROPIO aunque el conjunto de puertos por defecto (8787)
 * esté ocupado por una instancia real del usuario.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(
  root: string,
  env: Env,
  requestedPort = 0,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Running> {
  const scriptPath = join(env.root, `harness-${Date.now()}-${Math.random().toString(16).slice(2)}.ts`);
  writeFileSync(scriptPath, HARNESS);

  // La instancia de prueba usa SIEMPRE un puerto libre: sin `PORT` el arranque
  // toma el puerto de los ajustes (8787 por defecto), que puede ser el de una
  // instancia real del usuario y haría fallar la prueba por una razón ajena.
  const chosenPort = requestedPort > 0 ? requestedPort : await freePort();

  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    env: {
      ...process.env,
      START_MODULE: new URL("../../scripts/start.ts", import.meta.url).href,
      PATHS_MODULE: new URL("../../src/server/paths.ts", import.meta.url).href,
      PORT: String(chosenPort),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  created.push(child);

  let output = "";
  let port = 0;
  let exitedEarly: { code: number | null; signal: string | null } | null = null;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exitedEarly = { code, signal };
      resolve({ code, signal });
    });
  });

  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`el servidor no arrancó:\n${output}`)), 60_000);
    const check = (): void => {
      const match = /Dashboard: http:\/\/[^:]+:(\d+)\//.exec(output);
      if (match) {
        port = Number(match[1]);
        clearTimeout(timer);
        resolve(port);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      check();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      check();
    });
    // Una instancia que se niega a arrancar (cerrojo tomado) sale sin imprimir
    // el puerto: no hay que esperar 60 s, la salida se lee igual.
    void exited.then(() => {
      if (port === 0) {
        clearTimeout(timer);
        resolve(0);
      }
    });
  });

  port = await ready;
  return { child, port, output: () => output, exited, exitedEarly: () => exitedEarly };
}

async function waitForExit(running: Running, ms: number): Promise<{ code: number | null }> {
  const early = running.exitedEarly();
  if (early) return Promise.resolve({ code: early.code });
  return Promise.race([
    running.exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no salió en ${ms} ms:\n${running.output()}`)), ms),
    ),
  ]);
}

interface FileStamp {
  size: number;
  mtimeMs: number;
  /** Contenido completo (los archivos de SQLite de prueba son chicos). */
  sha: string;
}

/**
 * Huella de los archivos de una base SQLite: el `.db` y sus auxiliares (WAL,
 * SHM, journal). Un `openDatabase()` escribe (o al menos toca) estos archivos;
 * comparar la huella antes y después detecta que la segunda instancia abrió la
 * base aunque no haya llegado a insertar nada.
 */
function stampSqliteFiles(dbPath: string): Map<string, FileStamp> {
  const stamps = new Map<string, FileStamp>();
  const dir = join(dbPath, "..");
  const base = dbPath.slice(dir.length + 1);
  for (const name of readdirSync(dir)) {
    if (name !== base && !name.startsWith(`${base}-`)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    stamps.set(name, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha: readFileSync(full).toString("base64"),
    });
  }
  return stamps;
}

async function waitForHttp(port: number, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`);
      if (response.ok) return true;
    } catch {
      // Todavía no escucha.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function cleanup(): void {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows puede retener carpetas; no debe tapar el resultado.
    }
  }
}

/**
 * Limpieza al terminar CADA test, falle o no.
 *
 * Solo toca los procesos que este archivo creó: el arnés (por parentesco) y sus
 * descendientes. Si uno sobrevive, el test falla con su pid y su línea de
 * comandos (`describeSurvivors`): la limpieza no miente.
 */
afterEach(async () => {
  const roots_ = created.splice(0).map((child) => child.pid).filter((pid): pid is number => typeof pid === "number");
  const result = await killOwnTree({ roots: roots_ });
  expect(result.survivors, describeSurvivors(result.survivors)).toEqual([]);
  cleanup();
});

it(
  "el arranque real limpia temporales huérfanos y se cierra ordenadamente",
  { timeout: 120_000 },
  async () => {
    const env = makeEnv();
    seedDatabase(env);

    // Huérfanos de una ejecución anterior:
    const staleUpload = join(env.uploadsDir, `${UUID}.upload`);
    writeAged(staleUpload, 30);
    // Descarga vieja de un id SIN fila: temporal huérfano de yt-dlp.
    const staleSource = join(env.mediaDir, `${STALE_SOURCE_ID}.src.mp4`);
    writeAged(staleSource, 30);
    // Conversión interrumpida: mp4 final sin fila + evidencia en el libro (sin
    // temporales de descarga vivos de ese id, que es la condición de la evidencia).
    const interrupted = join(env.mediaDir, `${OTHER_ID}.mp4`);
    writeAged(interrupted, 30);
    writeFileSync(join(env.logsDir, "pending-media.txt"), `encodes ${OTHER_ID}\n`, "utf8");
    // Lo que NUNCA se toca:
    writeAged(join(env.mediaDir, `${CLIP_ID}.mp4`), 30);
    const sidecar = join(env.mediaDir, `${CLIP_ID}.json`);
    writeFileSync(sidecar, JSON.stringify({ title: "Clip registrado" }), "utf8");
    const stranger = join(env.mediaDir, "video-casero.mp4");
    writeAged(stranger, 30);

    let running: Running | null = null;
    try {
      running = await startServer(env.root, env);
      expect(await waitForHttp(running.port), running.output()).toBe(true);

      // La limpieza corrió ANTES de levantar el servidor.
      expect(existsSync(staleUpload), running.output()).toBe(false);
      expect(existsSync(staleSource), running.output()).toBe(false);
      expect(existsSync(interrupted), running.output()).toBe(false);
      expect(existsSync(join(env.mediaDir, `${CLIP_ID}.mp4`))).toBe(true);
      expect(existsSync(sidecar)).toBe(true);
      expect(existsSync(stranger)).toBe(true);
      // La limpieza corrió ANTES de levantar el servidor (su resumen va al log).
      expect(running.output()).toContain("Limpieza: se conservó");

      running.child.send("close");
      const { code } = await waitForExit(running, 30_000);
      expect(running.output()).toContain("VIUrewards se cerró correctamente.");
      expect(code).toBe(0);

      // La base se cerró sin quedar bloqueada y la fila sigue ahí.
      const db = openDatabase(join(env.dataDir, "app.db"));
      try {
        const row = db.prepare("SELECT COUNT(*) AS total FROM clips").get() as { total: number };
        expect(row.total).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      // No se señaliza acá: `afterEach` limpia por parentesco y verifica.
      cleanup();
    }
  },
);

it(
  "una segunda instancia sobre los mismos datos sale con código 3 sin tocar nada",
  { timeout: 120_000 },
  async () => {
    const env = makeEnv();
    seedDatabase(env);

    let first: Running | null = null;
    let second: Running | null = null;
    try {
      first = await startServer(env.root, env);
      expect(await waitForHttp(first.port), first.output()).toBe(true);
      const lockPath = join(env.root, SHARED_RESOURCES_LOCK_FILE);
      expect(existsSync(lockPath)).toBe(true);
      const lockBefore = readFileSync(lockPath, "utf8");

      // Un temporal de una ejecución anterior que la segunda NO debe borrar: la
      // primera está viva y puede estar usándolo.
      const live = join(env.uploadsDir, `${UUID}.upload`);
      writeAged(live, 30);
      // Un archivo sin fila: si la segunda reconciliara, lo importaría a la base.
      const unregistered = join(env.mediaDir, `${OTHER_ID}.src.mp4`);
      writeAged(unregistered, 30);

      // La segunda usa otro puerto: lo que se prueba es el cerrojo, no el puerto.
      // Sale ANTES de imprimir el arranque, así que se espera su salida (no el HTTP).
      //
      // Huella de la base ANTES del intento: el arranque real abre la base en
      // `openDatabase()` (migraciones incluidas), así que si la segunda llegara a
      // abrirla, el `.db` y sus auxiliares cambiarían. La primera está viva pero
      // sin trabajo pendiente en este punto (se esperó su HTTP y no se le manda
      // nada), y SQLite no toca los archivos mientras no haya escrituras: si algo
      // cambia, es la segunda.
      const dbPath = join(env.dataDir, "app.db");
      const before = stampSqliteFiles(dbPath);
      expect([...before.keys()]).toContain("app.db");

      second = await startServer(env.root, env, first.port === 8799 ? 8798 : first.port + 1);
      const { code } = await waitForExit(second, 60_000);

      // Sale sin arrancar, con el código propio y un mensaje en español.
      expect(code).toBe(3);
      expect(second.output()).toContain("No se puede arrancar VIUrewards");
      // No llegó a servir ni a reconciliar (nunca imprime el arranque completo).
      expect(second.output()).not.toContain("VIUrewards está corriendo.");
      expect(second.output()).not.toContain("Biblioteca sincronizada con /media");

      // Ni siquiera abrió SQLite: la huella de la base y de sus auxiliares
      // (WAL, SHM, journal) es idéntica. No basta con que el archivo exista.
      const after = stampSqliteFiles(dbPath);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [name, stamp] of before) {
        expect(after.get(name), `${name} cambió al arrancar la segunda instancia`).toEqual(stamp);
      }

      // No borró temporales de la primera ni liberó su cerrojo.
      expect(existsSync(live), second.output()).toBe(true);
      expect(existsSync(unregistered), second.output()).toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);

      // La primera sigue viva y sirviendo.
      expect(await waitForHttp(first.port, 10_000), first.output()).toBe(true);

      // Control negativo: la MISMA huella SÍ detecta un cambio. (Reabrir la base
      // no cambia bytes ni mtime; una escritura sí, y con WAL va al `-wal`.)
      const control = openDatabase(dbPath);
      try {
        control
          .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run("e2e.probe", String(Date.now()));
      } finally {
        control.close();
      }
      expect(stampSqliteFiles(dbPath)).not.toEqual(before);
      first.child.send("close");
      expect((await waitForExit(first, 30_000)).code).toBe(0);
      expect(existsSync(live)).toBe(true);
    } finally {
      // La limpieza de procesos la hace `afterEach` (por parentesco, validando
      // que el pid siga siendo el mismo); acá solo las carpetas temporales.
      cleanup();
    }
  },
);

it(
  "dos copias con data/ distintas pero el mismo media/ no conviven",
  { timeout: 120_000 },
  async () => {
    // La raíz es la MISMA (y por lo tanto `media/`, `.uploads/` y `logs/`), pero
    // la segunda copia usa otra carpeta de datos: el cerrojo de `data/` no las
    // vería entre sí, el de la raíz compartida sí.
    const env = makeEnv();
    const otherDataDir = join(env.root, "data-2");
    mkdirSync(otherDataDir, { recursive: true });
    seedDatabase(env);

    let first: Running | null = null;
    let second: Running | null = null;
    try {
      first = await startServer(env.root, env);
      expect(await waitForHttp(first.port), first.output()).toBe(true);

      second = await startServer(
        env.root,
        { ...env, dataDir: otherDataDir },
        first.port === 8799 ? 8798 : first.port + 1,
      );
      const { code } = await waitForExit(second, 60_000);
      expect(code).toBe(3);
      expect(second.output()).toContain("Otra copia");
      // Ni siquiera creó su base: la comprobación es ANTES de abrir SQLite.
      expect(existsSync(join(otherDataDir, "app.db"))).toBe(false);

      first.child.send("close");
      expect((await waitForExit(first, 30_000)).code).toBe(0);
    } finally {
      cleanup();
    }
  },
);

it(
  "con VIUREWARDS_DATA_DIR los datos viven fuera del directorio de la app",
  { timeout: 120_000 },
  async () => {
    // La app corre desde una carpeta (simula la versión instalada) y los datos
    // viven en OTRA carpeta persistente: base, medios, uploads, logs y bin/ deben
    // resolverse allí, y el cerrojo debe quedar en esa carpeta (no en la versión).
    const appDir = mkdtempSync(join(tmpdir(), "viu-e2e-appdir-"));
    roots.push(appDir);
    const dataDir = mkdtempSync(join(tmpdir(), "viu-e2e-datadir-"));
    roots.push(dataDir);

    const mediaDir = join(dataDir, "media");
    const logsDir = join(dataDir, "logs");
    const uploadsDir = join(dataDir, ".uploads");
    for (const dir of [mediaDir, logsDir, uploadsDir]) mkdirSync(dir, { recursive: true });

    let running: Running | null = null;
    try {
      running = await startServer(
        appDir,
        { root: dataDir, mediaDir, uploadsDir, logsDir, dataDir },
        0,
        { VIUREWARDS_DATA_DIR: dataDir },
      );
      expect(await waitForHttp(running.port), running.output()).toBe(true);
      expect(running.output()).toContain("VIUrewards está corriendo.");
      // Imprime el mapa de rutas resuelto (diagnóstico y soporte).
      expect(running.output()).toContain("datos en");

      // La base y el cerrojo viven en el directorio de DATOS…
      expect(existsSync(join(dataDir, "app.db"))).toBe(true);
      expect(existsSync(join(dataDir, SHARED_RESOURCES_LOCK_FILE))).toBe(true);
      // …y NO en la carpeta de la aplicación (que se reemplaza al actualizar).
      expect(existsSync(join(appDir, "app.db"))).toBe(false);
      expect(existsSync(join(appDir, "data"))).toBe(false);
      expect(existsSync(join(appDir, "media"))).toBe(false);
      expect(existsSync(join(appDir, "logs"))).toBe(false);
      expect(existsSync(join(appDir, SHARED_RESOURCES_LOCK_FILE))).toBe(false);

      // Los logs se escribieron en el directorio de datos.
      expect(existsSync(join(logsDir, "server.log"))).toBe(true);

      running.child.send("close");
      const { code } = await waitForExit(running, 30_000);
      expect(code).toBe(0);
      // La base se puede reabrir desde su ubicación configurada.
      const db = openDatabase(join(dataDir, "app.db"));
      try {
        const row = db.prepare("SELECT COUNT(*) AS total FROM clips").get() as { total: number };
        expect(row.total).toBe(0);
      } finally {
        db.close();
      }
      // El cerrojo propio se liberó al cerrar.
      expect(existsSync(join(dataDir, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
    } finally {
      cleanup();
    }
  },
);

it(
  "una VIUREWARDS_DATA_DIR relativa se rechaza sin arrancar en otra carpeta",
  { timeout: 120_000 },
  async () => {
    const env = makeEnv();
    seedDatabase(env);

    let running: Running | null = null;
    try {
      // Ruta RELATIVA: dependería del directorio de trabajo. Debe salir con el
      // código de configuración inválida (2) y NO inicializar en ningún lado.
      running = await startServer(env.root, env, 0, { VIUREWARDS_DATA_DIR: "datos-relativos" });
      const { code } = await waitForExit(running, 60_000);

      expect(code).toBe(2);
      expect(running.output()).toContain("No se puede arrancar VIUrewards");
      expect(running.output()).toContain("ABSOLUTA");
      // No sirvió ni arrancó.
      expect(running.output()).not.toContain("VIUrewards está corriendo.");
      // Y no creó la carpeta relativa bajo el directorio de trabajo.
      expect(existsSync(join(env.root, "datos-relativos"))).toBe(false);
    } finally {
      cleanup();
    }
  },
);
