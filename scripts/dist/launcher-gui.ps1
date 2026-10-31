<#
.SYNOPSIS
  Launcher grafico de VIUrewards (Fase de distribucion, Etapa 3C).

.DESCRIPTION
  Ventana pequena (Windows Forms) que prepara el entorno, arranca el servidor de
  VIUrewards, lo detiene de forma ORDENADA y muestra el estado y los registros.

  No hay un segundo mecanismo de cierre: el launcher es un cliente del canal de
  control de la Etapa 3A (`src/server/control-channel.ts`) y el cierre pasa por
  el MISMO controlador de produccion que Ctrl+C o `npm start`. Tampoco hay un
  segundo mecanismo de rutas ni de instalacion: reutiliza `src/server/paths.ts`
  (por sus invariantes) y `scripts/dist/install-tools.ps1`.

  ## Que resuelve y de donde

  - Raiz de la aplicacion: `$PSScriptRoot` (`<app>/scripts/dist` -> `<app>`). Es
    la MISMA deduccion que usa `install-tools.ps1` para su guard.
  - Directorio de datos: mismo contrato que `src/server/paths.ts`:
      * `-DataDir` explicito, si se pasa;
      * si no, `VIUREWARDS_DATA_DIR` (tiene que ser ABSOLUTA);
      * si no, el directorio persistente por usuario
        `%LOCALAPPDATA%\VIUrewards`.
    Nunca se acepta un directorio de datos dentro del arbol de la aplicacion.
  - Runtime de Node: `<datos>/runtime/node.exe` (lo instala `install-tools.ps1`).
    Es tambien el runtime JS que la app le pasa a yt-dlp
    (`VIUREWARDS_NODE_RUNTIME`).
  - Herramientas: `<datos>/bin/yt-dlp.exe`, `ffmpeg.exe` y `ffprobe.exe`. Si
    falta alguna se ejecuta `install-tools.ps1`, cuya politica es `if-missing`:
    NUNCA pisa un yt-dlp actualizado desde el dashboard ni un FFmpeg existente.

  ## Estados y controles

  Detenido / Preparando herramientas / Iniciando / En ejecucion / Deteniendo /
  Error. Mientras hay una operacion en curso los botones quedan deshabilitados
  para que no se pisen. Las operaciones largas (instalacion, arranque, cierre)
  corren en un runspace aparte, asi que el hilo de interfaz sigue bombeando
  mensajes y la ventana no se cuelga.

  ## Cierre de la ventana y bandeja

  Cerrar la ventana NO tira el servidor: la oculta en la bandeja del sistema. El
  servidor sigue bajo el control de este launcher (mismo proceso hijo, mismo
  token), asi que se puede detener desde el icono. Salir pide un apagado
  ordenado (si hay servidor) y recien despues cierra la aplicacion.

  ## Inicio con Windows

  Acceso directo en la carpeta de Inicio del USUARIO actual, sin privilegios de
  administrador, que invoca este mismo `.ps1` con `-AutoStart`. En ese modo la
  ventana arranca en la bandeja y pide el inicio del servidor. Asi el proceso
  sigue siendo hijo de ESTE launcher y conserva el token: no se arranca un
  servidor autonomo que despues nadie puede detener.

  ## Seguridad del canal

  El token viaja en los argumentos del proceso (`--Exchange=`) y NUNCA se
  escribe en el log de la interfaz ni en archivos. El nombre del pipe no aisla
  por usuario (ver `docs/distribution.md` 5.1): es una decision aceptada para
  una aplicacion de escritorio de un solo usuario.

.PARAMETER DataDir
  Sobrescribe el directorio de datos. Debe ser una ruta absoluta y quedar fuera
  de la aplicacion. Lo usan las pruebas, siempre con directorios temporales.

.PARAMETER AutoStart
  Modo inicio con Windows: abre en la bandeja e inicia el servidor.

.PARAMETER NoStart
  Solo abre la ventana, sin iniciar el servidor automaticamente.

.PARAMETER SelfTest
  Sin interfaz: comprueba la resolucion de rutas, las herramientas que faltan y
  que Windows Forms se pueda inicializar, y deja un JSON. Lo usan los tests de
  distribucion. Sale con 0 si `ok` es verdadero.

.PARAMETER SelfTestOutput
  Archivo donde `-SelfTest` deja el JSON (si se omite, se escribe en stdout).

.NOTES
  Windows PowerShell 5.1. Sin dependencias externas ni ejecutables compilados.
#>
[CmdletBinding()]
param(
  [string]$DataDir = "",
  [switch]$AutoStart,
  [switch]$NoStart,
  [switch]$SelfTest,
  [string]$SelfTestOutput = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

# ==============================================================================
# Rutas y constantes (una sola definicion; las pruebas las ejercitan con -SelfTest)
# ==============================================================================

$script:LauncherScript = $PSCommandPath
# PID de ESTA ventana: un launcher nunca adopta (ni detiene) su propio proceso.
$script:LauncherPid = $PID
$script:NodeRelativePath = @("runtime", "node.exe")
$script:ToolRelativePaths = @(
  @("bin", "yt-dlp.exe"),
  @("bin", "ffmpeg.exe"),
  @("bin", "ffprobe.exe")
)
$script:EntryRelativePath = @("scripts", "start.ts")
$script:InstallerRelativePath = @("scripts", "dist", "install-tools.ps1")
$script:StartTimeoutSeconds = 120
$script:StopTimeoutSeconds = 45
$script:InstallTimeoutSeconds = 1800
$script:LogTailBytes = 65536

# Los nombres NO distinguen mayusculas en PowerShell: nada de `$dataDir` junto a
# un parametro `$DataDir` con otro significado (fue el defecto real de la Etapa
# 3B.2). El parametro se copia una sola vez, al inicio.
$script:RequestedDataDir = $DataDir

# ==============================================================================
# Helpers puros (sin interfaz): los usa la GUI y -SelfTest
# ==============================================================================

# Ruta completa normalizada, sin separador final.
function Get-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

# `$Path` esta dentro de `$Base` (o es la base). Separador OBLIGATORIO: asi
# `VIUrewards-data` no cuenta como hijo de `VIUrewards`.
function Test-PathInside {
  param([Parameter(Mandatory = $true)][string]$Base, [Parameter(Mandatory = $true)][string]$Path)
  $baseFull = Get-NormalizedPath $Base
  $pathFull = Get-NormalizedPath $Path
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  if ($pathFull.Equals($baseFull, $comparison)) { return $true }
  return $pathFull.StartsWith($baseFull + [System.IO.Path]::DirectorySeparatorChar, $comparison)
}

# Raiz de la aplicacion a partir del directorio del propio script:
# `<app>/scripts/dist` -> `<app>`. Sin `package.json` no se inventa una raiz.
function Get-ApplicationRoot {
  param([Parameter(Mandatory = $true)][string]$ScriptRoot)
  $scriptsDir = [System.IO.Path]::GetDirectoryName((Get-NormalizedPath $ScriptRoot))
  if ([string]::IsNullOrWhiteSpace($scriptsDir)) { return $null }
  $candidate = [System.IO.Path]::GetDirectoryName($scriptsDir)
  if ([string]::IsNullOrWhiteSpace($candidate)) { return $null }
  if (-not (Test-Path -LiteralPath (Join-Path $candidate "package.json") -PathType Leaf)) { return $null }
  return (Get-NormalizedPath $candidate)
}

# Directorio de datos por usuario (misma forma que el contrato de `paths.ts`).
function Get-DefaultDataDir {
  param([string]$LocalAppData = "")
  if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
    $LocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  }
  return (Join-Path $LocalAppData "VIUrewards")
}

<#
  Resuelve el directorio de datos.
  Devuelve `{ path; source; error }`: `path` es `$null` si el motivo esta en
  `error`; `source` dice de donde salio (`argument`, `environment`, `default`)
  para poder informarlo sin exponer variables de entorno.
  Nunca crea nada.
#>
function Resolve-LauncherDataDir {
  param(
    [string]$Requested = "",
    [string]$ApplicationRoot = "",
    [string]$EnvironmentValue = "",
    [string]$LocalAppData = ""
  )
  $raw = $Requested
  $source = "argument"
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $source = "environment"
    $raw = $EnvironmentValue
  }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{ error = $null; path = (Get-DefaultDataDir $LocalAppData); source = "default" }
  }
  $value = $raw.Trim()
  if (-not [System.IO.Path]::IsPathRooted($value)) {
    return [pscustomobject]@{
      error = "El directorio de datos tiene que ser una ruta ABSOLUTA (recibi ""$value""). Una ruta relativa dependeria del directorio de trabajo."
      path = $null
      source = $source
    }
  }
  $full = Get-NormalizedPath $value
  if (([System.IO.Path]::GetPathRoot($full)).TrimEnd('\', '/') -eq $full) {
    return [pscustomobject]@{ error = """$full"" es la raiz de una unidad, no un directorio de datos."; path = $null; source = $source }
  }
  if ((-not [string]::IsNullOrWhiteSpace($ApplicationRoot)) -and (Test-PathInside $ApplicationRoot $full)) {
    return [pscustomobject]@{
      error = """$full"" esta dentro de la aplicacion; el directorio de datos tiene que quedar fuera de ""$ApplicationRoot""."
      path = $null
      source = $source
    }
  }
  return [pscustomobject]@{ error = $null; path = $full; source = $source }
}

# Ruta del node.exe administrado.
function Get-NodeRuntimePath {
  param([Parameter(Mandatory = $true)][string]$DataRoot)
  return (Join-Path (Join-Path $DataRoot $script:NodeRelativePath[0]) $script:NodeRelativePath[1])
}

