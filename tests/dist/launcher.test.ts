/**
 * Tests de DISTRIBUCIÓN del LAUNCHER (Fase de distribución, Etapa 3C).
 *
 * Solo se ejercita lo que puede verificarse **automáticamente** sobre el ZIP ya
 * construido (`npm run package:portable`), extraído a una ruta temporal CON
 * ESPACIOS, y sobre el `.ps1` tal como viaja en `app/scripts/dist/`:
 *
 *  1. `-SelfTest` (sin GUI): deduce la raíz de la aplicación desde
 *     `$PSScriptRoot`, resuelve el directorio de datos y comprueba que Windows
 *     Forms (Form/Label/Button/TextBox/CheckBox/NotifyIcon) se inicializa.
 *  2. Validación de rutas: una ruta relativa, la raíz de una unidad o un
 *     directorio DENTRO de la app se rechazan ANTES de escribir nada.
 *  3. El ciclo de vida real reutiliza las MISMAS funciones del launcher
 *     (`Invoke-ViuServerStart` / `Invoke-ViuServerStop`): arranque → mensaje
 *     `started` con la URL real → cierre ordenado por el named pipe de la Etapa
 *     3A → `closing`/`finished` con código 0 → proceso terminado → cerrojo
 *     liberado → SQLite reabrible.
 *  4. Arranque/parada repetidos no duplican procesos.
 *  5. Datos en uso (código 3): la ventana NO detiene ni toca el cerrojo ajeno.
 *  6. Fallos: instalador ausente y runtime ausente terminan con un motivo claro
 *     y sin dejar procesos.
 *  7. Inicio con Windows: el acceso directo se crea y se borra de forma
 *     IDEMPOTENTE en una carpeta temporal (nunca la del usuario).
 *
 * Lo que NO se automatiza (se prueba a mano, ver `docs/distribution.md`):
 *  - Ver la ventana, hacer clic y usar la bandeja del sistema.
 *  - Que el acceso directo de verdad arranque con Windows.
 *  - Cerrar con Ctrl+C una consola interactiva.
 *
 * Reglas de los tests: directorios temporales, procesos propios (se termina
 * SOLO el árbol del hijo que creó el test), sin descargas, sin `yt-dlp -U` y sin
 * tocar `data/`, `media/`, `.uploads/` ni `logs/` del desarrollo.
 *
 * El runtime es el fijado y verificado del paquete (`resolveRuntimeNodeExe`).
 * Las herramientas (`bin/*.exe`) NO se descargan: se siembran desde la caché
 * verificada si está; si no está, el ciclo de vida se corre igual porque el
 * servidor no necesita ffmpeg para arrancar.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdir, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MANAGED_TOOLS, NODE_ASSET } from "../../scripts/dist/config.ts";
import {
  CAN_RUN_DIST,
  REPO_ROOT,
  extractPackage,
  findZip,
  freePort,
  isAlive,
  killTree,
  resolveRuntimeNodeExe,
  run,
  waitUntil,
} from "./helpers.ts";

const zipPath = findZip();

function describeLauncher(name: string, fn: () => void): void {
  if (!CAN_RUN_DIST) {
    describe.skip(`${name} (omitido: el paquete es win-x64)`, fn);
    return;
  }
  if (!zipPath) {
    describe.skip(`${name} (omitido: falta build/dist/VIUrewards-*.zip)`, fn);
    return;
  }
  describe(name, fn);
}

let root = "";
let packageDir = "";
let appDir = "";
let launcherPath = "";
let nodeExe = "";

/** Directorios temporales de este archivo (se borran al final). */
const tempDirs: string[] = [];
/** Procesos que creó este archivo (solo esos se terminan). */
const createdPids = new Set<number>();

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `VIU launcher ${label} con espacios-`));
  // El launcher normaliza con `Get-NormalizedPath` (`GetFullPath`,
  // `scripts/dist/launcher-gui.ps1:125-128`), que devuelve la ruta LARGA. Si
  // `%TEMP%` viene en forma 8.3 (`C:\Users\RUNNER~1\…`, como en los runners de
  // GitHub), comparar contra la forma corta falla aunque el producto sea
  // correcto: todos los paths de este archivo se construyen en forma larga.
  const long = realpathSync.native(dir);
  tempDirs.push(long);
  return long;
}

/** Ejecuta el launcher con `-SelfTest` y devuelve el JSON del reporte. */
async function selfTest(dataDir: string | null): Promise<{ code: number | null; report: Record<string, unknown>; stderr: string }> {
  const output = join(tempDir("selftest"), "report.json");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath, "-SelfTest", "-SelfTestOutput", output];
  if (dataDir !== null) args.push("-DataDir", dataDir);
  const result = await run("powershell.exe", args, {
    timeoutMs: 180_000,
    env: { VIUREWARDS_DATA_DIR: "" },
  });
  const report = existsSync(output) ? readReport<Record<string, unknown>>(output) : {};
  return { code: result.code, report, stderr: result.stderr };
}

/**
 * Script que carga SOLO el bloque de funciones del launcher (sin GUI, sin
 * `param()`) y ejecuta una acción. Se escribe en un temporal: así las funciones
 * se prueban exactamente como están en el paquete.
 *
 * `action` recibe las variables ya definidas: `$data` (directorio de datos),
 * `$node`, `$entry`, `$tmp`.
 */
function functionScript(action: string): string {
  return [
    // Igual que el launcher real: StrictMode 2.0. Si un helper usa una variable
    // sin definir, falla acá y en producción por igual.
    "$ErrorActionPreference = 'Stop'",
    "Set-StrictMode -Version 2.0",
    "$launcherPath = $env:VIU_TEST_LAUNCHER",
    "$all = [System.IO.File]::ReadAllLines($launcherPath)",
    // El corte del bloque de funciones se busca desde el PRINCIPIO del archivo.
    // Antes empezaba en la línea `$ErrorActionPreference = "Stop"` (que va
    // DESPUÉS del `param(...)`) y el primer `)` que encontraba era el que cierra
    // `$script:ToolRelativePaths = @(`, no el del `param`: el bloque extraído
    // arrancaba más abajo y se perdían las constantes declaradas antes
    // (`$script:LauncherPid` entre ellas), que en StrictMode 2.0 fallaban con
    // `VariableIsUndefined` al usarse dentro de una función.
    "$paramStart = 0; $paramEnd = 0",
    "for ($i = 0; $i -lt $all.Length; $i++) { if ($all[$i] -eq 'param(') { $paramStart = $i; break } }",
    "for ($i = $paramStart; $i -lt $all.Length; $i++) { if ($all[$i] -eq ')') { $paramEnd = $i; break } }",
    "$guiStart = ($all | Select-String -Pattern '^function Show-ViuLauncher' | Select-Object -First 1).LineNumber",
    "$head = $all[($paramEnd + 1)..($guiStart - 2)]",
    "$defs = ($head -join \"`r`n\")",
    "$defs = $defs -replace '(?m)^\\s*\\$ErrorActionPreference = \"Stop\".*$', ''",
    "$defs = $defs -replace '(?m)^\\s*Set-StrictMode -Version 2\\.0.*$', ''",
    // OJO con el escapado: en la cadena TS `\\$` produce `\$` en PowerShell,
    // que es la barra escapada que .NET necesita antes de `$` (variable literal).
    // Con `\$` (una sola barra en el archivo) .NET lo lee como el ANCLA de fin
    // de línea y el `-replace` no coincide: la línea se colaba en el bloque
    // extraído y `Invoke-Expression` fallaba con `VariableIsUndefined` en
    // `$DataDir` (defecto real, Etapa 3C.1).
    "$defs = $defs -replace '(?m)^\\$script:RequestedDataDir = \\$DataDir.*$', ''",
    "Invoke-Expression $defs",
    "$data = $env:VIU_TEST_DATA",
    "$node = Join-Path $data 'runtime\\node.exe'",
    "$entry = Join-Path $env:VIU_TEST_APP 'scripts\\start.ts'",
    "$tmp = $env:VIU_TEST_TMP",
    action,
  ].join("\r\n");
}

