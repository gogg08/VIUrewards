/**
 * Bootstrap de instalación (`scripts/dist/install.ps1`), PR A de 3.
 *
 * Ejercita el `.ps1` REAL con Windows PowerShell 5.1 contra directorios
 * temporales CON ESPACIOS y un servidor HTTP local en `127.0.0.1` (puerto
 * efímero) que sirve un ZIP FALSO con la MISMA forma que el real:
 *
 *   VIUrewards-0.0.0-portable-win-x64/     <- una sola carpeta raíz
 *     VIUrewards.cmd
 *     app/scripts/dist/install-tools.ps1
 *     app/scripts/dist/launcher-gui.ps1
 *
 * Los dos `.ps1` falsos NO descargan nada: escriben un marcador con el
 * `-DataDir` que reciben y devuelven el código que se les pida. Así se comprueba
 * qué argumentos recibe el instalador de herramientas, sin red externa.
 *
 * Nunca se toca el Menú Inicio real ni `%LOCALAPPDATA%`: todo pasa por
 * `VIUREWARDS_INSTALL_START_MENU_DIR`, `VIUREWARDS_INSTALL_DIR` y
 * `VIUREWARDS_INSTALL_DATA_DIR`.
 *
 * El ZIP se escribe a mano (entradas STORED + directorio central), sin
 * dependencias nuevas: no hace falta DEFLATE para que `ZipFile` lo abra.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32 } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CAN_RUN_DIST, REPO_ROOT, run } from "./helpers.ts";

const BOOTSTRAP = join(REPO_ROOT, "scripts", "dist", "install.ps1");
const VERSION = "0.0.0";
const ROOT_DIR = `VIUrewards-${VERSION}-portable-win-x64`;

/**
 * Instalador de herramientas FALSO: escribe un marcador con el `-DataDir` que
 * recibió y sale con `VIU_TEST_TOOLS_CODE` (0 si no se define). No descarga.
 *
 * OJO: `param(...)` es obligatorio. Un `.ps1` sin `param()` NO liga `-DataDir`
 * a `$DataDir` (queda en `$args`), así que el marcador saldría vacío y el test
 * estaría midiendo un artefacto del propio falso.
 */
const FAKE_TOOLS = [
  "param([string]$DataDir)",
  "$ErrorActionPreference = 'Stop'",
  // Su salida tiene que LLEGAR al usuario: lo comprueba el test del PUNTO 2.
  "Write-Host ('FAKE-TOOLS-OUTPUT-' + $env:VIU_TEST_TOOLS_GUID)",
  "$marker = $env:VIU_TEST_TOOLS_MARKER",
  "$line = 'dataDir=' + $DataDir",
  "if (Test-Path -LiteralPath $marker) { $line = (Get-Content -Raw -LiteralPath $marker).TrimEnd() + [Environment]::NewLine + $line }",
  "Set-Content -LiteralPath $marker -Value $line -Encoding UTF8",
  "$code = 0",
  "if ($env:VIU_TEST_TOOLS_CODE) { $code = [int]$env:VIU_TEST_TOOLS_CODE }",
  "exit $code",
  "",
].join("\r\n");

/**
 * Launcher FALSO: deja constancia si se abre (solo si el caso lo permite).
 * Con `VIU_TEST_LAUNCHER_SLEEP=1` se queda vivo hasta que lo maten (PUNTO 3).
 */
const FAKE_LAUNCHER = [
  "$ErrorActionPreference = 'Stop'",
  // El marcador va PRIMERO: con VIU_TEST_LAUNCHER_SLEEP el script se queda
  // dormido enseguida, y un marcador escrito despues del Start-Sleep no llegaria
  // a existir (medido: marca=false, proceso vivo=true).
  "if ($env:VIU_TEST_LAUNCH_MARKER) {",
  "  Set-Content -LiteralPath $env:VIU_TEST_LAUNCH_MARKER -Value 'launched' -Encoding UTF8",
  "}",
  "if ($env:VIU_TEST_LAUNCHER_SLEEP) { Start-Sleep -Seconds 120 }",
  "exit 0",
  "",
].join("\r\n");

const FAKE_CMD = "@echo off\r\necho VIUrewards\r\n";

