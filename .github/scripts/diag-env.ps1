# Diagnostico del entorno del runner de Windows (SOLO LECTURA).
#
# Recoge version de la imagen, nucleos, memoria y la cadena de ancestros del
# shell del paso. NO termina procesos, NO escribe fuera de -LogDir y NO lanza
# ningun test.
#
# Por que existe: los E2E de procesos se colgaron varias veces en el runner sin
# dejar logs. Este script separa "el entorno se agota" de "el helper de limpieza
# toca lo que no debe": imprime la cadena de padres REAL del shell (PIDs, PPID y
# fecha de creacion) para poder comprobar, contra lo que reporte el helper, si
# algun ancestro estaba o no protegido.
#
# Reglas del proyecto que respeta:
#   - El PID del shell se toma de $PID: es el proceso actual, no "el PowerShell
#     mas reciente" (esa heuristica elige un proceso ajeno).
#   - ParentProcessId se compara con `$null -eq` ANTES de comparar con 0: en
#     PowerShell 5.1 un 0 legitimo es falsy y se confundiria con "sin padre".
#   - El archivo se escribe INCREMENTALMENTE: si el agente del runner muere, lo
#     ya volcado sobrevive.
#   - Todas las consultas lentas llevan margen de tiempo explicito.
#
# Uso:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .github/scripts/diag-env.ps1 -LogDir <carpeta>
#
# ASCII puro y CRLF (PowerShell 5.1 mal-decodifica UTF-8 sin BOM).