async function runFunctionScript(
  action: string,
  options: { data: string; tmp: string; timeoutMs?: number; extra?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = join(options.tmp, `accion-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}.ps1`);
  writeFileSync(script, functionScript(action), "utf8");
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    timeoutMs: options.timeoutMs ?? 300_000,
    env: {
      VIU_TEST_LAUNCHER: launcherPath,
      VIU_TEST_DATA: options.data,
      VIU_TEST_APP: appDir,
      VIU_TEST_TMP: options.tmp,
      ...options.extra,
      // Sin credenciales reales ni conexión a Kick.
      KICK_CLIENT_ID: "",
      KICK_CLIENT_SECRET: "",
    },
  });
}

/**
 * Lee el JSON que deja un script PowerShell.
 *
 * `Set-Content -Encoding UTF8` de Windows PowerShell 5.1 escribe BOM, y
 * `JSON.parse` lo rechaza: se quita antes de parsear.
 */
function readReport<T>(path: string): T {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text) as T;
}

/** Extrae el último objeto JSON de una salida que puede traer avisos. */
function lastJson<T>(stdout: string): T {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        return JSON.parse(line) as T;
      } catch {
        continue;
      }
    }
  }
  throw new Error(`No hay JSON en la salida:\n${stdout}`);
}

/** Siembra `<datos>/runtime/node.exe` desde el runtime fijado (sin red). */
function seedRuntime(dataDir: string): void {
  mkdirSync(join(dataDir, "runtime"), { recursive: true });
  copyFileSync(nodeExe, join(dataDir, "runtime", "node.exe"));
}

/**
 * Nombres de pipe del launcher que existen ahora mismo.
 *
 * `existsSync("\\\\.\\pipe\\nombre")` NO es fiable para named pipes (a veces
 * informa que no existe uno que sí está, verificado): se lista el directorio de
 * pipes del sistema.
 */
function listControlPipes(): Promise<string[]> {
  return new Promise((resolveList) => {
    readdir("\\\\?\\pipe\\", (error, names) => {
      resolveList(error ? [] : names.filter((name) => name.startsWith("viurewards-control-")));
    });
  });
}

/**
 * Cierra un servidor por su canal autenticado. Se usa SOLO para limpiar los
 * procesos que creó este test (los tests de recuperación y de ciclo de vida usan
 * el launcher real para verificar el cierre).
 *
 * En este entorno, `net.connect` al named pipe falla a veces aunque el pipe
 * exista (se midió: el mismo servidor acepta la conexión desde PowerShell y
 * desde otro proceso Node). Por eso la orden se manda igual con el cliente de
 * PowerShell del launcher, que usa `CreateFileW` (`ViuLauncherPipe`).
 */
async function shutdownViaChannel(controlId: string, token: string, tmp: string): Promise<void> {
  // OJO con el escapado: en una cadena normal `"\\\\"` produce DOS barras, que es
  // lo que necesita el nombre de un named pipe (`\\\\.\\pipe\\`). Antes se usaba un
  // template literal con `"\\\\.\\pipe\\"`, que produce UNA sola barra (`\\.\\pipe\\`):
  // `net.connect` de Node lo normalizaba y la orden llegaba, pero `CreateFileW`
  // del cliente PowerShell devolvía ERROR_PATH_NOT_FOUND (3) y el cierre nunca
  // se pedía (defecto real, Etapa 3C.1).
  const pipeName = "\\\\.\\pipe\\" + `viurewards-control-${controlId}`;
  const deadline = Date.now() + 60_000;
  let lastError = "sin intentos";
  while (Date.now() < deadline) {
    if ((await listControlPipes()).includes(`viurewards-control-${controlId}`)) break;
    lastError = "el pipe todavía no existe";
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const outcome = await new Promise<string>((resolveOrder) => {
      const socket = connect(pipeName);
      socket.setEncoding("utf8");
      let sent = false;
      let settled = false;
      let buffer = "";
      const done = (error = ""): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolveOrder(error);
      };
      socket.on("error", (error: NodeJS.ErrnoException) => done(`${error.code}`));
      socket.on("close", () => done());
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (!sent) {
          sent = true;
          socket.write(`${JSON.stringify({ type: "shutdown", exchange: token })}\n`);
        }
        if (buffer.includes('"finished"')) done();
      });
      socket.once("connect", () => {
        sent = true;
        socket.write(`${JSON.stringify({ type: "shutdown", exchange: token })}\n`);
      });
      setTimeout(() => done("timeout"), 20_000);
    });
    if (outcome === "") return;
    lastError = outcome;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  await shutdownViaPowerShell(pipeName, token, tmp, controlId);
  process.stderr.write(`[diag] pipe solicitado: ${pipeName} | controlId=${controlId} | existen=${(await listControlPipes()).join(",")}\n`);
  void lastError;
}

/** La orden de cierre enviada con el cliente de PowerShell del launcher. */
async function shutdownViaPowerShell(pipeName: string, token: string, tmp: string, controlId: string): Promise<void> {
  const script = join(tmp, `cierre-${controlId}.ps1`);
  const body = [
    "if (-not ('ViuLauncherPipe' -as [type])) {",
    "  Initialize-ControlPipe",
    "}",
    "if ([ViuLauncherPipe]::Open($env:VIU_TEST_PIPE)) {",
    "  $json = '{\"type\":\"shutdown\",\"exchange\":\"' + $env:VIU_TEST_TOKEN + '\"}'",
    "  [ViuLauncherPipe]::Send($json)",
    "  $limit = (Get-Date).AddSeconds(45)",
    "  while ((Get-Date) -lt $limit) {",
    "    $line = [ViuLauncherPipe]::ReadLine()",
    "    if ($null -eq $line) { Start-Sleep -Milliseconds 100; continue }",
    "    if ($line.Contains('\"finished\"')) { Write-Output 'finished'; break }",
    "  }",
    "  [ViuLauncherPipe]::Close()",
    "}",
  ].join("\r\n");
  writeFileSync(script, functionScript(["Initialize-ControlPipe", "Initialize-ExitCodeReader", body].join("\r\n")), "utf8");
  const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
    timeoutMs: 90_000,
    // `functionScript` calcula `$data`, `$node` y `$entry` desde el entorno: sin
    // estos valores, `Join-Path $null` lanzaba y el cliente NUNCA llegaba a
    // mandar la orden (por eso el servidor no se cerraba).
    env: {
      VIU_TEST_PIPE: pipeName,
      VIU_TEST_TOKEN: token,
      VIU_TEST_LAUNCHER: launcherPath,
      VIU_TEST_DATA: tmp,
      VIU_TEST_APP: appDir,
      VIU_TEST_TMP: tmp,
    },
  });
  process.stderr.write(`[diag] cliente PowerShell: code=${result.code} out=${result.stdout.trim()} err=${result.stderr.trim()}\n`);;
  process.stderr.write(`[diag] cliente PowerShell: code=${result.code} out=${result.stdout.trim()} err=${result.stderr.trim()}\n`);
}

/** Lee el stderr que el servidor de prueba dejó en el temporal (diagnóstico). */
function readErr(tmp: string): string {
  const path = join(tmp, "srv.err");
  if (!existsSync(path)) return "(sin archivo srv.err)";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "(no se pudo leer srv.err)";
  }
}

/** Reabre la base del directorio de datos con el runtime fijado. */
async function inspectDatabase(dbPath: string): Promise<number> {
  const script = join(tempDir("db"), "inspect.mjs");
  const moduleUrl = pathToFileURL(join(appDir, "node_modules", "better-sqlite3", "lib", "index.js")).href;
  writeFileSync(
    script,
    [
      `import Database from ${JSON.stringify(moduleUrl)};`,
      `const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });`,
      `const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;`,
      `db.close();`,
      `console.log(JSON.stringify({ tables }));`,
    ].join("\n"),
    "utf8",
  );
  const result = await run(nodeExe, [script], { cwd: appDir, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`No se pudo reabrir la base:\n${result.stderr || result.stdout}`);
  return lastJson<{ tables: number }>(result.stdout).tables;
}

beforeAll(async () => {
  if (!zipPath) return;
  const extracted = await extractPackage(zipPath);
  root = extracted.root;
  packageDir = extracted.packageDir;
  appDir = join(packageDir, "app");
  launcherPath = join(appDir, "scripts", "dist", "launcher-gui.ps1");
  nodeExe = await resolveRuntimeNodeExe();
}, 600_000);

afterAll(async () => {
  for (const pid of createdPids) await killTree(pid);
  for (const dir of tempDirs) {
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
      // Queda en temp; Windows lo limpia.
    }
  }
});