// -----------------------------------------------------------------------------
// Escritor de ZIP mínimo (STORED, sin compresión)
// -----------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Arma un ZIP sin compresión con las entradas dadas (nombre con `/`). */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    // CRC-32 sin signo: el de `node:zlib` puede venir con signo.
    const crc = crc32(entry.data) >>> 0;
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(0, 8); // método 0 = STORED
    local.writeUInt16LE(0, 10); // hora
    local.writeUInt16LE(0x21, 12); // fecha (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versión que lo creó
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/** ZIP con la forma del paquete real (con entradas extra opcionales). */
function packageZip(extra: ZipEntry[] = []): Buffer {
  return buildZip([
    { name: `${ROOT_DIR}/VIUrewards.cmd`, data: Buffer.from(FAKE_CMD, "utf8") },
    { name: `${ROOT_DIR}/app/scripts/dist/install-tools.ps1`, data: Buffer.from(FAKE_TOOLS, "utf8") },
    { name: `${ROOT_DIR}/app/scripts/dist/launcher-gui.ps1`, data: Buffer.from(FAKE_LAUNCHER, "utf8") },
    { name: `${ROOT_DIR}/app/scripts/dist/marker.txt`, data: Buffer.from("paquete", "utf8") },
    ...extra,
  ]);
}

// -----------------------------------------------------------------------------
// Servidor HTTP local (solo 127.0.0.1, puerto efímero)
// -----------------------------------------------------------------------------

let server: Server | null = null;
let baseUrl = "";
let payload: Buffer = Buffer.alloc(0);

async function startServer(): Promise<void> {
  if (server !== null) return;
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.endsWith(".zip")) {
      response.writeHead(200, { "content-type": "application/zip", "content-length": String(payload.length) });
      response.end(payload);
      return;
    }
    response.writeHead(404);
    response.end("no");
  });
  await new Promise<void>((resolveListen) => {
    server?.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}

/** Deja el servidor arriba y el payload por defecto antes de cada caso. */
async function prepareCase(): Promise<void> {
  if (!CAN_RUN_DIST) return;
  await startServer();
  payload = packageZip();
}

// -----------------------------------------------------------------------------
// Utilidades de los casos
// -----------------------------------------------------------------------------

const created: string[] = [];
let layoutCounter = 0;

/** Directorio temporal con espacios, en forma LARGA (los runners usan 8.3). */
function tempDir(label: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), `VIU bootstrap ${label} `)));
  created.push(dir);
  return dir;
}

interface Layout {
  root: string;
  installDir: string;
  dataDir: string;
  startMenuDir: string;
  toolsMarker: string;
  launchMarker: string;
}

/** Layout de un caso: app, datos y Menú Inicio, todos fuera de los reales. */
function makeLayout(label: string): Layout {
  layoutCounter += 1;
  const root = tempDir(`${label} ${layoutCounter}`);
  return {
    root,
    installDir: join(root, "carpeta de la app", "VIUrewards"),
    dataDir: join(root, "carpeta de datos", "VIUrewards"),
    startMenuDir: join(root, "menu inicio del usuario"),
    toolsMarker: join(root, "herramientas.txt"),
    launchMarker: join(root, "lanzado.txt"),
  };
}

/** Entorno del bootstrap: TODAS las rutas por variables, nada del usuario real. */
function bootstrapEnv(layout: Layout, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    VIUREWARDS_INSTALL_BASE_URL: `${baseUrl}/descargas/v${VERSION}`,
    VIUREWARDS_INSTALL_VERSION: VERSION,
    VIUREWARDS_INSTALL_SHA256: createHash("sha256").update(payload).digest("hex"),
    VIUREWARDS_INSTALL_DIR: layout.installDir,
    VIUREWARDS_INSTALL_DATA_DIR: layout.dataDir,
    VIUREWARDS_INSTALL_START_MENU_DIR: layout.startMenuDir,
    VIUREWARDS_INSTALL_NO_LAUNCH: "1",
    VIU_TEST_TOOLS_MARKER: layout.toolsMarker,
    VIU_TEST_LAUNCH_MARKER: layout.launchMarker,
    // Nada que ver con la instalación real del usuario.
    VIUREWARDS_DATA_DIR: "",
    ...extra,
  };
}

interface BootstrapResult {
  code: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

/** Lo que quedó en la sesión del host tras el `iex` (T2). */
interface SessionReport {
  newVars: string[];
  newFuncs: string[];
  lastExit: number | null;
  /** El host no llegó a escribir el informe: se cerró durante el bootstrap. */
  missing: boolean;
}

/** Corre el bootstrap como ARCHIVO (`powershell -File`). */
async function runBootstrap(layout: Layout, extra: Record<string, string> = {}): Promise<BootstrapResult> {
  const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BOOTSTRAP], {
    timeoutMs: 240_000,
    env: bootstrapEnv(layout, extra),
  });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

/**
 * Corre el bootstrap por `iex`, como el usuario (`irm | iex`).
 *
 * Se invoca `iex` sobre el texto del archivo y DESPUÉS se escribe el marcador de
 * "seguí vivo". Si el bootstrap llamara a `exit`, el host se cerraría y el
 * marcador no existiría.
 */
