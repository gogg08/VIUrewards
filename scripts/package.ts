#!/usr/bin/env node
/**
 * Empaquetado portable para Windows x64 (Fase de distribución, Etapa 2C).
 *
 * Arma un directorio de staging nuevo y reproducible con **solo la aplicación**:
 * código TS, recursos estáticos, `package.json` + lockfile y `node_modules` de
 * producción (instalado desde el lockfile y podado con `NODE_MODULES_PRUNE`).
 * Genera el manifiesto con hashes, comprime el ZIP y escribe su checksum aparte.
 *
 * ## Estrategia C: sin ejecutables de terceros
 *
 * El ZIP **no** contiene `node.exe`, `yt-dlp.exe`, `ffmpeg.exe` ni
 * `ffprobe.exe`: el instalador futuro los descarga **de cada proveedor**, los
 * verifica contra el SHA-256 fijado en `scripts/dist/config.ts` y los instala en
 * el directorio de datos (`<datos>/runtime/node.exe`, `<datos>/bin/*.exe`). El
 * build comprueba de forma explícita que ninguno se haya colado
 * (`FORBIDDEN_EXECUTABLES`), en el staging y en el ZIP.
 *
 * Versiones: las fija `scripts/dist/config.ts` (único lugar). Este script NO
 * consulta `latest` ni descarga nada de red: solo el runtime que lo ejecuta
 * tiene que ser el de `NODE_VERSION` (ABI de `better-sqlite3`).
 *
 * Uso:
 *   npm run package:portable                        # staging en build/portable, ZIP en build/dist
 *   npm run package:portable -- --smoke             # + smoke del ZIP extraído
 *   npm run package:portable -- --keep-staging      # deja el staging para inspección
 *
 * Opciones:
 *   --out=<dir>         Directorio de salida (por defecto `<repo>/build`).
 *   --keep-staging      No borra el staging ni el trabajo al terminar.
 *   --no-zip            Arma el staging y el manifiesto, sin comprimir.
 *   --smoke             Corre el smoke sobre el ZIP ya extraído (con el runtime
 *                       externo: `VIUREWARDS_TEST_NODE_EXE` o el Node que corre
 *                       el build).
 *
 * Estructura resultante (documentada también en `docs/distribution.md`):
 *
 *   VIUrewards-<versión>-portable-win-x64/
 *     app/                  código TS, web/, overlay/, scripts/, package.json,
 *                           lockfile y node_modules de producción (podado)
 *     licenses/             licencias de las dependencias npm redistribuidas
 *     manifest.json         versión, commit, plataforma, runtime esperado,
 *                           herramientas administradas (URL + SHA-256) y hashes
 *     README-DISTRIBUCION.md
 *     SHA256SUMS.txt        hashes de los archivos del paquete
 *
 * El ZIP y su `.sha256` quedan FUERA del directorio del paquete.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECKSUM_FILE,
  FORBIDDEN_EXECUTABLES,
  FORBIDDEN_PATH_SEGMENTS,
  FORBIDDEN_TOP_LEVEL,
  MANAGED_TOOLS,
  MANIFEST_FILE,
  NODE_ABI,
  NODE_MODULES_PRUNE,
  NODE_VERSION,
  PACKAGE_CONTRACT_VERSION,
  PACKAGE_NAME,
  PROJECT_LICENSE,
  TARGET,
  packageFileName,
} from "./dist/config.ts";
import { findForbiddenPaths, formatBytes, listFiles, sha256File, treeSize } from "./dist/fs-utils.ts";
import { INSTALLER_FILE } from "./dist/build-installer.ts";
import { managedTool } from "./dist/config.ts";

/** Launcher gráfico del paquete (Etapa 3C); se copia a `app/scripts/dist/`. */
const LAUNCHER_GUI_FILE = "launcher-gui.ps1";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIR = join(REPO_ROOT, "scripts", "dist");

/** Versión de SQLite embebida (dependencia de `better-sqlite3`). */
const SQLITE_VERSION = "3.53.4";

// -----------------------------------------------------------------------------
// Utilidades de consola y procesos
// -----------------------------------------------------------------------------

function step(message: string): void {
  console.log(`\n== ${message}`);
}

function info(message: string): void {
  console.log(`   ${message}`);
}

/** Error de build con mensaje en español (siempre se muestra tal cual). */
class BuildError extends Error {}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    out[key] = value ?? true;
  }
  return out;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Ejecuta un proceso con argumentos en array (nunca shell), capturando salida. */
function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-4000);
    throw new BuildError(`Falló \`${basename(command)} ${args[0] ?? ""}\` (código ${result.code}):\n${detail}`);
  }
  return result;
}

// -----------------------------------------------------------------------------
// ZIP
// -----------------------------------------------------------------------------

/**
 * Ruta al `npm-cli.js` que acompaña al runtime que ejecuta el build.
 *
 * Se usa en lugar del script de shell `npm` para no depender de una shell en
 * Windows (AGENTS.md #1). Si el runtime no trae npm (un Node portable mínimo),
 * devuelve `null` y el build cae al `npm` del PATH.
 */
