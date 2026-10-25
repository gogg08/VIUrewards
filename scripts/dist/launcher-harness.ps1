<#
.SYNOPSIS
  Launcher de PRUEBA del canal de control (Fase de distribución, Etapa 3A).

.DESCRIPTION
  Arranca el servidor de VIUrewards con el canal de control del launcher
  (`src/server/control-channel.ts`) y comprueba, desde PowerShell, el ciclo de
  vida completo:

    1. `accepted` + `started` → el servidor abrió el canal y está escuchando
                                (se lee del canal, no de la consola).
    2. `shutdown`             → pide el cierre ordenado por el MISMO canal.
    3. `closing` + `finished` → el servidor informa el resultado ANTES de salir.
    4. espera la terminación y comprueba el código de salida; si no responde en
       el plazo, recurre a `taskkill /PID <pid> /T /F` SOLO sobre el proceso que
       este launcher creó.

  Este archivo es el **prototipo del launcher**: la GUI y el instalador llegan en
  una etapa posterior. Nunca recibe un directorio de datos real: en los tests es
  una carpeta temporal; en uso manual, se exige `-AllowExistingData`.

  ## Por qué named pipe y no el IPC de Node

  En Windows `child.kill("SIGINT"|"SIGTERM")` mata sin correr los handlers y
  `SIGBREAK` se traduce a `SIGKILL`. El IPC nativo de Node tampoco sirve desde
  PowerShell 5.1 (`Start-Process` filtra `NODE_CHANNEL_*` del entorno del hijo).
  El canal es un named pipe local con nombre aleatorio y token:

    * el launcher genera `<id>` y `<token>` (`New-Guid`) y los pasa como
      `--Control=<id>` y `--Exchange=<token>`;
    * el servidor escucha en `\\.\pipe\viurewards-control-<id>`;
    * el launcher se conecta con `CreateFileW` a ese nombre exacto (el mismo
      `CreateFileW` que usa el kernel; `NamedPipeClientStream` de .NET
      Framework no sirve porque el pipe lo creó otro proceso);
    * los mensajes son NDJSON: una línea JSON por mensaje, en ambos sentidos.

  El token viaja en cada orden; un mensaje sin el token correcto no cierra nada.
  Lo que esto NO garantiza (medido, no supuesto):

    * El nombre del pipe NO aísla por usuario: otro proceso local que conozca el
      nombre puede conectarse, leer los mensajes y escribir en el canal. No se
      verificó la ACL que aplica Node al crear el pipe.
    * El token viaja en los argumentos del proceso (`--Exchange=`), visible para
      procesos con acceso a la línea de comandos de esta sesión. Protege contra
      mensajes sin autenticar, no contra el propio usuario ni sus procesos.
    * Se acepta para una aplicación de escritorio de un solo usuario.

.PARAMETER ExpectInUse
  Modo «datos en uso»: NO manda ninguna orden de cierre. Espera que el servidor
  salga con el código 3 y verifica que el cerrojo ajeno quedó intacto (mismo
  contenido). Cualquier otro código es un fallo: un launcher que recibe 3 no
  intenta detener ni matar a la instancia que ya posee los datos.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File launcher-harness.ps1 `
    -NodeExe "C:\datos\runtime\node.exe" -Entry "C:\pkg\app\scripts\start.ts" `
    -DataDir "C:\temp\datos" -Port 0 -OutputFile "C:\temp\resultado.json"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [Parameter(Mandatory = $true)][string]$Entry,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [int]$Port = 0,
  [string]$ControlId = "",
  [string]$Exchange = "",
  [int]$TimeoutSeconds = 60,
  [switch]$ExpectInUse,
  [switch]$AllowExistingData,
  [string]$OutputFile = "",
  [string]$WorkDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $ControlId) { $ControlId = [guid]::NewGuid().ToString("N") }
if (-not $Exchange) { $Exchange = [guid]::NewGuid().ToString("N") }

$script:result = [ordered]@{
  status = "failed"
  reason = "unknown"
  exitCode = $null
  pid = $null
  port = $null
  dashboardUrl = $null
  accepted = $false
  started = $false
  closing = $false
  finished = $false
  finishedCode = $null
  orderedShutdown = $false
  rejectedUnauthenticated = $false
  forcedKill = $false
  lockPath = $null
  lockUnchanged = $null
  lockExistsAfter = $null
}

function Write-Result {
  param([string]$Status, [string]$Reason)
  $script:result.status = $Status
  $script:result.reason = $Reason
  $json = $script:result | ConvertTo-Json -Depth 5
  if ($OutputFile) { Set-Content -LiteralPath $OutputFile -Value $json -Encoding UTF8 }
  Write-Output $json
}