# Lista de herramientas externas que faltan en `<datos>/bin`.
function Get-MissingTools {
  param([Parameter(Mandatory = $true)][string]$DataRoot)
  $missing = @()
  foreach ($rel in $script:ToolRelativePaths) {
    $path = Join-Path $DataRoot ($rel -join [System.IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $missing += $rel[1] }
  }
  return $missing
}

# Argumentos del servidor: MISMA forma que el canal de la Etapa 3A espera.
#
# `Port` vacio: NO se pasa `--port=` ni `PORT`, asi el servidor usa el puerto que
# el usuario tenga configurado en Ajustes (por defecto 8787). El launcher no
# cambia la eleccion de puerto; el puerto real llega en el mensaje `started`.
function New-ServerArguments {
  param(
    [Parameter(Mandatory = $true)][string]$EntryPath,
    [Parameter(Mandatory = $true)][string]$ControlId,
    [Parameter(Mandatory = $true)][string]$Exchange,
    [int]$Port = 0
  )
  $arguments = @(
    ('"' + $EntryPath + '"'),
    "--Control=$ControlId",
    "--Exchange=$Exchange"
  )
  if ($Port -gt 0) { $arguments += "--port=$Port" }
  return $arguments
}

function New-ControlId {
  return ([guid]::NewGuid().ToString("N"))
}

# 32 caracteres URL-safe: cumple `isExchangeToken` (16..256).
function New-ExchangeToken {
  return (([guid]::NewGuid().ToString("N")) + ([guid]::NewGuid().ToString("N")).Substring(0, 0))
}

function Get-ControlPipeName {
  param([Parameter(Mandatory = $true)][string]$ControlId)
  return ("\\.\pipe\viurewards-control-" + $ControlId)
}

# Ruta del cerrojo de recursos compartidos: MISMA regla que
# `acquireSharedResourcesLock` de `src/db/instance-lock.ts` (un archivo oculto en
# la raiz de los datos, al lado de `media/`).
function Get-SharedLockPath {
  param([Parameter(Mandatory = $true)][string]$DataRoot)
  return (Join-Path $DataRoot ".viurewards.lock")
}

# Procesos vivos con linea de comandos que contiene el patron (una sola
# consulta). Devuelve objetos con ProcessId, ParentProcessId y CommandLine.
function Get-CommandLineProcess {
  param([Parameter(Mandatory = $true)][string]$Pattern)
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $null -ne $_.CommandLine -and $_.CommandLine.Contains($Pattern)
    })
  } catch {
    # Sin WMI/CIM no se puede comprobar: se devuelve vacio y quien llama NO
    # adopta nada (adoptar a ciegas seria peor).
    return @()
  }
}

<#
  Reconoce el servidor que dejo viva una ventana anterior.

  El caso real: el launcher se cierra sin haber detenido el servidor (p. ej.
  con "Salir" durante el arranque, o si el proceso de la ventana muere). El
  servidor sigue sirviendo y tiene TOMADO el cerrojo, asi que el siguiente
  launcher solo recibe el codigo 3 ("datos en uso") y no hay ninguna ventana
  que lo pueda cerrar. Ninguna otra instancia de VIUrewards arranca.

  Para poder detenerlo hacen falta el identificador de control y el token, que
  solo existen en la linea de comandos de ese proceso. Se acepta SOLO si:
    - el PID del cerrojo es exactamente el proceso que arranca `start.ts` con
      `--Control=` y `--Exchange=` del directorio de datos de esta ventana;
    - ese proceso esta vivo.
  No se toca ningun otro proceso: si el dueno del cerrojo no es un servidor de
  VIUrewards (un launcher de otra copia, un proceso ajeno con el PID reciclado),
  devuelve `$null` y todo sigue como antes.

  OJO (defecto real, corregido en la Etapa 3C.1): el directorio de datos NO
  aparece en la linea de comandos del servidor. El launcher le pasa
  `VIUREWARDS_DATA_DIR` por el ENTORNO y solo pone en argv el `node.exe`, el
  `start.ts`, `--Control` y `--Exchange`. La comprobacion anterior exigia
  `$dataRoot` o `$applicationRoot` en argv y por eso RECHAZABA siempre el caso
  que justifica esta funcion: el servidor huerfano de la misma instalacion. El
  launcher nunca podia recuperar los datos y la unica salida era matar el
  proceso a mano. Ahora se reconoce la instalacion por el RUNTIME administrado
  (`<datos>/runtime/node.exe`, que si va en argv como imagen del proceso) y no
  por el texto del directorio de datos. El cerrojo sigue siendo la fuente de
  verdad de los datos compartidos: si el PID de su dueno es este proceso, es
  que usa este directorio de datos.