function npmCliPath(): string | null {
  const execDir = dirnameOf(process.execPath);
  const candidates = [
    join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}

/**
 * Fija el timestamp de todos los archivos: dos builds del mismo código dan un
 * ZIP con fechas idénticas (nada de la máquina que compiló queda dentro).
 */
function freezeTimestamps(root: string): void {
  const fixed = new Date("2020-01-01T00:00:00Z");
  for (const rel of listFiles(root)) {
    try {
      utimesSync(join(root, rel), fixed, fixed);
    } catch {
      // Un timestamp que no se puede fijar no impide empaquetar.
    }
  }
}

/** Resultado de intentar una herramienta del sistema. `missing` = no existe. */
interface ToolResult {
  code: number;
  missing: boolean;
  stdout: string;
  stderr: string;
}

/** Igual que `run`, pero distingue «la herramienta no existe» de «falló». */
function runTool(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<ToolResult> {
  return new Promise((resolveTool) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolveTool({ code: -1, missing: true, stdout, stderr });
      else resolveTool({ code: -1, missing: false, stdout, stderr: error.message });
    });
    child.once("close", (code) => resolveTool({ code: code ?? -1, missing: false, stdout, stderr }));
  });
}

/**
 * Ejecuta un comando de PowerShell sin inventar una línea de shell con datos
 * dinámicos: el script va fijo y las rutas se pasan por variables de entorno
 * (`VIU_*`), que PowerShell lee con `$env:`. Así los espacios y comillas de una
 * ruta nunca cambian el comando.
 */