# ------------------------------------------------------------------------------
# Acceso al named pipe: CreateFileW sobre el nombre exacto del pipe.
#
# `NamedPipeClientStream` no conecta a un pipe creado por OTRO proceso en este
# entorno (verificado: `EBUSY` desde Node, timeout desde .NET), y PowerShell
# 5.1 no hereda handles a los hijos. `CreateFileW` sí es la vía directa.
# ------------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ViuControlPipe {
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
    _handle = CreateFileW(name, GENERIC_READ_WRITE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (_handle.IsInvalid) { LastError = Marshal.GetLastWin32Error(); return false; }
    _stream = new FileStream(_handle, FileAccess.ReadWrite, 4096, false);
    return true;
  }

  public static void Send(string line) {
    byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
    _stream.Write(bytes, 0, bytes.Length);
    _stream.Flush();
  }

  /// Devuelve la siguiente línea completa, o null si no hay ninguna todavía.
  public static string ReadLine() {
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

# ------------------------------------------------------------------------------
# Código de salida del servidor.
#
# `Process.ExitCode` de .NET Framework devuelve `$null` cuando el proceso se lanzó
# con la salida o el error redirigidos a un archivo y el handle ya se cerró. Se
# consulta el código real con `GetExitCodeProcess` sobre el handle del proceso.
# -----------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ViuExitCode {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  public static int Leer(IntPtr process) {
    uint code;
    if (!GetExitCodeProcess(process, out code)) return -1;
    return unchecked((int)code);
  }
}
'@

# ------------------------------------------------------------------------------
# Validación: la entrada existe y los datos no son una instalación real
# ------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  Write-Result "failed" "node-exe-missing"
  exit 1
}
if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) {
  Write-Result "failed" "entry-missing"
  exit 1
}
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
$lockPath = Join-Path $DataDir ".viurewards.lock"
$dbPath = Join-Path $DataDir "app.db"
$script:result.lockPath = $lockPath
if ((-not $AllowExistingData) -and (Test-Path -LiteralPath $dbPath)) {
  # El arnés nunca abre una instalación existente: podría ser la del usuario.
  Write-Result "failed" "data-dir-not-empty"
  exit 1
}
if (Test-Path -LiteralPath $lockPath) {
  $lockBefore = [System.IO.File]::ReadAllText($lockPath)
} else {
  $lockBefore = $null
}

$outFile = Join-Path ([System.IO.Path]::GetTempPath()) ("viu-launcher-" + $ControlId + ".out")
$errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("viu-launcher-" + $ControlId + ".err")
$serverProcess = $null

function Read-Output {
  $text = ""
  if (Test-Path -LiteralPath $outFile) {
    try { $text += [System.IO.File]::ReadAllText($outFile) } catch { }
  }
  if (Test-Path -LiteralPath $errFile) {
    try { $text += [System.IO.File]::ReadAllText($errFile) } catch { }
  }
  return $text
}

function Stop-ProcessTree {
  if ($null -eq $serverProcess) { return }
  if (-not $serverProcess.HasExited) {
    # Solo el árbol del proceso que creó ESTE launcher.
    $null = & taskkill /PID $serverProcess.Id /T /F 2>&1
    $script:result.forcedKill = $true
    $null = $serverProcess.WaitForExit(10000)
  }
}

$pipeName = "\\.\pipe\viurewards-control-" + $ControlId
$previous = @{
  VIUREWARDS_DATA_DIR = $env:VIUREWARDS_DATA_DIR
  VIUREWARDS_NODE_RUNTIME = $env:VIUREWARDS_NODE_RUNTIME
  PORT = $env:PORT
}