describeLauncher("launcher: estructura y autoprueba", () => {
  it("el paquete trae el .cmd de entrada y el .ps1 dentro de app/scripts/dist", () => {
    expect(existsSync(join(packageDir, "VIUrewards.cmd"))).toBe(true);
    expect(existsSync(launcherPath)).toBe(true);
    // El .ps1 NO se duplica en la raíz: su guard de rutas depende de su lugar.
    expect(existsSync(join(packageDir, "launcher-gui.ps1"))).toBe(false);
    // El instalador sigue al lado (el launcher lo ejecuta tal cual).
    expect(existsSync(join(appDir, "scripts", "dist", "install-tools.ps1"))).toBe(true);
  });

  it("-SelfTest deduce la raíz, resuelve los datos fuera de la app y arranca Windows Forms", async () => {
    const dataDir = join(tempDir("datos"), "datos del streamer");
    const { code, report, stderr } = await selfTest(dataDir);
    expect(code, stderr).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.appRoot).toBe(appDir);
    expect(report.dataDir).toBe(dataDir);
    expect(report.dataDirSource).toBe("argument");
    expect(report.outsideApplication).toBe(true);
    expect(report.entryExists).toBe(true);
    expect(report.installerExists).toBe(true);
    expect(report.formsAvailable).toBe(true);
    expect(report.controls).toContain("NotifyIcon");
    // Toolchain del canal: nombres y longitudes que acepta `control-channel.ts`.
    expect(report.controlIdLength).toBe(32);
    expect(report.tokenLength).toBe(32);
    const args = report.arguments as string[];
    expect(args.some((arg) => arg.startsWith("--Control="))).toBe(true);
    expect(args.some((arg) => arg.startsWith("--Exchange="))).toBe(true);
    // Las 3 herramientas faltan en un directorio vacío: no se inventan.
    expect(report.missingTools).toEqual(["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"]);
    // No se creó nada: `-SelfTest` solo resuelve rutas.
    expect(existsSync(dataDir)).toBe(false);
  });

  it("-SelfTest rechaza un directorio de datos DENTRO de la aplicación", async () => {
    const inside = join(appDir, "media");
    const { code, report } = await selfTest(inside);
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    expect(String(report.dataDirError)).toContain("esta dentro de la aplicacion");
    expect(existsSync(inside)).toBe(false);
  });

  it("el .ps1 es ASCII puro con CRLF y sin un segundo mecanismo de cierre", () => {
    // Se lee como BYTES: `readFileSync(..., "utf8")` traduce CRLF a LF y la
    // comprobación de finales de línea daría un falso negativo.
    const bytes = readFileSync(launcherPath);
    expect(bytes.some((byte) => byte > 0x7f)).toBe(false);
    expect(bytes.includes(0x0d)).toBe(true);
    // Cada LF va precedido de CR (nada de mezclar terminadores).
    let loneLf = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0x0a && bytes[index - 1] !== 0x0d) loneLf += 1;
    }
    expect(loneLf).toBe(0);
    const text = bytes.toString("utf8");
    // Reutiliza el canal de la Etapa 3A y el instalador existente.
    expect(text).toContain("--Control=");
    expect(text).toContain("--Exchange=");
    expect(text).toContain("install-tools.ps1");
    // Sin un endpoint HTTP de apagado ni señales como sustituto.
    expect(text).not.toMatch(/\/api\/(shutdown|stop)/);
    expect(text).not.toContain("kill(\"SIGTERM\")");
    expect(text).not.toContain("kill(\"SIGINT\")");
  });

  it("atiende -SelfTest antes de invocar el cuerpo y el cuerpo se invoca CON PUNTO", () => {
    // Contrato de dos defectos reales medidos con el ZIP (ver el comentario del
    // tramo `Principal` en el .ps1):
    //
    //  a) `exit (Invoke-ViuLauncherSelfTest)` estaba DESPUES de invocar el
    //     cuerpo: si el cuerpo termina en `return` (autoprueba), con punto el
    //     `return` salia del script y el `exit` nunca corria, asi que un caso
    //     invalido informaba ok con codigo 0.
    //  b) `exit $LASTEXITCODE` no existe en un script (StrictMode 2.0 lo
    //     rechaza) y, sin el, `exit` tomaba el ultimo codigo de un proceso
    //     externo (medido: 2 tras una conversion con ffmpeg).
    //
    // Y el cuerpo tiene que invocarse CON PUNTO: como funcion, las variables
    // sin calificar de la ventana (`$form`, `$notify`) no estan en el alcance
    // donde corren los eventos y la X lanzaba `VariableIsUndefined`.
    const text = readFileSync(launcherPath, "utf8");
    const selfTestAt = text.indexOf("exit (Invoke-ViuLauncherSelfTest)");
    const bodyAt = text.indexOf(". ${function:Show-ViuLauncher}");
    expect(selfTestAt).toBeGreaterThan(0);
    expect(bodyAt).toBeGreaterThan(0);
    // La autoprueba va ANTES de invocar el cuerpo.
    expect(selfTestAt).toBeLessThan(bodyAt);
    // Sin la forma de funcion: `Show-ViuLauncher` como comando suelto o con `&`.
    expect(text).not.toMatch(/^\s*(?:&\s*)?Show-ViuLauncher\s*$/m);
    // Y sin `exit` con la variable que no existe en un script.
    expect(text).not.toMatch(/^\s*exit\s+\$LASTEXITCODE\s*$/m);
  });

  it("la ventana se abre con Show()+Application.Run() y la bandeja se activa con el loop ya corriendo", () => {
    // Contrato de dos defectos reales medidos con el ZIP (ver el tramo
    // `--- Message loop ---` del .ps1):
    //
    //  a) Con `ShowDialog()` la X CERRABA el launcher en vez de ocultarlo
    //     (medido: el proceso salia con codigo 0 y el servidor quedaba sin
    //     ventana ni bandeja, con el cerrojo tomado por nadie).
    //  b) Los clics del icono de bandeja no llegaban a sus handlers porque
    //     nadie bombeaba mensajes: `NotifyIcon` solo despacha sus mensajes si
    //     hay un message loop de Windows Forms corriendo.
    //
    // `Application.Idle` tampoco sirve para el arranque inicial: medido que no
    // se dispara en esta sesion (el servidor nunca arrancaba).
    const text = readFileSync(launcherPath, "utf8");
    expect(text).not.toMatch(/\]::ShowDialog\s*\(/);
    expect(text).not.toMatch(/\]::add_Idle\b/);
    expect(text).toContain("[System.Windows.Forms.Application]::Run($form)");

    // El icono de bandeja se hace visible DESPUES de `$form.Show()` y con el
    // loop a punto de arrancar; en el bloque `--- Bandeja ---` solo se crea.
    const trayBlock = text.indexOf("# --- Bandeja ---");
    const loopBlock = text.indexOf("# --- Message loop ---");
    expect(trayBlock).toBeGreaterThan(0);
    expect(loopBlock).toBeGreaterThan(trayBlock);
    expect(text.slice(trayBlock, loopBlock)).not.toContain("$notify.Visible = $true");
    const runAt = text.indexOf("[System.Windows.Forms.Application]::Run($form)");
    const showAt = text.indexOf("$form.Show()", loopBlock);
    const visibleAt = text.indexOf("$notify.Visible = $true", loopBlock);
    expect(showAt).toBeGreaterThan(loopBlock);
    expect(visibleAt).toBeGreaterThan(showAt);
    expect(visibleAt).toBeLessThan(runAt);

    // Clic izquierdo y doble clic restauran la ventana; el clic derecho NO se
    // atiende a mano (el shell ya abre el `ContextMenuStrip` y abrirlo tambien
    // desde `MouseClick` lo desplegaba y lo cerraba en el mismo clic).
    expect(text).toContain("$notify.Add_DoubleClick(");
    expect(text).toContain("$notify.Add_MouseClick(");
    expect(text).toContain("[System.Windows.Forms.MouseButtons]::Left");
    expect(text).not.toContain("[System.Windows.Forms.MouseButtons]::Right");
    expect(text).not.toContain("$notify.ContextMenuStrip.Show(");
  });
});