function runPowerShell(script: string, env: Record<string, string>): Promise<ToolResult> {
  return runTool("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { env });
}

/**
 * Comprime `sourceDir` (el nombre de la carpeta será la raíz dentro del ZIP) con
 * la herramienta que exista en el sistema, sin dependencias de npm.
 *
 * En Windows se usa `Compress-Archive` de PowerShell (siempre presente); en
 * otros sistemas se prueban `zip` y `tar`. Se pasan rutas **absolutas** y `cwd`
 * explícito: un `tar` viejo confunde `N:\...` con un host remoto. Si nada
 * funciona, el build falla: no se publica un ZIP sin verificar.
 */
async function createZip(sourceDir: string, zipPath: string): Promise<string> {
  const parent = resolve(sourceDir, "..");
  const folder = basename(sourceDir);
  const zipAbs = resolve(zipPath);
  rmSync(zipAbs, { force: true });

  if (process.platform === "win32") {
    const result = await runPowerShell(
      "Compress-Archive -LiteralPath $env:VIU_SOURCE -DestinationPath $env:VIU_ZIP -CompressionLevel Optimal -Force",
      { VIU_SOURCE: resolve(sourceDir), VIU_ZIP: zipAbs },
    );
    if (result.code === 0 && existsSync(zipAbs)) return "powershell";
    throw new BuildError(
      `No se pudo comprimir el paquete con Compress-Archive.\n${(result.stderr || result.stdout).trim().slice(0, 600)}`,
    );
  }

  const failures: string[] = [];
  for (const candidate of [
    { tool: "zip", args: ["-r", "-q", "-X", zipAbs, folder] },
    { tool: "tar", args: ["-a", "-c", "-f", zipAbs, folder] },
  ]) {
    const result = await runTool(candidate.tool, candidate.args, { cwd: parent });
    if (result.code === 0 && existsSync(zipAbs)) return candidate.tool;
    failures.push(
      result.missing
        ? `${candidate.tool}: no está disponible en esta máquina`
        : `${candidate.tool}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    );
  }
  throw new BuildError(`No se pudo comprimir el paquete.\n${failures.join("\n")}`);
}

// -----------------------------------------------------------------------------
// Manifest y documentación del paquete
// -----------------------------------------------------------------------------

interface Manifest {
  name: string;
  version: string;
  /** Versión del contrato que consume el instalador (ver `config.ts`). */
  contractVersion: number;
  commit: string | null;
  dirty: boolean;
  builtAt: string;
  platform: string;
  arch: string;
  /** Runtime que la instalación debe proveer (NO viaja en el ZIP). */
  node: { version: string; abi: string; installedBy: string };
  /** Herramientas que el instalador descarga e instala en el directorio de datos. */
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
    /** Proveedor, licencia y fuente del código del artefacto (avisos de terceros). */
    provenance: {
      vendor: string;
      vendorPage: string;
      license: string;
      sourceCode?: string;
      verified: string;
    };
  }>;
  /**
   * Licencia del código propio de VIUrewards. Es independiente de las de
   * terceros: cubre solo los archivos de este repositorio.
   */
  projectLicense: { spdx: string; name: string; file: string; coversProjectCodeOnly: true };
  entries: Array<{ path: string; bytes: number; sha256: string }>;
}

async function gitInfo(): Promise<{ commit: string | null; dirty: boolean }> {
  try {
    const commit = await run("git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: REPO_ROOT });
    const status = await run("git", ["--no-optional-locks", "status", "--porcelain"], { cwd: REPO_ROOT });
    return {
      commit: commit.code === 0 ? commit.stdout.trim() : null,
      dirty: status.code === 0 && status.stdout.trim().length > 0,
    };
  } catch {
    return { commit: null, dirty: false };
  }
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

// -----------------------------------------------------------------------------
// Copia de la aplicación
// -----------------------------------------------------------------------------

/** Archivos de la raíz que forman parte del paquete (lista explícita). */
const ROOT_FILES = ["package.json", "package-lock.json", "README.md", "LICENSE"] as const;

/** Carpetas del repositorio que se copian completas a `app/`. */
const APP_DIRS = ["src", "web", "overlay", "scripts"] as const;

function copyApp(appDir: string): void {
  for (const dir of APP_DIRS) {
    const from = join(REPO_ROOT, dir);
    if (!existsSync(from)) throw new BuildError(`Falta la carpeta requerida del repositorio: ${dir}`);
    cpSync(from, join(appDir, dir), {
      recursive: true,
      // Nunca se copian tests ni herramientas de desarrollo: no forman parte del
      // runtime y arrastran fixtures o escrituras a `media/`.
      filter: (path) => {
        const rel = relative(from, path).split(sep).join("/");
        if (rel === "") return true;
        const name = basename(path);
        if (name.endsWith(".test.ts")) return false;
        if (name === "__fixtures__" || name === "fixtures") return false;
        // `play-test.ts` descarga y convierte medios reales: es una herramienta
        // de desarrollo, no algo que el usuario final ejecute.
        if (rel === "play-test.ts") return false;
        return true;
      },
    });
  }
  for (const file of ROOT_FILES) {
    const from = join(REPO_ROOT, file);
    if (existsSync(from)) copyFileSync(from, join(appDir, file));
  }
  // El smoke, el arnés de cierre, el instalador de herramientas y el launcher
  // viven en el paquete (se ejecutan con el runtime que provee la instalación).
  //
  // `install-tools.ps1` y `launcher-gui.ps1` tienen que quedar DENTRO de
  // `app/scripts/dist/`: ambos deducen la raíz de la aplicación desde
  // `$PSScriptRoot` (`<pkg>/app/scripts/dist` -> `<pkg>/app`). El instalador, para
  // rechazar un directorio de datos dentro de la app; el launcher, para
  // encontrar `scripts/start.ts` y el propio instalador. La primera vez no hay
  // nada instalado, así que no pueden buscarse fuera del paquete.
  //
  // El usuario no entra en `app/`: hace doble clic en `VIUrewards.cmd`, que está
  // en la raíz del paquete y llama a este `.ps1` (`writeLauncherEntry`).
  mkdirSync(join(appDir, "scripts", "dist"), { recursive: true });
  for (const file of [
    "smoke.mjs",
    "config.ts",
    "fs-utils.ts",
    "shutdown-harness.mjs",
    "launcher-harness.ps1",
    INSTALLER_FILE,
    LAUNCHER_GUI_FILE,
  ]) {
    copyFileSync(join(DIST_DIR, file), join(appDir, "scripts", "dist", file));
  }
}

// -----------------------------------------------------------------------------
// Punto de entrada del launcher (Etapa 3C)
// -----------------------------------------------------------------------------

/**
 * Nombre del `.cmd` que el usuario hace doble clic en la RAÍZ del paquete.
 *
 * El `.ps1` NO se copia a la raíz: se queda en `app/scripts/dist/` porque su
 * guard de rutas deduce la raíz de la aplicación desde `$PSScriptRoot`
 * (`<pkg>/app/scripts/dist` -> `<pkg>/app`). Moverlo cambiaría esa deducción.
 */
const LAUNCHER_ENTRY_FILE = "VIUrewards.cmd";

/**
 * Contenido del `.cmd`. Todo ASCII y CRLF (el `.cmd` lo interpreta `cmd.exe`, que
 * parte las líneas así).
 *
 * `%~dp0` es el directorio del propio `.cmd`, rodeado de comillas: la ruta puede
 * tener espacios. PowerShell recibe la ruta del `.ps1` por `-File`, también
 * entrecomillada. No se usa `start` ni `cmd /c` anidado: el proceso PowerShell
 * queda como hijo del `.cmd` que abrió el usuario.
 */
function launcherEntryText(): string {
  return [
    "@echo off",
    "setlocal",
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\\scripts\\dist\\${LAUNCHER_GUI_FILE}" %*`,
    "",
  ].join("\r\n");
}

function writeLauncherEntry(stagingDir: string): void {
  writeFileSync(join(stagingDir, LAUNCHER_ENTRY_FILE), launcherEntryText(), "utf8");
}

// -----------------------------------------------------------------------------
// Poda de node_modules
// -----------------------------------------------------------------------------

/**
 * Elimina de `node_modules` las rutas de `NODE_MODULES_PRUNE` (lista explícita
 * en `config.ts`). Solo borra lo que existe; informa cuánto se liberó.
 *
 * Es conservador a propósito: no usa patrones, así que una entrada que no
 * exista (p. ej. porque cambió la versión de un paquete) no borra otra cosa.
 */
function pruneNodeModules(nodeModules: string): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  for (const rel of NODE_MODULES_PRUNE) {
    const target = join(nodeModules, rel);
    if (!existsSync(target)) continue;
    bytes += treeSize(target, listFiles(target)).bytes + (statSync(target).isFile() ? statSync(target).size : 0);
    rmSync(target, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, bytes };
}

// -----------------------------------------------------------------------------
// Licencias
// -----------------------------------------------------------------------------

/**
 * Copia las licencias de las dependencias de producción de terceros que viajan
 * en el paquete. **No** incluye la licencia de VIUrewards (`LICENSE`, en la
 * raíz del paquete), que cubre solo el código propio.
 *
 * Las licencias de los ejecutables externos (Node, yt-dlp, FFmpeg) **no** van
 * acá: no se redistribuyen, y el instalador deja los avisos de cada proveedor
 * junto a los binarios en el directorio de datos (`MANAGED_TOOLS[].notices`).
 * `licenses/FFMPEG.md` documenta esa procedencia aunque el binario no viaje.
 */
function collectLicenses(nodeModules: string, licensesDir: string): string[] {
  mkdirSync(licensesDir, { recursive: true });
  const included: string[] = [];
  const visit = (packageDir: string, name: string): void => {
    const pkgPath = join(packageDir, "package.json");
    if (!existsSync(pkgPath)) return;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
      license?: string;
      dependencies?: Record<string, string>;
    };
    const safe = name.replace(/^@/, "").replace(/\//g, "__");
    const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"].find((file) =>
      existsSync(join(packageDir, file)),
    );
    const target = `${safe}.txt`;
    const lines = [
      `${name}@${pkg.version ?? "?"}`,
      `Licencia declarada: ${pkg.license ?? "no declarada en package.json"}`,
      "",
    ];
    if (licenseFile) lines.push(readFileSync(join(packageDir, licenseFile), "utf8"));
    else lines.push("(El paquete no incluye un archivo de licencia; se declara en package.json.)");
    writeFileSync(join(licensesDir, target), lines.join("\n"), "utf8");
    included.push(target);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      const nested = join(packageDir, "node_modules", dependency);
      const hoisted = join(nodeModules, dependency);
      if (existsSync(nested)) visit(nested, dependency);
      else if (existsSync(hoisted)) visit(hoisted, dependency);
    }
  };
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
    const full = join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        if (scoped.isDirectory()) visit(join(full, scoped.name), `${entry.name}/${scoped.name}`);
      }
    } else {
      visit(full, entry.name);
    }
  }
  return included.sort();
}

