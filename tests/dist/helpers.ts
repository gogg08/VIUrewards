/**
 * Helpers de los tests de DISTRIBUCIÓN (Etapa 2C, Parte G).
 *
 * Todo se apoya en el ZIP ya construido y en el **runtime fijado, externo al
 * paquete** (el ZIP no redistribuye `node.exe`):
 *
 *  - El runtime se toma de `VIUREWARDS_TEST_NODE_EXE`, o de la caché
 *    `build/downloads/`, o se DESCARGA de la URL versionada de `config.ts` y se
 *    verifica contra el SHA-256 fijado. Si la descarga falla o el hash no
 *    coincide, los tests FALLAN: nunca se omiten por falta de red.
 *  - El paquete se extrae a una ruta temporal **con espacios** (los usuarios de
 *    Windows instalan en `C:\Program Files\...` y en `AppData`), así que
 *    cualquier supuesto de "sin espacios" aparece como fallo.
 *  - Solo se escribe en directorios temporales. Nunca se tocan `data/app.db`,
 *    `media/`, `.uploads/` ni `logs/` del repositorio.
 *  - Ningún test ejecuta `yt-dlp -U` ni descarga medios reales. La única
 *    descarga (con caché) es el runtime fijado de Node.
 */

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { NODE_ASSET, NODE_VERSION } from "../../scripts/dist/config.ts";
import { sha256File } from "../../scripts/dist/fs-utils.ts";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Los tests de distribución solo tienen sentido en Windows x64: el paquete es
 * `win-x64` y ejecuta un `node.exe` de Windows.
 */
export const CAN_RUN_DIST = IS_WINDOWS && process.arch === "x64";

/** Raíz del repositorio (donde vive `build/`). */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Directorio donde `scripts/package.ts` deja el ZIP (`build/dist`). */
export const DIST_DIR = join(REPO_ROOT, "build", "dist");

/** Caché de descargas verificadas (`build/downloads`). */
const CACHE_DIR = join(REPO_ROOT, "build", "downloads");

/** Ruta del ZIP, buscándolo por patrón si no se fija por entorno. */
export function findZip(): string | null {
  const explicit = process.env.VIUREWARDS_PACKAGE_ZIP;
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;
  if (!existsSync(DIST_DIR)) return null;
  const candidates = readdirSync(DIST_DIR)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => join(DIST_DIR, name));
  return candidates[0] ?? null;
}

/** Corre un binario y devuelve código y salida (sin shell). */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });
}

/** Puerto libre en 127.0.0.1 (nunca se usa 8787, el de la instalación real). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  return check();
}

/** Extrae el ZIP a una ruta temporal con espacios y devuelve la carpeta raíz. */
export async function extractPackage(zipPath: string): Promise<{ root: string; packageDir: string }> {
  const root = mkdtempSync(join(tmpdir(), "VIU tests distribucion con espacios-"));
  const extractDir = join(root, "paquete extraido");
  // `Expand-Archive` falla con las entradas que usan `\` como separador (el ZIP
  // se genera en Windows) y, peor, termina con código 0 dejando la carpeta sin
  // extraer: se usó .NET `ExtractToDirectory`, que sí las resuelve.
  const scriptPath = join(root, "extraer.ps1");
  writeFileSync(
    scriptPath,
    [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:VIU_ZIP, $env:VIU_DEST)",
    ].join("\r\n"),
    "utf8",
  );
  const source = await run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    timeoutMs: 300_000,
    env: { VIU_ZIP: zipPath, VIU_DEST: extractDir },
  });
  if (source.code !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`No se pudo extraer ${zipPath}:\n${source.stderr || source.stdout}`);
  }
  const name = zipPath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.zip$/i, "");
  if (!name) throw new Error(`Nombre de ZIP inesperado: ${zipPath}`);
  const packageDir = join(extractDir, name);
  // El paquete NO trae el runtime (lo instala el instalador): solo se exige la
  // app y el manifiesto.
  for (const required of [join("app", "scripts", "start.ts"), "manifest.json"]) {
    if (!existsSync(join(packageDir, required))) {
      rmSync(root, { recursive: true, force: true });
      throw new Error(`La extracción no tiene ${required}: ${packageDir}`);
    }
  }
  return { root, packageDir };
}