#>
function Invoke-ViuAdoptServer {
  param([Parameter(Mandatory = $true)]$Context)

  $dataRoot = [string]$Context.DataRoot
  $entry = [string]$Context.Entry

  $lockPath = Get-SharedLockPath -DataRoot $dataRoot
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
  $lock = $null
  try {
    # Get-Content: lee el archivo aunque otro proceso lo tenga abierto.
    $lock = (Get-Content -LiteralPath $lockPath -Raw -ErrorAction Stop) | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($null -eq $lock -or $null -eq $lock.pid) { return $null }
  $ownerPid = [int]$lock.pid
  if ($ownerPid -le 0 -or $ownerPid -eq $PID) { return $null }
  # Si el dueno del cerrojo es un launcher (o una ventana de PowerShell), no es
  # el servidor: no se adopta a ciegas.
  if ($ownerPid -eq $script:LauncherPid) { return $null }

  $pattern = Get-CommandLineProcess -Pattern ("--Control=")
  $candidate = $null
  foreach ($process in $pattern) {
    if ([int]$process.ProcessId -eq $ownerPid) { $candidate = $process; break }
  }
  if ($null -eq $candidate) { return $null }

  $commandLine = [string]$candidate.CommandLine
  $controlMatch = [regex]::Match($commandLine, '--Control=(?<id>[A-Za-z0-9_-]{1,128})')
  $exchangeMatch = [regex]::Match($commandLine, '--Exchange=(?<token>[A-Za-z0-9_-]{16,256})')
  if (-not $controlMatch.Success -or -not $exchangeMatch.Success) { return $null }

  # El proceso tiene que ser ESTE servidor, con los datos de ESTA ventana:
  #  - argv incluye el punto de entrada de esta instalacion; y
  #  - argv incluye el runtime administrado de estos datos
  #    (`<datos>/runtime/node.exe`), que es lo que lo ata al directorio.
  # El directorio de datos NO va en argv (se pasa por el entorno), asi que
  # comparar `$dataRoot` en la linea de comandos rechazaria siempre.
  $normalizedEntry = $entry.Replace("/", "\")
  if (-not $commandLine.Contains($normalizedEntry)) { return $null }
  $nodeExe = Get-NodeRuntimePath $dataRoot
  if (-not $commandLine.Contains($nodeExe)) { return $null }

  $process = $null
  try {
    $process = Get-Process -Id $ownerPid -ErrorAction Stop
  } catch {
    return $null
  }

  return [pscustomobject]@{
    ProcessId = $ownerPid
    ControlId = $controlMatch.Groups["id"].Value
    Exchange = $exchangeMatch.Groups["token"].Value
    Process = $process
    StartedAt = $candidate.CreationDate
  }
}

# Mensajes del canal -> texto para el log (NUNCA incluye el token).
function Format-ControlMessage {
  param($Message)
  switch ($Message.type) {
    "accepted" { return "El servidor acepto el canal de control." }
    "started" { return ("Servidor escuchando en el puerto " + $Message.port + " (" + $Message.dashboardUrl + ").") }
    "closing" { return ("El servidor esta cerrando (motivo: " + $Message.reason + ").") }
    "finished" {
      if ($Message.code -eq 0) { return "El servidor se cerro correctamente." }
      return ("El servidor termino con error: " + $Message.message)
    }
    default { return ("Mensaje de control desconocido: " + $Message.type) }
  }
}

# Las lineas del servidor pueden traer rutas o el token: nunca se muestra el
# token. Un proceso con acceso a su propia linea de comandos SI puede verlo; esto
# solo evita que quede escrito en la ventana y en el log.
function Protect-LogLine {
  param([string]$Line, [string]$Secret = "")
  if ([string]::IsNullOrEmpty($Line)) { return $Line }
  $clean = $Line
  if (-not [string]::IsNullOrEmpty($Secret)) {
    $clean = $clean.Replace($Secret, "***")
  }
  $clean = [regex]::Replace($clean, "--Exchange=\S+", "--Exchange=***")
  return $clean.TrimEnd()
}

# ------------------------------------------------------------------------------
# Acceso al named pipe (mismo mecanismo verificado en `launcher-harness.ps1`)
#
# `CreateFileW` sobre el nombre exacto del pipe: `NamedPipeClientStream` de .NET
# Framework no conecta a un pipe creado por otro proceso en este entorno.
# ------------------------------------------------------------------------------
function Initialize-ControlPipe {
  if ("ViuLauncherPipe" -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ViuLauncherPipe {
  private const uint GENERIC_READ_WRITE = 0xC0000000;
  private const uint OPEN_EXISTING = 3;
  private const uint SHARE_ALL = 0x7;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  private static SafeFileHandle _handle;
  private static FileStream _stream;
  private static string _pending = "";

  public static int LastError { get; private set; }

  public static bool Open(string name) {
    Close();
    _handle = CreateFileW(name, GENERIC_READ_WRITE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (_handle.IsInvalid) { LastError = Marshal.GetLastWin32Error(); return false; }
    _stream = new FileStream(_handle, FileAccess.ReadWrite, 4096, false);
    _pending = "";
    return true;
  }

  public static void Send(string line) {
    if (_stream == null) throw new InvalidOperationException("El canal no esta abierto.");
    byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
    _stream.Write(bytes, 0, bytes.Length);
    _stream.Flush();
  }

  public static string ReadLine() {
    if (_stream == null) return null;
    while (true) {
      int cut = _pending.IndexOf('\n');
      if (cut >= 0) {
        string line = _pending.Substring(0, cut).Replace("\r", "");
        _pending = _pending.Substring(cut + 1);
        return line;
      }
      byte[] buffer = new byte[4096];
      int read = _stream.Read(buffer, 0, buffer.Length);
      if (read <= 0) return null;
      _pending += Encoding.UTF8.GetString(buffer, 0, read);
    }
  }

  public static void Close() {
    if (_stream != null) { try { _stream.Dispose(); } catch { } _stream = null; }
    if (_handle != null) { try { _handle.Dispose(); } catch { } _handle = null; }
  }
}
'@
}

# `Process.ExitCode` de .NET Framework devuelve vacio cuando la salida esta
# redirigida: se lee el codigo real del handle capturado ANTES de esperar.
function Initialize-ExitCodeReader {
  if ("ViuLauncherExitCode" -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ViuLauncherExitCode {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  public static int Read(IntPtr process) {
    uint code;
    if (!GetExitCodeProcess(process, out code)) return -1;
    return unchecked((int)code);
  }
}
'@
}

# ==============================================================================
# Operaciones del servidor (se ejecutan en un runspace aparte)
#
# Cada funcion es autonoma: no toca controles de la ventana. Recibe un objeto de
# contexto y escribe en `log`. La GUI solo mueve el estado.
# ==============================================================================

# Ultimas lineas de la salida del servidor (acotado: el archivo crece).
function Get-TailText {
  param([string[]]$Files, [int]$MaxBytes = 65536)
  $text = ""
  foreach ($file in $Files) {
    if ([string]::IsNullOrEmpty($file)) { continue }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    try {
      $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $length = $stream.Length
        $start = 0
        if ($length -gt $MaxBytes) { $start = $length - $MaxBytes }
        [void]$stream.Seek($start, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $text += $reader.ReadToEnd()
      } finally {
        $stream.Dispose()
      }
    } catch {
      # Un archivo que todavia se esta escribiendo puede fallar: no es un error.
    }
  }
  return $text
}

<#
  Arranca el servidor y espera `started` por el canal.
  Devuelve: ok, reason, message, exitCode, url, port, pid.
#>
function Invoke-ViuServerStart {
  param([Parameter(Mandatory = $true)]$Context)

  $log = New-Object System.Collections.ArrayList
  $addLog = { param($line) [void]$log.Add($line) }
  $result = [ordered]@{
    ok = $false; reason = "unknown"; message = ""; exitCode = $null
    url = $null; port = $null; pid = $null; log = $log
  }

  $dataRoot = $Context.DataDir
  $nodeExe = $Context.NodeExe
  $entry = $Context.Entry
  $outFile = $Context.OutFile
  $errFile = $Context.ErrFile
  $exchange = $Context.Exchange
  $controlId = $Context.ControlId
  $timeoutSeconds = [int]$Context.TimeoutSeconds
  if ($timeoutSeconds -le 0) { $timeoutSeconds = 120 }

  if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    $result.reason = "runtime-missing"
    $result.message = "No esta el runtime de Node en ""$nodeExe""."
    return [pscustomobject]$result
  }
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    $result.reason = "entry-missing"
    $result.message = "No se encontro el punto de entrada del servidor: ""$entry""."
    return [pscustomobject]$result
  }

  $previous = @{
    VIUREWARDS_DATA_DIR = $env:VIUREWARDS_DATA_DIR
    VIUREWARDS_NODE_RUNTIME = $env:VIUREWARDS_NODE_RUNTIME
    PORT = $env:PORT
  }

  $serverProcess = $null
  $processHandle = $null
  $pipeName = "\\.\pipe\viurewards-control-" + $controlId

  try {
    # Las variables se ponen justo antes de crear el proceso: `Start-Process`
    # hereda el entorno del proceso actual.
    $env:VIUREWARDS_DATA_DIR = $dataRoot
    $env:VIUREWARDS_NODE_RUNTIME = $nodeExe
    if ([int]$Context.Port -gt 0) { $env:PORT = [string]$Context.Port } else { Remove-Item Env:PORT -ErrorAction SilentlyContinue }

    # `WindowStyle Hidden`: el servidor no abre una consola propia. Lanzado desde
    # la GUI, `powershell.exe` no tiene consola y un hijo de consola abriria una
    # ventana negra nueva.
    # Los argumentos se arman ACA y no con `New-ServerArguments`: esta funcion
    # corre en un runspace nuevo, donde SOLO existe su propio cuerpo (ver
    # `New-BackgroundOperation`). Llamar a un helper del launcher fallaria con
    # "The term ... is not recognized" (defecto real, encontrado probando la GUI).
    $port = [int]$Context.Port
    $serverArguments = @('"' + $entry + '"', "--Control=$controlId", "--Exchange=$exchange")
    if ($port -gt 0) { $serverArguments += "--port=$port" }
    $serverProcess = Start-Process -FilePath $nodeExe `
      -ArgumentList $serverArguments `
      -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    # El handle se captura ANTES de esperar: despues .NET lo libera.
    $processHandle = $serverProcess.Handle
    $result.pid = $serverProcess.Id
    & $addLog ("Servidor iniciado (PID " + $serverProcess.Id + "). Esperando la confirmacion...")

    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    $pipeOpen = $false
    while ((Get-Date) -lt $deadline) {
      if ($serverProcess.HasExited) { break }
      if ([ViuLauncherPipe]::Open($pipeName)) { $pipeOpen = $true; break }
      Start-Sleep -Milliseconds 200
    }

    if (-not $pipeOpen) {
      if ($serverProcess.HasExited) {
        $code = [ViuLauncherExitCode]::Read($processHandle)
        $result.exitCode = $code
        if ($code -eq 3) {
          $result.reason = "data-in-use"
          $result.message = "Ya hay otra copia de VIUrewards usando estos datos. Esta ventana NO la detiene."
        } elseif ($code -eq 2) {
          $result.reason = "invalid-data-dir"
          $result.message = "El servidor rechazo la configuracion del directorio de datos."
        } elseif ($code -eq 1) {
          # El puerto ocupado (o un error de arranque) sale por la consola del
          # servidor: el detalle se muestra aparte, este mensaje solo orienta.
          $result.reason = "failed"
          $result.message = "El servidor no pudo arrancar (codigo 1). Revisa el detalle de abajo; si el puerto esta ocupado por otra aplicacion, elegi otro en Ajustes."
        } else {
          $result.reason = "exited-early"
          $result.message = "El servidor termino antes de estar listo (codigo $code)."
        }
      } else {
        $result.reason = "start-timeout"
        $result.message = "El servidor no abrio el canal de control en $timeoutSeconds s."
      }
      return [pscustomobject]$result
    }

    $sawStarted = $false
    while ((Get-Date) -lt $deadline) {
      $line = [ViuLauncherPipe]::ReadLine()
      if ($null -eq $line) {
        if ($serverProcess.HasExited) { break }
        Start-Sleep -Milliseconds 50
        continue
      }
      if ($line.Trim().Length -eq 0) { continue }
      $message = $null
      try { $message = $line | ConvertFrom-Json } catch { continue }
      if ($null -eq $message) { continue }
      # Aca NO se llama a `Format-ControlMessage`: esta funcion corre en un
      # runspace nuevo donde solo existe su propio cuerpo (ver el comentario de
      # `New-BackgroundOperation`). El texto se arma con un switch local.
      switch ($message.type) {
        "accepted" { & $addLog "El servidor acepto el canal de control." }
        "started" { & $addLog ("Servidor escuchando en el puerto " + $message.port + " (" + $message.dashboardUrl + ").") }
        "closing" { & $addLog ("El servidor esta cerrando (motivo: " + $message.reason + ").") }
        "finished" {
          if ($message.code -eq 0) { & $addLog "El servidor se cerro correctamente." } else { & $addLog ("El servidor termino con error: " + $message.message) }
        }
        default { & $addLog ("Mensaje de control desconocido: " + $message.type) }
      }
      if ($message.type -eq "started") {
        $sawStarted = $true
        $result.ok = $true
        $result.reason = "started"
        $result.message = "Servidor en ejecucion."
        $result.port = $message.port
        # Solo se acepta una URL http(s) del servidor local: `Abrir dashboard`
        # nunca abre algo que no haya informado el servidor.
        if ([string]$message.dashboardUrl -match '^https?://') { $result.url = [string]$message.dashboardUrl }
        break
      }
      if ($message.type -eq "finished") { break }
    }

    if (-not $sawStarted) {
      if ($serverProcess.HasExited) {
        $result.exitCode = [ViuLauncherExitCode]::Read($processHandle)
        $result.reason = "exited-before-started"
        $result.message = "El servidor termino antes de informar que estaba listo (codigo $($result.exitCode))."
      } else {
        $result.reason = "no-started"
        $result.message = "El servidor abrio el canal pero no informo que estuviera listo."
      }
      return [pscustomobject]$result
    }

    if ($result.url -match "^https?://") {
      $result.url = $result.url
    }
    # El proceso y su handle se devuelven a la GUI ANTES de armar el resultado: el
    # launcher SOLO detiene el que creo. Se asigna aca y no en el `finally`
    # porque la copia del contexto que ve la GUI puede formarse antes de que ese
    # bloque corra (defecto real: `$contexto.Process` llegaba vacio y el cierre
    # informado no encontraba el proceso).
    $Context.Process = $serverProcess
    $Context.ProcessHandle = $processHandle
    return [pscustomobject]$result
  } catch {
    $result.reason = "start-error"
    $result.message = $_.Exception.Message
    return [pscustomobject]$result
  } finally {
    # Respaldo (arranque fallido a mitad): si el proceso llego a crearse, se
    # conserva para poder detenerlo; despues de un exito ya se asigno arriba.
    if ($null -eq $Context.Process) {
      $Context.Process = $serverProcess
      $Context.ProcessHandle = $processHandle
    }
    foreach ($name in @($previous.Keys)) {
      if ($null -eq $previous[$name]) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
      } else {
        Set-Item -Path "Env:$name" -Value $previous[$name]
      }
    }
  }
}

<#
  Pide el cierre ordenado por el canal y espera `finished` + la terminacion real.
  Si el proceso no termina en el plazo, termina SOLO el arbol del proceso que
  este launcher creo.
#>
function Invoke-ViuServerStop {
  param([Parameter(Mandatory = $true)]$Context)

  $log = New-Object System.Collections.ArrayList
  $addLog = { param($line) [void]$log.Add($line) }
  $result = [ordered]@{
    ok = $false; reason = "unknown"; message = ""; exitCode = $null
    closed = $false; forced = $false; log = $log
    # Diagnostico (solo lectura): que factor de `ok` fallo. Se inicializan aca
    # porque StrictMode 2.0 rechaza leer una variable sin definir.
    sawFinished = $false; vanished = $false; eofBreak = $false
    # Como se decidio `vanished` (diagnostico): "immediate" si el primer sondeo
    # ya no vio el proceso, "poll" si desaparecio durante la espera, "hasexited"
    # si se acepto `HasExited` al agotar la espera, "none" si no desaparecio.
    vanishedBy = "none"; vanishedPolls = 0; vanishedMs = 0
  }

  $serverProcess = $Context.Process
  $processHandle = $Context.ProcessHandle
  $exchange = $Context.Exchange
  $controlId = $Context.ControlId
  $timeoutSeconds = [int]$Context.TimeoutSeconds
  if ($timeoutSeconds -le 0) { $timeoutSeconds = 45 }

  if ($null -eq $serverProcess) {
    $result.ok = $true
    $result.reason = "not-running"
    $result.message = "No hay un servidor iniciado por esta ventana."
    return [pscustomobject]$result
  }

  $pipeName = "\\.\pipe\viurewards-control-" + $controlId
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $sawFinished = $false

  try {
    if (-not $serverProcess.HasExited) {
      if ([ViuLauncherPipe]::Open($pipeName)) {
        # Orden autenticada: mismo protocolo de la Etapa 3A.
        [ViuLauncherPipe]::Send('{"type":"shutdown","exchange":"' + $exchange + '"}')
        & $addLog "Se pidio el cierre ordenado al servidor."
        while ((Get-Date) -lt $deadline) {
          $line = [ViuLauncherPipe]::ReadLine()
          if ($null -eq $line) {
            if ($serverProcess.HasExited) { $result.eofBreak = $true; break }
            Start-Sleep -Milliseconds 50
            continue
          }
          if ($line.Trim().Length -eq 0) { continue }
          $message = $null
          try { $message = $line | ConvertFrom-Json } catch { continue }
          if ($null -eq $message) { continue }
          # Mismo motivo que arriba: el worker de cierre es autocontenido.
          switch ($message.type) {
            "accepted" { & $addLog "El servidor acepto el canal de control." }
            "started" { & $addLog ("Servidor escuchando en el puerto " + $message.port + " (" + $message.dashboardUrl + ").") }
            "closing" { & $addLog ("El servidor esta cerrando (motivo: " + $message.reason + ").") }
            "finished" {
              if ($message.code -eq 0) { & $addLog "El servidor se cerro correctamente." } else { & $addLog ("El servidor termino con error: " + $message.message) }
            }
            default { & $addLog ("Mensaje de control desconocido: " + $message.type) }
          }
          if ($message.type -eq "finished") {
            $sawFinished = $true
            $result.closed = ($message.code -eq 0)
            if ($null -eq $result.exitCode) { $result.exitCode = [int]$message.code }
            break
          }
        }
      } else {
        & $addLog "No se pudo conectar al canal de control del servidor."
        $result.reason = "pipe-unavailable"
      }
      [ViuLauncherPipe]::Close()
    }

    $exited = $serverProcess.WaitForExit($timeoutSeconds * 1000)
    if (-not $exited) {
      & $addLog "El servidor no termino en $timeoutSeconds s: se termina el proceso que inicio esta ventana."
      # Solo el arbol de ESTE proceso hijo (`/PID <pid> /T`): nada por nombre.
      $null = & taskkill /PID $serverProcess.Id /T /F 2>&1
      $result.forced = $true
      $null = $serverProcess.WaitForExit(10000)
    }
    $null = $serverProcess.WaitForExit()
    # `Process` llega por el contexto de la operacion (creado en otro runspace o
    # recuperado de una ventana anterior). Cuando NO es hijo de este proceso,
    # Windows PowerShell 5.1 no puede leer su codigo de salida (`ExitCode` y
    # `GetExitCodeProcess` no estan disponibles para un proceso ajeno, medido).
    # Por eso el codigo autoritativo es el `finished` del canal: lo emite el
    # MISMO controlador de cierre de produccion justo antes de `exit()`.
    $handleExitCode = $null
    if ($null -ne $processHandle) {
      $read = [ViuLauncherExitCode]::Read($processHandle)
      if ($read -ge 0) { $handleExitCode = $read }
    }
    $vanished = $false
    # Espera acotada en vez de un unico chequeo. Motivo: `Get-Process -Id` puede
    # no encontrar el proceso justo despues de `WaitForExit` (Windows sigue
    # liberando el objeto) o, al reves, encontrarlo un instante mas. Se sondea
    # cada 100 ms hasta 3 s; si al agotarse sigue apareciendo, se acepta
    # `HasExited`. Esto MITIGA el falso negativo, no demuestra la causa.
    $vanishedBy = "none"
    $vanishedPolls = 0
    $vanishedWatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      $vanishedPolls++
      $stillThere = $false
      try { $stillThere = [bool](Get-Process -Id $serverProcess.Id -ErrorAction Stop) } catch { $stillThere = $false }
      if (-not $stillThere) {
        $vanished = $true
        if ($vanishedPolls -eq 1) { $vanishedBy = "immediate" } else { $vanishedBy = "poll" }
        break
      }
      if ($vanishedWatch.ElapsedMilliseconds -ge 3000) {
        $hasExited = $false
        try { $hasExited = [bool]$serverProcess.HasExited } catch { $hasExited = $false }
        if ($hasExited) { $vanished = $true; $vanishedBy = "hasexited" } else { $vanished = $false; $vanishedBy = "none" }
        break
      }
      Start-Sleep -Milliseconds 100
    }
    $vanishedWatch.Stop()
    $result.vanishedMs = [int]$vanishedWatch.ElapsedMilliseconds
    $result.exitCode = $handleExitCode
    if ($null -eq $result.exitCode -and -not $vanished) {
      try { $result.exitCode = $serverProcess.ExitCode } catch { $result.exitCode = $null }
    }
    # Solo hay cierre ordenado si el canal confirmo `finished` con codigo 0 y el
    # proceso salio de verdad (su cerrojo lo libero el propio servidor).
    $result.sawFinished = $sawFinished
    $result.vanished = $vanished
    $result.vanishedBy = $vanishedBy
    $result.vanishedPolls = $vanishedPolls
    $result.ok = $sawFinished -and (-not $result.forced) -and ($result.closed -or ($null -ne $result.exitCode -and $result.exitCode -eq 0)) -and $vanished
    if ($result.ok -and $null -eq $result.exitCode) { $result.exitCode = 0 }
    if ($result.ok) {
      $result.reason = "closed"
      $result.message = "El servidor se cerro ordenadamente."
    } elseif ($result.forced) {
      $result.reason = "forced"
      $result.message = "El servidor no respondio al cierre ordenado y se termino a la fuerza."
    } else {
      $result.reason = "unexpected-exit"
      $result.message = "El servidor se cerro con codigo $($result.exitCode)."
    }
    return [pscustomobject]$result
  } catch {
    $result.reason = "stop-error"
    $result.message = $_.Exception.Message
    return [pscustomobject]$result
  } finally {
    [ViuLauncherPipe]::Close()
  }
}

<#
  Ejecuta `install-tools.ps1` con los argumentos reales del instalador.
  Codigo 0 = listo; 2 rutas invalidas; 3 datos en uso; 1 fallo.
#>
function Invoke-ViuToolInstall {
  param([Parameter(Mandatory = $true)]$Context)

  $log = New-Object System.Collections.ArrayList
  $addLog = { param([string]$line) if (-not [string]::IsNullOrWhiteSpace($line)) { [void]$log.Add($line) } }
  $result = [ordered]@{ ok = $false; reason = "unknown"; message = ""; exitCode = $null; log = $log }

  $installer = $Context.Installer
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    $result.reason = "installer-missing"
    $result.message = "No se encontro el instalador de herramientas: ""$installer""."
    return [pscustomobject]$result
  }

  # Ruta con espacios: SIEMPRE por `-File` y con los argumentos en UN solo
  # string entrecomillado (como el servidor en `Invoke-ViuServerStart`). Con un
  # ARREGLO, `Start-Process` une y re-entrecomilla a su manera, parte la ruta y
  # PowerShell no encuentra el script: el hijo termina con un codigo distinto de
  # 0 (-196608) aunque `install-tools.ps1` nunca llegue a ejecutarse.
  $quotedInstaller = [string]::Concat([string][char]34, $installer, [string][char]34)
  $quotedDataDir = [string]::Concat([string][char]34, [string]$Context.DataDir, [string][char]34)
  $argumentLine = [string]::Join(" ", @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $quotedInstaller,
    "-DataDir",
    $quotedDataDir
  ))
  & $addLog "Preparando herramientas (Node.js, yt-dlp y FFmpeg)..."
  $stdout = $Context.OutputFile
  $stderr = $Context.ErrorFile
  $timeoutSeconds = [int]$Context.TimeoutSeconds
  if ($timeoutSeconds -le 0) { $timeoutSeconds = 1800 }

  $process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentLine -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  # El handle se captura ANTES de esperar: despues .NET lo libera y
  # `Process.ExitCode` queda vacio con la salida redirigida (el mismo defecto
  # que resuelve `Invoke-ViuServerStop`). Esa funcion corre desde el script
  # principal; esta corre en un runspace nuevo, asi que el tipo no tiene por
  # que estar cargado ahi: se registra si falta y, si no se puede, se cae a
  # `Process.ExitCode`.
  $exitCodeHandle = $null
  try { $exitCodeHandle = $process.Handle } catch { $exitCodeHandle = $null }
  $exited = $process.WaitForExit($timeoutSeconds * 1000)
  if (-not $exited) {
    $null = & taskkill /PID $process.Id /T /F 2>&1
    $result.reason = "install-timeout"
    $result.message = "La instalacion de herramientas no termino en $timeoutSeconds s."
    return [pscustomobject]$result
  }
  $null = $process.WaitForExit()
  $installExitCode = $null
  if ($null -ne $exitCodeHandle) {
    try {
      if (-not ("ViuLauncherExitCode" -as [type])) { Initialize-ExitCodeReader }
      $read = [ViuLauncherExitCode]::Read($exitCodeHandle)
      if ($read -ge 0) { $installExitCode = $read }
    } catch {
      $installExitCode = $null
    }
  }
  if ($null -eq $installExitCode) {
    try { $installExitCode = $process.ExitCode } catch { $installExitCode = $null }
  }
  $result.exitCode = $installExitCode

  # Salida del instalador: se muestran los pasos utiles (ya sin secretos: el
  # instalador no maneja el token) y el motivo final lo da su JSON.
  #
  # Esta funcion corre en un runspace nuevo, donde solo existe su propio cuerpo:
  # no puede llamar a `Get-TailText` ni a `Protect-LogLine`. La lectura acotada
  # y la limpieza del token se hacen aca (defecto real, de la GUI).
  $maxBytes = 65536
  $tail = ""
  foreach ($file in @($stdout, $stderr)) {
    if ([string]::IsNullOrEmpty($file)) { continue }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    try {
      $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $length = $stream.Length
        $start = 0
        if ($length -gt $maxBytes) { $start = $length - $maxBytes }
        [void]$stream.Seek($start, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $tail += $reader.ReadToEnd()
      } finally {
        $stream.Dispose()
      }
    } catch {
      # Un archivo que todavia se esta escribiendo puede fallar: no es un error.
    }
  }
  foreach ($line in ($tail -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    & $addLog ([regex]::Replace($line, '--Exchange=\S+', '--Exchange=***').TrimEnd())
  }

  $detail = $null
  foreach ($line in ($tail -split "`r?`n")) {
    $trimmed = $line.Trim()
    if (-not $trimmed.StartsWith("{")) { continue }
    try {
      $parsed = $trimmed | ConvertFrom-Json
      if ($null -ne $parsed -and $null -ne $parsed.PSObject.Properties["status"]) { $detail = $parsed }
    } catch {
      # No es el JSON final: se ignora.
    }
  }
  if ($null -ne $detail -and -not [string]::IsNullOrWhiteSpace($detail.message)) {
    & $addLog ([string]$detail.message)
  }

  switch ($result.exitCode) {
    0 {
      $result.ok = $true
      $result.reason = "installed"
      $result.message = "Herramientas listas."
    }
    3 {
      $result.reason = "data-in-use"
      $result.message = "Otra copia de VIUrewards esta usando estos datos. Cerrala y volve a intentar."
    }
    2 {
      $result.reason = "invalid-data-dir"
      $result.message = "El instalador rechazo la configuracion del directorio de datos."
      if ($null -ne $detail -and -not [string]::IsNullOrWhiteSpace($detail.message)) { $result.message = [string]$detail.message }
    }
    default {
      $result.reason = "install-failed"
      $result.message = "La instalacion de herramientas fallo (codigo $($result.exitCode))."
      if ($null -ne $detail -and -not [string]::IsNullOrWhiteSpace($detail.message)) { $result.message = [string]$detail.message }
    }
  }
  return [pscustomobject]$result
}

