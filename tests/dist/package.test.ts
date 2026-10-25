/**
 * Tests de DISTRIBUCIÓN (Etapa 2C, Parte G): el PAQUETE, no el repositorio.
 *
 * Todo se hace sobre el ZIP ya construido (`npm run package:portable`), extraído
 * a una ruta temporal **con espacios**. El paquete **no** contiene el runtime:
 * los tests usan el Node fijado y verificado (`VIUREWARDS_TEST_NODE_EXE`, la
 * caché `build/downloads/` o una descarga verificada contra el SHA-256 fijado),
 * nunca el Node global del sistema.
 *
 * Qué se comprueba de verdad:
 *
 *  1. El runtime fijado (externo) es la versión de `scripts/dist/config.ts` y la
 *     del manifiesto, y el ABI coincide (binding de `better-sqlite3`).
 *  2. `better-sqlite3` carga con ese runtime: crea, escribe con WAL, lee, cierra
 *     y REABRE una base temporal.
 *  3. El servidor del paquete arranca (arnés IPC), el dashboard, el login, los
 *     estáticos y `/guia` responden, y las reglas de acceso dan 401/403.
 *  4. La base, `media/`, `.uploads/` y `logs/` se crean en el
 *     `VIUREWARDS_DATA_DIR` temporal y NO dentro del paquete.
 *  5. Con una sesión real (contraseña temporal), el dashboard y `/api/state`
 *     responden 200.
 *  6. El CIERRE ORDENADO se ejerce con el arnés IPC (misma secuencia y mismo
 *     controlador que producción): el proceso termina, sale con 0, la base se
 *     reabre y el cerrojo se libera.
 *  7. El cerrojo: una segunda instancia no borra uno válido y una instancia
 *     nueva recupera los datos cuando el dueño anterior terminó.
 *  8. El paquete no trae datos de usuario, secretos ni cerrojos, y **tampoco
 *     ejecutables de terceros**: los descarga el instalador desde cada
 *     proveedor (estrategia C).
 *
 * Sobre las señales: en Windows, desde un proceso sin consola interactiva, una
 * llamada `kill("SIGINT")` NO llega a los handlers de Node (verificado; ver
 * `docs/distribution.md`). Por eso acá **no se usa una señal** como prueba de
 * cierre: el Ctrl+C real queda como prueba MANUAL documentada. Este test NO
 * afirma haber verificado el cierre por señales del sistema operativo.
 *
 * Solo se escribe en directorios temporales. No se tocan `data/app.db`,
 * `media/`, `.uploads/` ni `logs/` del desarrollo, y no se ejecuta `yt-dlp -U`.
 *
 * Se corre con: `npm run test:dist` (lento: requiere el ZIP ya construido).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FFMPEG_VERSION,
  FORBIDDEN_EXECUTABLES,
  NODE_ABI,
  NODE_VERSION,
  PACKAGE_CONTRACT_VERSION,
  SHUTDOWN_HARNESS_FILE,
  YTDLP_VERSION,
} from "../../scripts/dist/config.ts";
import {
  CAN_RUN_DIST,
  extractPackage,
  findZip,
  formatBytes,
  freePort,
  isAlive,
  killTree,
  readManifest,
  resolveRuntimeNodeExe,
  run,
  startHarness,
  zipSize,
  type Manifest,
} from "./helpers.ts";

const describeDist = CAN_RUN_DIST ? describe : describe.skip;

/** Ruta del ZIP: `VIUREWARDS_PACKAGE_ZIP` o el primer `.zip` de `build/dist`. */
const zipPath = findZip();
const haveZip = zipPath !== null;

/**
 * Grupo de tests del PAQUETE.
 *
 * `describePackage(nombre, fn)` se salta entero (con el motivo a la vista) si
 * no es Windows x64 o si todavía no hay ZIP construido: un paquete ausente no
 * puede pasar como verde.
 */