/**
 * Aviso sobre SQLite: `better-sqlite3` embebe SQLite (dominio público) en su
 * binario nativo. Se anota la versión y el texto de "blessing" que el propio
 * proyecto de SQLite pide mantener, leído del header **antes** de podar
 * `better-sqlite3/deps` (que es lo único que lo usa en tiempo de build).
 */
function writeSqliteNotice(nodeModules: string, licensesDir: string): string {
  let blessing = "";
  const header = join(nodeModules, "better-sqlite3", "deps", "sqlite3", "sqlite3.h");
  if (existsSync(header)) {
    const text = readFileSync(header, "utf8");
    const start = text.indexOf("** The author disclaims copyright to this source code.");
    const end = text.indexOf("*/", start);
    if (start >= 0 && end > start) blessing = text.slice(start, end).trim();
  }
  const target = "SQLITE.txt";
  writeFileSync(
    join(licensesDir, target),
    [
      `SQLite ${SQLITE_VERSION} (embebido en better-sqlite3)`,
      "Licencia: dominio público.",
      "",
      blessing || "(El header de SQLite no incluyó el texto de atribución.)",
      "",
    ].join("\n"),
    "utf8",
  );
  return target;
}

// -----------------------------------------------------------------------------
// Documentación del paquete
// -----------------------------------------------------------------------------

/**
 * Aviso de terceros de FFmpeg (`licenses/FFMPEG.md` del paquete).
 *
 * Los datos salen de `config.ts`, así que el aviso no puede divergir de la
 * versión/hash configurados. Separa a propósito los hechos verificados (de dónde
 * sale el archivo, qué declara el proveedor) de las obligaciones legales, que
 * este proyecto no resuelve por su cuenta.
 */
function writeFfmpegNotice(licensesDir: string): string {
  const tool = managedTool("ffmpeg");
  const { provenance } = tool;
  const target = "FFMPEG.md";
  writeFileSync(
    join(licensesDir, target),
    [
      "# FFmpeg / ffprobe — aviso de terceros",
      "",
      "FFmpeg NO se redistribuye dentro de este paquete. Lo descarga el instalador",
      "(app/scripts/dist/install-tools.ps1) desde el proveedor y lo deja en el",
      "directorio de datos (bin/ffmpeg.exe, bin/ffprobe.exe) junto con el texto",
      "GPLv3 y la información de procedencia del propio paquete del proveedor.",
      "",
      "## Artefacto fijado",
      "",
      "| Dato | Valor |",
      "| --- | --- |",
      `| Proveedor | ${provenance.vendor} |`,
      `| Página del proveedor | ${provenance.vendorPage} |`,
      `| Archivo | \`${tool.asset.file}\` |`,
      `| Versión | ${tool.version} |`,
      `| URL de descarga | ${tool.asset.url} |`,
      `| SHA-256 | \`${tool.asset.sha256}\` |`,
      `| Origen del hash | ${tool.asset.checksumSource} |`,
      `| Licencia declarada | ${provenance.license} |`,
      `| Código fuente citado por el proveedor | ${provenance.sourceCode ?? "(el proveedor no lo identifica)"} |`,
      "",
      "## Hechos verificados",
      "",
      provenance.verified,
      "",
      "El ZIP del proveedor incluye su propio LICENSE (texto GPLv3) y un README.txt",
      "con la versión exacta de la compilación, el commit de FFmpeg y las versiones",
      "de las bibliotecas externas incluidas. El instalador copia ambos junto a los",
      "binarios (bin/ffmpeg-LICENSE.txt y bin/ffmpeg-PROCEDENCIA.txt).",
      "",
      "## Qué usa VIUrewards",
      "",
      "VIUrewards ejecuta ffmpeg.exe y ffprobe.exe como PROCESOS SEPARADOS, con",
      "argumentos de línea de comandos (src/media/args.ts). Las operaciones que",
      "necesita son libx264 (video), aac (audio), loudnorm y scale: todas están",
      "presentes en esta compilación, lo que se comprobó con los binarios reales.",
      "",
      "Sobre la relación entre los dos programas (obra combinada frente a programas",
      "separados que se comunican por línea de comandos): aquí solo se deja",
      "constancia de los hechos técnicos. Este proyecto NO afirma que esa separación",
      "resuelva por sí sola las obligaciones de la GPLv3.",
      "",
      "## Obligaciones y límites",
      "",
      "- El hash fijado NO es una firma digital: se publica desde el mismo origen que",
      "  el ZIP y sirve para detectar corrupción y cambios de archivo, no para",
      "  autenticar la autoría.",
      "- Descargar el binario directamente desde el proveedor NO elimina por sí solo",
      "  las obligaciones de la GPLv3 para quien lo redistribuya. Quien lo haga debe",
      "  evaluar por su cuenta el código fuente correspondiente y la información de",
      "  compilación de esa compilación exacta.",
      "- Este aviso NO constituye una opinión legal ni una declaración de",
      "  cumplimiento.",
      "",
    ].join("\n"),
    "utf8",
  );
  return target;
}