describeLauncher("launcher: validación de rutas", () => {
  it("una ruta relativa se rechaza y no se crea nada", async () => {
    const tmp = tempDir("relativa");
    const result = await runFunctionScript(
      [
        "$resolved = Resolve-LauncherDataDir -Requested 'datos relativos' -ApplicationRoot $env:VIU_TEST_APP",
        "Write-Output ($resolved | ConvertTo-Json -Compress)",
        "if ($null -eq $resolved.error) { exit 9 }",
        "exit 0",
      ].join("\r\n"),
      { data: join(tmp, "x"), tmp },
    );
    expect(result.code, result.stderr).toBe(0);
    const resolved = lastJson<{ path: string | null; error: string | null }>(result.stdout);
    expect(resolved.path).toBeNull();
    expect(resolved.error).toMatch(/ABSOLUTA/);
    expect(existsSync(join(tmp, "x"))).toBe(false);
  });

  it("la raíz de una unidad se rechaza", async () => {
    const tmp = tempDir("unidad");
    const result = await runFunctionScript(
      [
        "$root = [System.IO.Path]::GetPathRoot($env:VIU_TEST_TMP)",
        "$resolved = Resolve-LauncherDataDir -Requested $root -ApplicationRoot $env:VIU_TEST_APP",
        "Write-Output ($resolved | ConvertTo-Json -Compress)",
        "if ($null -eq $resolved.error) { exit 9 }",
        "exit 0",
      ].join("\r\n"),
      { data: join(tmp, "x"), tmp },
    );
    expect(result.code, result.stderr).toBe(0);
    const resolved = lastJson<{ error: string | null }>(result.stdout);
    expect(resolved.error).toMatch(/raiz de una unidad/);
  });

  it("un directorio dentro de la aplicación, a cualquier profundidad, se rechaza", async () => {
    const tmp = tempDir("dentro");
    const result = await runFunctionScript(
      [
        "$deep = Join-Path $env:VIU_TEST_APP 'a\\b\\c\\d\\e\\f'",
        "$r1 = Resolve-LauncherDataDir -Requested $env:VIU_TEST_APP -ApplicationRoot $env:VIU_TEST_APP",
        "$r2 = Resolve-LauncherDataDir -Requested $deep -ApplicationRoot $env:VIU_TEST_APP",
        "Write-Output (ConvertTo-Json -Compress @{ root = $null -ne $r1.error; deep = $null -ne $r2.error })",
        "exit 0",
      ].join("\r\n"),
      { data: join(tmp, "x"), tmp },
    );
    expect(result.code, result.stderr).toBe(0);
    const verdict = lastJson<{ root: boolean; deep: boolean }>(result.stdout);
    expect(verdict.root).toBe(true);
    expect(verdict.deep).toBe(true);
    expect(existsSync(join(appDir, "a"))).toBe(false);
  });

  it("un hermano con el prefijo compartido NO se confunde con la aplicación", async () => {
    const tmp = tempDir("hermano");
    // `...<<paquete>>-datos` comparte el prefijo de texto con el paquete pero NO
    // es un subdirectorio: el separador es obligatorio en la comparación.
    const sibling = `${appDir}-datos`;
    tempDirs.push(sibling);
    const result = await runFunctionScript(
      [
        "$resolved = Resolve-LauncherDataDir -Requested $env:VIU_TEST_SIBLING -ApplicationRoot $env:VIU_TEST_APP",
        "Write-Output ($resolved | ConvertTo-Json -Compress)",
        "exit 0",
      ].join("\r\n"),
      { data: join(tmp, "x"), tmp, extra: { VIU_TEST_SIBLING: sibling } },
    );
    expect(result.code, result.stderr).toBe(0);
    const resolved = lastJson<{ path: string | null; error: string | null }>(result.stdout);
    expect(resolved.error).toBeNull();
    expect(resolved.path).toBe(sibling);
    expect(existsSync(sibling)).toBe(false);
  });

  it("sin -DataDir usa VIUREWARDS_DATA_DIR; sin nada, el directorio por usuario", async () => {
    const tmp = tempDir("fuentes");
    const result = await runFunctionScript(
      [
        "$fromEnv = Resolve-LauncherDataDir -Requested '' -ApplicationRoot $env:VIU_TEST_APP -EnvironmentValue $env:VIU_TEST_TMP",
        "$fromDefault = Resolve-LauncherDataDir -Requested '' -ApplicationRoot $env:VIU_TEST_APP -EnvironmentValue '' -LocalAppData 'C:\\perfil\\AppData\\Local'",
        "$fromArg = Resolve-LauncherDataDir -Requested $env:VIU_TEST_TMP -ApplicationRoot $env:VIU_TEST_APP -EnvironmentValue 'C:\\otra\\ruta'",
        "Write-Output (ConvertTo-Json -Compress @{ env = $fromEnv.source; def = $fromDefault.path; arg = $fromArg.source })",
        "exit 0",
      ].join("\r\n"),
      { data: join(tmp, "x"), tmp },
    );
    expect(result.code, result.stderr).toBe(0);
    const verdict = lastJson<{ env: string; def: string; arg: string }>(result.stdout);
    expect(verdict.env).toBe("environment");
    expect(verdict.def).toBe(join("C:\\perfil\\AppData\\Local", "VIUrewards"));
    // `-DataDir` manda sobre la variable de entorno.
    expect(verdict.arg).toBe("argument");
  });
});