function describePackage(name: string, fn: () => void): void {
  if (!CAN_RUN_DIST) {
    describe.skip(`${name} (omitido: el paquete es win-x64)`, fn);
    return;
  }
  if (!haveZip) {
    describe.skip(`${name} (omitido: falta build/dist/VIUrewards-*.zip)`, fn);
    return;
  }
  describe(name, fn);
}

/** Pids de procesos que este archivo creó; se limpian solo esos. */
const createdPids = new Set<number>();

let root = "";
let packageDir = "";
let appDir = "";
let nodeExe = "";
let manifest: Manifest;
/** Directorios de datos temporales que crean los tests. */
const dataRoots: string[] = [];

function tempDataDir(label: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), `VIU datos ${label} con espacios-`));
  dataRoots.push(rootDir);
  const dataDir = join(rootDir, "datos del streamer");
  return dataDir;
}

/** Petición HTTP simple (sin redirecciones automáticas). */
async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(url, { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" ? raw.pid : null;
  } catch {
    return null;
  }
}

/** Reabre una base SQLite con el runtime fijado y devuelve unas filas de prueba. */
async function inspectDatabase(dbPath: string): Promise<{ tables: number; userVersion: number; value: string | null }> {
  const script = join(root, "inspect.mjs");
  writeFileSync(
    script,
    [
      `import Database from ${JSON.stringify(pathToFileURL(join(appDir, "node_modules", "better-sqlite3", "lib", "index.js")).href)};`,
      `const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });`,
      `const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;`,
      `const userVersion = db.pragma("user_version", { simple: true });`,
      `let value = null;`,
      `try { value = db.prepare("SELECT value FROM settings WHERE key = 'server.port'").pluck().get() ?? null; } catch {}`,
      `db.close();`,
      `console.log(JSON.stringify({ tables, userVersion, value }));`,
    ].join("\n"),
    "utf8",
  );
  const result = await run(nodeExe, [script], { cwd: appDir, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`No se pudo reabrir la base:\n${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim()) as { tables: number; userVersion: number; value: string | null };
}

beforeAll(async () => {
  if (!zipPath) return;
  const extracted = await extractPackage(zipPath);
  root = extracted.root;
  packageDir = extracted.packageDir;
  appDir = join(packageDir, "app");
  // El runtime es EXTERNO al paquete (estrategia C): se resuelve y verifica.
  nodeExe = await resolveRuntimeNodeExe();
  manifest = readManifest(packageDir);
}, 600_000);

afterAll(async () => {
  // Solo se termina lo que este archivo creó (por pid exacto), y se verifica.
  for (const pid of createdPids) await killTree(pid);
  for (const dir of dataRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Un temporal que no se puede borrar no falla el test.
    }
  }
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Lo mismo: queda en temp y Windows lo limpia.
    }
  }
});

describePackage("estructura, runtime y SQLite", () => {
  it("el runtime fijado (externo al paquete) es la versión y el ABI del manifiesto", async () => {
    expect(existsSync(nodeExe)).toBe(true);
    const version = await run(nodeExe, ["--version"], { cwd: appDir });
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(`v${NODE_VERSION}`);
    const abi = await run(
      nodeExe,
      ["-p", "process.versions.modules"],
      { cwd: appDir },
    );
    expect(abi.stdout.trim()).toBe(NODE_ABI);
    expect(manifest.node.version).toBe(`v${NODE_VERSION}`);
    expect(manifest.node.abi).toBe(NODE_ABI);
    expect(manifest.name).toBe("VIUrewards");
    expect(manifest.platform).toBe("win32");
    expect(manifest.arch).toBe("x64");
    // El paquete NO redistribuye el runtime: lo instala el instalador.
    expect(existsSync(join(packageDir, "runtime"))).toBe(false);
    expect(nodeExe.startsWith(packageDir)).toBe(false);
  });

  it("el manifiesto fija las herramientas externas con URL y SHA-256", () => {
    expect(manifest.contractVersion).toBe(PACKAGE_CONTRACT_VERSION);
    const byId = new Map(manifest.managedTools.map((tool) => [tool.id, tool]));
    expect([...byId.keys()].sort()).toEqual(["ffmpeg", "node", "yt-dlp"]);
    expect(byId.get("node")?.version).toBe(NODE_VERSION);
    expect(byId.get("node")?.policy).toBe("match-manifest");
    expect(byId.get("yt-dlp")?.version).toBe(YTDLP_VERSION);
    expect(byId.get("ffmpeg")?.version).toBe(FFMPEG_VERSION);
    // yt-dlp NUNCA se sobrescribe: el dashboard es su actualizador principal.
    expect(byId.get("yt-dlp")?.policy).toBe("if-missing");
    expect(byId.get("yt-dlp")?.updatedBy).toBe("dashboard");
    expect(byId.get("ffmpeg")?.policy).toBe("if-missing");
    for (const tool of manifest.managedTools) {
      expect(tool.url).toMatch(/^https:\/\//);
      expect(tool.url).not.toContain("latest");
      expect(tool.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tool.checksumSource).toMatch(/^https:\/\//);
      // Separa las herramientas y los datos de los archivos de cada versión.
      for (const target of tool.install) {
        expect(target.to.startsWith("app/")).toBe(false);
        expect(target.to).not.toMatch(/^\.\./);
      }
    }
    // FFmpeg: proveedor externo, no el upstream, y el hash no es una firma.
    const ffmpeg = byId.get("ffmpeg")!;
    expect(ffmpeg.url).toContain("gyan.dev");
    expect(ffmpeg.licenseNote.toLowerCase()).toContain("no es el upstream");
    expect(ffmpeg.licenseNote.toLowerCase()).toContain("no es una firma");
    expect(ffmpeg.notices.map((notice) => notice.to).sort()).toEqual([
      "bin/ffmpeg-LICENSE.txt",
      "bin/ffmpeg-PROCEDENCIA.txt",
    ]);
  });

  it("el paquete no incluye ejecutables de terceros ni herramientas semilla", () => {
    const found: string[] = [];
    const forbidden = new Set<string>(FORBIDDEN_EXECUTABLES);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (forbidden.has(entry.name)) found.push(relative(packageDir, full));
      }
    };
    walk(packageDir);
    expect(found).toEqual([]);
    for (const dir of ["runtime", "seed-tools", "bin"]) {
      expect(existsSync(join(packageDir, dir)), `el paquete no debe tener ${dir}/`).toBe(false);
    }
    // Las licencias de las dependencias npm SÍ viajan (esas sí se redistribuyen).
    expect(existsSync(join(packageDir, "licenses", "better-sqlite3.txt"))).toBe(true);
    expect(existsSync(join(packageDir, "licenses", "SQLITE.txt"))).toBe(true);
  });

  it("el manifiesto trae un hash por archivo, sin rutas de la máquina", () => {
    expect(manifest.entries.length).toBeGreaterThan(50);
    for (const entry of manifest.entries) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Sin rutas absolutas de la máquina que compiló.
      expect(entry.path).not.toMatch(/^[A-Za-z]:\\/);
      expect(entry.path.startsWith("/")).toBe(false);
    }
  });

  it("better-sqlite3 se carga y funciona con el runtime fijado", async () => {
    const dataDir = tempDataDir("sqlite");
    rmSync(dataDir, { recursive: true, force: true });
    expect(existsSync(dataDir)).toBe(false);
    const dbFile = join(root, "sqlite check con espacios.db");
    // La ruta del módulo tiene que ser un file:// URL: en Windows una ruta
    // absoluta suelta se interpreta como un scheme (`c:`) y el loader la rechaza.
    const moduleUrl = pathToFileURL(join(appDir, "node_modules", "better-sqlite3", "lib", "index.js")).href;
    const script = join(root, "sqlite.mjs");
    writeFileSync(
      script,
      [
        `import Database from ${JSON.stringify(moduleUrl)};`,
        `const db = new Database(${JSON.stringify(dbFile)});`,
        `db.pragma("journal_mode = WAL");`,
        `db.exec("CREATE TABLE prueba (id INTEGER PRIMARY KEY, valor TEXT NOT NULL)");`,
        `db.prepare("INSERT INTO prueba (valor) VALUES (?)").run("hola");`,
        `const row = db.prepare("SELECT valor FROM prueba WHERE id = 1").get();`,
        `db.close();`,
        `const again = new Database(${JSON.stringify(dbFile)}, { readonly: true });`,
        `const row2 = again.prepare("SELECT valor FROM prueba WHERE id = 1").get();`,
        `again.close();`,
        `console.log(JSON.stringify({ row: row?.valor, row2: row2?.valor, node: process.version, abi: process.versions.modules }));`,
      ].join("\n"),
      "utf8",
    );
    try {
      const result = await run(nodeExe, [script], { cwd: appDir, timeoutMs: 60_000 });
      expect(result.code, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as { row: string; row2: string; node: string; abi: string };
      expect(parsed.row).toBe("hola");
      expect(parsed.row2).toBe("hola");
      expect(parsed.node).toBe(`v${NODE_VERSION}`);
      // El binding precompilado de Windows x64 es de este ABI: si no, no carga.
      expect(parsed.abi).toBe(NODE_ABI);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbFile}${suffix}`, { force: true });
      rmSync(script, { force: true });
    }
  });
});