/** Copia el `LICENSE` del código propio a la raíz del paquete. */
function copyProjectLicense(stagingDir: string): string {
  const from = join(REPO_ROOT, PROJECT_LICENSE.file);
  if (!existsSync(from)) {
    throw new BuildError(
      `Falta ${PROJECT_LICENSE.file} en la raíz del repositorio (licencia del código propio, ${PROJECT_LICENSE.spdx}).`,
    );
  }
  copyFileSync(from, join(stagingDir, PROJECT_LICENSE.file));
  return PROJECT_LICENSE.file;
}

function writePackageReadme(target: string, version: string): void {
  const tools = MANAGED_TOOLS.map((tool) => {
    const base = tool.install[0]?.to.split("/")[0] ?? "";
    return `| ${tool.id} | ${tool.version} | \`<datos>/${tool.install.map((item) => item.to).join("`, `<datos>/")}\` | ${base ? `por el instalador (${tool.policy})` : ""} |`;
  });
  const text = `# ${PACKAGE_NAME} ${version} — paquete portable ${TARGET.label}

Este paquete es para **probar** la distribución. Incluye el launcher (ventana,
bandeja del sistema e inicio con Windows) y el instalador de herramientas, pero
todavía **no** incluye un instalador gráfico ni la actualización automática de
la aplicación.

> **No es una release pública.** El código propio de VIUrewards se distribuye
> bajo 0BSD (ver \`LICENSE\`); las dependencias npm y los ejecutables externos
> conservan sus propias licencias (\`licenses/\`). Antes de publicar hay que
> revisar las obligaciones de los proveedores de los binarios externos
> (\`docs/distribution.md\` §4).

## Qué contiene

\`\`\`
VIUrewards.cmd    punto de entrada: doble clic (abre el launcher)
app/              aplicación (código TS, web/, overlay/, dependencias de producción,
                  instalador de herramientas y launcher en app/scripts/dist/)
licenses/         licencias de las dependencias npm redistribuidas y avisos
                  de terceros (FFMPEG.md)
LICENSE           licencia 0BSD del código propio de VIUrewards
manifest.json     versión, commit, plataforma, runtime esperado y hashes
SHA256SUMS.txt    hashes de los archivos del paquete
\`\`\`

**No contiene ejecutables de terceros.** \`node.exe\`, \`yt-dlp.exe\`,
\`ffmpeg.exe\` y \`ffprobe.exe\` los descarga el instalador desde cada proveedor y
los deja en el directorio de datos, junto con sus avisos.

## Cómo se usa

1. Descomprimí el ZIP en una carpeta (se admite que la ruta tenga espacios).
2. Doble clic en \`VIUrewards.cmd\`.
3. Pulsá **Iniciar servidor**: si faltan las herramientas, el launcher ejecuta el
   instalador y muestra el progreso. Cuando el servidor informa la URL real,
   **Abrir dashboard** la abre.
4. **Detener servidor** pide el cierre ordenado y espera la terminación real.
5. Cerrar la ventana deja el launcher en la bandeja; **Salir** detiene el
   servidor y cierra.

Los datos (base, medios, logs, herramientas) van a
\`%LOCALAPPDATA%\\VIUrewards\` salvo que definas \`VIUREWARDS_DATA_DIR\` con otra
ruta absoluta. Nunca se escribe dentro de la carpeta del paquete.

## Qué tiene que instalar la instalación (directorio de datos)

| Herramienta | Versión fijada | Ruta en el directorio de datos | Se actualiza |
| --- | --- | --- | --- |
${tools.join("\n")}

Las URLs y los SHA-256 están en \`manifest.json\` (\`managedTools\`), copiados de
\`scripts/dist/config.ts\`. El hash fijado detecta corrupción y cambios de
archivo; **no es una firma digital**.

## Probarlo a mano (sin el launcher)

1. Descargá el runtime fijado (Node.js ${NODE_VERSION}) desde la URL oficial y
   poné su \`node.exe\` en una carpeta temporal.
2. Elegí una carpeta de datos **fuera** del paquete, por ejemplo
   \`C:\\VIUrewards-datos\`.
3. Abrí PowerShell en la carpeta del paquete y ejecutá:

\`\`\`powershell
$env:VIUREWARDS_DATA_DIR = "C:\\VIUrewards-datos"
$env:VIUREWARDS_NODE_RUNTIME = "C:\\ruta\\al\\node.exe"
C:\\ruta\\al\\node.exe .\\app\\scripts\\start.ts
\`\`\`

5. Abrí <http://127.0.0.1:8787/> y creá la contraseña (primera vez).
6. Para cerrar: Ctrl+C en esa consola.

Sin \`ffmpeg\`/\`ffprobe\` en \`<datos>/bin\` (o en el PATH) no se pueden descargar
ni convertir videos; el resto del dashboard funciona. El launcher instala esas
herramientas solo (\`app/scripts/dist/install-tools.ps1 -DataDir <datos>\`).

## Comprobar el paquete sin abrir el navegador

\`\`\`powershell
C:\\ruta\\al\\node.exe .\\app\\scripts\\dist\\smoke.mjs $PWD
\`\`\`

Sale con 0 si todo pasa.

## Validar el checksum del ZIP

El ZIP se distribuye junto a un archivo \`.sha256\`. En PowerShell:

\`\`\`powershell
Get-FileHash .\\${packageFileName(version)} -Algorithm SHA256
\`\`\`

El hash debe coincidir con el contenido del \`.sha256\`. Eso detecta corrupción
en la descarga; **no** es una firma digital ni prueba de autoría.

## Herramientas

yt-dlp se actualiza desde el dashboard (Ajustes → Biblioteca y descargas), sobre
el binario de \`<datos>/bin/yt-dlp.exe\`. Actualizar VIUrewards no reemplaza esa
versión: el instalador no sobrescribe una herramienta existente
(\`policy: if-missing\`).

## Licencias

- **VIUrewards (código propio):** licencia 0BSD, texto completo en \`LICENSE\`.
  Permite usar, modificar y redistribuir el código sin exigir que los derivados
  se publiquen como código abierto. Cubre **solo** los archivos de este
  repositorio.
- **Dependencias npm:** ver \`licenses/\`, con la versión y la licencia declarada
  de cada paquete redistribuido.
- **SQLite** (embebido en \`better-sqlite3\`): dominio público (\`licenses/SQLITE.txt\`).
- **Avisos de terceros:** \`licenses/FFMPEG.md\` documenta la procedencia de
  FFmpeg/ffprobe aunque el binario no viaje en el paquete. Los avisos de
  Node.js, yt-dlp y FFmpeg los deja el instalador junto a cada binario en el
  directorio de datos; \`manifest.json\` (\`managedTools[].provenance\`) guarda la
  misma información en forma legible por máquina.

FFmpeg es una compilación **GPLv3** de un proveedor externo (gyan.dev, enlazado
por FFmpeg.org; **no** es el upstream de FFmpeg). Descargarlo desde el proveedor
no elimina por sí solo las obligaciones de la GPLv3 para quien lo redistribuya:
consultá \`docs/distribution.md\` §4 antes de redistribuir nada.
`;
  writeFileSync(target, text, "utf8");
}