# ==============================================================================
# Inicio con Windows (acceso directo en la carpeta de Inicio del usuario)
# ==============================================================================

function Get-StartupLinkPath {
  param([string]$StartupFolder = "")
  if ([string]::IsNullOrWhiteSpace($StartupFolder)) {
    $StartupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  }
  return (Join-Path $StartupFolder "VIUrewards.lnk")
}

<#
  Crea/elimina el acceso directo de inicio. Idempotente y acotado a la carpeta
  de Inicio del usuario actual (sin privilegios de administrador). El acceso
  directo invoca ESTE .ps1 con `-AutoStart`: el servidor sigue siendo hijo del
  launcher, asi que conserva el token y se puede detener.
#>
function Set-StartupShortcut {
  param(
    [Parameter(Mandatory = $true)][bool]$Enabled,
    [Parameter(Mandatory = $true)][string]$LauncherPath,
    [Parameter(Mandatory = $true)][string]$ApplicationRoot,
    [string]$StartupFolder = ""
  )
  $link = Get-StartupLinkPath $StartupFolder
  if (-not $Enabled) {
    if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
    return $link
  }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = "powershell.exe"
  # Entrecomillado obligatorio: la aplicacion puede estar en una ruta con espacios.
  $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $LauncherPath + '" -AutoStart'
  $shortcut.WorkingDirectory = $ApplicationRoot
  $shortcut.Description = "VIUrewards"
  $shortcut.Save()
  return $link
}