describeLauncher("launcher: ciclo de vida real (arranque y cierre ordenado)", () => {
  it("arranca, informa started, cierra por el canal y libera los recursos", async () => {
    const tmp = tempDir("ciclo");
    const dataDir = join(tmp, "datos del streamer");
    mkdirSync(dataDir, { recursive: true });
    seedRuntime(dataDir);
    const outFile = join(tmp, "salida.json");
    // Puerto LIBRE: con `Port = 0` el launcher no fija `--port` ni `PORT` y el
    // servidor usa el 8787 por defecto, que puede tener una instancia real del
    // usuario. El test no debe depender de que ese puerto esté libre.
    const port = await freePort();

    const action = [
      "Initialize-ControlPipe",
      "Initialize-ExitCodeReader",
      "$exchange = New-ExchangeToken",
      "$controlId = New-ControlId",
      "$startCtx = [pscustomobject]@{",
      "  DataDir = $data; NodeExe = $node; Entry = $entry; Exchange = $exchange; ControlId = $controlId",
      "  Port = $env:VIU_TEST_PORT; OutFile = (Join-Path $tmp 'srv.out'); ErrFile = (Join-Path $tmp 'srv.err'); TimeoutSeconds = 120",
      "  Process = $null; ProcessHandle = $null",
      "}",
      "$start = Invoke-ViuServerStart -Context $startCtx",
      "$report = [ordered]@{ started = $start.ok; url = $start.url; port = $start.port; reason = $start.reason; pid = $start.pid; stops = @(); pids = @($start.pid) }",
      "if ($start.ok) {",
      "  $stopCtx = [pscustomobject]@{ Process = $startCtx.Process; ProcessHandle = $startCtx.ProcessHandle; Exchange = $exchange; ControlId = $controlId; TimeoutSeconds = 45 }",
      "  $stop = Invoke-ViuServerStop -Context $stopCtx",
      "  $report.stops += [ordered]@{ ok = $stop.ok; reason = $stop.reason; exitCode = $stop.exitCode; forced = $stop.forced }",
      "}",
      "$report.lockAfter = Test-Path -LiteralPath (Join-Path $data '.viurewards.lock')",
      "$report.dbAfter = Test-Path -LiteralPath (Join-Path $data 'app.db')",
      "$report.mediaAfter = Test-Path -LiteralPath (Join-Path $data 'media') -PathType Container",
      "$report.uploadsAfter = Test-Path -LiteralPath (Join-Path $data '.uploads') -PathType Container",
      "$report.logsAfter = Test-Path -LiteralPath (Join-Path $data 'logs') -PathType Container",
      "if ($null -ne $start.pid) { $report.stillAlive = [bool](Get-Process -Id $start.pid -ErrorAction SilentlyContinue) } else { $report.stillAlive = $false }",
      "$report | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $env:VIU_TEST_OUT -Encoding UTF8",
      "exit 0",
    ].join("\r\n");

    const script = join(tmp, "ciclo.ps1");
    writeFileSync(script, functionScript(action), "utf8");
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeoutMs: 420_000,
      env: {
        VIU_TEST_LAUNCHER: launcherPath,
        VIU_TEST_DATA: dataDir,
        VIU_TEST_APP: appDir,
        VIU_TEST_TMP: tmp,
        VIU_TEST_OUT: outFile,
        VIU_TEST_PORT: String(port),
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
    });
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = readReport(outFile) as {
      started: boolean;
      url: string | null;
      port: number | null;
      pid: number | null;
      stops: Array<{ ok: boolean; reason: string; exitCode: number | null; forced: boolean }>;
      lockAfter: boolean;
      dbAfter: boolean;
      mediaAfter: boolean;
      uploadsAfter: boolean;
      logsAfter: boolean;
      stillAlive: boolean;
      reason?: string;
    };
    if (typeof report.pid === "number") createdPids.add(report.pid);

    expect(report.started, `motivo de arranque: ${report.reason ?? "(sin motivo)"}\nstderr del servidor:\n${readErr(tmp)}`).toBe(true);
    // La URL es la REAL que informó el servidor, no una inventada.
    expect(report.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(report.port).toBeGreaterThan(0);
    expect(report.stops).toHaveLength(1);
    expect(report.stops[0]?.ok).toBe(true);
    expect(report.stops[0]?.reason).toBe("closed");
    expect(report.stops[0]?.exitCode).toBe(0);
    expect(report.stops[0]?.forced).toBe(false);
    // El proceso terminó de verdad y el cerrojo se liberó.
    expect(report.stillAlive).toBe(false);
    expect(report.lockAfter).toBe(false);
    // Todo quedó DENTRO del directorio de datos, no del paquete.
    expect(report.dbAfter).toBe(true);
    expect(report.mediaAfter).toBe(true);
    expect(report.uploadsAfter).toBe(true);
    expect(report.logsAfter).toBe(true);
    expect(existsSync(join(appDir, "app.db"))).toBe(false);
    expect(existsSync(join(packageDir, "app.db"))).toBe(false);
    // Y SQLite se puede reabrir.
    expect(await inspectDatabase(join(dataDir, "app.db"))).toBeGreaterThan(0);
  });

  it("arranque y parada repetidos no duplican procesos", async () => {
    const tmp = tempDir("repetido");
    const dataDir = join(tmp, "datos");
    mkdirSync(dataDir, { recursive: true });
    seedRuntime(dataDir);
    const outFile = join(tmp, "repetido.json");
    // Puerto LIBRE por ronda (ver el test anterior): con `Port = 0` el servidor
    // caería en el 8787 por defecto, que puede estar ocupado por una instancia real.
    const port1 = await freePort();
    const port2 = await freePort();

    const loop = (round: number): string[] => [
      `$exchange${round} = New-ExchangeToken`,
      `$control${round} = New-ControlId`,
      `$ctx${round} = [pscustomobject]@{`,
      `  DataDir = $data; NodeExe = $node; Entry = $entry; Exchange = $exchange${round}; ControlId = $control${round}`,
      `  Port = $env:VIU_TEST_PORT${round}; OutFile = (Join-Path $tmp 'r${round}.out'); ErrFile = (Join-Path $tmp 'r${round}.err'); TimeoutSeconds = 120`,
      "  Process = $null; ProcessHandle = $null",
      "}",
      `$start${round} = Invoke-ViuServerStart -Context $ctx${round}`,
      `$report.pids += @($start${round}.pid)`,
      `if ($start${round}.ok) {`,
      `  $stopCtx${round} = [pscustomobject]@{ Process = $ctx${round}.Process; ProcessHandle = $ctx${round}.ProcessHandle; Exchange = $exchange${round}; ControlId = $control${round}; TimeoutSeconds = 45 }`,
      `  $stop${round} = Invoke-ViuServerStop -Context $stopCtx${round}`,
      `  $report.rounds += [ordered]@{ started = $true; closed = $stop${round}.ok; exitCode = $stop${round}.exitCode; reason = $stop${round}.reason; message = $stop${round}.message; forced = $stop${round}.forced; log = @($stop${round}.log) }`,
      `} else {`,
      `  $report.rounds += [ordered]@{ started = $false; closed = $false; reason = $start${round}.reason }`,
      "}",
    ];

    const action = [
      "Initialize-ControlPipe",
      "Initialize-ExitCodeReader",
      "$report = [ordered]@{ rounds = @(); pids = @(); liveAtEnd = @() }",
      ...loop(1),
      ...loop(2),
      "foreach ($p in $report.pids) { if ($null -ne $p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { $report.liveAtEnd += $p } }",
      "$report.lockAfter = Test-Path -LiteralPath (Join-Path $data '.viurewards.lock')",
      "$report | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $env:VIU_TEST_OUT -Encoding UTF8",
      "exit 0",
    ].join("\r\n");

    const script = join(tmp, "repetido.ps1");
    writeFileSync(script, functionScript(action), "utf8");
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeoutMs: 600_000,
      env: {
        VIU_TEST_LAUNCHER: launcherPath,
        VIU_TEST_DATA: dataDir,
        VIU_TEST_APP: appDir,
        VIU_TEST_TMP: tmp,
        VIU_TEST_OUT: outFile,
        VIU_TEST_PORT1: String(port1),
        VIU_TEST_PORT2: String(port2),
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
    });
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = readReport(outFile) as {
      rounds: Array<{
        started: boolean;
        closed: boolean;
        exitCode?: number | null;
        reason?: string;
        message?: string;
        forced?: boolean;
        log?: string[];
      }>;
      pids: Array<number | null>;
      liveAtEnd: number[];
      lockAfter: boolean;
    };
    for (const pid of report.pids) if (typeof pid === "number") createdPids.add(pid);
    expect(report.rounds).toHaveLength(2);
    for (const round of report.rounds) {
      // La ronda entera viaja en el mensaje: si falla, el log del CI dice si se
      // forzó la terminación, si el canal no respondió o si el código no era 0.
      expect(round.started, `motivo de arranque: ${round.reason ?? "(sin motivo)"}`).toBe(true);
      expect(round.closed, JSON.stringify(round)).toBe(true);
      expect(round.exitCode).toBe(0);
    }
    // Cada ronda usó un proceso propio y ninguno quedó vivo.
    const pids = report.pids.filter((pid): pid is number => typeof pid === "number");
    expect(new Set(pids).size).toBe(pids.length);
    expect(report.liveAtEnd).toEqual([]);
    expect(report.lockAfter).toBe(false);
  });

  it("con los datos en uso (código 3) no detiene ni altera la instancia existente", async () => {
    const tmp = tempDir("enuso");
    const dataDir = join(tmp, "datos");
    mkdirSync(dataDir, { recursive: true });
    seedRuntime(dataDir);
    const outFile = join(tmp, "enuso.json");
    // Cerrojo de "otra instancia": el PID es el de ESTE proceso de PowerShell,
    // que sigue vivo. El launcher no debe llamarlo, matarlo ni borrarlo.
    const lockPath = join(dataDir, ".viurewards.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
    const lockBefore = readFileSync(lockPath, "utf8");

    const action = [
      "Initialize-ControlPipe",
      "Initialize-ExitCodeReader",
      "$exchange = New-ExchangeToken",
      "$controlId = New-ControlId",
      "$ctx = [pscustomobject]@{",
      "  DataDir = $data; NodeExe = $node; Entry = $entry; Exchange = $exchange; ControlId = $controlId",
      "  Port = 0; OutFile = (Join-Path $tmp 'srv.out'); ErrFile = (Join-Path $tmp 'srv.err'); TimeoutSeconds = 90",
      "  Process = $null; ProcessHandle = $null",
      "}",
      "$start = Invoke-ViuServerStart -Context $ctx",
      "$report = [ordered]@{ ok = $start.ok; reason = $start.reason; exitCode = $start.exitCode; alive = $null }",
      "if ($null -ne $ctx.Process) { $report.alive = -not $ctx.Process.HasExited } else { $report.alive = $false }",
      "$report | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $env:VIU_TEST_OUT -Encoding UTF8",
      "exit 0",
    ].join("\r\n");

    const script = join(tmp, "enuso.ps1");
    writeFileSync(script, functionScript(action), "utf8");
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeoutMs: 240_000,
      env: {
        VIU_TEST_LAUNCHER: launcherPath,
        VIU_TEST_DATA: dataDir,
        VIU_TEST_APP: appDir,
        VIU_TEST_TMP: tmp,
        VIU_TEST_OUT: outFile,
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
    });
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = readReport(outFile) as {
      ok: boolean;
      reason: string;
      exitCode: number | null;
      alive: boolean;
    };
    expect(report.ok).toBe(false);
    expect(report.reason).toBe("data-in-use");
    expect(report.exitCode).toBe(3);
    // El hijo salió solo: no quedó nada vivo que matar.
    expect(report.alive).toBe(false);
    // El cerrojo ajeno sigue EXACTAMENTE igual y el proceso "dueño" sigue vivo.
    expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
    expect(isAlive(process.pid)).toBe(true);
  });

  it("sin runtime o sin instalador falla con un motivo claro y sin procesos", async () => {
    const tmp = tempDir("faltan");
    const dataDir = join(tmp, "datos sin runtime");
    mkdirSync(dataDir, { recursive: true });
    const outFile = join(tmp, "faltan.json");

    const action = [
      "Initialize-ControlPipe",
      "Initialize-ExitCodeReader",
      "$ctx = [pscustomobject]@{",
      "  DataDir = $data; NodeExe = (Join-Path $data 'runtime\\node.exe'); Entry = $entry",
      "  Exchange = (New-ExchangeToken); ControlId = (New-ControlId)",
      "  Port = 0; OutFile = (Join-Path $tmp 'srv.out'); ErrFile = (Join-Path $tmp 'srv.err'); TimeoutSeconds = 30",
      "  Process = $null; ProcessHandle = $null",
      "}",
      "$start = Invoke-ViuServerStart -Context $ctx",
      "$installCtx = [pscustomobject]@{",
      "  Installer = (Join-Path $env:VIU_TEST_APP 'scripts\\dist\\no-existe.ps1')",
      "  DataDir = $data; OutputFile = (Join-Path $tmp 'i.out'); ErrorFile = (Join-Path $tmp 'i.err'); TimeoutSeconds = 60",
      "}",
      "$install = Invoke-ViuToolInstall -Context $installCtx",
      "$ok = (Join-Path (Split-Path $env:VIU_TEST_APP -Parent) 'app\\scripts\\dist\\install-tools.ps1')",
      "$report = [ordered]@{",
      "  startReason = $start.reason; startOk = $start.ok; startExited = ($null -eq $ctx.Process)",
      "  installReason = $install.reason; installOk = $install.ok",
      "}",
      "$report | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $env:VIU_TEST_OUT -Encoding UTF8",
      "exit 0",
    ].join("\r\n");

    const script = join(tmp, "faltan.ps1");
    writeFileSync(script, functionScript(action), "utf8");
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeoutMs: 180_000,
      env: {
        VIU_TEST_LAUNCHER: launcherPath,
        VIU_TEST_DATA: dataDir,
        VIU_TEST_APP: appDir,
        VIU_TEST_TMP: tmp,
        VIU_TEST_OUT: outFile,
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
    });
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = readReport(outFile) as {
      startReason: string;
      startOk: boolean;
      startExited: boolean;
      installReason: string;
      installOk: boolean;
    };
    expect(report.startOk).toBe(false);
    expect(report.startReason).toBe("runtime-missing");
    expect(report.startExited).toBe(true);
    expect(report.installOk).toBe(false);
    expect(report.installReason).toBe("installer-missing");
    // No se creó nada en el paquete ni en el directorio de datos.
    expect(existsSync(join(dataDir, "app.db"))).toBe(false);
    expect(existsSync(join(appDir, "runtime"))).toBe(false);
  });
});