[CmdletBinding()]
param(
    [string]$LogDir = "",
    # Margen de UNA consulta CIM. Medido en una PC de desarrollo: ~1 s por
    # consulta con `Get-CimInstance Win32_Process`; en un runner compartido puede
    # ser bastante peor, por eso 60 s sigue siendo generoso y acotado.
    [int]$CimTimeoutSec = 60,
    # Margen total del script: deja 20 s para que el workflow todavia pueda
    # subir el artefacto antes del timeout del paso.
    [int]$SoftLimitSec = 100
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $env:RUNNER_TEMP "diag-env"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$logPath = Join-Path $LogDir "diag-env.log"
$startedAt = Get-Date

# Writer incremental: cada linea se escribe y se vacia al disco en el acto. Un
# `Add-Content` por linea seria mas lento pero igual de durable; se usa un
# StreamWriter con AutoFlush para no abrir y cerrar el archivo N veces.
$writer = New-Object System.IO.StreamWriter($logPath, $true, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

function Write-Diag {
    param([string]$Message)
    $line = "[ci-diag] " + (Get-Date).ToString("HH:mm:ss.fff") + " " + $Message
    Write-Host $line
    $writer.WriteLine($line)
    $writer.Flush()
}

function Get-ElapsedSec {
    return [int]((Get-Date) - $startedAt).TotalSeconds
}

function Test-Budget {
    param([int]$NeededSec)
    $left = [int]($SoftLimitSec - (Get-ElapsedSec))
    if ($left -lt $NeededSec) {
        Write-Diag ("presupuesto agotado: quedan " + $left + "s y se necesitan " + $NeededSec + "s")
        return $false
    }
    return $true
}

# Marca durable ANTES de una operacion potencialmente bloqueante: si el agente
# muere durante la consulta, el archivo ya dice cual estaba en curso.
function Invoke-TimedOperation {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )
    if (-not (Test-Budget -NeededSec ($CimTimeoutSec + 10))) {
        Write-Diag ("begin " + $Label + " => omitido por presupuesto")
        return $null
    }
    Write-Diag ("begin " + $Label)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # Se declara antes del try: `finally` tiene que ver la misma variable.
    $job = $null
    try {
        # Un `Job` con plazo acotado: el cmdlet CIM no acepta Timeout propio y
        # puede quedarse bloqueado si el servicio WMI esta saturado.
        $job = Start-Job -ScriptBlock $Action
        $done = Wait-Job -Job $job -Timeout $CimTimeoutSec
        if ($null -eq $done) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Write-Diag ("end " + $Label + " => TIMEOUT tras " + $CimTimeoutSec + "s")
            return $null
        }
        $result = Receive-Job -Job $job
        Write-Diag ("end " + $Label + " ms=" + $sw.ElapsedMilliseconds)
        return $result
    }
    catch {
        Write-Diag ("end " + $Label + " => ERROR " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
        return $null
    }
    finally {
        $sw.Stop()
        if ($null -ne $job) {
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
}

function Format-ProcessRow {
    param($Row)
    if ($null -eq $Row) { return "null" }
    $created = "desconocida"
    if ($null -ne $Row.CreationDate) {
        $created = ([datetime]$Row.CreationDate).ToString("yyyy-MM-dd HH:mm:ss.fff")
    }
    return ("pid=" + $Row.ProcessId + " ppid=" + $Row.ParentProcessId + " name=" + $Row.Name + " created=" + $created)
}

try {
    Write-Diag "=== diag-env begin ==="
    Write-Diag ("computer=" + $env:COMPUTERNAME + " user=" + $env:USERNAME)
    Write-Diag ("os=" + [System.Environment]::OSVersion.VersionString)
    Write-Diag ("osbuild=" + (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").CurrentBuild + "." + (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").UBR)
    Write-Diag ("image=" + $env:ImageOS + " version=" + $env:ImageVersion + " runner=" + $env:RUNNER_VERSION)
    Write-Diag ("arch=" + $env:PROCESSOR_ARCHITECTURE + " cores=" + $env:NUMBER_OF_PROCESSORS)
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem -OperationTimeoutSec 10
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -OperationTimeoutSec 10
    $totalGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 2)
    $freeMb = [math]::Round($os.FreePhysicalMemory / 1KB, 0)
    Write-Diag ("memory_total_gb=" + $totalGb + " memory_free_mb=" + $freeMb)
    Write-Diag ("ps_version=" + $PSVersionTable.PSVersion.ToString())

    $selfPid = $PID
    Write-Diag ("shell_pid=" + $selfPid + " (proceso actual del paso)")

    # UNA sola consulta de la tabla de procesos; con ella se arma la cadena de
    # ancestros y se buscan los procesos del agente. Sin consultas repetidas.
    $table = Invoke-TimedOperation -Label "cim:Win32_Process" -Action {
        Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate
    }

    if ($null -eq $table) {
        Write-Diag "cadena=no-disponible (la consulta CIM no devolvio filas)"
    }
    else {
        $byPid = @{}
        foreach ($row in $table) { $byPid[[int]$row.ProcessId] = $row }
        Write-Diag ("process_count=" + @($table).Count)

        # Cadena de ancestros: recorrido con `visited` (proteccion contra ciclos)
        # y sin limite de profundidad funcional. Un padre ausente, un PID 0/4 o
        # un ciclo se registran EXPLICITAMENTE en vez de cortar en silencio.
        $depth = 0
        $current = $selfPid
        $visited = New-Object System.Collections.Generic.HashSet[int]
        while ($true) {
            $row = $byPid[[int]$current]
            if ($null -eq $row) {
                Write-Diag ("ancestor depth=" + $depth + " pid=" + $current + " => fila ausente (cadena INCOMPLETA)")
                break
            }
            Write-Diag ("ancestor depth=" + $depth + " " + (Format-ProcessRow $row))
            if (-not $visited.Add([int]$current)) {
                Write-Diag ("ancestor => CICLO detectado en pid=" + $current)
                break
            }
            $ppid = $row.ParentProcessId
            if ($null -eq $ppid) {
                Write-Diag "ancestor => ParentProcessId nulo (sin padre declarado)"
                break
            }
            if ([int]$ppid -eq 0) {
                Write-Diag "ancestor => raiz legitima (ParentProcessId 0)"
                break
            }
            if ([int]$ppid -eq 4) {
                Write-Diag "ancestor => raiz de sistema (ParentProcessId 4)"
                break
            }
            if (-not $visited.Contains([int]$ppid)) {
                $parentRow = $byPid[[int]$ppid]
                if ($null -ne $parentRow -and $null -ne $row.CreationDate -and $null -ne $parentRow.CreationDate) {
                    if ([datetime]$parentRow.CreationDate -gt [datetime]$row.CreationDate) {
                        Write-Diag ("ancestor => CONTRADICCION: el padre " + $ppid + " es mas nuevo que el hijo " + $current)
                    }
                }
            }
            $current = [int]$ppid
            $depth = $depth + 1
            if ($depth -gt 64) {
                Write-Diag "ancestor => mas de 64 niveles (se corta el INFORME, no la proteccion)"
                break
            }
        }

        # Procesos del agente: se buscan sobre la MISMA tabla, sin consultar de
        # nuevo (evita el bucle de CIM que agoto WMI en una sesion anterior).
        foreach ($name in @("Runner.Worker", "Runner.Listener", "Runner.PluginHost", "dotnet")) {
            $found = @($table | Where-Object { $_.Name -like ($name + "*") })
            foreach ($m in $found) {
                Write-Diag ("agent " + (Format-ProcessRow $m))
            }
            if ($found.Count -eq 0) {
                Write-Diag ("agent name=" + $name + " => no encontrado")
            }
        }

        # Los 5 procesos con mas memoria de trabajo: es un indicador instantaneo
        # valido (a diferencia de CPU, que en Get-Process es tiempo ACUMULADO).
        $top = @($table | ForEach-Object {
            $proc = Get-Process -Id ([int]$_.ProcessId) -ErrorAction SilentlyContinue
            if ($null -ne $proc) {
                [pscustomobject]@{ Pid = $proc.Id; Name = $proc.ProcessName; WorkingSetMb = [math]::Round($proc.WorkingSet64 / 1MB, 1) }
            }
        } | Sort-Object WorkingSetMb -Descending | Select-Object -First 5)
        foreach ($t in $top) {
            Write-Diag ("top-mem pid=" + $t.Pid + " name=" + $t.Name + " working_set_mb=" + $t.WorkingSetMb)
        }
    }

    Write-Diag ("=== diag-env end elapsed_s=" + (Get-ElapsedSec) + " ===")
    exit 0
}
catch {
    Write-Diag ("FALLO: " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
    exit 1
}
finally {
    $writer.Flush()
    $writer.Dispose()
}