function Test-StartupShortcut {
  param([string]$StartupFolder = "")
  return (Test-Path -LiteralPath (Get-StartupLinkPath $StartupFolder) -PathType Leaf)
}

# ==============================================================================
# Interfaz (Windows Forms)
# ==============================================================================

# Arranca una operacion en un runspace aparte; la GUI la sondea con un timer.
#
# El runspace es NUEVO y solo recibe el CUERPO del scriptblock (`$Worker`), no el
# resto del launcher: las funciones del launcher (`New-ServerArguments`,
# `Get-TailText`, `Protect-LogLine`, ...) NO existen ahi. Un worker tiene que ser
# autocontenido; si necesita un helper, se duplica dentro. Se descubrio probando
# la GUI: el arranque fallaba con "The term 'New-ServerArguments' is not
# recognized" y el launcher lo reportaba como `start-error` sin detalle.
function New-BackgroundOperation {
  param([scriptblock]$Worker, [hashtable]$Context, [scriptblock]$OnDone)
  $runspace = [runspacefactory]::CreateRunspace()
  $runspace.ApartmentState = "MTA"
  $runspace.ThreadOptions = "ReuseThread"
  $runspace.Open()
  $contextArg = [pscustomobject]$Context
  $powershell = [powershell]::Create()
  $powershell.Runspace = $runspace
  [void]$powershell.AddScript($Worker.ToString()).AddArgument($contextArg)
  $handle = $powershell.BeginInvoke()
  return @{ PowerShell = $powershell; Handle = $handle; Runspace = $runspace; OnDone = $OnDone; Context = $contextArg }
}

# ==============================================================================
# Autoprueba sin interfaz (tests de distribucion)
# ==============================================================================