async function runBootstrapIex(layout: Layout, extra: Record<string, string> = {}): Promise<BootstrapResult> {
  const after = join(layout.root, "siguio-vivo.txt");
  const command = [
    `iex (Get-Content -Raw -LiteralPath ${JSON.stringify(BOOTSTRAP)})`,
    `Set-Content -LiteralPath ${JSON.stringify(after)} -Value 'vivo' -Encoding UTF8`,
  ].join("\n");
  const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    timeoutMs: 240_000,
    env: bootstrapEnv(layout, extra),
  });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

// -----------------------------------------------------------------------------
// Procesos hijos lanzados por un caso (se terminan siempre en el `finally`)
// -----------------------------------------------------------------------------

const spawned: number[] = [];

/** Lanza un proceso que se queda vivo (cuelga del test) y devuelve su PID. */
function spawnChild(command: string, args: string[], extraEnv: Record<string, string> = {}): number {
  const child = spawn(command, args, {
    // Sin "detached": detached hace que powershell.exe salga 0 sin correr el script.
    // "pipe" y no "ignore": con "ignore" tambien termina sin correr.
    stdio: ["ignore", "pipe", "pipe"],
    // Sin esto el script falso no ve sus variables y no deja el marcador: el
    // proceso sale en el acto y el caso se queda sin nada que detectar.
    env: { ...process.env, ...extraEnv },
  });
  if (child.pid === undefined) throw new Error(`no se pudo lanzar ${command}`);
  spawned.push(child.pid);
  return child.pid;
}

/** Termina los procesos lanzados por el caso (arbol de cada uno). */
function killSpawned(): void {
  for (const pid of spawned.splice(0)) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Ya no estaba: es el resultado esperado cuando el caso murio solo.
    }
  }
}

/** true si el PID sigue vivo (y no es un zombi que ya termino). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Espera a que el PID desaparezca. Devuelve true si desaparecio. */
async function waitGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !isAlive(pid);
}

/**
 * Host REAL de `%LOCALAPPDATA%` (el que el bootstrap usaria sin overrides).
 * Sirve para comprobar que un proceso de prueba corriendo AHI no se toca.
 */
function realLocalAppData(): string {
  if (!process.env.LOCALAPPDATA) throw new Error("no hay %LOCALAPPDATA%");
  return realpathSync.native(process.env.LOCALAPPDATA);
}

let waitHandleSeq = 0;

/**
 * Arranca un proceso que mantiene abierto un archivo para que el borrado falle
 * (PUNTO 4). Avisa cuando ya lo tiene y espera a que el test lo termine.
 *
 * Dos condiciones del escenario, ambas medidas:
 *
 * - El proceso NO puede ser un interprete con la carpeta de la app en la linea
 *   de comandos: powershell.exe, pwsh.exe o cmd.exe que la nombran son
 *   justamente lo que el bootstrap toma como la app en ejecucion (el launcher),
 *   y el caso terminaria en "instancia en ejecucion" (codigo 3) sin llegar
 *   nunca al borrado. Por eso el script va por STDIN (`-Command -`) y las rutas
 *   por variables de entorno: su linea de comandos queda en `-Command -`.
 * - Un archivo abierto con `fs.openSync` de Node NO impide borrar la carpeta
 *   (medido: `Remove-Item -Recurse -Force` termina bien). Hace falta abrirlo con
 *   FileShare.None, que es lo que hace el script de abajo (medido: el borrado
 *   falla).
 */
function spawnKeeper(filePath: string, workDir: string): string {
  waitHandleSeq += 1;
  const waitHandlePath = join(workDir, `retencion ${waitHandleSeq}.txt`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$stream = [System.IO.File]::Open($env:VIU_KEEPER_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "Set-Content -LiteralPath $env:VIU_KEEPER_READY -Value ([string]$PID) -Encoding UTF8",
    "while ($true) { Start-Sleep -Milliseconds 200 }",
    "",
  ].join("\r\n");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    // Sin "detached" y con stdio en pipe: powershell.exe arranca igual, queda
    // hijo del test y killSpawned() lo termina.
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, VIU_KEEPER_FILE: filePath, VIU_KEEPER_READY: waitHandlePath },
  });
  if (child.pid === undefined) throw new Error("no se pudo lanzar el proceso que retiene el archivo");
  spawned.push(child.pid);
  child.stdin.write(script);
  child.stdin.end();
  return waitHandlePath;
}

/**
 * Corre por `iex` un payload que, ANTES y DESPUÉS del bootstrap, lista las
 * variables y las funciones del host: así se comprueba que el script no deja
 * nada en la sesión del usuario.
 *
 * El payload sale de un archivo temporal escrito en UTF-8, y no de
 * `Get-Content -Raw` sin `-Encoding`: Windows PowerShell 5.1 lee los `.ps1` sin
 * BOM en ANSI.
 */