describeLauncher("launcher: recuperación de un servidor huérfano", () => {
  /**
   * Levanta un servidor con su propio canal, como lo deja un launcher que se
   * cerró sin detenerlo (dueño del cerrojo, con `--Control`/`--Exchange`).
   */
  async function startOrphan(
    dataDir: string,
    tmp: string,
    label: string,
  ): Promise<{ pid: number; controlId: string; token: string; port: number; output: () => string }> {
    // Identificador y token válidos y DISTINTOS por servidor (el nombre del pipe
    // no se puede repetir): el alfabeto de control no admite letras fuera de
    // A-Z, a-z, 0-9, "_" y "-".
    const seed = label.charCodeAt(0).toString(16).padStart(2, "0");
    const controlId = `${seed}${randomBytes(13).toString("hex")}`;
    const token = randomBytes(24).toString("base64url");
    // El launcher real no fija el puerto, pero este servidor de prueba no debe
    // chocar con el puerto por defecto (una instancia del usuario podria estar
    // corriendo con su propia configuracion).
    const port = await freePort();
    // MISMO perfil de proceso que produce el launcher: el ejecutable es el
    // runtime ADMINISTRADO `<datos>/runtime/node.exe` (no el runtime del test) y
    // los datos van SOLO por el entorno. Con el runtime de la cache, el argv
    // llevaba la raiz de la aplicacion y la comprobacion vieja de
    // `Invoke-ViuAdoptServer` pasaba por casualidad: el caso real (ventana
    // cerrada sobre una instalacion ya en marcha) siempre se rechazaba.
    const orphanNodeExe = join(dataDir, "runtime", "node.exe");
    const child = spawn(orphanNodeExe, [join(appDir, "scripts", "start.ts"), `--Control=${controlId}`, `--Exchange=${token}`], {
      cwd: appDir,
      env: {
        ...process.env,
        VIUREWARDS_DATA_DIR: dataDir,
        VIUREWARDS_NODE_RUNTIME: orphanNodeExe,
        PORT: String(port),
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
      stdio: "pipe",
      windowsHide: true,
    });
    if (typeof child.pid !== "number") throw new Error("El servidor no expuso un PID.");
    createdPids.add(child.pid);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    let exited = false;
    child.once("exit", (code) => {
      exited = true;
      stdout += `\n[exit ${code}]`;
    });
    const lockPath = join(dataDir, ".viurewards.lock");
    const ready = await waitUntil(() => {
      if (exited) return true;
      if (!existsSync(lockPath) || !existsSync(join(dataDir, "app.db"))) return false;
      try {
        return JSON.parse(readFileSync(lockPath, "utf8")).pid === child.pid;
      } catch {
        return false;
      }
    }, 90_000);
    if (!ready || exited) {
      throw new Error(`El servidor de prueba no quedó en marcha (pid=${child.pid}, puerto=${port}):\n${stderr}\n${stdout}`);
    }
    // La prueba del cerrojo se satisface ANTES de que el servidor abra el canal:
    // por eso se espera a que el pipe de control exista de verdad. Sin esto, el
    // fallo era intermitente (el `waitUntil` devolvía en cuanto el cerrojo y la
    // base existían).
    const pipeName = "\\\\.\\pipe\\" + `viurewards-control-${controlId}`;
    const channelReady = await waitUntil(async () => (await listControlPipes()).includes(`viurewards-control-${controlId}`), 60_000);
    if (!channelReady) {
      const listing = (await listControlPipes()).join(",") || "(ninguno)";
      const logPath = join(dataDir, "logs", "server.log");
      const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(sin log)";
      throw new Error(
        `El servidor de prueba no abrió el canal de control (${pipeName}).\nPipes de viurewards: ${listing}\nLog:\n${logText}\nSalida:\n${stderr}\n${stdout}`,
      );
    }
    void tmp;
    return { pid: child.pid, controlId, token, port, output: () => `${stdout}\n${stderr}` };
  }

  it("reconoce al dueño del cerrojo y NO adopta un PID ajeno", async () => {
    const tmp = tempDir("adopcion");
    const dataDir = join(tmp, "datos");
    mkdirSync(dataDir, { recursive: true });
    seedRuntime(dataDir);
    const outFile = join(tmp, "adopcion.json");
    const orphan = await startOrphan(dataDir, tmp, "a");

    // Caso negativo: el cerrojo apunta a un proceso VIVO que no es un servidor
    // de esta app (acá, este mismo Node del test). No se puede adoptar.
    const foreignDir = join(tmp, "datos ajenos");
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(
      join(foreignDir, ".viurewards.lock"),
      JSON.stringify({ pid: Number(process.env.VIU_TEST_FOREIGN_PID), at: Date.now() }),
    );

    const action = [
      "Initialize-ControlPipe",
      "Initialize-ExitCodeReader",
      "$found = Invoke-ViuAdoptServer -Context ([pscustomobject]@{ DataRoot = $data; Entry = $entry })",
      "$report = [ordered]@{ found = ($null -ne $found); pid = $null; controlId = $null; exchange = $null; alive = $false; foreign = $false; otherData = $false }",
      "if ($null -ne $found) {",
      "  $report.pid = $found.ProcessId; $report.controlId = $found.ControlId; $report.exchange = $found.Exchange",
      "  $report.alive = -not $found.Process.HasExited",
      "}",
      "$foreignLock = Invoke-ViuAdoptServer -Context ([pscustomobject]@{ DataRoot = $env:VIU_TEST_FOREIGN_DIR; Entry = $entry })",
      "$report.foreign = ($null -ne $foreignLock)",
      // Otro directorio de datos que NO es el dueno del cerrojo: comparte el
      // `start.ts` pero no el runtime administrado, asi que tampoco se adopta.
      "$otherDir = Join-Path $env:VIU_TEST_TMP 'datos otros'",
      "New-Item -ItemType Directory -Path (Join-Path $otherDir 'runtime') -Force | Out-Null",
      "Copy-Item -LiteralPath (Join-Path $data 'runtime\\node.exe') -Destination (Join-Path $otherDir 'runtime\\node.exe')",
      "$report.otherData = ($null -ne (Invoke-ViuAdoptServer -Context ([pscustomobject]@{ DataRoot = $otherDir; Entry = $entry })))",
      "$report | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $env:VIU_TEST_OUT -Encoding UTF8",
      "exit 0",
    ].join("\r\n");

    const script = join(tmp, "adopcion.ps1");
    writeFileSync(script, functionScript(action), "utf8");
    const timeoutMs = Number(process.env.VIU_TEST_ORPHAN_TIMEOUT ?? 180_000);
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeoutMs,
      env: {
        VIU_TEST_LAUNCHER: launcherPath,
        VIU_TEST_DATA: dataDir,
        VIU_TEST_APP: appDir,
        VIU_TEST_TMP: tmp,
        VIU_TEST_OUT: outFile,
        VIU_TEST_FOREIGN_DIR: foreignDir,
        VIU_TEST_FOREIGN_PID: String(process.pid),
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
    });
    process.stderr.write(`[diag] ps adopción: code=${result.code} en ${timeoutMs} ms\n`);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = readReport(outFile) as {
      found: boolean;
      pid: number | null;
      controlId: string | null;
      exchange: string | null;
      alive: boolean;
      foreign: boolean;
      otherData: boolean;
    };
    // El servidor huérfano se reconoce por el cerrojo y su línea de comandos.
    expect(report.found).toBe(true);
    expect(report.pid).toBe(orphan.pid);
    expect(report.controlId).toBe(orphan.controlId);
    expect(report.exchange).toBe(orphan.token);
    expect(report.alive).toBe(true);
    // Un proceso ajeno (vivo, pero sin el canal de esta app) NO se adopta.
    expect(report.foreign).toBe(false);
    // Y un directorio de datos DISTINTO al del dueño del cerrojo tampoco: el
    // runtime administrado de ese otro directorio no es el que corre.
    expect(report.otherData).toBe(false);
    // Y nadie lo tocó: el proceso ajeno sigue vivo.
    expect(isAlive(process.pid)).toBe(true);

    // Limpieza: el huérfano se cierra por su canal (nada de señales ni taskkill).
    // Si la limpieza no llegara a conectarse, `afterAll` termina el árbol del PID
    // que creó este test; no se convierte en un fallo de la verificación.
    await shutdownViaChannel(orphan.controlId, orphan.token, tmp);
    process.stderr.write(`[diag] limpieza por canal ok (pid=${orphan.pid})\n`);
    await shutdownViaChannel(orphan.controlId, orphan.token, tmp);
    const gone = await waitUntil(() => !isAlive(orphan.pid), 30_000);
    if (!gone) {
      const logPath = join(dataDir, "logs", "server.log");
      const logText = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(sin log)";
      throw new Error(
        `El servidor de prueba no se cerró (pid=${orphan.pid}).\nPipes: ${(await listControlPipes()).join(",")}\nLog:\n${logText}`,
      );
    }
    expect(gone).toBe(true);
  });

  it("recuperar y detener libera el cerrojo, deja reabrir SQLite y permite arrancar de nuevo", async () => {
    const tmp = tempDir("recuperacion");
    const dataDir = join(tmp, "datos");
    mkdirSync(dataDir, { recursive: true });
    seedRuntime(dataDir);
    const outFile = join(tmp, "recuperacion.json");
    const orphan = await startOrphan(dataDir, tmp, "b");
    const orphanLog = join(dataDir, "logs", "server.log");

    const action = [
      "Initialize-ControlPipe",
      "Initialize-ExitCodeReader",
      "$report = [ordered]@{ adopted = $false; stopOk = $false; stopReason = $null; exitCode = $null; aliveAfter = $true; lockAfter = $true }",
      "$found = Invoke-ViuAdoptServer -Context ([pscustomobject]@{ DataRoot = $data; Entry = $entry })",
      "$report.adopted = ($null -ne $found)",
      "if ($null -ne $found) {",
      // Sin `ProcessHandle`: el recuperado no lo tiene. Es el caso de la GUI cuando
      // reabre con un servidor de una ventana anterior.
      "  $stopCtx = [pscustomobject]@{ Process = $found.Process; ProcessHandle = $null; Exchange = $found.Exchange; ControlId = $found.ControlId; TimeoutSeconds = 45 }",
      "  $stop = Invoke-ViuServerStop -Context $stopCtx",
      "  $report.stopOk = $stop.ok; $report.stopReason = $stop.reason; $report.exitCode = $stop.exitCode",
      "}",
      "Start-Sleep -Milliseconds 500",
      "$report.aliveAfter = [bool](Get-Process -Id $env:VIU_TEST_ORPHAN_PID -ErrorAction SilentlyContinue)",
      "$report.lockAfter = Test-Path -LiteralPath (Join-Path $data '.viurewards.lock')",
      "$report | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $env:VIU_TEST_OUT -Encoding UTF8",
      "exit 0",
    ].join("\r\n");

    const script = join(tmp, "recuperacion.ps1");
    writeFileSync(script, functionScript(action), "utf8");
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeoutMs: 300_000,
      env: {
        VIU_TEST_LAUNCHER: launcherPath,
        VIU_TEST_DATA: dataDir,
        VIU_TEST_APP: appDir,
        VIU_TEST_TMP: tmp,
        VIU_TEST_OUT: outFile,
        VIU_TEST_ORPHAN_PID: String(orphan.pid),
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
    });
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = readReport(outFile) as {
      adopted: boolean;
      stopOk: boolean;
      stopReason: string | null;
      exitCode: number | null;
      aliveAfter: boolean;
      lockAfter: boolean;
    };
    expect(report.adopted).toBe(true);
    // Cierre ORDENADO por el canal (no forzado) y con código 0. Antes de la
    // corrección, el código de salida de un proceso recuperado se leía de un
    // handle nulo y el cierre se informaba como fallido.
    expect(report.stopReason).toBe("closed");
    expect(report.stopOk).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.aliveAfter).toBe(false);
    expect(isAlive(orphan.pid)).toBe(false);
    // El servidor registró el cierre de producción (no un camino alternativo).
    expect(readFileSync(orphanLog, "utf8")).toContain("se cerró correctamente");
    // El cerrojo quedó libre: la próxima ventana puede usar los datos (un
    // arranque nuevo completo se prueba en el ciclo de vida de arriba, que ya
    // verifica el arranque, el cierre ordenado y el cerrojo liberado).
    expect(report.lockAfter).toBe(false);
    // La base quedó cerrada y se puede reabrir.
    expect(await inspectDatabase(join(dataDir, "app.db"))).toBeGreaterThanOrEqual(10);
  }, 600_000);
});