// -----------------------------------------------------------------------------
// Script principal
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(String(args.out ?? join(REPO_ROOT, "build")));
  const makeZip = args["no-zip"] !== true;
  const keepStaging = args["keep-staging"] === true;

  const version = readPackageVersion();
  const zipName = packageFileName(version);
  const zipPath = join(outDir, "dist", zipName);
  const stagingRoot = join(outDir, "portable");
  const stagingDir = join(stagingRoot, `${PACKAGE_NAME}-${version}-portable-${TARGET.label}`);

  if (process.platform !== TARGET.platform || process.arch !== TARGET.arch) {
    throw new BuildError(
      `El paquete es para ${TARGET.platform}/${TARGET.arch} y este entorno es ${process.platform}/${process.arch}.\n` +
        "El build debe correr en Windows x64 (localmente o en el runner de GitHub Actions).",
    );
  }
  // El runtime NO viaja en el paquete, pero el build tiene que correr con la
  // MISMA versión: `better-sqlite3` trae un binario nativo por ABI y se verifica
  // contra `NODE_ABI` con el runtime que lo va a cargar.
  if (process.versions.node !== NODE_VERSION) {
    throw new BuildError(
      `Este build tiene que correr con Node ${NODE_VERSION} (la versión fijada, ABI ${NODE_ABI}) y está corriendo con ${process.version}.\n` +
        "El binario precompilado de better-sqlite3 se liga a un ABI concreto: otro Node no puede verificarlo.",
    );
  }

  step(`Preparando directorios en ${outDir}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(join(outDir, "dist"), { recursive: true });
  const appDir = join(stagingDir, "app");
  mkdirSync(appDir, { recursive: true });

  step("Copiando la aplicación");
  copyApp(appDir);
  // Punto de entrada visible en la raíz del paquete: el usuario no navega por
  // `app/`. El `.ps1` se queda dentro de `app/scripts/dist/` (ver `writeLauncherEntry`).
  writeLauncherEntry(stagingDir);
  info(`app/: ${listFiles(appDir).length} archivos`);

  step("Instalando dependencias de producción (lockfile, sin scripts de build)");
  // `--ignore-scripts`: los paquetes nativos se resuelven por sus binarios
  // precompilados que viajan en el paquete npm (better-sqlite3 trae
  // `prebuilds/win32-x64.node`). No hace falta compilador, ni Python, ni Visual
  // Studio, y no se ejecutan scripts de instalación de terceros.
  //
  // npm se lanza como un JS con el runtime actual (no como `npm.cmd`, que en
  // Windows exigiría shell).
  const npmCli = npmCliPath();
  if (npmCli) {
    await runChecked(process.execPath, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: appDir,
    });
  } else {
    await runChecked("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: appDir });
  }
  const nodeModules = join(appDir, "node_modules");
  const nativeBinding = join(nodeModules, "better-sqlite3", "prebuilds", "win32-x64.node");
  if (!existsSync(nativeBinding)) {
    throw new BuildError(
      `better-sqlite3 no trajo el binario precompilado de Windows x64 (${nativeBinding}). No se empaqueta un paquete que no puede cargar SQLite.`,
    );
  }
  info("better-sqlite3: binario precompilado win32-x64 presente (se prueba con el runtime fijado).");

  step("Reuniendo licencias y avisos de las dependencias");
  const licensesDir = join(stagingDir, "licenses");
  const licenseFiles = collectLicenses(nodeModules, licensesDir);
  // SQLite se documenta ANTES de podar: `better-sqlite3/deps` (fuente) es lo
  // único que trae el header del que se lee el texto de atribución.
  licenseFiles.push(writeSqliteNotice(nodeModules, licensesDir));
  // Aviso de terceros de FFmpeg: el binario no viaja, pero la procedencia
  // fijada y su licencia GPLv3 quedan documentadas en el paquete.
  licenseFiles.push(writeFfmpegNotice(licensesDir));
  info(`${licenseFiles.length} archivos de licencia`);

  step("Copiando la licencia del proyecto");
  const projectLicenseFile = copyProjectLicense(stagingDir);
  info(`${projectLicenseFile} (${PROJECT_LICENSE.spdx})`);

  step("Podiendo node_modules (lista explícita de config.ts)");
  const pruned = pruneNodeModules(nodeModules);
  info(`rutas podadas: ${pruned.removed} (${formatBytes(pruned.bytes)})`);
  if (!existsSync(nativeBinding)) {
    throw new BuildError("La poda borró el binario nativo de better-sqlite3 (win32-x64.node): se cancela el build.");
  }

  step("Verificando better-sqlite3 con el runtime fijado");
  await assertSqliteWorks(process.execPath, appDir, NODE_ABI);

  step("Comprobando que no haya ejecutables de terceros en el paquete");
  assertNoForbiddenExecutables(stagingDir);

  step("Escribiendo manifiesto y README del paquete");
  writePackageReadme(join(stagingDir, "README-DISTRIBUCION.md"), version);
  freezeTimestamps(stagingDir);

  const files = listFiles(stagingDir);
  const violations = findForbiddenPaths(files, FORBIDDEN_PATH_SEGMENTS, FORBIDDEN_TOP_LEVEL);
  if (violations.length > 0) {
    throw new BuildError(`El paquete contiene rutas prohibidas:\n${violations.join("\n")}`);
  }

  const entries: Manifest["entries"] = [];
  for (const rel of files) {
    if (rel === MANIFEST_FILE) continue;
    entries.push({ path: rel, bytes: statSync(join(stagingDir, rel)).size, sha256: await sha256File(join(stagingDir, rel)) });
  }
  const git = await gitInfo();
  const manifest: Manifest = {
    name: PACKAGE_NAME,
    version,
    contractVersion: PACKAGE_CONTRACT_VERSION,
    commit: git.commit,
    dirty: git.dirty,
    // Sin rutas de la máquina ni hora exacta local: fecha UTC en el manifiesto.
    builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platform: TARGET.platform,
    arch: TARGET.arch,
    node: { version: `v${NODE_VERSION}`, abi: NODE_ABI, installedBy: "installer" },
    managedTools: MANAGED_TOOLS.map((tool) => ({
      id: tool.id,
      version: tool.version,
      url: tool.asset.url,
      sha256: tool.asset.sha256,
      checksumSource: tool.asset.checksumSource,
      install: tool.install.map((item) => ({ from: item.from, to: item.to })),
      notices: tool.notices.map((item) => ({ from: item.from, to: item.to })),
      policy: tool.policy,
      updatedBy: tool.updatedBy,
      licenseNote: tool.licenseNote,
      provenance: tool.provenance,
    })),
    projectLicense: PROJECT_LICENSE,
    entries,
  };
  writeFileSync(join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const sums = [...entries.map((entry) => `${entry.sha256}  ${entry.path}`), `${sha256Text(JSON.stringify(manifest, null, 2) + "\n")}  ${MANIFEST_FILE}`];
  writeFileSync(join(stagingDir, CHECKSUM_FILE), `${sums.join("\n")}\n`, "utf8");

  const size = treeSize(stagingDir, listFiles(stagingDir));
  info(`staging: ${size.files} archivos, ${formatBytes(size.bytes)}`);

  if (makeZip) {
    step("Comprimiendo el ZIP y calculando el checksum");
    const tool = await createZip(stagingDir, zipPath);
    const zipBytes = statSync(zipPath).size;
    const zipHash = await sha256File(zipPath);
    writeFileSync(`${zipPath}.sha256`, `${zipHash}  ${zipName}\n`, "utf8");
    info(`ZIP: ${zipPath} (${formatBytes(zipBytes)}, con ${tool})`);
    info(`SHA-256: ${zipHash}`);

    // Parte G: smoke sobre el ZIP YA EXTRAÍDO (no sobre el staging), en una ruta
    // temporal con espacios. Se ejecuta después de generar el ZIP porque es lo
    // que se distribuye; si falla, el build falla.
    if (args.smoke === true) {
      step("Smoke del paquete extraído (runtime fijado, externo al paquete)");
      await smokeExtractedZip(zipPath, stagingDir);
    }
  }

  if (!keepStaging) {
    step("Limpiando staging");
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(join(outDir, "work"), { recursive: true, force: true });
  }

  step("Build terminado");
  console.log(`   versión:  ${version}`);
  console.log(`   commit:   ${git.commit ?? "(sin git)"}${git.dirty ? " (árbol con cambios sin commitear)" : ""}`);
  console.log(`   ZIP:      ${makeZip ? zipPath : "(no se generó: --no-zip)"}`);
}

/**
 * Falla si el staging contiene alguno de `FORBIDDEN_EXECUTABLES`.
 *
 * En la estrategia C esos binarios los instala el instalador desde el proveedor:
 * si uno viajara en el ZIP, volveríamos a redistribuirlo sin querer.
 */
function assertNoForbiddenExecutables(stagingDir: string): void {
  const forbidden = new Set<string>(FORBIDDEN_EXECUTABLES);
  const found = listFiles(stagingDir).filter((rel) => forbidden.has(basename(rel)));
  if (found.length > 0) {
    throw new BuildError(
      `El paquete contiene ejecutables que NO se redistribuyen (los instala el instalador):\n${found.join("\n")}`,
    );
  }
  info(`ningún ejecutable de terceros (${FORBIDDEN_EXECUTABLES.join(", ")})`);
}

/**
 * Smoke del paquete EXTRAÍDO (Parte G).
 *
 * Extrae el ZIP a una ruta temporal CON ESPACIOS y corre `smoke.mjs` con el
 * runtime FIJADO (fuera del paquete: `VIUREWARDS_TEST_NODE_EXE`, o el Node que
 * corre este build) — nunca con el staging. Si el smoke falla o deja
 * comprobaciones omitidas, el build falla: una omisión no cuenta como éxito.
 */
async function smokeExtractedZip(zipPath: string, expectedPackageDir: string): Promise<void> {
  const smokeRoot = mkdtempSync(join(tmpdir(), "VIU smoke con espacios"));
  try {
    const extractDir = join(smokeRoot, "paquete extraido");
    mkdirSync(extractDir, { recursive: true });
    info(`Extrayendo el ZIP en ${extractDir}`);
    await extractZip(zipPath, extractDir);

    const packageDir = join(extractDir, basename(expectedPackageDir));
    if (!existsSync(packageDir)) {
      throw new BuildError(`El ZIP no contiene la carpeta esperada ${basename(expectedPackageDir)}.`);
    }
    const nodeExe = process.env.VIUREWARDS_TEST_NODE_EXE?.trim() || process.execPath;
    const smokeScript = join(packageDir, "app", "scripts", "dist", "smoke.mjs");
    if (!existsSync(nodeExe) || !existsSync(smokeScript)) {
      throw new BuildError(`Falta el runtime (${nodeExe}) o app/scripts/dist/smoke.mjs en el paquete extraído.`);
    }

    const result = await run(nodeExe, [smokeScript, packageDir], { cwd: smokeRoot });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.code !== 0) {
      throw new BuildError(
        `El smoke del paquete extraído falló (código ${result.code}). ` +
          "Código 2 significa que hubo comprobaciones OMITIDAS, que no cuentan como éxito.",
      );
    }
    info("Smoke del paquete extraído: todo OK");
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

/** Extrae un ZIP con la herramienta del sistema (PowerShell o unzip). */
async function extractZip(zipPath: string, destination: string): Promise<void> {
  const zipAbs = resolve(zipPath);
  const destAbs = resolve(destination);
  const failures: string[] = [];

  const compressed = await runPowerShell(
    "Expand-Archive -LiteralPath $env:VIU_ZIP -DestinationPath $env:VIU_DEST -Force",
    { VIU_ZIP: zipAbs, VIU_DEST: destAbs },
  );
  if (compressed.code === 0) return;
  failures.push(
    compressed.missing
      ? "powershell: no está disponible en esta máquina"
      : `powershell: ${(compressed.stderr || compressed.stdout).trim().slice(0, 200)}`,
  );

  const unzip = await runTool("unzip", ["-q", "-o", zipAbs, "-d", destAbs]);
  if (unzip.code === 0) return;
  failures.push(
    unzip.missing
      ? "unzip: no está disponible en esta máquina"
      : `unzip: ${(unzip.stderr || unzip.stdout).trim().slice(0, 200)}`,
  );
  throw new BuildError(`No se pudo extraer ${basename(zipPath)}.\n${failures.join("\n")}`);
}

/**
 * better-sqlite3 con el runtime fijado: crear, escribir, leer, reabrir y
 * comprobar el ABI (un binario de otro ABI no carga).
 */
async function assertSqliteWorks(nodeExe: string, appDir: string, expectedAbi: string): Promise<void> {
  const script = join(appDir, ".sqlite-check.mjs");
  writeFileSync(
    script,
    [
      'import Database from "better-sqlite3";',
      'import { mkdtempSync, rmSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'const dir = mkdtempSync(join(tmpdir(), "viu-sqlite-check-"));',
      'const file = join(dir, "check.db");',
      "const db = new Database(file);",
      'db.pragma("journal_mode = WAL");',
      'db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");',
      'db.prepare("INSERT INTO t (v) VALUES (?)").run("ok");',
      'const row = db.prepare("SELECT v FROM t WHERE id = 1").get();',
      "db.close();",
      'const again = new Database(file, { readonly: true });',
      'const row2 = again.prepare("SELECT v FROM t WHERE id = 1").get();',
      "again.close();",
      "rmSync(dir, { recursive: true, force: true });",
      "if (row?.v !== \"ok\" || row2?.v !== \"ok\") { console.error(\"better-sqlite3 no leyó la fila\"); process.exit(1); }",
      'console.log(JSON.stringify({ ok: true, node: process.version, abi: process.versions.modules }));',
    ].join("\n"),
    "utf8",
  );
  try {
    const result = await run(nodeExe, [script], { cwd: appDir });
    if (result.code !== 0) {
      throw new BuildError(
        `better-sqlite3 no funciona con el runtime fijado (${nodeExe}).\n${(result.stderr || result.stdout).trim().slice(0, 2000)}`,
      );
    }
    const parsed = JSON.parse(result.stdout.trim()) as { node: string; abi: string };
    if (parsed.abi !== expectedAbi) {
      throw new BuildError(
        `El runtime informa ABI ${parsed.abi} y el paquete declara ${expectedAbi} (NODE_ABI en scripts/dist/config.ts).`,
      );
    }
    info(`better-sqlite3 OK con ${parsed.node} (ABI ${parsed.abi})`);
  } finally {
    rmSync(script, { force: true });
  }
}

/** SHA-256 de un texto (para el manifiesto). */
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

try {
  await main();
} catch (error) {
  if (error instanceof BuildError) {
    console.error(`\nEl empaquetado se canceló:\n${error.message}`);
  } else {
    console.error(`\nEl empaquetado se canceló por un error inesperado:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  process.exitCode = 1;
}