async function runBootstrapIexSession(
  layout: Layout,
  extra: Record<string, string> = {},
): Promise<{ result: BootstrapResult; report: SessionReport }> {
  const aliveMarker = join(layout.root, "siguio-vivo.txt");
  const reportPath = join(layout.root, "sesion.json");
  const command = [
    // Todo lo que es del arnés lleva el prefijo Viut, para poder descontarlo del
    // informe: sin prefijo, estas mismas variables ensucian la comparación.
    "$viutBeforeVars = @(Get-Variable | Select-Object -ExpandProperty Name)",
    "$viutBeforeFuncs = @(Get-ChildItem Function: | Select-Object -ExpandProperty Name)",
    `iex ([System.IO.File]::ReadAllText(${psQuote(BOOTSTRAP)}))`,
    `Set-Content -LiteralPath ${psQuote(aliveMarker)} -Value 'vivo' -Encoding UTF8`,
    "$viutAfterVars = @(Get-Variable | Select-Object -ExpandProperty Name)",
    "$viutAfterFuncs = @(Get-ChildItem Function: | Select-Object -ExpandProperty Name)",
    "$viutReport = [ordered]@{",
    "  newVars = @(Compare-Object -ReferenceObject $viutBeforeVars -DifferenceObject $viutAfterVars |",
    "    Where-Object { $_.SideIndicator -eq '=>' } | Select-Object -ExpandProperty InputObject |",
    "    Where-Object { $_ -notlike 'viut*' })",
    "  newFuncs = @(Compare-Object -ReferenceObject $viutBeforeFuncs -DifferenceObject $viutAfterFuncs |",
    "    Where-Object { $_.SideIndicator -eq '=>' } | Select-Object -ExpandProperty InputObject |",
    "    Where-Object { $_ -notlike 'viut*' })",
    "  lastExit = $LASTEXITCODE",
    "}",
    `$viutReport | ConvertTo-Json -Compress | Set-Content -LiteralPath ${psQuote(reportPath)} -Encoding UTF8`,
  ].join("\r\n");
  const commandPath = join(tempDir("sesion iex"), "sesion.ps1");
  writeFileSync(commandPath, command, "utf8");
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", commandPath],
    { timeoutMs: 240_000, env: bootstrapEnv(layout, extra) },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (!existsSync(reportPath)) {
    return {
      result: { ...result, output },
      report: { newVars: [], newFuncs: [], lastExit: null, missing: true },
    };
  }
  const parsed = JSON.parse(readFileSync(reportPath, "utf8").replace(/^\uFEFF/, "")) as {
    newVars: string[] | null;
    newFuncs: string[] | null;
    lastExit: number | null;
  };
  return {
    result: { ...result, output },
    report: {
      newVars: parsed.newVars ?? [],
      newFuncs: parsed.newFuncs ?? [],
      lastExit: parsed.lastExit,
      missing: false,
    },
  };
}

/** Lee el acceso directo `.lnk` con `WScript.Shell` (sin abrir nada). */
async function readShortcut(linkPath: string): Promise<{ target: string; arguments: string; workingDirectory: string } | null> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "if (-not (Test-Path -LiteralPath $env:VIU_LNK -PathType Leaf)) { exit 3 }",
    "$shell = New-Object -ComObject WScript.Shell",
    "$s = $shell.CreateShortcut($env:VIU_LNK)",
    "$o = [ordered]@{ target = $s.TargetPath; arguments = $s.Arguments; workingDirectory = $s.WorkingDirectory }",
    "$o | ConvertTo-Json -Compress",
    "exit 0",
  ].join("\r\n");
  const scriptPath = join(tempDir("leer acceso directo"), "leer.ps1");
  writeFileSync(scriptPath, script, "utf8");
  const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    timeoutMs: 60_000,
    env: { VIU_LNK: linkPath },
  });
  if (result.code !== 0) return null;
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  return JSON.parse(line) as { target: string; arguments: string; workingDirectory: string };
}

/** Literal de cadena para PowerShell (comillas dobles escapadas). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Contenido de un archivo como texto sin BOM ni salto de línea final. */
function readText(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n$/, "");
}

beforeEach(prepareCase);