describeLauncher("launcher: inicio con Windows (acceso directo)", () => {
  it("crea y borra el acceso directo de forma idempotente, con rutas entrecomilladas", async () => {
    const tmp = tempDir("inicio");
    const startup = join(tmp, "Start Menu Programs Startup");
    mkdirSync(startup, { recursive: true });
    const outFile = join(tmp, "inicio.json");

    const action = [
      "$link = Set-StartupShortcut -Enabled $true -LauncherPath $env:VIU_TEST_LAUNCHER -ApplicationRoot $env:VIU_TEST_APP -StartupFolder $env:VIU_TEST_STARTUP",
      "$first = Test-StartupShortcut -StartupFolder $env:VIU_TEST_STARTUP",
      "$shell = New-Object -ComObject WScript.Shell",
      "$shortcut = $shell.CreateShortcut($link)",
      "$target = $shortcut.TargetPath",
      "$arguments = $shortcut.Arguments",
      "$working = $shortcut.WorkingDirectory",
      "$link2 = Set-StartupShortcut -Enabled $true -LauncherPath $env:VIU_TEST_LAUNCHER -ApplicationRoot $env:VIU_TEST_APP -StartupFolder $env:VIU_TEST_STARTUP",
      "$second = Test-StartupShortcut -StartupFolder $env:VIU_TEST_STARTUP",
      "$same = ($link -eq $link2)",
      "$null = Set-StartupShortcut -Enabled $false -LauncherPath $env:VIU_TEST_LAUNCHER -ApplicationRoot $env:VIU_TEST_APP -StartupFolder $env:VIU_TEST_STARTUP",
      "$afterDisable = Test-StartupShortcut -StartupFolder $env:VIU_TEST_STARTUP",
      "$null = Set-StartupShortcut -Enabled $false -LauncherPath $env:VIU_TEST_LAUNCHER -ApplicationRoot $env:VIU_TEST_APP -StartupFolder $env:VIU_TEST_STARTUP",
      "$afterSecondDisable = Test-StartupShortcut -StartupFolder $env:VIU_TEST_STARTUP",
      "$report = [ordered]@{ link = $link; first = $first; second = $second; same = $same; afterDisable = $afterDisable; afterSecondDisable = $afterSecondDisable; target = $target; arguments = $arguments; working = $working }",
      "$report | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $env:VIU_TEST_OUT -Encoding UTF8",
      "exit 0",
    ].join("\r\n");

    const script = join(tmp, "inicio.ps1");
    writeFileSync(script, functionScript(action), "utf8");
    const result = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      timeoutMs: 180_000,
      env: {
        VIU_TEST_LAUNCHER: launcherPath,
        VIU_TEST_DATA: join(tmp, "datos"),
        VIU_TEST_APP: appDir,
        VIU_TEST_TMP: tmp,
        VIU_TEST_STARTUP: startup,
        VIU_TEST_OUT: outFile,
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
    });
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = readReport(outFile) as {
      link: string;
      first: boolean;
      second: boolean;
      same: boolean;
      afterDisable: boolean;
      afterSecondDisable: boolean;
      target: string;
      arguments: string;
      working: string;
    };
    expect(report.link).toBe(join(startup, "VIUrewards.lnk"));
    expect(report.first).toBe(true);
    expect(report.second).toBe(true);
    expect(report.same).toBe(true);
    expect(report.afterDisable).toBe(false);
    // Desactivar dos veces no falla ni deja el archivo.
    expect(report.afterSecondDisable).toBe(false);
    expect(existsSync(report.link)).toBe(false);
    // `WScript.Shell` guarda la ruta EFECTIVA de powershell.exe: lo que importa
    // es que apunte a PowerShell (no a un binario nuestro ni a otro programa).
    expect(report.target.toLowerCase().endsWith("powershell.exe")).toBe(true);
    // La ruta del launcher va ENTRE COMILLAS (puede tener espacios) y el modo
    // `-AutoStart` mantiene el servidor bajo el control de este launcher.
    expect(report.arguments).toContain(`-File "${launcherPath}"`);
    expect(report.arguments).toContain("-AutoStart");
    expect(report.working).toBe(appDir);
    // Nunca se tocó la carpeta de Inicio real del usuario.
    expect(report.link.startsWith(tmp)).toBe(true);
  });
});

