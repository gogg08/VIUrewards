# Watchdog OBSERVACIONAL de un archivo E2E de Vitest (Windows).
#
# Lanza Vitest con `node.exe` DIRECTO (nunca `npx.cmd`: un `.cmd` mete un
# `cmd.exe` intermedio y el objeto `Process` deja de representar al proceso de la
# prueba) y lo vigila con hitos y latidos incrementales.
#
# QUE HACE

#   - Guarda stdout y stderr en archivos (los escribe el PROPIO hijo con

#     Start-Process -RedirectStandardOutput/-RedirectStandardError): el launcher

#     no copia streams, asi que no hay lectores que cerrar ni copias a medio

#     hacer.

#   - Escribe CADA evento en el log con AutoFlush: si el proceso se cuelga o el

#     agente del runner muere, lo ya volcado sobrevive.

#   - Late cada HeartbeatSec con datos LIVIANOS: working set del propio proceso de
#     prueba, via el objeto Process de .NET (`Refresh()` + `WorkingSet64`). El
#     latido NO enumera procesos NI consulta CIM: una consulta dentro del latido
#     crearia mas carga justo cuando la maquina ya esta saturada.
#   - Solo al alcanzar el LIMITE DURO hace UNA consulta CIM, acotada, para dejar
#     evidencia de la descendencia del proceso de prueba. Es un bloque APARTE y

#     etiquetado; no forma parte del latido.
#   - NO se usa `Get-Process.CPU` como "consumo": es tiempo de CPU ACUMULADO
#     desde que arranco el proceso, no una tasa.

#   - NO se pide `CommandLine` a CIM: esa informacion puede contener tokens,

#     rutas personales y argumentos de otros procesos, y el diagnostico no los
#     necesita para identificar la descendencia.
#
# QUE NO HACE (a proposito)

#   - NO termina procesos: ni por PID, ni `taskkill`, ni `/T`, ni

#     `Stop-Process`. No puede demostrar la identidad de un descendiente y matar

#     a ciegas es lo que se esta investigando. La descendencia se INFORMA.

#   - Al vencer el limite duro sale con codigo 2 y DEJA el proceso de prueba

#     vivo (ver "limitaciones" abajo).

#

# LIMITACIONES EXPLICITAS

#   - Si se alcanza el limite duro, Vitest y sus workers pueden seguir vivos. El

#     codigo 2 hace que el PASO falle, GitHub marca el job, y el job terminara

#     (con su propio timeout) tomando consigo el arbol del paso. Esto NO esta

#     verificado en el runner desde este script.

#   - Un watchdog DENTRO del runner no puede garantizar la subida del artefacto

#     si el agente de GitHub Actions deja de funcionar: los timeouts dependen de

#     que el agente este vivo para aplicarlos.

#   - `WaitForExit(ms)` bloquea el hilo del script durante `ms`; mientras espera

#     no se late. Por eso la espera es `min(HeartbeatSec * 1000, restante)`: con
#     HeartbeatSec = 10 se late cada 10 s, no cada segundo.
#   - La descendencia se identifica solo por PID/PPID de una UNICA instantanea.
#     Un PID reciclado o un proceso que cambio de padre no se distingue: por eso
#     se informa y NO se usa para terminar nada.
#
# Uso:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .github/scripts/diag-e2e-watchdog.ps1 `
#     -TestFile tests/e2e/proc-table.test.ts -LogDir <carpeta> -HardLimitSec 225
#
# Codigos de salida: 0 = el proceso de prueba termino (el codigo de Vitest se
# informa en el log y en exit.txt), 2 = limite duro alcanzado (proceso NO
# terminado), 3 = no se pudo lanzar.
#
# ASCII puro y CRLF (PowerShell 5.1 mal-decodifica UTF-8 sin BOM).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TestFile,
    [string]$LogDir = "",
    [int]$HeartbeatSec = 10,
    # Presupuesto propio del watchdog: MENOR que el timeout del paso del
    # workflow, que a su vez es menor que el del job (hay margen para subir el
    # artefacto).
    [int]$HardLimitSec = 220,
    [string]$NodeExe = "",
    [string]$VitestEntry = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $env:RUNNER_TEMP "diag-e2e"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$base = [System.IO.Path]::GetFileNameWithoutExtension($TestFile) + "-" + $stamp
$logPath = Join-Path $LogDir ($base + ".log")
$stdoutPath = Join-Path $LogDir ($base + ".stdout.log")
$stderrPath = Join-Path $LogDir ($base + ".stderr.log")
$markersPath = Join-Path $LogDir ($base + ".markers.log")
$exitPath = Join-Path $LogDir ($base + ".exit.txt")