/** Descarga un archivo fijado (sin shell), siguiendo redirecciones acotadas. */
function download(url: string, destination: string): Promise<void> {
  const attempt = (currentUrl: string, redirects: number): Promise<void> =>
    new Promise((resolveDownload, rejectDownload) => {
      const request = httpGet(currentUrl, { headers: { "user-agent": "VIUrewards-tests" } }, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirects <= 0) {
            rejectDownload(new Error(`Demasiadas redirecciones al descargar ${url}`));
            return;
          }
          attempt(new URL(location, currentUrl).toString(), redirects - 1).then(resolveDownload, rejectDownload);
          return;
        }
        if (status !== 200) {
          response.resume();
          rejectDownload(new Error(`La descarga de ${currentUrl} respondió HTTP ${status}`));
          return;
        }
        pipeline(response, createWriteStream(destination)).then(() => resolveDownload(), rejectDownload);
      });
      request.once("error", rejectDownload);
      request.setTimeout(180_000, () => request.destroy(new Error(`Timeout al descargar ${currentUrl}`)));
    });
  return attempt(url, 5);
}

/**
 * Runtime fijado de Node, EXTERNO al paquete.
 *
 * Orden: `VIUREWARDS_TEST_NODE_EXE` (ruta explícita; se verifica la versión) →
 * caché `build/downloads/` → descarga de la URL versionada de `config.ts`.
 * **Nunca se omite**: si el archivo no se puede obtener o el hash no coincide,
 * lanza un error con el motivo, así que el test falla.
 */
export async function resolveRuntimeNodeExe(): Promise<string> {
  const explicit = process.env.VIUREWARDS_TEST_NODE_EXE?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`VIUREWARDS_TEST_NODE_EXE apunta a un archivo inexistente: ${explicit}`);
    const version = await run(explicit, ["--version"], { timeoutMs: 60_000 });
    if (version.stdout.trim() !== `v${NODE_VERSION}`) {
      throw new Error(
        `VIUREWARDS_TEST_NODE_EXE informa ${version.stdout.trim() || version.stderr.trim()} y el paquete fija v${NODE_VERSION}.`,
      );
    }
    return resolve(explicit);
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const cachedZip = join(CACHE_DIR, NODE_ASSET.file);
  if (existsSync(cachedZip)) {
    if ((await sha256File(cachedZip)) === NODE_ASSET.sha256) return await extractRuntimeFrom(cachedZip);
    rmSync(cachedZip, { force: true });
  }

  const partial = `${cachedZip}.part`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await download(NODE_ASSET.url, partial);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      rmSync(partial, { force: true });
    }
  }
  if (lastError !== null) {
    throw new Error(
      `No se pudo descargar el runtime fijado ${NODE_ASSET.file} desde ${NODE_ASSET.url}: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}. ` +
        "Los tests de distribución NO se omiten por falta de red: verificá la conexión o usá VIUREWARDS_TEST_NODE_EXE.",
    );
  }
  const actual = await sha256File(partial);
  if (actual !== NODE_ASSET.sha256) {
    rmSync(partial, { force: true });
    throw new Error(
      `El SHA-256 de ${NODE_ASSET.file} no coincide con el fijado en scripts/dist/config.ts.\n` +
        `  esperado: ${NODE_ASSET.sha256} (${NODE_ASSET.checksumSource})\n  obtenido: ${actual}`,
    );
  }
  renameSync(partial, cachedZip);
  return await extractRuntimeFrom(cachedZip);
}

