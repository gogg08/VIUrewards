# Watchdog de DIAGNOSTICO con Windows Job Object (solo diagnostico).
#
# QUE HACE
#   - Crea un Job Object de Windows con JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
#   - Lanza el comando de la prueba SUSPENDIDO (CREATE_SUSPENDED), lo asigna al
#     Job Object y solo entonces lo reanuda. Asi ningun descendiente puede
#     crearse fuera del job: la asignacion ocurre antes de que el hijo ejecute
#     una sola instruccion.
#   - Reproduce la invocacion de produccion (`npx vitest ...`), lanzada a
#     traves del shell que usa el workflow (`pwsh -NoProfile -Command ...`),
#     no mediante `cmd.exe /c`. Ver "FIDELIDAD" abajo.
#   - Vigila con latidos livianos (WorkingSet64 via el objeto Process) y deja
#     stdout/stderr, marcas y un resumen de hitos en archivos incrementales.
#   - Al alcanzar el limite duro: PRIMERO escribe la instantanea y el motivo,
#     despues CIERRA el Job Object, que termina los procesos que contiene.
#
# QUE NO HACE
#   - NO usa `taskkill`, `Stop-Process` ni terminacion manual por PID.
#   - NO afirma contener procesos que hayan escapado del job: si el runner
#     asigna el proceso a otro Job Object incompatible (jobs anidados de
#     GitHub Actions) o si AssignProcessToJobObject falla, el script FALLA sin
#     ejecutar la prueba. No se ejecuta la prueba "fuera del job".
#
# LIMITACIONES REALES (documentadas, no resueltas)
#   1. Jobs anidados del runner: desde Windows 8 los jobs pueden anidarse, pero
#      solo si el job externo lo permite. Si el runner asigna `pwsh`/`npx` a un
#      job que no permite anidamiento, AssignProcessToJobObject devuelve error
#      y este script sale con codigo 3 SIN lanzar la prueba.
#   2. Si el AGENTE del runner deja de responder, nada de este script se
#      ejecuta despues: ni el limite duro, ni el cierre del job, ni la subida
#      del artefacto. Es el mismo modo de fallo que en produccion.
#   3. KILL_ON_JOB_CLOSE termina los procesos del job al cerrar el handle. El
#      script lo hace DESPUES de tomar la instantanea, a proposito.
#   4. Un proceso creado con CREATE_BREAKAWAY_FROM_JOB podria escapar si el job
#      lo permitiera; este job NO concede breakaway, por lo que Node/cmd no
#      pueden escapar por esa via (inferencia de la documentacion de Windows,
#      no verificada en este repositorio).
#
# FIDELIDAD
#   Produccion ejecuta el paso con `defaults.run.shell: pwsh`, y su `run:` es
#   `npx vitest run --config vitest.e2e.config.ts tests/e2e/shutdown.test.ts`.
#   La accion `pwsh` de GitHub NO pasa ese texto a `-Command`: escribe el
#   bloque en un archivo temporal .ps1 y ejecuta `pwsh -command ". '{0}'"`,
#   donde {0} es la RUTA de ese archivo.
#   Aqui se hace lo mismo: se escribe un .ps1 temporal con el comando y se
#   lanza `pwsh -NoProfile -NonInteractive -Command ". '<ruta del temporal>'"`.
#   NO se usa `cmd.exe /c` porque `cmd.exe` no es el shell del paso.
#   DIFERENCIAS CONOCIDAS respecto de produccion (no se afirma fidelidad
#   exacta): (1) se agrega `-NoProfile`, que la accion oficial no usa; (2) se
#   agrega `-NonInteractive`; (3) el proceso padre es el supervisor y no el
#   agente del runner, asi que la cadena de procesos y el Job Object no son
#   los mismos. El texto del comando ejecutado SI es el mismo.
#
# Codigos de salida:
#   0 = la prueba termino (el codigo de Vitest queda en .exit.txt)
#   2 = limite duro alcanzado; instantanea escrita y job cerrado
#   3 = no se pudo crear/asignar el job o lanzar el proceso (prueba NO ejecutada)
#
# ASCII puro y CRLF (PowerShell 5.1 mal-decodifica UTF-8 sin BOM).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TestFile,
    # Linea EXACTA del comando de produccion. Si se omite, se compone como en
    # el workflow de empaquetado.
    [string]$CommandLine = "",
    [string]$LogDir = "",
    [int]$HeartbeatSec = 10,
    # Presupuesto propio de la prueba: MENOR que el timeout del paso.
    [int]$HardLimitSec = 3300,
    # Cada cuantos segundos se escribe una linea `tick` con la hora y si el
    # proceso raiz sigue vivo. Es SOLO un latido de progreso: NO enumera
    # procesos ni refresca ninguna lista. NO es terminacion.
    [int]$SnapshotEverySec = 60
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $env:RUNNER_TEMP "diag-job"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$base = [System.IO.Path]::GetFileNameWithoutExtension($TestFile) + "-job-" + $stamp
$logPath = Join-Path $LogDir ($base + ".log")
$stdoutPath = Join-Path $LogDir ($base + ".stdout.log")
$stderrPath = Join-Path $LogDir ($base + ".stderr.log")
$markersPath = Join-Path $LogDir ($base + ".markers.log")
$exitPath = Join-Path $LogDir ($base + ".exit.txt")
$snapshotPath = Join-Path $LogDir ($base + ".snapshot.txt")