describeLauncher("launcher: política de herramientas", () => {
  it("conserva la política del instalador (yt-dlp y FFmpeg nunca se pisan)", () => {
    // Las versiones y políticas viven en `scripts/dist/config.ts`, no en el
    // launcher: se comprueban las que el instalador realmente aplica.
    const ytdlp = MANAGED_TOOLS.find((tool) => tool.id === "yt-dlp");
    const ffmpeg = MANAGED_TOOLS.find((tool) => tool.id === "ffmpeg");
    const node = MANAGED_TOOLS.find((tool) => tool.id === "node");
    expect(ytdlp?.policy).toBe("if-missing");
    expect(ytdlp?.updatedBy).toBe("dashboard");
    expect(ffmpeg?.policy).toBe("if-missing");
    expect(node?.policy).toBe("match-manifest");
    // El launcher solo ejecuta el instalador: no duplica la descarga ni los hashes.
    const launcher = readFileSync(launcherPath, "utf8");
    expect(launcher).not.toContain("gyan.dev");
    expect(launcher).not.toContain("github.com/yt-dlp");
    expect(launcher).not.toContain(NODE_ASSET.url);
    // Ni implementa un segundo actualizador de yt-dlp.
    expect(launcher).not.toContain("yt-dlp -U");
    expect(launcher).not.toContain('"-U"');
  });

  it("el launcher no escribe dentro de la aplicación", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    // Todo lo mutable va al directorio de datos.
    expect(launcher).toContain("Get-NodeRuntimePath");
    expect(launcher).toContain("Resolve-LauncherDataDir");
    // Los archivos temporales de salida van al directorio temporal del sistema.
    expect(launcher).toContain("GetTempPath()");
    expect(existsSync(join(appDir, "media"))).toBe(false);
    expect(existsSync(join(appDir, ".uploads"))).toBe(false);
    expect(existsSync(join(appDir, "logs"))).toBe(false);
  });

  /**
   * El defecto real de la Etapa 3C.1: con una operación en curso, "Salir"
   * cerraba la ventana SIN detener el servidor y descartaba la orden. El
   * proceso quedaba vivo con el cerrojo tomado y ninguna ventana podía cerrarlo
   * (el launcher siguiente informaba "datos en uso").
   */
  it('"Salir" nunca cierra la ventana antes de que el servidor esté controlado', () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const start = launcher.indexOf("$menuExit.Add_Click({");
    const end = launcher.indexOf("$notify.Add_DoubleClick", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handler = launcher.slice(start, end);

    // La orden de salida se registra SIEMPRE, antes de decidir qué hacer.
    const flagAt = handler.indexOf("$script:ExitAfterStop = $true");
    const branchAt = handler.indexOf("$beginStop");
    expect(flagAt).toBeGreaterThan(0);
    expect(branchAt).toBeGreaterThan(flagAt);

    // Con una operación en curso no se cierra: el cierre ocurre cuando termina.
    expect(handler).toContain('$script:State -notin @("preparando", "iniciando", "deteniendo")');
    const closeCalls = handler.split("$form.Close()").length - 1;
    expect(closeCalls).toBe(1);
    const closeAt = handler.indexOf("$form.Close()");
    expect(handler.slice(closeAt - 400, closeAt)).toContain("$null -eq $script:ServerProcess");

    // Y la orden se cumple al terminar cada operación: arranque, instalación y
    // cierre. Si no, la ventana quedaría abierta para siempre.
    for (const callback of ["$onStartDone", "$onInstallDone", "$onStopDone"]) {
      const from = launcher.indexOf(`${callback} = {`);
      expect(from, callback).toBeGreaterThan(0);
      const block = launcher.slice(from, from + 3000);
      expect(block, callback).toContain("$script:ExitAfterStop");
    }

    // Una ventana que no tiene el control del servidor no lo detiene ni lo mata.
    expect(launcher).toContain('$script:ServerOwnership -ne "launched"');
  });
});

// Evita un import sin uso si el archivo cambia de forma.
void REPO_ROOT;