function Invoke-ViuLauncherSelfTest {
  $report = [ordered]@{
    ok = $false
    appRoot = $null
    scriptRoot = $PSScriptRoot
    launcher = $script:LauncherScript
    dataDir = $null
    dataDirSource = $null
    dataDirError = $null
    outsideApplication = $null
    nodeExe = $null
    nodeExists = $false
    entry = $null
    entryExists = $false
    installer = $null
    installerExists = $false
    missingTools = @()
    controlIdLength = 0
    tokenLength = 0
    arguments = @()
    pipelessRun = $false
    formsAvailable = $false
    startWorkerOk = $false
    startWorkerReason = $null
    startWorkerError = $null
    controls = @()
    errors = @()
  }
  try {
    $report.appRoot = Get-ApplicationRoot $PSScriptRoot
    if ($null -eq $report.appRoot) { throw "No se pudo determinar la raiz de la aplicacion desde ""$PSScriptRoot""." }

    $resolved = Resolve-LauncherDataDir -Requested $script:RequestedDataDir -ApplicationRoot $report.appRoot `
      -EnvironmentValue ([Environment]::GetEnvironmentVariable("VIUREWARDS_DATA_DIR"))
    $report.dataDir = $resolved.path
    $report.dataDirSource = $resolved.source
    $report.dataDirError = $resolved.error
    if ($null -ne $resolved.path -and $null -eq $resolved.error) {
      $report.outsideApplication = -not (Test-PathInside $report.appRoot $resolved.path)
      $report.missingTools = @(Get-MissingTools $resolved.path)
      $report.nodeExe = Get-NodeRuntimePath $resolved.path
      $report.nodeExists = (Test-Path -LiteralPath $report.nodeExe -PathType Leaf)
    }

    $report.entry = Join-Path $report.appRoot ($script:EntryRelativePath -join [System.IO.Path]::DirectorySeparatorChar)
    $report.entryExists = (Test-Path -LiteralPath $report.entry -PathType Leaf)
    $report.installer = Join-Path $report.appRoot ($script:InstallerRelativePath -join [System.IO.Path]::DirectorySeparatorChar)
    $report.installerExists = (Test-Path -LiteralPath $report.installer -PathType Leaf)

    # Sin launcher no hay canal: con `npm start` no se pasa `--Control`.
    $report.pipelessRun = -not [bool]$PSBoundParameters

    $controlId = New-ControlId
    $token = New-ExchangeToken
    $report.controlIdLength = $controlId.Length
    $report.tokenLength = $token.Length
    $report.arguments = @(New-ServerArguments -EntryPath $report.entry -ControlId $controlId -Exchange $token -Port 0)
    if ($report.arguments -notcontains "--Control=$controlId") { throw "Los argumentos no llevan --Control." }
    if ($report.arguments -notcontains "--Exchange=$token") { throw "Los argumentos no llevan --Exchange." }
    if ((Get-ControlPipeName $controlId) -ne ("\\.\pipe\viurewards-control-" + $controlId)) { throw "El nombre del pipe no coincide con el protocolo." }

    # Windows Forms de verdad, con los MISMOS tipos y propiedades que usa la
    # ventana: si el entorno no lo tiene (o se usa una propiedad que no existe),
    # esto falla y el test lo informa (nunca se marca como aprobado).
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $report.formsAvailable = $true
    $probe = New-Object System.Windows.Forms.Form
    $probe.Text = "VIUrewards"
    $probe.ClientSize = New-Object System.Drawing.Size(760, 520)
    $probe.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $layout = New-Object System.Windows.Forms.TableLayoutPanel
    $layout.Dock = "Fill"
    $probe.Controls.Add($layout)
    $label = New-Object System.Windows.Forms.Label
    $label.Name = "statusLabel"
    $label.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
    $probe.Controls.Add($label)
    $button = New-Object System.Windows.Forms.Button
    $button.Name = "startButton"
    $button.AutoSize = $true
    $button.Enabled = $false
    $probe.Controls.Add($button)
    $text = New-Object System.Windows.Forms.TextBox
    $text.Name = "logTextBox"
    $text.Multiline = $true
    $text.ReadOnly = $true
    $probe.Controls.Add($text)
    $check = New-Object System.Windows.Forms.CheckBox
    $check.Name = "autoStartCheckBox"
    $check.Checked = $false
    $probe.Controls.Add($check)
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 200
    # `NotifyIcon` NO tiene propiedad `Name`: ese fue un defecto real que este
    # recorrido detecta (la ventana fallaba al construirse).
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Text = "VIUrewards"
    $notify.Icon = [System.Drawing.SystemIcons]::Application
    $notify.Visible = $false
    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    [void]$menu.Items.Add("Salir")
    $notify.ContextMenuStrip = $menu
    $notify.Dispose()
    $menu.Dispose()
    $timer.Dispose()
    $probe.Dispose()
    $report.controls = @("Form", "TableLayoutPanel", "Label", "Button", "TextBox", "CheckBox", "Timer", "NotifyIcon", "ContextMenuStrip")

    # Workers: tienen que ser AUTOCONTENIDOS. Se ejecutan tal cual en un runspace
    # nuevo, sin helpers del launcher (defecto real: el arranque fallaba con "The
    # term 'New-ServerArguments' is not recognized"). Se corta ANTES de crear el
    # proceso: runtime y entry inexistentes devuelven ese motivo, sin efectos.
    $probeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("viu-selftest-" + [guid]::NewGuid().ToString("N"))
    # Tiene que ser una HASHTABLE: `New-BackgroundOperation` declara
    # `[hashtable]$Context` (el pscustomobject lo entrega al worker como
    # `PSCustomObject`, que no convierte a `[hashtable]`).
    $probeContext = @{
      DataDir = $probeDir
      NodeExe = (Join-Path $probeDir (Join-Path "runtime" "node.exe"))
      Entry = (Join-Path $probeDir "scripts\start.ts")
      Exchange = $token
      ControlId = $controlId
      Port = 0
      OutFile = (Join-Path $probeDir "srv.out")
      ErrFile = (Join-Path $probeDir "srv.err")
      TimeoutSeconds = 30
      Process = $null
      ProcessHandle = $null
    }
    $worker = New-BackgroundOperation -Worker ${function:Invoke-ViuServerStart} -Context $probeContext -OnDone { param($r, $c) }
    try {
      $null = $worker.Handle.AsyncWaitHandle.WaitOne(30000)
      $workerOutput = $worker.PowerShell.EndInvoke($worker.Handle)
      $startProbe = $null
      if ($null -ne $workerOutput -and $workerOutput.Count -gt 0) { $startProbe = $workerOutput[$workerOutput.Count - 1] }
      $report.startWorkerReason = if ($null -eq $startProbe) { "sin resultado" } else { [string]$startProbe.reason }
      $report.startWorkerOk = ($report.startWorkerReason -eq "runtime-missing")
      foreach ($errorRecord in ($worker.PowerShell.Streams.Error | Select-Object -First 1)) {
        $report.startWorkerError = $errorRecord.Exception.Message
      }
    } finally {
      $worker.PowerShell.Dispose()
      $worker.Runspace.Dispose()
    }
    if (Test-Path -LiteralPath $probeDir) { Remove-Item -LiteralPath $probeDir -Recurse -Force }

    $report.ok = ($null -eq $report.dataDirError) -and $report.entryExists -and $report.installerExists -and $report.formsAvailable -and $report.startWorkerOk
  } catch {
    $report.errors += $_.Exception.Message
    $report.ok = $false
  }
  $json = $report | ConvertTo-Json -Depth 6
  if (-not [string]::IsNullOrWhiteSpace($SelfTestOutput)) {
    Set-Content -LiteralPath $SelfTestOutput -Value $json -Encoding UTF8
  } else {
    Write-Output $json
  }
  if ($report.ok) { return 0 }
  return 1
}

function Show-ViuLauncher {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Initialize-ControlPipe
  Initialize-ExitCodeReader

  $root = Get-ApplicationRoot $PSScriptRoot
  if ($null -eq $root) {
    [System.Windows.Forms.MessageBox]::Show(
      "No se pudo determinar la raiz de la aplicacion desde ""$PSScriptRoot"".",
      "VIUrewards", "OK", "Error") | Out-Null
    return 1
  }
  $resolved = Resolve-LauncherDataDir -Requested $script:RequestedDataDir -ApplicationRoot $root `
    -EnvironmentValue ([Environment]::GetEnvironmentVariable("VIUREWARDS_DATA_DIR"))
  if (-not [string]::IsNullOrWhiteSpace($resolved.error)) {
    [System.Windows.Forms.MessageBox]::Show($resolved.error, "VIUrewards", "OK", "Error") | Out-Null
    return 2
  }
  $script:Root = $root
  $script:DataRoot = $resolved.path
  $script:NodeExe = Get-NodeRuntimePath $resolved.path
  $script:Entry = Join-Path $root ($script:EntryRelativePath -join [System.IO.Path]::DirectorySeparatorChar)
  $script:Installer = Join-Path $root ($script:InstallerRelativePath -join [System.IO.Path]::DirectorySeparatorChar)

  # Estado del ciclo de vida (una sola copia, siempre en el hilo de interfaz).
  $script:State = "detenido"
  # Proceso que inicio ESTA ventana (o adoptado por el cerrojo, ver abajo).
  $script:ServerProcess = $null
  $script:ProcessHandle = $null
  # Como se llego a ese proceso: "launched" (lo creo este launcher) u
  # "adopted" (lo lanzo una version anterior de esta ventana que cerro sin
  # detenerlo y dejo los datos tomados). Se derivan del estado REAL, no de lo
  # que diga la pantalla: es lo que impide que un arranque normal termine
  # matando o "deteniendo" el servidor de otra ventana abierta con los mismos
  # datos.
  $script:ServerOwnership = $null
  $script:Exchange = $null
  $script:ControlId = $null
  $script:DashboardUrl = $null
  $script:Pending = $null
  $script:Closing = $false
  $script:ExitAfterStop = $false
  $script:AutoStartMode = $false
  $script:TrayHintShown = $false
  $script:OutFile = $null
  $script:ErrFile = $null
  # Servidor reconocido de una ventana anterior (ver `Invoke-ViuAdoptServer`).
  $script:PendingRecovery = $null

  # --- Ventana ----------------------------------------------------------------
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "VIUrewards"
  $form.ClientSize = New-Object System.Drawing.Size(760, 520)
  $form.MinimumSize = New-Object System.Drawing.Size(640, 440)
  $form.StartPosition = "CenterScreen"
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

  $layout = New-Object System.Windows.Forms.TableLayoutPanel
  $layout.Dock = "Fill"
  $layout.ColumnCount = 1
  $layout.RowCount = 4
  $layout.Padding = New-Object System.Windows.Forms.Padding(12)
  [void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 34)))
  [void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 44)))
  [void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 38)))
  [void]$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100)))
  $form.Controls.Add($layout)

  $status = New-Object System.Windows.Forms.Label
  $status.Name = "statusLabel"
  $status.Text = "Detenido"
  $status.AutoSize = $false
  $status.Dock = "Fill"
  $status.TextAlign = "MiddleLeft"
  $status.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
  [void]$layout.Controls.Add($status, 0, 0)

  $buttons = New-Object System.Windows.Forms.FlowLayoutPanel
  $buttons.Name = "buttonPanel"
  $buttons.Dock = "Fill"
  $buttons.WrapContents = $false
  $buttons.FlowDirection = "LeftToRight"

  $startButton = New-Object System.Windows.Forms.Button
  $startButton.Name = "startButton"
  $startButton.Text = "Iniciar servidor"
  $startButton.AutoSize = $true
  $startButton.MinimumSize = New-Object System.Drawing.Size(130, 30)
  [void]$buttons.Controls.Add($startButton)

  $stopButton = New-Object System.Windows.Forms.Button
  $stopButton.Name = "stopButton"
  $stopButton.Text = "Detener servidor"
  $stopButton.AutoSize = $true
  $stopButton.MinimumSize = New-Object System.Drawing.Size(130, 30)
  $stopButton.Enabled = $false
  [void]$buttons.Controls.Add($stopButton)

  $openButton = New-Object System.Windows.Forms.Button
  $openButton.Name = "openButton"
  $openButton.Text = "Abrir dashboard"
  $openButton.AutoSize = $true
  $openButton.MinimumSize = New-Object System.Drawing.Size(130, 30)
  $openButton.Enabled = $false
  [void]$buttons.Controls.Add($openButton)

  [void]$layout.Controls.Add($buttons, 0, 1)

  $options = New-Object System.Windows.Forms.CheckBox
  $options.Name = "autoStartCheckBox"
  $options.Text = "Iniciar con Windows"
  $options.AutoSize = $true
  $options.Padding = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)
  [void]$layout.Controls.Add($options, 0, 2)

  $logView = New-Object System.Windows.Forms.TextBox
  $logView.Name = "logTextBox"
  $logView.Multiline = $true
  $logView.ReadOnly = $true
  $logView.ScrollBars = "Vertical"
  $logView.Dock = "Fill"
  $logView.BackColor = [System.Drawing.Color]::White
  $logView.Font = New-Object System.Drawing.Font("Consolas", 9)
  [void]$layout.Controls.Add($logView, 0, 3)

  # --- Bandeja ----------------------------------------------------------------
  # OJO: `Visible = $true` se deja para DESPUES de que el message loop este
  # corriendo (ver el tramo final). Activarlo aca funcionaba a medias: el icono
  # se dibujaba en la bandeja pero los clics no llegaban nunca a sus handlers
  # (medido: el proceso no respondia ni al doble clic ni al clic derecho).
  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Text = "VIUrewards"
  $notify.Icon = [System.Drawing.SystemIcons]::Application
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $menuShow = $menu.Items.Add("Mostrar ventana")
  $menuOpen = $menu.Items.Add("Abrir dashboard")
  $menuStop = $menu.Items.Add("Detener servidor")
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $menuExit = $menu.Items.Add("Salir")
  $notify.ContextMenuStrip = $menu
  $menuOpen.Enabled = $false
  $menuStop.Enabled = $false

  # --- Utilidades (definidas ANTES de cualquier uso) ---------------------------
  $appendLog = {
    param([string]$Line)
    if ([string]::IsNullOrWhiteSpace($Line)) { return }
    $stamp = (Get-Date).ToString("HH:mm:ss")
    $logView.AppendText("[$stamp] $(Protect-LogLine $Line $script:Exchange)`r`n")
  }

  # Solo audio de los ultimos bytes del archivo del servidor (no vuelca todo).
  $flushOutput = {
    $text = Get-TailText -Files @($script:OutFile, $script:ErrFile) -MaxBytes $script:LogTailBytes
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    foreach ($line in ($text -split "`r?`n")) {
      if (-not [string]::IsNullOrWhiteSpace($line)) { & $appendLog $line }
    }
  }

  $setControls = {
    $busy = ($script:State -eq "preparando" -or $script:State -eq "iniciando" -or $script:State -eq "deteniendo")
    $running = ($script:State -eq "ejecutando")
    $hasServer = ($null -ne $script:ServerProcess)
    $hasUrl = -not [string]::IsNullOrEmpty($script:DashboardUrl)
    $startButton.Enabled = (-not $busy) -and (-not $running) -and (-not $hasServer)
    $stopButton.Enabled = (-not $busy) -and $hasServer
    $openButton.Enabled = $hasUrl
    $menuStop.Enabled = $stopButton.Enabled
    $menuOpen.Enabled = $hasUrl
  }

  $setState = {
    param([string]$NewState)
    $script:State = $NewState
    switch ($NewState) {
      "detenido" { $status.Text = "Detenido" ; $status.ForeColor = [System.Drawing.Color]::FromArgb(60, 60, 60) }
      "preparando" { $status.Text = "Preparando herramientas..." ; $status.ForeColor = [System.Drawing.Color]::FromArgb(150, 95, 0) }
      "iniciando" { $status.Text = "Iniciando..." ; $status.ForeColor = [System.Drawing.Color]::FromArgb(150, 95, 0) }
      "ejecutando" { $status.Text = "En ejecucion" ; $status.ForeColor = [System.Drawing.Color]::FromArgb(0, 110, 55) }
      "deteniendo" { $status.Text = "Deteniendo..." ; $status.ForeColor = [System.Drawing.Color]::FromArgb(150, 95, 0) }
      "error" { $status.Text = "Error" ; $status.ForeColor = [System.Drawing.Color]::FromArgb(165, 30, 30) }
      default { $status.Text = $NewState }
    }
    & $setControls
    $notify.Text = "VIUrewards - " + $status.Text
  }

  # Ofrece recuperar el servidor que quedo vivo de una ventana anterior. No se
  # adopta solo: el usuario tiene que aceptar (podria ser otro usuario de esta
  # PC usando el mismo directorio de datos).
  $offerRecovery = {
    $pending = $script:PendingRecovery
    if ($null -eq $pending) { return }
    & $appendLog ("Se encontro un servidor de VIUrewards de una ventana anterior (PID " + $pending.ProcessId + ") que sigue usando estos datos.")
    $answer = [System.Windows.Forms.MessageBox]::Show(
      "Un servidor de VIUrewards iniciado por una ventana anterior sigue en ejecucion y tiene tomados los datos." + [Environment]::NewLine + [Environment]::NewLine +
      "Detenerlo permite usar esta ventana y libera el cerrojo. No se cierran datos ni se pierde nada." + [Environment]::NewLine + [Environment]::NewLine +
      "Detenerlo ahora?", "VIUrewards", "YesNo", "Question")
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
      $script:PendingRecovery = $null
      & $appendLog "No se detuvo el servidor anterior."
      return
    }
    & $acceptRecovery
  }

  # Adopta el servidor reconocido y lo detiene por el canal autenticado (misma
  # secuencia de cierre que todo lo demas). Al terminar se puede volver a
  # iniciar sin cerrar la ventana.
  $acceptRecovery = {
    $pending = $script:PendingRecovery
    if ($null -eq $pending) { return }
    $script:PendingRecovery = $null
    # A partir de aca la ventana es duena del canal de ESE proceso.
    $script:ServerProcess = $pending.Process
    $script:ProcessHandle = $null
    $script:ServerOwnership = "launched"
    $script:Exchange = $pending.Exchange
    $script:ControlId = $pending.ControlId
    $script:State = "detenido"
    & $appendLog ("Deteniendo el servidor anterior (PID " + $pending.ProcessId + ").")
    & $beginStop -Quiet
  }

  # Abre la URL real que informo el servidor (nunca una inventada).
  $openDashboard = {
    if ([string]::IsNullOrEmpty($script:DashboardUrl)) {
      & $appendLog "Todavia no hay una URL de dashboard: inicia el servidor primero."
      return
    }
    try {
      Start-Process $script:DashboardUrl | Out-Null
    } catch {
      & $appendLog ("No se pudo abrir el navegador: " + $_.Exception.Message)
    }
  }

  $syncStartupCheckbox = {
    $options.Checked = (Test-StartupShortcut)
  }

  $applyStartup = {
    param([bool]$Enabled)
    $link = Set-StartupShortcut -Enabled $Enabled -LauncherPath $script:LauncherScript -ApplicationRoot $script:Root
    if ($Enabled) {
      & $appendLog ("Inicio con Windows activado (" + $link + ").")
    } else {
      & $appendLog "Inicio con Windows desactivado."
    }
    & $syncStartupCheckbox
  }

  # Sondeo de la operacion en curso: nunca bloquea el hilo de interfaz.
  $pollTimer = New-Object System.Windows.Forms.Timer
  $pollTimer.Interval = 200
  $pollTimer.Add_Tick({
    $pending = $script:Pending
    if ($null -eq $pending) { return }
    if (-not $pending.Handle.IsCompleted) { return }
    # Al cerrar la ventana el timer se detiene (ver `FormClosed`); una ultima
    # vencida ya en cola no debe volver a cerrar el runspace ni pisar el estado
    # de la operacion que se estaba deteniendo.
    if ($script:Closing) { return }
    $pollTimer.Stop()
    $script:Pending = $null
    $output = $null
    try {
      $output = $pending.PowerShell.EndInvoke($pending.Handle)
      foreach ($errorRecord in $pending.PowerShell.Streams.Error) {
        & $appendLog ("Error: " + $errorRecord.Exception.Message)
      }
    } catch {
      & $appendLog ("Error interno: " + $_.Exception.Message)
    } finally {
      $pending.PowerShell.Dispose()
      $pending.Runspace.Dispose()
    }
    $resultado = $null
    if ($null -ne $output -and $output.Count -gt 0) { $resultado = $output[$output.Count - 1] }
    # El callback es codigo de la GUI y se ejecuta en el message pump: si lanza,
    # la ventana quedaria trabada en "Iniciando...". Se informa y se vuelve a
    # "Error" en vez de propagar.
    try {
      & $pending.OnDone $resultado $pending.Context
    } catch {
      & $appendLog ("Error en el callback: " + $_.Exception.Message)
      $script:ServerProcess = $null
      $script:ProcessHandle = $null
      $script:DashboardUrl = $null
      & $setState "error"
    }
  })

  # OJO: en un scriptblock, `param(...)` tiene que ir primero; una sentencia
  # antes hace que PowerShell lo trate como COMANDO y falle (verificado).
  $runOperation = {
    param([scriptblock]$Worker, [hashtable]$Context, [scriptblock]$OnDone)
    $script:Pending = New-BackgroundOperation -Worker $Worker -Context $Context -OnDone $OnDone
    $pollTimer.Start()
  }

  # --- Inicio y detencion (trampolines: se pueden referenciar antes de definir) --

  $beginServerStart = {
    & $setState "iniciando"
    & $appendLog "Iniciando el servidor..."
    $startContext = @{
      DataDir = $script:DataRoot
      NodeExe = $script:NodeExe
      Entry = $script:Entry
      Exchange = $script:Exchange
      ControlId = $script:ControlId
      # 0 = el sistema elige un puerto libre: dos instancias nunca chocan.
      Port = 0
      OutFile = $script:OutFile
      ErrFile = $script:ErrFile
      TimeoutSeconds = $script:StartTimeoutSeconds
      Process = $null
      ProcessHandle = $null
    }
    $onStartDone = {
      param($resultado, $contexto)
      # El proceso se conserva SOLO si sigue vivo y esta ventana lo puede
      # controlar. Un arranque fallido deja un proceso que ya salio (codigo 3,
      # 2 o 1) o uno que abrio el canal pero nunca informo `started` sin token
      # utilizable: en los dos casos no hay nada que detener, y conservarlo hacia
      # que el launcher "adoptara" un proceso que no puede controlar.
      $ok = ($null -ne $resultado -and $resultado.ok)
      if ($ok) {
        $script:ServerProcess = $contexto.Process
        $script:ProcessHandle = $contexto.ProcessHandle
        $script:ServerOwnership = "launched"
      } else {
        $script:ServerProcess = $null
        $script:ProcessHandle = $null
        $script:ServerOwnership = $null
      }
      if (-not $ok) {
        $detalle = if ($null -eq $resultado) { "sin resultado" } else { $resultado.message }
        & $appendLog $detalle
        & $flushOutput
        if ($null -ne $resultado -and $resultado.reason -eq "data-in-use") {
          & $appendLog "Otra copia de VIUrewards ya usa estos datos: esta ventana NO la detiene."
          # Si es un servidor que quedo vivo de una ventana anterior (este
          # launcher cerrado sin detenerlo), se OFRECE recuperarlo. Solo se
          # acepta con el cerrojo del servidor y el nombre del canal, y siempre
          # se confirma que el proceso sea el dueno del cerrojo antes de tocarlo.
          # Los datos y la aplicacion salen del estado de la ventana (esta
          # funcion corre en el hilo de interfaz, no en el worker).
          $script:PendingRecovery = Invoke-ViuAdoptServer -Context @{
            DataRoot = $script:DataRoot
            Entry = $script:Entry
          }
          if ($null -ne $script:PendingRecovery) {
            & $offerRecovery
          }
        }
        & $setState "error"
        # Una salida pedida durante el arranque se cumple ahora: no hay
        # servidor que controlar.
        if ($script:ExitAfterStop) { $script:Closing = $true; $form.Close() }
        return
      }
      $script:DashboardUrl = $resultado.url
      & $appendLog $resultado.message
      & $setState "ejecutando"
      if ($script:AutoStartMode) { $form.Hide() }
      if ($script:ExitAfterStop) { & $beginStop }
    }
    & $runOperation ${function:Invoke-ViuServerStart} $startContext $onStartDone
  }

  $beginStart = {
    if ($script:State -eq "preparando" -or $script:State -eq "iniciando" -or $script:State -eq "deteniendo") { return }
    if ($null -ne $script:ServerProcess) { return }

    $script:DashboardUrl = $null
    $code = New-ControlId
    $token = New-ExchangeToken
    # El token solo vive en memoria del launcher y en los argumentos del proceso.
    $script:ControlId = $code
    $script:Exchange = $token
    $script:OutFile = Join-Path ([System.IO.Path]::GetTempPath()) ("viu-launcher-" + $code + ".out")
    $script:ErrFile = Join-Path ([System.IO.Path]::GetTempPath()) ("viu-launcher-" + $code + ".err")

    if (-not (Test-Path -LiteralPath $script:DataRoot -PathType Container)) {
      New-Item -ItemType Directory -Path $script:DataRoot -Force | Out-Null
    }
    & $appendLog ("Directorio de datos: " + $script:DataRoot)

    $missing = @(Get-MissingTools $script:DataRoot)
    $needsNode = -not (Test-Path -LiteralPath $script:NodeExe -PathType Leaf)

    if ($needsNode -or $missing.Count -gt 0) {
      & $setState "preparando"
      $faltan = @()
      if ($needsNode) { $faltan += "runtime/node.exe" }
      if ($missing.Count -gt 0) { $faltan += $missing }
      & $appendLog ("Faltan herramientas (" + ($faltan -join ", ") + "). Se ejecuta el instalador.")
      $installContext = @{
        Installer = $script:Installer
        DataDir = $script:DataRoot
        OutputFile = $script:OutFile
        ErrorFile = $script:ErrFile
        TimeoutSeconds = $script:InstallTimeoutSeconds
      }
      $onInstallDone = {
        param($resultado, $contexto)
        if ($null -eq $resultado -or -not $resultado.ok) {
          $reason = if ($null -eq $resultado) { "sin resultado" } else { $resultado.message }
          & $appendLog ("No se pudo preparar el entorno: " + $reason)
          if ($null -ne $resultado -and $resultado.reason -eq "data-in-use") {
            & $appendLog "La ventana no intenta detener ni cerrar la instancia existente."
            # El INSTALADOR tambien detecta los datos en uso (codigo 3): si el
            # dueno es un servidor de una ventana anterior, se ofrece recuperarlo
            # igual que cuando lo detecta el arranque.
            $script:PendingRecovery = Invoke-ViuAdoptServer -Context @{
              DataRoot = $script:DataRoot
              Entry = $script:Entry
            }
            if ($null -ne $script:PendingRecovery) { & $offerRecovery }
          }
          & $setState "error"
          if ($script:ExitAfterStop) { $script:Closing = $true; $form.Close() }
          return
        }
        & $appendLog $resultado.message
        # Salir pedido durante la preparacion: no se arranca el servidor para
        # detenerlo un segundo despues.
        if ($script:ExitAfterStop) { $script:Closing = $true; $form.Close(); return }
        & $beginServerStart
      }
      & $runOperation ${function:Invoke-ViuToolInstall} $installContext $onInstallDone
      return
    }

    & $beginServerStart
  }

  $beginStop = {
    param([switch]$Quiet)
    if ($script:State -eq "preparando" -or $script:State -eq "iniciando" -or $script:State -eq "deteniendo") { return }
    if ($null -eq $script:ServerProcess) {
      if (-not $Quiet) { & $appendLog "No hay un servidor iniciado por esta ventana." }
      & $setState "detenido"
      # Una salida pedida mientras se detenia o al detenerse no se puede perder:
      # si no hay servidor que controlar, la ventana se cierra ACA.
      if ($script:ExitAfterStop) { $script:Closing = $true; $form.Close() }
      return
    }
    # Solo se detiene un proceso que ESTA ventana controla. `launched`: lo creo
    # aca (o se recupero con su token, y entonces ya es suyo). Sin dueno
    # conocido no se envia nada ni se mata nada: el proceso puede ser el
    # servidor de otra ventana abierta con los mismos datos.
    if ($script:ServerOwnership -ne "launched") {
      & $appendLog "Esta ventana no tiene el control del servidor en ejecucion: no lo detiene ni lo termina."
      & $setState "error"
      if ($script:ExitAfterStop) { $script:Closing = $true; $form.Close() }
      return
    }
    & $setState "deteniendo"
    & $appendLog "Pidiendo el cierre ordenado..."
    $stopContext = @{
      Process = $script:ServerProcess
      ProcessHandle = $script:ProcessHandle
      Exchange = $script:Exchange
      ControlId = $script:ControlId
      TimeoutSeconds = $script:StopTimeoutSeconds
    }
    $onStopDone = {
      param($resultado, $contexto)
      & $flushOutput
      if ($null -eq $resultado) {
        & $appendLog "No se recibio el resultado del cierre."
        & $setState "error"
      } else {
        & $appendLog $resultado.message
      }
      $script:ServerProcess = $null
      $script:ProcessHandle = $null
      $script:ServerOwnership = $null
      $script:DashboardUrl = $null
      $script:Exchange = $null
      $script:ControlId = $null
      $script:PendingRecovery = $null
      if ($null -eq $resultado -or -not $resultado.ok) {
        & $setState "error"
      } else {
        & $setState "detenido"
      }
      # Salir pedido durante el cierre: la ventana termina UNA vez que el
      # servidor ya salio (nunca antes: dejaria el proceso sin control).
      if ($script:ExitAfterStop) {
        $script:Closing = $true
        $form.Close()
      }
    }
    & $runOperation ${function:Invoke-ViuServerStop} $stopContext $onStopDone
  }

  # --- Eventos ----------------------------------------------------------------
  $startButton.Add_Click({ & $beginStart })
  $stopButton.Add_Click({ & $beginStop })
  $openButton.Add_Click({ & $openDashboard })
  $menuShow.Add_Click({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })
  $menuOpen.Add_Click({ & $openDashboard })
  $menuStop.Add_Click({ & $beginStop })
  $menuExit.Add_Click({
    # La salida se pide SIEMPRE. Si hay una operacion en curso (preparando,
    # iniciando o deteniendo) NO se pierde la orden: se cumple cuando esa
    # operacion termina (ver `$onStartDone` / `$onStopDone`). Antes, ese caso
    # cerraba la ventana con `$script:Closing = $true` y podia dejar el proceso
    # servidor sin control (el cerrojo seguia tomado y el launcher siguiente
    # informaba "datos en uso" sin ninguna ventana que lo cerrara).
    $script:ExitAfterStop = $true
    if ($null -ne $script:ServerProcess -and $script:State -notin @("preparando", "iniciando", "deteniendo")) {
      & $beginStop
    } else {
      # Sin servidor: no hay nada que detener. Durante una operacion: el cierre
      # ocurre en cuanto se sepa si el servidor llego a arrancar.
      if ($script:State -notin @("preparando", "iniciando", "deteniendo") -and $null -eq $script:ServerProcess) {
        $script:Closing = $true
        $form.Close()
      }
    }
  })
  # Mostrar la ventana desde la bandeja: doble clic (lo habitual) y tambien
  # clic simple izquierdo. El clic derecho lo atiende el shell de Windows con el
  # `ContextMenuStrip` asignado al icono.
  $showWindow = {
    $form.Show()
    $form.WindowState = "Normal"
    $form.Activate()
  }
  # El shell de Windows ya muestra el menu de un icono de bandeja al hacer clic
  # derecho (y al clic izquierdo, segun el ajuste del usuario); abrirlo tambien
  # desde `MouseClick` lo desplegaba y lo cerraba en el mismo clic. Por eso solo
  # se restaura la ventana con el clic izquierdo y el doble clic; el menu queda
  # en manos del shell, que es el comportamiento esperado.
  $notify.Add_DoubleClick({ & $showWindow })
  $notify.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      & $showWindow
    }
  })
  $options.Add_Click({
    try {
      & $applyStartup ([bool]$options.Checked)
    } catch {
      & $appendLog ("No se pudo cambiar el inicio con Windows: " + $_.Exception.Message)
      & $syncStartupCheckbox
    }
  })
  $form.Add_FormClosing({
    param($sender, $e)
    if ($script:Closing) { return }
    # Cerrar la ventana NO deja el servidor sin control: se oculta en la bandeja.
    $e.Cancel = $true
    $form.Hide()
    if (-not $script:TrayHintShown) {
      $script:TrayHintShown = $true
      $notify.ShowBalloonTip(3000, "VIUrewards", "VIUrewards sigue en la bandeja. Usa 'Salir' para cerrarla.", "Info")
    }
  })
  $form.Add_FormClosed({
    $script:Closing = $true
    $script:ExitAfterStop = $true
    $pollTimer.Stop()
    $notify.Visible = $false
    $notify.Dispose()
  })

  & $syncStartupCheckbox
  & $appendLog "VIUrewards listo."
  & $appendLog ("Aplicacion: " + $script:Root)
  & $setState "detenido"

  if ($AutoStart) {
    $script:AutoStartMode = $true
    $form.WindowState = "Minimized"
    $form.ShowInTaskbar = $false
  }

  # --- Message loop -----------------------------------------------------------
  #
  # Se usa `Show()` + `Application.Run($form)` y NO `ShowDialog()`. Medido en
  # este entorno con `ShowDialog()`: (a) la X cerraba el launcher en vez de
  # ocultarlo (el proceso salia con codigo 0 y el servidor quedaba sin ventana
  # ni bandeja, con los datos tomados por un cerrojo que nadie liberaba) y (b)
  # los clics del icono de bandeja no llegaban a sus handlers.
  #
  # El arranque inicial NO cuelga de `Shown` ni de `Application.Idle`: medido
  # que `Shown` puede no dispararse y que `Idle` no se dispara en esta sesion
  # (con `Shown`+`Idle` el servidor nunca arrancaba). Se usa un `Timer` de un
  # solo disparo, que corre ya con la bomba de mensajes activa.
  #
  # El `Timer` de `$tickTimer` no hace nada: mantiene la bomba con trabajo
  # periodico. Sin el, Windows deja de repintar la ventana cuando no hay
  # actividad (el WM_TIMER es lo que despierta al hilo).
  $tickTimer = New-Object System.Windows.Forms.Timer
  $tickTimer.Interval = 250
  $tickTimer.Add_Tick({ })
  $tickTimer.Start()

  # Arranque: un solo disparo, ya con el bucle corriendo.
  $firstTick = $null
  $firstTick = New-Object System.Windows.Forms.Timer
  $firstTick.Interval = 150
  $firstTick.Add_Tick({
    $firstTick.Stop()
    $firstTick.Dispose()
    if (-not $NoStart) { & $beginStart }
  })

  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form.Show()
  $notify.Visible = $true
  $firstTick.Start()
  [System.Windows.Forms.Application]::Run($form)
  $tickTimer.Stop()
  $tickTimer.Dispose()
  return 0
}