describePackage("arranque real del servidor del paquete", () => {
  it("arranca, sirve el dashboard y el cierre ordenado termina bien", async () => {
    const dataDir = tempDataDir("arranque");
    const harnessPath = join(appDir, "scripts", "dist", SHUTDOWN_HARNESS_FILE);
    expect(existsSync(harnessPath), "el paquete tiene que incluir el arnés de cierre").toBe(true);

    const port = await freePort();
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const harness = startHarness({ nodeExe, harnessPath, dataDir, appDir, port, token });
    if (typeof harness.child.pid === "number") createdPids.add(harness.child.pid);

    try {
      const ready = await harness.ready;
      expect(ready, `el arnés no arrancó:\n${harness.output().slice(-2000)}`).not.toBeNull();
      const base = `http://127.0.0.1:${ready!.port}`;

      // --- Rutas públicas y reglas de acceso --------------------------------
      const dashboard = await request(`${base}/`);
      expect(dashboard.status).toBe(302);
      expect(dashboard.headers.get("location")).toBe("/login");

      const login = await request(`${base}/login`);
      expect(login.status).toBe(200);
      expect(login.text).toContain("VIUrewards");

      for (const asset of ["/web/style.css", "/web/app.js", "/web/theme.js", "/web/logo.js", "/guia"]) {
        const response = await request(`${base}${asset}`);
        expect(response.status, `${asset} respondió ${response.status}`).toBe(200);
      }

      const overlayNoKey = await request(`${base}/overlay`);
      expect(overlayNoKey.status).toBe(403);
      const stateNoSession = await request(`${base}/api/state`);
      expect(stateNoSession.status).toBe(401);
      const mediaNoSession = await request(`${base}/media/no-existe.mp4`);
      expect(mediaNoSession.status).toBe(401);
      // Sin credenciales reales ni conexión a Kick.
      const kick = await request(`${base}/api/platforms`);
      expect(kick.status).toBe(401);

      // --- Sesión real con una contraseña TEMPORAL --------------------------
      const password = "prueba-distribucion-123";
      const setup = await request(`${base}/api/auth/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ password }),
      });
      expect(setup.status, setup.text).toBe(200);
      const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(cookie).toContain("=");

      const home = await request(`${base}/`, { headers: { cookie } });
      expect(home.status).toBe(200);
      expect(home.text).toContain("VIUrewards");
      const state = await request(`${base}/api/state`, { headers: { cookie } });
      expect(state.status, state.text.slice(0, 300)).toBe(200);
      // El estado tiene que salir de la base real del directorio de datos.
      expect(existsSync(join(dataDir, "app.db"))).toBe(true);

      // --- Aislamiento de los datos -----------------------------------------
      for (const name of ["media", ".uploads", "logs"]) {
        expect(existsSync(join(dataDir, name)), `${name} no se creó en el directorio de datos`).toBe(true);
      }
      for (const name of ["data", "media", ".uploads", "logs", "app.db"]) {
        expect(existsSync(join(packageDir, name)), `el paquete contiene ${name}`).toBe(false);
        expect(existsSync(join(appDir, name)), `app/ contiene ${name}`).toBe(false);
      }
      expect(existsSync(join(dataDir, ".viurewards.lock"))).toBe(true);

      // --- CIERRE ORDENADO por el arnés (misma secuencia que producción) ----
      harness.child.send({ shutdown: true });
      const exit = await Promise.race([
        harness.exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveSlow) =>
          setTimeout(() => resolveSlow({ code: -1, signal: null }), 30_000),
        ),
      ]);
      expect(exit.code, `el cierre no terminó bien:\n${harness.output().slice(-2000)}`).toBe(0);
      expect(harness.output()).toContain("VIUrewards se cerró correctamente.");
      expect(isAlive(harness.child.pid ?? 0)).toBe(false);

      // SQLite se puede reabrir y el esquema quedó aplicado.
      const inspected = await inspectDatabase(join(dataDir, "app.db"));
      expect(inspected.tables).toBeGreaterThan(0);
      expect(inspected.userVersion).toBeGreaterThan(0);

      // El cerrojo se liberó al terminar el cierre (no antes: lo libera el
      // controlador al cerrar recursos, no al recibir la orden).
      expect(existsSync(join(dataDir, ".viurewards.lock"))).toBe(false);
    } finally {
      if (typeof harness.child.pid === "number") {
        await killTree(harness.child.pid);
        createdPids.delete(harness.child.pid);
      }
    }
  }, 180_000);
});

describePackage("cerrojo entre instancias", () => {
  it("una segunda instancia no borra un cerrojo válido y una nueva lo recupera cuando el dueño terminó", async () => {
    const dataDir = tempDataDir("cerrojo");
    const harnessPath = join(appDir, "scripts", "dist", SHUTDOWN_HARNESS_FILE);
    const lockPath = join(dataDir, ".viurewards.lock");

    // 1) Primera instancia: toma el cerrojo y sirve.
    const first = startHarness({ nodeExe, harnessPath, dataDir, appDir, port: await freePort(), token: `t1-${Date.now()}` });
    if (typeof first.child.pid === "number") createdPids.add(first.child.pid);
    const firstReady = await first.ready;
    try {
      expect(firstReady, `la primera instancia no arrancó:\n${first.output().slice(-2000)}`).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);
      const lockBefore = readFileSync(lockPath, "utf8");
      const ownerPid = readLockPid(lockPath);
      expect(ownerPid).toBe(firstReady!.pid);
      expect(isAlive(ownerPid!)).toBe(true);

      // 2) Segunda instancia sobre los MISMOS datos: debe rechazarse (código 3)
      //    y dejar el cerrojo de la primera intacto, byte por byte.
      const second = startHarness({ nodeExe, harnessPath, dataDir, appDir, port: await freePort(), token: `t2-${Date.now()}` });
      const secondExit = await Promise.race([
        second.exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveSlow) =>
          setTimeout(() => resolveSlow({ code: -1, signal: null }), 60_000),
        ),
      ]);
      createdPids.add(second.child.pid!);
      expect(secondExit.code, `la segunda instancia no salió con 3:\n${second.output().slice(-2000)}`).toBe(3);
      expect(second.output()).toContain("No se puede arrancar VIUrewards");
      // No sirvió: nunca mandó `ready`.
      const secondReady = await second.ready;
      expect(secondReady).toBeNull();

      expect(existsSync(lockPath), "la segunda instancia borró el cerrojo ajeno").toBe(true);
      expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
      expect(readLockPid(lockPath)).toBe(ownerPid);
      expect(isAlive(first.child.pid ?? 0)).toBe(true);
    } finally {
      // 3) Cierre ordenado de la primera y recuperación por una instancia nueva.
      //    `send` falla si el canal ya se cerró: no se deja escapar la excepción.
      try {
        first.child.send({ shutdown: true });
      } catch {
        // El proceso ya había terminado: el cierre se comprueba igual abajo.
      }
      const firstExit = await Promise.race([
        first.exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveSlow) =>
          setTimeout(() => resolveSlow({ code: -1, signal: null }), 30_000),
        ),
      ]);
      expect(firstExit.code, `la primera instancia no se cerró bien:\n${first.output().slice(-2000)}`).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      if (typeof first.child.pid === "number") createdPids.delete(first.child.pid);
    }

    // 4) El dueño terminó (comprobado, no supuesto): una instancia nueva usa los
    //    mismos datos y el esquema anterior sigue ahí.
    const third = startHarness({ nodeExe, harnessPath, dataDir, appDir, port: await freePort(), token: `t3-${Date.now()}` });
    if (typeof third.child.pid === "number") createdPids.add(third.child.pid);
    try {
      const thirdReady = await third.ready;
      expect(thirdReady, `la tercera instancia no recuperó los datos:\n${third.output().slice(-2000)}`).not.toBeNull();
      const inspected = await inspectDatabase(join(dataDir, "app.db"));
      expect(inspected.tables).toBeGreaterThan(0);
      try {
        third.child.send({ shutdown: true });
      } catch {
        // Ya terminó: el código de salida se comprueba igual abajo.
      }
      const thirdExit = await Promise.race([
        third.exited,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveSlow) =>
          setTimeout(() => resolveSlow({ code: -1, signal: null }), 30_000),
        ),
      ]);
      expect(thirdExit.code).toBe(0);
      if (typeof third.child.pid === "number") createdPids.delete(third.child.pid);
    } finally {
      if (typeof third.child.pid === "number") await killTree(third.child.pid);
    }
  }, 240_000);

  it("el arnés no arranca sin el token de pruebas (no hay canal de control en uso normal)", async () => {
    const dataDir = tempDataDir("sin token");
    const harnessPath = join(appDir, "scripts", "dist", SHUTDOWN_HARNESS_FILE);
    expect(existsSync(harnessPath), "el paquete tiene que incluir el arnés de cierre").toBe(true);
    // Sin `VIUREWARDS_TEST_IPC_TOKEN` no debe ni abrir la base.
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.VIUREWARDS_TEST_IPC_TOKEN;
    const result = await run(nodeExe, [harnessPath], {
      cwd: appDir,
      env: { ...env, VIUREWARDS_DATA_DIR: dataDir },
      timeoutMs: 60_000,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("solo corre desde los tests de distribución");
    expect(existsSync(join(dataDir, "app.db"))).toBe(false);
    expect(existsSync(join(dataDir, ".viurewards.lock"))).toBe(false);
  }, 120_000);
});

describePackage("contenido del paquete", () => {
  it("no trae datos de usuario, secretos ni cerrojos", () => {
    const forbidden: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (
          /^(\.env(\..*)?|\.kick-tokens\.json|\.kick-reward\.json|\.viurewards\.lock|instance\.lock|app\.db|app\.db-wal|app\.db-shm)$/.test(
            entry.name,
          )
        ) {
          forbidden.push(relative(packageDir, full));
        }
      }
    };
    walk(packageDir);
    expect(forbidden).toEqual([]);
  });

  it("no trae tests de la app ni herramientas de desarrollo", async () => {
    // Se buscan solo los artefactos de la APP (no las carpetas `test/` de
    // dependencias de terceros, que vienen dentro de sus paquetes npm).
    const result = await run(nodeExe, [
      "-e",
      "const {readdirSync}=require('node:fs');const {join}=require('node:path');const out=[];" +
        "const walk=(d,depth)=>{for(const e of readdirSync(d,{withFileTypes:true})){const f=join(d,e.name);" +
        "if(e.isDirectory()){if(!(depth===0&&e.name==='node_modules'))walk(f,depth+1);}" +
        "else if(/(^|[\\\\/])(play-test\\.ts|.*\\.test\\.ts)$/.test(f))out.push(f);}};" +
        "walk(process.argv[1],0);console.log(JSON.stringify(out));",
      appDir,
    ], { timeoutMs: 120_000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([]);
    // Y las herramientas de desarrollo no están instaladas.
    for (const devOnly of ["vitest", "typescript", "tsx", "@types"]) {
      expect(existsSync(join(appDir, "node_modules", devOnly)), `${devOnly} no debería estar en el paquete`).toBe(false);
    }
  });

  it("el paquete trae el launcher y su punto de entrada en la raíz", () => {
    // Punto de entrada visible: el usuario no navega por `app/`.
    const entry = join(packageDir, "VIUrewards.cmd");
    expect(existsSync(entry)).toBe(true);
    const text = readFileSync(entry, "utf8");
    // Llama al `.ps1` que queda DENTRO de `app/scripts/dist/` (su guard de rutas
    // deduce la raíz de la app desde `$PSScriptRoot`).
    expect(text).toContain("%~dp0app\\scripts\\dist\\launcher-gui.ps1");
    expect(text).toContain("-ExecutionPolicy Bypass");
    expect(text).toContain("-NoProfile");
    // Nada de binarios ni rutas absolutas de la máquina que compiló.
    expect(text).not.toMatch(/^[A-Za-z]:\\/m);
    expect(existsSync(join(packageDir, "launcher-gui.ps1"))).toBe(false);

    const launcher = join(appDir, "scripts", "dist", "launcher-gui.ps1");
    expect(existsSync(launcher)).toBe(true);
    // Se lee como BYTES: `readFileSync(..., "utf8")` traduce CRLF a LF y la
    // comprobación de finales de línea daría un falso negativo.
    const bytes = readFileSync(launcher);
    // ASCII puro y CRLF: Windows PowerShell 5.1 mal-decodifica UTF-8 sin BOM y
    // los finales de línea mezclados rompen `ParseFile`.
    expect(bytes.some((byte) => byte > 0x7f)).toBe(false);
    expect(bytes.includes(0x0d)).toBe(true);
    let loneLf = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0x0a && bytes[index - 1] !== 0x0d) loneLf += 1;
    }
    expect(loneLf).toBe(0);
    const script = bytes.toString("utf8");
    // Reutiliza el canal de la Etapa 3A: sin segundo protocolo ni endpoint HTTP.
    expect(script).toContain("--Control=");
    expect(script).toContain("--Exchange=");
    expect(script).not.toMatch(/localhost:\d+\/api\/shutdown/);
    // El instalador sigue en su lugar, al lado del launcher.
    expect(existsSync(join(appDir, "scripts", "dist", "install-tools.ps1"))).toBe(true);
  });

  it("el ZIP pesa lo esperado y su checksum tiene la forma correcta", () => {
    const bytes = zipSize(zipPath!);
    // Sin ejecutables externos el ZIP es mucho más chico que el de la Etapa 2
    // (141 MB con Node + herramientas): solo la app y sus dependencias.
    expect(bytes).toBeGreaterThan(1 * 1024 * 1024);
    expect(bytes).toBeLessThan(60 * 1024 * 1024);
    // El reporte final muestra el valor real (no se fija un techo frágil).
    console.log(`ZIP: ${formatBytes(bytes)} (${bytes} bytes)`);
    const checksum = readFileSync(`${zipPath}.sha256`, "utf8").trim();
    expect(checksum).toMatch(/^[0-9a-f]{64}  .+\.zip$/);
    // Un checksum sirve para detectar CORRUPCIÓN del ZIP, no es una firma: se
    // comprueba que tenga la forma esperada y que exista al lado del ZIP.
    expect(checksum.endsWith(".zip")).toBe(true);
    expect(statSync(zipPath!).isFile()).toBe(true);
  });
});
