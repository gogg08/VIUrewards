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
import { createHash } from "node:crypto";
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
  "$marker = $env:VIU_TEST_TOOLS_MARKER",
  "$line = 'dataDir=' + $DataDir",
  "Set-Content -LiteralPath $marker -Value $line -Encoding UTF8",
  "$code = 0",
  "if ($env:VIU_TEST_TOOLS_CODE) { $code = [int]$env:VIU_TEST_TOOLS_CODE }",
  "exit $code",
  "",
].join("\r\n");

/** Launcher FALSO: deja constancia si se abre (solo si el caso lo permite). */
const FAKE_LAUNCHER = [
  "$ErrorActionPreference = 'Stop'",
  "if ($env:VIU_TEST_LAUNCH_MARKER) {",
  "  Set-Content -LiteralPath $env:VIU_TEST_LAUNCH_MARKER -Value 'launched' -Encoding UTF8",
  "}",
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
});