$writer = New-Object System.IO.StreamWriter($logPath, $true, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

function Write-Diag {
    param([string]$Message)
    $line = "[ci-job] " + (Get-Date).ToString("HH:mm:ss.fff") + " " + $Message
    Write-Host $line
    $writer.WriteLine($line)
    $writer.Flush()
}

function Write-Marker {
    param([string]$Message)
    $line = (Get-Date).ToString("HH:mm:ss.fff") + " " + $Message
    [System.IO.File]::AppendAllText($markersPath, $line + [System.Environment]::NewLine)
}

# ---------------------------------------------------------------------------
# P/Invoke: Job Objects + CreateProcess suspendido.
#
# Se declaran SOLO las estructuras y funciones necesarias. Nada de P/Invoke
# generico: cada firma esta probada contra la documentacion de Windows.
# ---------------------------------------------------------------------------
$nativeType = @"
using System;
using System.Runtime.InteropServices;

namespace DiagJob
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public static class Native
    {
        public const uint CREATE_SUSPENDED = 0x00000004;
        public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint STARTF_USESTDHANDLES = 0x00000100;
        public const uint HANDLE_FLAG_INHERIT = 0x00000001;
        public const int STARTF_USESHOWWINDOW = 0x00000001;
        public const short SW_HIDE = 0;
        public const uint GENERIC_READ = 0x80000000;
        public const uint FILE_SHARE_READ = 0x00000001;
        public const uint FILE_SHARE_WRITE = 0x00000002;
        public const uint OPEN_EXISTING = 3;
        public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess,
            uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition,
            uint dwFlagsAndAttributes, IntPtr hTemplateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass,
            IntPtr lpJobObjectInfo, int cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreateProcess(string lpApplicationName, string lpCommandLine,
            IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
            uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
    }
}
"@

try {
    Add-Type -TypeDefinition $nativeType -ErrorAction Stop
}
catch {
    Write-Diag ("FALLO al compilar el P/Invoke: " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
    $writer.Dispose()
    exit 3
}

# ---------------------------------------------------------------------------
# Comando exacto (fidelidad respecto de produccion).
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    $CommandLine = "npx vitest run --config vitest.e2e.config.ts " + $TestFile
}

$pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($pwshExe)) {
    Write-Diag "FALLO: no hay pwsh en PATH; el shell de produccion no se puede reproducir."
    $writer.Dispose()
    exit 3
}

# GitHub Actions NO pasa el texto del paso a `-Command`: escribe el bloque `run:`
# en un archivo temporal .ps1 y ejecuta `pwsh -command ". '{0}'"`, donde {0} es
# la RUTA de ese archivo. Por eso aqui se hace lo mismo: se crea un archivo
# temporal con el comando autorizado y se hace dot-source de SU RUTA. Hacer
# `. '<texto del comando>'` seria distinto y fallaria (PowerShell lo trataria
# como el nombre de un archivo).
#
# El archivo reproduce lo que la accion `pwsh` de GitHub agrega ADEMAS del
# bloque `run:` (ver su plantilla): `$ErrorActionPreference = 'stop'` y, al
# final, `if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit
# $LASTEXITCODE }`. Sin ese `exit`, `pwsh` sale con 0 aunque `npx vitest`
# termine con error, y el supervisor lo registraria como `exit=0`.
$stepScriptPath = Join-Path $LogDir ($base + ".step.ps1")
# OJO: la primera linea va entre comillas SIMPLES a proposito. Con comillas
# dobles, el propio supervisor interpolaria `$ErrorActionPreference` y el
# archivo quedaria con "Stop = 'stop'".
$stepScript = '$ErrorActionPreference = ''stop''' + [System.Environment]::NewLine +
    $CommandLine + [System.Environment]::NewLine +
    'if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }' +
    [System.Environment]::NewLine