$writer = New-Object System.IO.StreamWriter($logPath, $true, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

function Write-Diag {
    param([string]$Message)
    $line = "[ci-diag] " + (Get-Date).ToString("HH:mm:ss.fff") + " " + $Message
    Write-Host $line
    $writer.WriteLine($line)
    $writer.Flush()
}

function Write-Marker {
    param([string]$Message)
    # Archivo aparte y con AutoFlush: marca durable antes de una operacion que
    # puede bloquear, aunque el log principal quede a medio escribir.
    $line = (Get-Date).ToString("HH:mm:ss.fff") + " " + $Message
    [System.IO.File]::AppendAllText($markersPath, $line + [System.Environment]::NewLine)
}

function Get-CpuUsagePercent {
    # Uso INSTANTANEO de la maquina: dos muestras del contador de rendimiento,
    # no una diferencia de tiempos acumulados de un proceso. No se usa en el
    # latido (mide con una espera de 1 s): queda como utilidad del diagnostico.
    try {
        $sample = (Get-Counter -Counter "\Processor(_Total)\% Processor Time" -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples[0].CookedValue
        return [math]::Round($sample, 1)
    }
    catch {
        return "no-disponible"
    }
}

function Get-TopMemoryProcesses {
    param([int]$Count)
    # Memoria de trabajo: indicador INSTANTANEO. Se etiqueta como tal en el log y
    # como resumen GLOBAL (no es la descendencia del proceso de prueba).
    return @(Get-Process |
        Sort-Object WorkingSet64 -Descending |
        Select-Object -First $Count |
        ForEach-Object { "pid=" + $_.Id + " name=" + $_.ProcessName + " working_set_mb=" + [math]::Round($_.WorkingSet64 / 1MB, 1) })
}

function Get-ProcessTableSnapshot {
    # UNA consulta CIM acotada. Solo PID, PPID, nombre y memoria: sin
    # `CommandLine` (puede traer tokens y argumentos de otros procesos).
    # Devuelve @() si falla o vence el plazo: el diagnostico nunca revienta el
    # watchdog.
    try {
        return @(Get-CimInstance -ClassName Win32_Process `
            -Property ProcessId, ParentProcessId, Name, WorkingSetSize `
            -OperationTimeoutSec 5 -ErrorAction Stop)
    }
    catch {
        Write-Diag ("descendencia: la consulta CIM fallo: " + $_.Exception.GetType().Name)
        return @()
    }
}

function Write-TestDescendants {
    param([int]$RootPid, $Snapshot)
    # Bloque SEPARADO del heartbeat: solo se ejecuta en el limite duro. Recorre
    # ppid -> pid por BFS sobre UNA instantanea y escribe evidencia. NO termina
    # nada y no puede hacerlo: la tabla solo identifica por PID/PPID.
    if ($Snapshot.Count -eq 0) {
        Write-Diag "test-descendants: sin instantanea (consulta fallida o vacia)"
        return
    }
    $childrenOf = @{}
    foreach ($row in $Snapshot) {
        $parent = [int]$row.ParentProcessId
        if (-not $childrenOf.ContainsKey($parent)) { $childrenOf[$parent] = New-Object System.Collections.ArrayList }
        [void]$childrenOf[$parent].Add($row)
    }
    $found = New-Object System.Collections.ArrayList
    $seen = New-Object System.Collections.Generic.HashSet[int]
    $pending = New-Object System.Collections.ArrayList
    [void]$pending.Add($RootPid)
    [void]$seen.Add($RootPid)
    while ($pending.Count -gt 0) {
        $current = [int]$pending[0]
        $pending.RemoveAt(0)
        if (-not $childrenOf.ContainsKey($current)) { continue }
        foreach ($row in $childrenOf[$current]) {
            $childPid = [int]$row.ProcessId
            if (-not $seen.Add($childPid)) { continue }
            [void]$found.Add($row)
            [void]$pending.Add($childPid)
        }
    }
    Write-Diag ("test-descendants: root_pid=" + $RootPid + " count=" + $found.Count + " (instantanea unica; solo observacion)")
    foreach ($row in $found) {
        Write-Diag ("test-descendant pid=" + $row.ProcessId + " ppid=" + $row.ParentProcessId +
            " name=" + $row.Name + " working_set_mb=" + [math]::Round($row.WorkingSetSize / 1MB, 1))
    }
}

if ([string]::IsNullOrWhiteSpace($NodeExe)) {
    $NodeExe = (Get-Command node -ErrorAction Stop).Source
}
if ([string]::IsNullOrWhiteSpace($VitestEntry)) {
    $VitestEntry = Join-Path (Get-Location) "node_modules\vitest\vitest.mjs"
}
if (-not (Test-Path -LiteralPath $VitestEntry)) {
    Write-Diag ("FALLO: no existe el entrypoint de Vitest: " + $VitestEntry)
    $writer.Dispose()
    exit 3
}

$arguments = @(
    $VitestEntry,
    "run",
    "--config", "vitest.e2e.config.ts",
    $TestFile
)

Write-Diag ("=== watchdog begin file=" + $TestFile + " hard_limit_s=" + $HardLimitSec + " heartbeat_s=" + $HeartbeatSec + " ===")
Write-Diag ("node=" + $NodeExe)
Write-Diag ("entry=" + $VitestEntry)
Write-Diag ("args=" + ($arguments -join " "))
Write-Marker "launch"

$process = $null
try {
    # `-PassThru` da el objeto Process del HIJO DIRECTO. La redireccion la hace
    # el propio launcher: el hijo escribe en archivos, no en pipes que alguien
    # tenga que drenar.
    $process = Start-Process -FilePath $NodeExe -ArgumentList $arguments `
        -WorkingDirectory (Get-Location).Path `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -NoNewWindow -PassThru
}
catch {
    Write-Diag ("FALLO al lanzar: " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
    $writer.Dispose()
    exit 3
}

$pidValue = $process.Id
Write-Diag ("launched pid=" + $pidValue + " start=" + $process.StartTime.ToString("HH:mm:ss.fff"))
Write-Marker ("launched pid=" + $pidValue)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$lastHeartbeatSec = 0
$timedOut = $false

while ($true) {
    $remainingMs = ($HardLimitSec * 1000) - [int]$sw.ElapsedMilliseconds
    if ($remainingMs -le 0) { break }

    # Espera acotada por el intervalo configurado Y por lo que queda.
    $waitMs = [int][math]::Min($HeartbeatSec * 1000, $remainingMs)
    Write-Marker ("wait ms=" + $waitMs)
    $exited = $process.WaitForExit($waitMs)

    if ($exited) {
        Write-Diag ("process exited code=" + $process.ExitCode + " elapsed_s=" + [int]$sw.Elapsed.TotalSeconds)
        Write-Marker ("exited code=" + $process.ExitCode)
        break
    }

    $elapsedSec = [int]$sw.Elapsed.TotalSeconds
    if (($elapsedSec - $lastHeartbeatSec) -ge $HeartbeatSec) {
        $lastHeartbeatSec = $elapsedSec
        $workingSet = "no-disponible"
        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                $workingSet = [math]::Round($process.WorkingSet64 / 1MB, 1)
            }
        }
        catch {
            $workingSet = "no-disponible"
        }
        Write-Diag ("heartbeat elapsed_s=" + $elapsedSec +

            " testproc_working_set_mb=" + $workingSet)

    }



    if ([int]$sw.Elapsed.TotalSeconds -ge $HardLimitSec) {

        $timedOut = $true

        break

    }

}



if ($timedOut) {

    Write-Diag ("LIMITE DURO alcanzado (" + $HardLimitSec + "s). NO se termina ningun proceso.")

    Write-Diag "El proceso de prueba y sus workers pueden seguir vivos: ver limitaciones del script."

    # UNA sola consulta CIM, solo aqui, para dejar evidencia de la descendencia.
    Write-Marker "hard-limit-snapshot"
    $snapshot = Get-ProcessTableSnapshot
    Write-TestDescendants -RootPid $pidValue -Snapshot $snapshot
    Write-Diag ("global top-mem(working_set): resumen de la MAQUINA, no la descendencia del test")
    foreach ($line in (Get-TopMemoryProcesses -Count 10)) {

        Write-Diag ("final top-mem(working_set) " + $line)

    }

    Write-Marker "hard-limit"
    [System.IO.File]::AppendAllText($exitPath, "hard-limit" + [System.Environment]::NewLine)
    Write-Diag "=== watchdog end (timeout) ==="
    $writer.Dispose()
    exit 2
}

# Salida confirmada por el objeto Process. NO se afirma nada sobre los
# descendientes: el cierre del proceso principal no demuestra que su arbol haya
# terminado.
$code = $process.ExitCode
Write-Diag ("=== watchdog end code=" + $code + " ===")
[System.IO.File]::AppendAllText($exitPath, "exit=" + $code + [System.Environment]::NewLine)
$writer.Dispose()
exit 0