/** Extrae `node.exe` del ZIP oficial (verificado) a un directorio temporal. */
async function extractRuntimeFrom(nodeZip: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "VIU runtime pruebas con espacios-"));
  const result = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${nodeZip}' -DestinationPath '${join(dir, "node")}' -Force`,
    ],
    { timeoutMs: 300_000 },
  );
  if (result.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`No se pudo extraer ${nodeZip}:\n${result.stderr || result.stdout}`);
  }
  const nodeExe = join(dir, "node", NODE_ASSET.file.replace(/\.zip$/i, ""), "node.exe");
  if (!existsSync(nodeExe)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`El ZIP de Node no contiene node.exe: ${nodeExe}`);
  }
  const version = await run(nodeExe, ["--version"], { timeoutMs: 60_000 });
  if (version.stdout.trim() !== `v${NODE_VERSION}`) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`El node.exe extraído informa ${version.stdout.trim()} y se esperaba v${NODE_VERSION}.`);
  }
  return nodeExe;
}

export interface Manifest {
  name: string;
  version: string;
  contractVersion: number;
  commit: string | null;
  dirty: boolean;
  builtAt: string;
  platform: string;
  arch: string;
  node: { version: string; abi: string; installedBy: string };
  managedTools: Array<{
    id: string;
    version: string;
    url: string;
    sha256: string;
    checksumSource: string;
    install: Array<{ from: string; to: string }>;
    notices: Array<{ from: string; to: string }>;
    policy: string;
    updatedBy: string;
    licenseNote: string;
  }>;
  entries: Array<{ path: string; bytes: number; sha256: string }>;
}

/**
 * Lee (y cachea) el manifiesto del paquete extraído, o `null` si no existe.
 *
 * Los tests lo usan para comprobar las versiones fijadas en
 * `scripts/dist/config.ts` sin ejecutar nada.
 */
export function readManifest(packageDir: string): Manifest {
  return JSON.parse(readFileSync(join(packageDir, "manifest.json"), "utf8")) as Manifest;
}

/**
 * Arranca un proceso del paquete con un canal IPC y espera su mensaje `ready`.
 *
 * Se usa con `app/scripts/dist/shutdown-harness.mjs`, que corre la MISMA
 * secuencia de arranque y el MISMO controlador de cierre que producción. El
 * token mínimo por entorno habilita el canal (`VIUREWARDS_TEST_IPC_TOKEN`): sin
 * él el arnés se niega a arrancar, así que en el uso normal no hay canal.
 */
export interface HarnessChild {
  child: ReturnType<typeof spawn>;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Se resuelve con el mensaje `ready` del arnés, o `null` si no llegó. */
  ready: Promise<{ port: number; pid: number; lockPath: string } | null>;
}

export function startHarness(options: {
  nodeExe: string;
  harnessPath: string;
  dataDir: string;
  appDir: string;
  port: number;
  token: string;
}): HarnessChild {
  const child = spawn(options.nodeExe, [options.harnessPath, `--port=${options.port}`], {
    cwd: options.appDir,
    env: {
      ...process.env,
      VIUREWARDS_DATA_DIR: options.dataDir,
      VIUREWARDS_NODE_RUNTIME: options.nodeExe,
      PORT: String(options.port),
      VIUREWARDS_TEST_IPC_TOKEN: options.token,
      // Sin credenciales reales ni conexión a Kick.
      KICK_CLIENT_ID: "",
      KICK_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const ready = new Promise<{ port: number; pid: number; lockPath: string } | null>((resolveReady) => {
    const timer = setTimeout(() => resolveReady(null), 60_000);
    child.on("message", (message: unknown) => {
      const data = message as { ready?: boolean; port?: number; pid?: number; lockPath?: string };
      if (data?.ready === true && typeof data.port === "number") {
        clearTimeout(timer);
        resolveReady({ port: data.port, pid: data.pid ?? -1, lockPath: data.lockPath ?? "" });
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      resolveReady(null);
    });
  });
  return { child, output: () => output, exited, ready };
}

/** Termina el árbol de un proceso de prueba (solo ese pid) y espera a que muera. */
export async function killTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== "number" || !isAlive(pid)) return;
  if (IS_WINDOWS) {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 20_000 });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ya murió.
    }
  }
  await waitUntil(() => !isAlive(pid), 20_000);
}

/** Tamaño legible (para el informe de los tests). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function zipSize(zipPath: string): number {
  return statSync(zipPath).size;
}