# ==============================================================================
# Principal
# ==============================================================================

# OJO: el cuerpo NO se invoca con `Show-ViuLauncher` (funcion) sino con PUNTO.
#
# `Show-ViuLauncher` arma la ventana con variables SIN calificar (`$form`,
# `$notify`, `$menuExit`, ...). Una funcion las declara en SU alcance y los
# scriptblocks de los eventos, al EJECUTARSE con la ventana ya abierta, buscan
# esas variables por el alcance del script. Medido en este entorno: la X
# (`FormClosing`) y "Salir" (click del menu) lanzaban `VariableIsUndefined` antes
# de poder ocultar la ventana, asi que el launcher no desaparecia a la vista. Con
# punto, el cuerpo corre en el alcance del script y los eventos ven las variables.
#
# `$SelfTest` se atiende ANTES: su rama termina en `return`, y al invocar el
# cuerpo con punto ese `return` saldria del script sin ejecutar el `exit` de
# abajo (medido: la autoprueba informaba ok con codigo 0 en un caso invalido).
if ($SelfTest) {
  exit (Invoke-ViuLauncherSelfTest)
}

. ${function:Show-ViuLauncher}
# Codigo de salida 0: la ventana llego a abrirse (y el message loop termino). Los
# fallos de validacion (1 sin raiz de la aplicacion, 2 directorio de datos
# invalido) salen desde el propio cuerpo, antes de armar la ventana. No se usa
# `$LASTEXITCODE`: no existe en un script y, sin el, `exit` tomaba el ultimo
# codigo de un proceso externo (medido: salia con 2 tras una conversion con
# ffmpeg).
exit 0