afterAll(async () => {
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((resolveClose) => closing.close(() => resolveClose()));
  }
  for (const dir of created.splice(0)) {
    // El bootstrap lanza `powershell.exe` hijos: Windows puede negar el borrado
    // un instante después. Se reintenta sin silenciar el error final.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});

// `skipIf` se evalúa al ejecutar (no al colectar), así el archivo aparece
// omitido en el informe cuando no es Windows x64, y no cuenta como fallo.
describe.skipIf(!CAN_RUN_DIST)("bootstrap de instalacion (scripts/dist/install.ps1)", () => {
  it("instala en una carpeta nueva y crea el acceso directo sin -AutoStart", async () => {
    const layout = makeLayout("limpia");
    const result = await runBootstrap(layout);

    expect(result.code, result.output).toBe(0);

    // Contenido del paquete, sin la carpeta raíz del ZIP.
    expect(existsSync(join(layout.installDir, "VIUrewards.cmd"))).toBe(true);
    expect(existsSync(join(layout.installDir, "app", "scripts", "dist", "install-tools.ps1"))).toBe(true);
    expect(existsSync(join(layout.installDir, "app", "scripts", "dist", "launcher-gui.ps1"))).toBe(true);
    expect(existsSync(join(layout.installDir, ROOT_DIR))).toBe(false);

    // El instalador de herramientas recibió el -DataDir resuelto.
    expect(readText(layout.toolsMarker)).toBe(`dataDir=${layout.dataDir}`);
    // El bootstrap nunca crea el directorio de datos.
    expect(existsSync(layout.dataDir)).toBe(false);

    const shortcut = await readShortcut(join(layout.startMenuDir, "VIUrewards.lnk"));
    expect(shortcut, "no se pudo leer el acceso directo").not.toBeNull();
    expect(shortcut?.target.toLowerCase().endsWith("powershell.exe")).toBe(true);
    expect(shortcut?.arguments).not.toContain("-AutoStart");
    expect(shortcut?.arguments).toContain(join(layout.installDir, "app", "scripts", "dist", "launcher-gui.ps1"));
    expect(shortcut?.workingDirectory).toBe(layout.installDir);

    // Sin staging ni `.old` residuales al lado de la app.
    expect(readdirSync(dirname(layout.installDir))).toEqual(["VIUrewards"]);
  });

  it("reemplaza una instalacion previa y no toca el directorio de datos", async () => {
    const layout = makeLayout("reinstalacion");

    // Instalación previa con un archivo que la nueva NO tiene.
    mkdirSync(join(layout.installDir, "app"), { recursive: true });
    writeFileSync(join(layout.installDir, "viejo.txt"), "quedo de la version anterior", "utf8");
    // Datos de prueba con contenido propio.
    mkdirSync(layout.dataDir, { recursive: true });
    const dbPath = join(layout.dataDir, "app.db");
    writeFileSync(dbPath, "datos-de-prueba", "utf8");
    const beforeSize = statSync(dbPath).size;
    const beforeText = readText(dbPath);

    const result = await runBootstrap(layout);
    expect(result.code, result.output).toBe(0);

    expect(existsSync(join(layout.installDir, "viejo.txt"))).toBe(false);
    expect(existsSync(join(layout.installDir, "VIUrewards.cmd"))).toBe(true);
    expect(existsSync(`${layout.installDir}.old`)).toBe(false);

    expect(statSync(dbPath).size).toBe(beforeSize);
    expect(readText(dbPath)).toBe(beforeText);
  });

  it("aborta si el SHA-256 no coincide, sin instalar ni dejar restos", async () => {
    const layout = makeLayout("hash");
    mkdirSync(layout.installDir, { recursive: true });
    writeFileSync(join(layout.installDir, "previo.txt"), "intacto", "utf8");

    const result = await runBootstrap(layout, { VIUREWARDS_INSTALL_SHA256: "a".repeat(64) });

    expect(result.code).not.toBe(0);
    expect(result.output.toLowerCase()).toContain("sha-256");
    expect(readText(join(layout.installDir, "previo.txt"))).toBe("intacto");
    expect(readdirSync(layout.installDir)).toEqual(["previo.txt"]);
    // Sin staging al lado de la app.
    expect(readdirSync(dirname(layout.installDir))).toEqual(["VIUrewards"]);
    // Ni siquiera llegó a llamar al instalador de herramientas.
    expect(existsSync(layout.toolsMarker)).toBe(false);
  });

  it("rechaza un ZIP con una entrada que escapa de la carpeta destino", async () => {
    const layout = makeLayout("traversal");
    payload = packageZip([{ name: `${ROOT_DIR}/../../fuera.txt`, data: Buffer.from("no", "utf8") }]);

    const result = await runBootstrap(layout);

    expect(result.code).not.toBe(0);
    expect(existsSync(join(layout.root, "fuera.txt"))).toBe(false);
    expect(existsSync(join(dirname(dirname(layout.installDir)), "fuera.txt"))).toBe(false);
    expect(existsSync(layout.installDir)).toBe(false);
    // No quedó nada en la carpeta hermana del staging ni en el padre de la app.
    const appParent = dirname(layout.installDir);
    expect(existsSync(appParent) && readdirSync(appParent).length > 0).toBe(false);
  });

  it("aborta si hay una instancia en ejecucion, sin tocar nada", async () => {
    const layout = makeLayout("enuso");
    mkdirSync(layout.dataDir, { recursive: true });
    // Cerrojo con el PID de este mismo proceso de test: está vivo.
    writeFileSync(
      join(layout.dataDir, ".viurewards.lock"),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
      "utf8",
    );

    const result = await runBootstrap(layout);

    expect(result.code, result.output).toBe(3);
    expect(existsSync(layout.installDir)).toBe(false);
    expect(readdirSync(layout.dataDir)).toEqual([".viurewards.lock"]);
    expect(existsSync(layout.toolsMarker)).toBe(false);
    expect(existsSync(layout.startMenuDir)).toBe(false);
  });

  it("por iex no cierra el host, ni al terminar bien ni al fallar", async () => {
    const okLayout = makeLayout("iex ok");
    const okResult = await runBootstrapIex(okLayout);
    expect(okResult.code, okResult.output).toBe(0);
    expect(existsSync(join(okLayout.root, "siguio-vivo.txt"))).toBe(true);
    expect(existsSync(join(okLayout.installDir, "VIUrewards.cmd"))).toBe(true);

    const failLayout = makeLayout("iex fallo");
    const failResult = await runBootstrapIex(failLayout, { VIUREWARDS_INSTALL_SHA256: "b".repeat(64) });
    expect(failResult.code, failResult.output).toBe(0);
    expect(existsSync(join(failLayout.root, "siguio-vivo.txt"))).toBe(true);
    expect(existsSync(failLayout.installDir)).toBe(false);
  });

  it("los marcadores sin reemplazar y sin overrides abortan con un mensaje claro", async () => {
    const layout = makeLayout("marcadores");
    const result = await run(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BOOTSTRAP],
      {
        timeoutMs: 120_000,
        env: {
          VIUREWARDS_INSTALL_VERSION: "",
          VIUREWARDS_INSTALL_SHA256: "",
          VIUREWARDS_INSTALL_BASE_URL: "",
          VIUREWARDS_INSTALL_DIR: layout.installDir,
          VIUREWARDS_INSTALL_START_MENU_DIR: layout.startMenuDir,
          VIUREWARDS_INSTALL_DATA_DIR: layout.dataDir,
          VIUREWARDS_INSTALL_NO_LAUNCH: "1",
          VIUREWARDS_DATA_DIR: "",
        },
      },
    );

    expect(result.code).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toContain("no corresponde a un release");
    expect(existsSync(layout.installDir)).toBe(false);
  });

  it("si el instalador de herramientas falla, avisa y deja la app instalada", async () => {
    const layout = makeLayout("herramientas");
    const result = await runBootstrap(layout, { VIU_TEST_TOOLS_CODE: "1" });

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("codigo 1");
    expect(existsSync(join(layout.installDir, "VIUrewards.cmd"))).toBe(true);
    expect(existsSync(join(layout.startMenuDir, "VIUrewards.lnk"))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Abortos por `iex`: el host sigue vivo Y el flujo principal se detuvo
  // ---------------------------------------------------------------------------

  /**
   * T1: en cada camino de aborto, por `iex`, el host llega a la línea posterior
   * y NO hay ningún efecto del paso siguiente (ni instalación, ni acceso
   * directo, ni marcador del instalador de herramientas).
   */
  it("por iex cada aborto corta el flujo: el host sigue vivo y no hay efectos", async () => {
    interface AbortCase {
      label: string;
      extra: Record<string, string>;
      code: number;
      /** Arma el caso antes de correrlo (instalación previa, payload, etc.). */
      setup?: (layout: Layout) => void;
      /** Texto que tiene que aparecer en la salida. */
      expectText: string;
    }

    const cases: AbortCase[] = [
      {
        label: "hash",
        extra: { VIUREWARDS_INSTALL_SHA256: "a".repeat(64) },
        code: 1,
        expectText: "sha-256",
      },
      {
        label: "traversal",
        extra: {},
        code: 1,
        expectText: "no es segura",
        setup: () => {
          payload = packageZip([
            { name: `${ROOT_DIR}/../../fuera.txt`, data: Buffer.from("no", "utf8") },
          ]);
        },
      },
      {
        label: "enuso",
        extra: {},
        code: 3,
        expectText: "en ejecucion",
        setup: (layout) => {
          mkdirSync(layout.dataDir, { recursive: true });
          writeFileSync(
            join(layout.dataDir, ".viurewards.lock"),
            JSON.stringify({ pid: process.pid, at: Date.now() }),
            "utf8",
          );
        },
      },
      {
        label: "marcadores",
        extra: {
          VIUREWARDS_INSTALL_VERSION: "",
          VIUREWARDS_INSTALL_SHA256: "",
        },
        code: 2,
        expectText: "no corresponde a un release",
      },
    ];

    for (const abortCase of cases) {
      const layout = makeLayout(`iex aborto ${abortCase.label}`);
      abortCase.setup?.(layout);
      const result = await runBootstrapIex(layout, abortCase.extra);
      const where = `${abortCase.label}: ${result.output}`;

      // El host NO se cerró.
      expect(result.code, where).toBe(0);
      expect(existsSync(join(layout.root, "siguio-vivo.txt")), where).toBe(true);
      // Y se informó el motivo del aborto.
      expect(result.output.toLowerCase(), where).toContain(abortCase.expectText);

      // Nada del paso siguiente: ni app, ni acceso directo, ni herramientas.
      expect(existsSync(layout.installDir), where).toBe(false);
      expect(existsSync(`${layout.installDir}.old`), where).toBe(false);
      expect(existsSync(join(layout.startMenuDir, "VIUrewards.lnk")), where).toBe(false);
      expect(existsSync(layout.toolsMarker), where).toBe(false);
      // Sin staging residual al lado de la app.
      const appParent = dirname(layout.installDir);
      const leftovers = existsSync(appParent) ? readdirSync(appParent) : [];
      expect(leftovers, where).toEqual([]);
    }
  });

  /**
   * T1 (reinstalación): un aborto por `iex` sobre una instalación previa la deja
   * con el mismo contenido, sin `.old` ni staging al lado.
   */
  it("por iex un aborto no toca una instalacion previa", async () => {
    const layout = makeLayout("iex aborto previa");
    mkdirSync(join(layout.installDir, "app"), { recursive: true });
    writeFileSync(join(layout.installDir, "previo.txt"), "intacto", "utf8");

    const result = await runBootstrapIex(layout, { VIUREWARDS_INSTALL_SHA256: "c".repeat(64) });

    expect(result.code, result.output).toBe(0);
    expect(existsSync(join(layout.root, "siguio-vivo.txt")), result.output).toBe(true);
    expect(readText(join(layout.installDir, "previo.txt"))).toBe("intacto");
    expect(readdirSync(layout.installDir)).toEqual(["app", "previo.txt"]);
    expect(existsSync(`${layout.installDir}.old`)).toBe(false);
    expect(readdirSync(dirname(layout.installDir))).toEqual(["VIUrewards"]);
    expect(existsSync(layout.toolsMarker)).toBe(false);
  });

  /**
   * T2: por `iex`, la sesión del host queda limpia. Única excepción permitida:
   * `LASTEXITCODE`, que es como el script deja el código de salida cuando corre
   * por `iex` (lo documenta su cabecera, líneas 50-57) y que PowerShell ya usa
   * para el código del último proceso externo.
   */
  it("por iex no deja variables ni funciones en la sesion del host", async () => {
    const okLayout = makeLayout("sesion iex ok");
    const ok = await runBootstrapIexSession(okLayout);
    expect(ok.result.code, ok.result.output).toBe(0);
    expect(ok.report.missing, ok.result.output).toBe(false);
    expect(ok.report.newFuncs, ok.result.output).toEqual([]);
    expect(ok.report.newVars.filter((name) => name !== "LASTEXITCODE"), ok.result.output).toEqual([]);
    expect(ok.report.lastExit, ok.result.output).toBe(0);

    const failLayout = makeLayout("sesion iex aborto");
    const fail = await runBootstrapIexSession(failLayout, {
      VIUREWARDS_INSTALL_SHA256: "d".repeat(64),
    });
    expect(fail.result.code, fail.result.output).toBe(0);
    expect(fail.report.missing, fail.result.output).toBe(false);
    expect(fail.report.newFuncs, fail.result.output).toEqual([]);
    expect(fail.report.newVars.filter((name) => name !== "LASTEXITCODE"), fail.result.output).toEqual([]);
    expect(fail.report.lastExit, fail.result.output).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // PUNTO 1: el mensaje del SHA-256 incorrecto, con saltos de linea de verdad
  // ---------------------------------------------------------------------------

  it("el aviso de SHA-256 incorrecto no muestra secuencias de escape literales", async () => {
    const layout = makeLayout("hash legible");
    const result = await runBootstrap(layout, { VIUREWARDS_INSTALL_SHA256: "a".repeat(64) });

    expect(result.code, result.output).toBe(1);
    const outputLines = result.output.split(/\r?\n/);
    expect(outputLines.filter((line) => line.trimStart().startsWith("esperado:")).length, result.output).toBe(1);
    expect(outputLines.filter((line) => line.trimStart().startsWith("obtenido:")).length, result.output).toBe(1);
    // Ni la secuencia de escape literal ni su caracter de escape.
    expect(result.output).not.toContain("x60");
    expect(result.output).not.toContain("`");
  });

  // ---------------------------------------------------------------------------
  // PUNTO 2: la salida del instalador de herramientas llega al usuario
  // ---------------------------------------------------------------------------

  it("la salida del instalador de herramientas llega al usuario", async () => {
    const layout = makeLayout("salida herramientas");
    const guid = randomUUID();
    const result = await runBootstrap(layout, { VIU_TEST_TOOLS_GUID: guid });

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("FAKE-TOOLS-OUTPUT-" + guid);
  });

  // ---------------------------------------------------------------------------
  // PUNTO 3: un launcher en ejecucion se detecta aunque powershell.exe no viva
  // dentro de la carpeta de la app
  // ---------------------------------------------------------------------------

  it("aborta si hay un launcher en ejecucion desde la carpeta de la app", async () => {
    try {
      const layout = makeLayout("launcher en ejecucion");
      // Instalacion previa con el launcher FALSO, que se queda dormido.
      const launcherDir = join(layout.installDir, "app", "scripts", "dist");
      mkdirSync(launcherDir, { recursive: true });
      writeFileSync(join(launcherDir, "launcher-gui.ps1"), FAKE_LAUNCHER, "utf8");
      writeFileSync(join(layout.installDir, "previo.txt"), "intacto", "utf8");

      const launcherPid = spawnChild(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          join(launcherDir, "launcher-gui.ps1"),
        ],
        // El launcher falso lee estas dos variables: sin pasarlas, arranca, no
        // deja el marcador y hace exit 0 en el acto (medido: proceso vivo=false).
        { VIU_TEST_LAUNCH_MARKER: layout.launchMarker, VIU_TEST_LAUNCHER_SLEEP: "1" },
      );
      expect(launcherPid).toBeGreaterThan(0);
      // VIU_TEST_LAUNCHER_SLEEP hace que el launcher falso duerma: sin ella el
      // script hace exit 0 en el acto y no queda nada que detectar (medido: el
      // proceso ya no estaba a los 1.5 s). No es la variable de "no lanzar"
      // (VIUREWARDS_INSTALL_NO_LAUNCH), es la del script falso.
      // El marcador es la prueba de que el script ARRANCO de verdad: un
      // powershell.exe que sale en el acto dejaria el caso sin nada que detectar.
      const launchDeadline = Date.now() + 20_000;
      while (!existsSync(layout.launchMarker) && Date.now() < launchDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      expect(existsSync(layout.launchMarker), "el launcher falso no llego a arrancar").toBe(true);
      const sleepDeadline = Date.now() + 20_000;
      while (isAlive(launcherPid) && Date.now() < sleepDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }

      const result = await runBootstrap(layout, { VIU_TEST_LAUNCHER_SLEEP: "1" });

      expect(result.code, result.output).toBe(3);
      expect(result.output).toContain("en ejecucion");
      expect(readText(join(layout.installDir, "previo.txt"))).toBe("intacto");
      expect(existsSync(layout.toolsMarker)).toBe(false);
      expect(existsSync(layout.startMenuDir)).toBe(false);
      expect(existsSync(`${layout.installDir}.old`)).toBe(false);
    } finally {
      killSpawned();
    }
  });

  // ---------------------------------------------------------------------------
  // PUNTO 4: una carpeta `.old` que no se puede borrar aborta ANTES de mover nada
  // ---------------------------------------------------------------------------

  it("aborta si no se puede borrar la carpeta .old previa, antes de mover nada", async () => {
    try {
      const layout = makeLayout("carpeta old");
      mkdirSync(layout.installDir, { recursive: true });
      writeFileSync(join(layout.installDir, "previo.txt"), "intacto", "utf8");
      const oldDir = `${layout.installDir}.old`;
      mkdirSync(oldDir, { recursive: true });
      const oldFile = join(oldDir, "resto.txt");
      writeFileSync(oldFile, "resto de una instalacion anterior", "utf8");

      // Un proceso se queda con el archivo abierto sin compartir: el borrado falla.
      const waitHandlePath = spawnKeeper(oldFile, layout.root);
      const deadline = Date.now() + 20_000;
      while (!existsSync(waitHandlePath) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      expect(existsSync(waitHandlePath), "el proceso que retiene el archivo no arranco").toBe(true);

      const result = await runBootstrap(layout);

      // Codigo 1 y un mensaje claro; NADA se movio.
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(".old");
      expect(readdirSync(layout.installDir)).toEqual(["previo.txt"]);
      expect(existsSync(join(layout.installDir, "VIUrewards.cmd"))).toBe(false);
      expect(existsSync(oldFile)).toBe(true);
      expect(existsSync(layout.toolsMarker)).toBe(false);
      expect(existsSync(layout.startMenuDir)).toBe(false);
    } finally {
      killSpawned();
    }
  });

});