[System.IO.File]::WriteAllText(
    $stepScriptPath,
    $stepScript,
    (New-Object System.Text.UTF8Encoding($false)))

# Misma forma que la accion `pwsh` de GitHub: dot-source del ARCHIVO temporal.
# La ruta se escapa duplicando las comillas simples, que es como PowerShell
# escapa una cadena literal entre comillas simples.
$scriptBlock = ". '" + ($stepScriptPath -replace "'", "''") + "'"

# CreateProcess necesita una unica linea de comandos: se construye a mano con
# las comillas de Windows (no se usa PowerShell para escapar).
function Quote-Arg {
    param([string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

# La accion `pwsh` de GitHub agrega tambien `-FileName` (informa el archivo del
# paso, no cambia que se ejecuta). DIFERENCIA CONOCIDA: se agrega `-NoProfile`
# para no depender del perfil del runner; la accion oficial NO lo usa.
$commandLineForCreate = (Quote-Arg $pwshExe) + " " +
    (Quote-Arg "-NoProfile") + " " +
    (Quote-Arg "-NonInteractive") + " " +
    (Quote-Arg "-Command") + " " +
    (Quote-Arg $scriptBlock)

# ---------------------------------------------------------------------------
# Handles heredables para stdout/stderr del hijo.
#
# El hijo escribe DIRECTO en los archivos; no hay pipes que drenar. Esto es lo
# que evita que el diagnostico se bloquee leyendo un pipe lleno.
# ---------------------------------------------------------------------------
$stdoutStream = $null
$stderrStream = $null
$stdInHandle = [IntPtr]::Zero
$jobHandle = [IntPtr]::Zero
$procHandle = [IntPtr]::Zero
$threadHandle = [IntPtr]::Zero
$process = $null
$timedOut = $false
$exitReason = "unknown"

# Estado explicito del ciclo de vida del proceso. Sirve para saber, desde
# CUALQUIER camino de error y desde el finally, si hay un proceso suspendido
# fuera del job que hay que terminar, y para no terminarlo dos veces.
$procCreated = $false   # CreateProcess devolvio handles validos
$procAssigned = $false  # AssignProcessToJobObject tuvo exito
$procResumed = $false   # ResumeThread tuvo exito
$procTerminated = $false # ya se termino (o se intento y se decidio no repetir)

# ---------------------------------------------------------------------------
# Limpieza centralizada del proceso suspendido que NO integro el job.
#
# El unico caso en que hay que hacer algo es: proceso creado, NO asignado, NO
# reanudado. Ahi el proceso no ejecuto ninguna instruccion y cerrar el job
# vacio no lo termina. Se usa el handle EXACTO de CreateProcess; nunca
# taskkill, Stop-Process ni busqueda por PID. Si ya se reanudo o ya se asigno,
# la terminacion la resuelve el Job Object (KILL_ON_JOB_CLOSE) y aqui no se
# toca, para no matar dos veces ni saltarse la politica normal.
# ---------------------------------------------------------------------------
function Clear-SuspendedOrphan {
    if ($script:procCreated -and (-not $script:procAssigned) -and (-not $script:procResumed)) {
        if ($script:procTerminated) { return }
        $script:procTerminated = $true
        try {
            if ([DiagJob.Native]::TerminateProcess($script:procHandle, 1)) {
                Write-Diag "proceso suspendido terminado por su handle (la prueba nunca se ejecuto)"
            }
            else {
                $termErr = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                Write-Diag ("FALLO al terminar el proceso suspendido error=" + $termErr)
            }
        }
        catch {
            Write-Diag ("EXCEPCION al terminar el proceso suspendido: " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
        }
    }
}

try {
    Write-Diag ("=== inicio file=" + $TestFile + " hard_limit_s=" + $HardLimitSec + " heartbeat_s=" + $HeartbeatSec + " ===")
    Write-Diag ("comando=" + $CommandLine)
    Write-Diag ("create=" + $commandLineForCreate)
    Write-Marker "begin"

    # Crear el Job Object ANTES de crear el proceso.
    $jobHandle = [DiagJob.Native]::CreateJobObject([IntPtr]::Zero, $null)
    if ($jobHandle -eq [IntPtr]::Zero) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: CreateJobObject error=" + $err)
        $exitReason = "job-create-failed"
        throw "job-create-failed"
    }
    Write-Diag ("job_handle=0x" + $jobHandle.ToString("X"))

    # KILL_ON_JOB_CLOSE: al cerrar el handle del job, el SO termina sus procesos.
    $info = New-Object DiagJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $info.BasicLimitInformation.LimitFlags = [DiagJob.Native]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([System.Type][DiagJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    try {
        [System.Runtime.InteropServices.Marshal]::StructureToPtr($info, $buffer, $false)
        $ok = [DiagJob.Native]::SetInformationJobObject(
            $jobHandle,
            [DiagJob.Native]::JobObjectExtendedLimitInformation,
            $buffer,
            $size)
        if (-not $ok) {
            $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Write-Diag ("FALLO: SetInformationJobObject error=" + $err)
            $exitReason = "job-configure-failed"
            throw "job-configure-failed"
        }
        Write-Diag "job_limit=KILL_ON_JOB_CLOSE configurado"
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }

    # Archivos de salida: handles heredables. El hijo escribe a traves del
    # handle, no de un pipe.
    $stdoutStream = New-Object System.IO.FileStream($stdoutPath,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::ReadWrite,
        4096,
        [System.IO.FileOptions]::None)
    $stderrStream = New-Object System.IO.FileStream($stderrPath,
        [System.IO.FileMode]::Create,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::ReadWrite,
        4096,
        [System.IO.FileOptions]::None)

    $stdOutHandle = $stdoutStream.SafeFileHandle.DangerousGetHandle()
    $stdErrHandle = $stderrStream.SafeFileHandle.DangerousGetHandle()

    # Si un handle NO queda heredable, el hijo escribiaria en un handle
    # invalido y la evidencia se perderia en silencio. Se comprueba cada uno y
    # se ABORTA antes de reanudar.
    if (-not [DiagJob.Native]::SetHandleInformation($stdOutHandle, [DiagJob.Native]::HANDLE_FLAG_INHERIT, [DiagJob.Native]::HANDLE_FLAG_INHERIT)) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: SetHandleInformation(stdout) error=" + $err + " (el proceso NO se reanuda)")
        $exitReason = "handle-inherit-failed"
        [System.IO.File]::AppendAllText($exitPath, "launch-failed" + [System.Environment]::NewLine)
        throw "handle-inherit-failed"
    }
    if (-not [DiagJob.Native]::SetHandleInformation($stdErrHandle, [DiagJob.Native]::HANDLE_FLAG_INHERIT, [DiagJob.Native]::HANDLE_FLAG_INHERIT)) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: SetHandleInformation(stderr) error=" + $err + " (el proceso NO se reanuda)")
        $exitReason = "handle-inherit-failed"
        [System.IO.File]::AppendAllText($exitPath, "launch-failed" + [System.Environment]::NewLine)
        throw "handle-inherit-failed"
    }

    # stdin: si el hijo hereda un handle invalido, `npx`/`node` pueden bloquearse
    # esperando entrada (justo el sintoma que queremos descartar). Se pasa el
    # handle NUL del sistema, que es heredable y valido siempre.
    $stdInHandle = [DiagJob.Native]::CreateFileW(
        "NUL",
        [DiagJob.Native]::GENERIC_READ,
        [DiagJob.Native]::FILE_SHARE_READ -bor [DiagJob.Native]::FILE_SHARE_WRITE,
        [IntPtr]::Zero,
        [DiagJob.Native]::OPEN_EXISTING,
        0,
        [IntPtr]::Zero)
    if ($stdInHandle -eq [IntPtr]::Zero -or $stdInHandle -eq [IntPtr](-1)) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: no se pudo abrir NUL para stdin error=" + $err + " (el proceso NO se reanuda)")
        $exitReason = "handle-inherit-failed"
        [System.IO.File]::AppendAllText($exitPath, "launch-failed" + [System.Environment]::NewLine)
        throw "handle-inherit-failed"
    }
    if (-not [DiagJob.Native]::SetHandleInformation($stdInHandle, [DiagJob.Native]::HANDLE_FLAG_INHERIT, [DiagJob.Native]::HANDLE_FLAG_INHERIT)) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: SetHandleInformation(stdin) error=" + $err + " (el proceso NO se reanuda)")
        $exitReason = "handle-inherit-failed"
        [System.IO.File]::AppendAllText($exitPath, "launch-failed" + [System.Environment]::NewLine)
        throw "handle-inherit-failed"
    }
    Write-Diag "handles stdout/stderr/stdin heredables"

    $startup = New-Object DiagJob.STARTUPINFO
    $startup.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([System.Type][DiagJob.STARTUPINFO])
    $startup.dwFlags = [DiagJob.Native]::STARTF_USESTDHANDLES -bor [DiagJob.Native]::STARTF_USESHOWWINDOW
    $startup.wShowWindow = [DiagJob.Native]::SW_HIDE
    $startup.hStdInput = $stdInHandle
    $startup.hStdOutput = $stdOutHandle
    $startup.hStdError = $stdErrHandle

    $procInfo = New-Object DiagJob.PROCESS_INFORMATION

    $creationFlags = [DiagJob.Native]::CREATE_SUSPENDED -bor [DiagJob.Native]::CREATE_UNICODE_ENVIRONMENT

    Write-Marker "create-suspended"
    $launched = [DiagJob.Native]::CreateProcess(
        $null,
        $commandLineForCreate,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        $true,
        $creationFlags,
        [IntPtr]::Zero,
        (Get-Location).Path,
        [ref]$startup,
        [ref]$procInfo)

    if (-not $launched) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: CreateProcess error=" + $err + " (el proceso NO se ejecuto)")
        $exitReason = "create-process-failed"
        [System.IO.File]::AppendAllText($exitPath, "launch-failed" + [System.Environment]::NewLine)
        throw "create-process-failed"
    }

    $procHandle = $procInfo.hProcess
    $threadHandle = $procInfo.hThread
    $rootPid = $procInfo.dwProcessId
    # A partir de aqui el proceso existe: si cualquier cosa falla antes de
    # asignarlo, Clear-SuspendedOrphan lo termina por su handle.
    $procCreated = $true
    Write-Diag ("proceso creado SUSPENDIDO pid=" + $rootPid)
    Write-Marker ("created pid=" + $rootPid)

    # Asignar al job ANTES de reanudar. Si falla, NO se reanuda: la prueba no
    # se ejecuta fuera del job.
    $assigned = [DiagJob.Native]::AssignProcessToJobObject($jobHandle, $procHandle)
    if (-not $assigned) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: AssignProcessToJobObject error=" + $err + " (el proceso queda suspendido y se termina sin ejecutar la prueba)")
        $exitReason = "assign-failed"
        [System.IO.File]::AppendAllText($exitPath, "launch-failed" + [System.Environment]::NewLine)
        # La terminacion la centraliza el finally (una sola vez, mismo handle).
        throw "assign-failed"
    }
    $procAssigned = $true
    Write-Diag "proceso asignado al job"
    Write-Marker "assigned"

    # Reanudar: a partir de aqui el hijo ejecuta y todos sus descendientes
    # heredan el job automaticamente.
    $resumed = [DiagJob.Native]::ResumeThread($threadHandle)
    if ($resumed -eq [uint32]::MaxValue) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Diag ("FALLO: ResumeThread error=" + $err)
        $exitReason = "resume-failed"
        [System.IO.File]::AppendAllText($exitPath, "launch-failed" + [System.Environment]::NewLine)
        throw "resume-failed"
    }
    Write-Diag ("proceso REANUDADO pid=" + $rootPid)
    Write-Marker ("resumed pid=" + $rootPid)
    $procResumed = $true

    # Ahora `$process` solo se usa para consultar WorkingSet64 y HasExited.
    $process = [System.Diagnostics.Process]::GetProcessById($rootPid)

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastHeartbeatSec = 0
    $lastSnapshotSec = 0

    while ($true) {
        $remainingMs = ($HardLimitSec * 1000) - [int]$sw.ElapsedMilliseconds
        if ($remainingMs -le 0) {
            $timedOut = $true
            break
        }

        $waitMs = [int][math]::Min($HeartbeatSec * 1000, $remainingMs)
        $exited = $process.WaitForExit($waitMs)

        if ($exited) {
            $exitCode = $process.ExitCode
            Write-Diag ("proceso termino code=" + $exitCode + " elapsed_s=" + [int]$sw.Elapsed.TotalSeconds)
            Write-Marker ("exited code=" + $exitCode)
            $exitReason = "exit"
            break
        }

        $elapsedSec = [int]$sw.Elapsed.TotalSeconds
        if (($elapsedSec - $lastHeartbeatSec) -ge $HeartbeatSec) {
            $lastHeartbeatSec = $elapsedSec
            # Solo .NET sobre el propio hijo: NADA de CIM en el latido.
            $workingSet = "no-disponible"
            try {
                $process.Refresh()
                if (-not $process.HasExited) {
                    $workingSet = [math]::Round($process.WorkingSet64 / 1MB, 1)
                }
            }
            catch { $workingSet = "no-disponible" }
            Write-Diag ("heartbeat elapsed_s=" + $elapsedSec + " root_pid=" + $rootPid +
                " root_working_set_mb=" + $workingSet + " (solo .NET; sin CIM)")
        }

        # El contenido real del job solo se puede observar con una consulta del
        # sistema al alcanzar el limite (ver la instantanea). Aqui NO se consulta
        # nada: asi el latido no carga el runner mientras la prueba corre.
        if (($elapsedSec - $lastSnapshotSec) -ge $SnapshotEverySec) {
            $lastSnapshotSec = $elapsedSec
            $rootAlive = "no-disponible"
            try { $rootAlive = [string](-not $process.HasExited) } catch { }
            Write-Diag ("tick elapsed_s=" + $elapsedSec + " root_alive=" + $rootAlive +
                " (sin enumeracion; el job contiene mas procesos que los visibles aqui)")
        }
    }

    if ($timedOut) {
        $exitReason = "hard-limit"
        Write-Diag ("LIMITE DURO alcanzado (" + $HardLimitSec + "s). Se toma la instantanea ANTES de cerrar el job.")
        Write-Marker "hard-limit-snapshot"

        # INSTANTANEA: solo lectura. Una consulta CIM acotada, sin CommandLine.
        try {
            $rows = @(Get-CimInstance -ClassName Win32_Process `
                -Property ProcessId, ParentProcessId, Name, WorkingSetSize `
                -OperationTimeoutSec 5 -ErrorAction Stop)
        }
        catch {
            Write-Diag ("instantanea: la consulta CIM fallo: " + $_.Exception.GetType().Name)
            $rows = @()
        }

        $lines = New-Object System.Collections.ArrayList
        [void]$lines.Add("hard_limit_s=" + $HardLimitSec)
        [void]$lines.Add("root_pid=" + $rootPid)
        [void]$lines.Add("snapshot_rows=" + $rows.Count)
        [void]$lines.Add("(descendencia calculada por PPID desde root_pid; solo observacion)")
        if ($rows.Count -gt 0) {
            $childrenOf = @{}
            foreach ($row in $rows) {
                $parent = [int]$row.ParentProcessId
                if (-not $childrenOf.ContainsKey($parent)) {
                    $childrenOf[$parent] = New-Object System.Collections.ArrayList
                }
                [void]$childrenOf[$parent].Add($row)
            }
            $found = New-Object System.Collections.ArrayList
            $seen = New-Object System.Collections.Generic.HashSet[int]
            $pending = New-Object System.Collections.ArrayList
            [void]$pending.Add($rootPid)
            [void]$seen.Add($rootPid)
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
            [void]$lines.Add("descendants=" + $found.Count)
            foreach ($row in $found) {
                [void]$lines.Add("pid=" + $row.ProcessId + " ppid=" + $row.ParentProcessId +
                    " name=" + $row.Name + " working_set_mb=" + [math]::Round($row.WorkingSetSize / 1MB, 1))
            }
        }
        [System.IO.File]::WriteAllLines($snapshotPath, $lines)
        Write-Diag ("instantanea escrita en " + $snapshotPath)

        [System.IO.File]::AppendAllText($exitPath, "hard-limit" + [System.Environment]::NewLine)
        Write-Marker "hard-limit"
    }
    else {
        [System.IO.File]::AppendAllText($exitPath, "exit=" + $process.ExitCode + [System.Environment]::NewLine)
    }
}
catch {
    $message = $_.Exception.GetType().Name + ": " + $_.Exception.Message
    if ($exitReason -eq "unknown" -or $exitReason -eq "exception") {
        # Una excepcion despues de reanudar el hijo NO reemplaza el motivo real
        # (p. ej. "exit"): solo se informa.
        if ($exitReason -eq "unknown") { $exitReason = "exception" }
        Write-Diag ("EXCEPCION: " + $message)
        try { [System.IO.File]::AppendAllText($exitPath, "exception" + [System.Environment]::NewLine) } catch { }
    }
    else {
        # Motivo ya fijado por una comprobacion de lanzamiento (job/assign/etc.).
        Write-Diag ("ABORTA motivo=" + $exitReason + " detalle=" + $message)
    }
}
finally {
    # ---------------------------------------------------------------------
    # Limpieza SIEMPRE en finally. Orden:
    #   1. EL PROCESO SUSPENDIDO SIN ASIGNAR: se termina por su handle ANTES de
    #      cerrar el job, porque el job vacio no lo contiene y no lo terminaria.
    #   2. El job (KILL_ON_JOB_CLOSE termina lo que SI integro).
    #   3. Handles individuales y archivos.
    # NO se llama `exit` antes de este bloque: el codigo de salida se calcula al
    # final, despues de la limpieza.
    # ---------------------------------------------------------------------
    if (-not (Test-Path -LiteralPath $exitPath)) {
        try { [System.IO.File]::AppendAllText($exitPath, "unknown" + [System.Environment]::NewLine) } catch { }
    }

    # Cubre TODOS los caminos entre CreateProcess y AssignProcessToJobObject
    # (fallo de Assign, pero tambien cualquier excepcion en los logs/marcas
    # posteriores si se agregaran). Si ya se asigno o reanudo, no hace nada.
    Clear-SuspendedOrphan

    if ($jobHandle -ne [IntPtr]::Zero) {
        # Cerrar el job dispara KILL_ON_JOB_CLOSE: los procesos del job se
        # terminan. Esto ocurre DESPUES de la instantanea.
        [void][DiagJob.Native]::CloseHandle($jobHandle)
        $jobHandle = [IntPtr]::Zero
        try { Write-Diag "job cerrado (KILL_ON_JOB_CLOSE aplicado)" } catch { }
    }
    if ($threadHandle -ne [IntPtr]::Zero) {
        [void][DiagJob.Native]::CloseHandle($threadHandle)
        $threadHandle = [IntPtr]::Zero
    }
    if ($procHandle -ne [IntPtr]::Zero) {
        [void][DiagJob.Native]::CloseHandle($procHandle)
        $procHandle = [IntPtr]::Zero
    }
    if ($stdInHandle -ne [IntPtr]::Zero -and $stdInHandle -ne [IntPtr](-1)) {
        # Handle propio de NUL abierto para stdin del hijo.
        [void][DiagJob.Native]::CloseHandle($stdInHandle)
        $stdInHandle = [IntPtr]::Zero
    }
    if ($null -ne $process) {
        try { $process.Dispose() } catch { }
        $process = $null
    }
    if ($null -ne $stdoutStream) {
        try { $stdoutStream.Dispose() } catch { }
        $stdoutStream = $null
    }
    if ($null -ne $stderrStream) {
        try { $stderrStream.Dispose() } catch { }
        $stderrStream = $null
    }

    try {
        Write-Diag ("=== fin motivo=" + $exitReason + " ===")
    }
    catch { }
    if ($null -ne $writer) {
        try { $writer.Dispose() } catch { }
        $writer = $null
    }
}

# Codigo de salida, DESPUES de la limpieza (una sola salida real).
if ($timedOut) { exit 2 }
if ($exitReason -eq "exit") { exit 0 }
exit 3