try {
  $env:VIUREWARDS_DATA_DIR = $DataDir
  if (-not $env:VIUREWARDS_NODE_RUNTIME) { $env:VIUREWARDS_NODE_RUNTIME = $NodeExe }
  if ($Port -gt 0) { $env:PORT = [string]$Port } else { Remove-Item Env:PORT -ErrorAction SilentlyContinue }

  $arguments = @(
    "--Control=$ControlId",
    "--Exchange=$Exchange",
    "--port=$Port"
  )
  $startArgs = @{
    FilePath = $NodeExe
    ArgumentList = @('"' + $Entry + '"') + $arguments
    PassThru = $true
    NoNewWindow = $true
    RedirectStandardOutput = $outFile
    RedirectStandardError = $errFile
  }
  if ($WorkDir) { $startArgs.WorkingDirectory = $WorkDir }
  $serverProcess = Start-Process @startArgs
  $script:result.pid = $serverProcess.Id
  # El handle se captura ANTES de esperar la salida: después, .NET lo libera y el
  # código de salida no se puede leer de otra forma (ver `ViuExitCode`).
  $processHandle = $serverProcess.Handle

  # El canal tarda en abrirse (base, limpieza, reconciliación): se reintenta.
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $pipeAbierto = $false
  while (-not $serverProcess.HasExited -and (Get-Date) -lt $deadline) {
    if ([ViuControlPipe]::Open($pipeName)) { $pipeAbierto = $true; break }
    Start-Sleep -Milliseconds 200
  }

  $sawFinished = $false
  if ($pipeAbierto -and -not $ExpectInUse) {
    # Orden SIN token: el servidor no debe cerrarse con ella.
    [ViuControlPipe]::Send('{"type":"shutdown","exchange":"0000000000000000"}')
    $orderSent = $false
    # Se lee hasta `finished` o hasta que el canal se cierre: el proceso puede
    # salir EN EL MISMO INSTANTE en que envía `finished`, así que no se corta por
    # `HasExited`.
    while ((Get-Date) -lt $deadline) {
      $line = [ViuControlPipe]::ReadLine()
      if ($null -eq $line) {
        if ($serverProcess.HasExited) { break }
        Start-Sleep -Milliseconds 50
        continue
      }
      if ($line.Trim().Length -eq 0) { continue }
      $message = $line | ConvertFrom-Json
      switch ($message.type) {
        "accepted" { $script:result.accepted = $true }
        "started" {
          # El servidor sigue vivo después de la orden sin token: se rechazó.
          $script:result.rejectedUnauthenticated = -not $orderSent
          $script:result.started = $true
          $script:result.port = $message.port
          $script:result.dashboardUrl = $message.dashboardUrl
          if (-not $orderSent) {
            $orderSent = $true
            $script:result.orderedShutdown = $true
            [ViuControlPipe]::Send('{"type":"shutdown","exchange":"' + $Exchange + '"}')
          }
        }
        "closing" { $script:result.closing = $true }
        "finished" {
          $script:result.finished = $true
          $script:result.finishedCode = $message.code
          $sawFinished = $true
        }
      }
      if ($sawFinished) { break }
    }
  }

  $exited = $serverProcess.WaitForExit($TimeoutSeconds * 1000)
  if (-not $exited) {
    Stop-ProcessTree
    Write-Result "failed" "servidor-no-termino"
    exit 1
  }
  # `WaitForExit(ms)` no vuelca el estado de salida en .NET Framework: se espera
  # de nuevo SIN plazo (el proceso ya terminó) para poder leer `ExitCode`.
  $null = (Read-Output)
  $serverProcess.WaitForExit()
  $script:result.exitCode = [ViuExitCode]::Leer($processHandle)

  if ($ExpectInUse) {
    if ($script:result.exitCode -ne 3) {
      Write-Result "failed" "codigo-$($script:result.exitCode)-en-lugar-de-3"
      exit 1
    }
    if (-not (Test-Path -LiteralPath $lockPath)) {
      $script:result.lockExistsAfter = $false
      Write-Result "failed" "el-cerrojo-ajeno-desaparecio"
      exit 1
    }
    $script:result.lockExistsAfter = $true
    $script:result.lockUnchanged = ([System.IO.File]::ReadAllText($lockPath) -eq $lockBefore)
    if ($script:result.lockUnchanged) {
      Write-Result "in-use" "codigo-3-cerrojo-intacto"
      exit 0
    }
    Write-Result "failed" "el-cerrojo-ajeno-cambio"
    exit 1
  }

  if (-not $script:result.started) {
    Write-Result "failed" ("sin-started: " + (Read-Output))
    exit 1
  }
  if (-not $script:result.closing) {
    Write-Result "failed" ("sin-closing: " + (Read-Output))
    exit 1
  }
  if (-not $script:result.finished) {
    Write-Result "failed" ("sin-finished: " + (Read-Output))
    exit 1
  }
  if ($script:result.exitCode -ne 0) {
    Write-Result "failed" "codigo-$($script:result.exitCode)"
    exit 1
  }
  $script:result.lockExistsAfter = (Test-Path -LiteralPath $lockPath)
  if ($script:result.lockExistsAfter) {
    Write-Result "failed" "el-cerrojo-no-se-libero"
    exit 1
  }
  $script:result.lockUnchanged = $true
  Write-Result "closed" ("codigo-0-puerto-" + $script:result.port)
  exit 0
} catch {
  Stop-ProcessTree
  Write-Result "failed" ("error: " + $_.Exception.Message)
  exit 1
} finally {
  [ViuControlPipe]::Close()
  foreach ($name in $previous.Keys) {
    if ($null -eq $previous[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$name" -Value $previous[$name]
    }
  }
  foreach ($file in @($outFile, $errFile)) {
    # Con -Verbose se ve qué imprimió el servidor antes de terminar (diagnóstico
    # manual); por defecto los temporales del launcher se borran siempre.
    if ($VerbosePreference -ne "SilentlyContinue" -and (Test-Path -LiteralPath $file)) {
      Write-Host ("[launcher] " + $file + ": " + ((Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue) -replace "`r?`n", " | "))
    }
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
  }
}
