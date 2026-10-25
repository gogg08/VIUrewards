<#
.SYNOPSIS
  Instalador de las herramientas externas de VIUrewards (Fase de distribucion, Etapa 3B).

.DESCRIPTION
  Descarga Node.js, yt-dlp y FFmpeg/ffprobe desde el proveedor de cada uno,
  verifica el SHA-256 fijado e instala solo los archivos necesarios en el
  directorio de datos de VIUrewards:

    <datos>/runtime/node.exe          Node.js que ejecuta el servidor
    <datos>/runtime/LICENSE           aviso de licencia de Node.js
    <datos>/bin/yt-dlp.exe            herramienta administrada (la actualiza el dashboard)
    <datos>/bin/ffmpeg.exe
    <datos>/bin/ffprobe.exe
    <datos>/bin/ffmpeg-LICENSE.txt    texto GPLv3 del paquete del proveedor
    <datos>/bin/ffmpeg-PROCEDENCIA.txt procedencia (commit de FFmpeg, bibliotecas...)

  ## De donde salen las versiones

  Este script se genera desde `scripts/dist/config.ts` (unico lugar que fija
  versiones, URLs y hashes). Version, rutas y SHA-256 de cada herramienta son
  LITERALES en la tabla `$Tools`: el script NO parsea el `.ts` en tiempo de
  ejecucion, asi que la tabla de arriba y `config.ts` tienen que coincidir (lo
  comprueba `tests/dist/installer.test.ts`). Para cambiar una version se edita
  `config.ts` y se regenera este archivo con `npm run build:installer`.

  ## Seguridad

  - Todo se descarga a un archivo TEMPORAL dentro del directorio de datos y se
    verifica ahi. Un hash incorrecto, una descarga truncada o un error de red se
    descartan sin tocar la instalacion existente.
  - Solo se extrae lo declarado en `install` y `notices`, **nunca** el ZIP
    completo. Antes de escribir se comprueba que la ruta de destino quede dentro
    del directorio de datos esperado.
  - Nada se escribe en su destino final de a poco: se extrae a un temporal y se
    MUEVE (`Move-Item`), que en el mismo volumen es atomico. Asi no quedan
    ejecutables a medio escribir.
  - El hash fijado detecta corrupcion y cambios de archivo; **no es una firma
    digital** (ver `docs/distribution.md` sec. 1 y sec. 4).
  - El directorio de datos NUNCA puede ser la aplicacion ni estar dentro de
    ella (a ninguna profundidad). La raiz se deduce de `$PSScriptRoot`
    (`<app>/scripts/dist` -> `<app>`), que es la misma en fuentes y en el
    paquete; se compara contra el destino con separador obligatorio, asi que
    `C:\VIUrewards-datos` no se confunde con `C:\VIUrewards`.
    Los nombres de variable de PowerShell NO distinguen mayusculas: la variable
    local del guard se llama `$guardRoot` a proposito, porque `$applicationRoot`
    seria el MISMO parametro `$ApplicationRoot` y lo borraria.

  ## Politicas (`policy` en `config.ts`)

  - `if-missing` (yt-dlp, FFmpeg): si el destino ya existe, NO se sobrescribe con
    `-Force`. El usuario puede haberlo actualizado (yt-dlp, desde el dashboard).
  - `match-manifest` (Node): se respeta un `node.exe` ya instalado, con el mismo
    SHA-256. Si difiere y se pide reemplazarlo, se exige `-ForceRuntime`;
    mientras `VIUREWARDS_NODE_RUNTIME` apunte a ese proceso, el reemplazo se
    rechaza (el sistema operativo no permite sobrescribir un ejecutable en uso).

  ## Salidas

  Codigo 0 = todo listo (instalado ahora o ya estaba valido).
  Codigo 1 = fallo (mensaje en espanol).
  Codigo 2 = configuracion de rutas invalida. No se escribe nada.
  Codigo 3 = otra instancia usa estos datos (.viurewards.lock con PID vivo).
  No se escribe nada, ni siquiera con -ForceRuntime.

  Solo Windows PowerShell 5.1 o posterior. No requiere administrador.

.PARAMETER DataDir
  Directorio de datos persistente. Si se omite, se usa `VIUREWARDS_DATA_DIR`.
  Tiene que ser una ruta ABSOLUTA (la misma regla que `src/server/paths.ts`).

.PARAMETER ForceRuntime
  Autoriza reemplazar un `runtime/node.exe` cuyo SHA-256 no coincide con el fijado.

.PARAMETER ForceTool
  Autoriza reemplazar yt-dlp o FFmpeg ya instalados. Es SOLO para probar en un
  directorio temporal: en uso normal esas herramientas no se pisan (el dashboard
  actualiza yt-dlp y el instalador de una version nueva de VIUrewards no debe
  pisar esa version).

.PARAMETER KeepDownloads
  Deja los archivos descargados en `<datos>/.downloads`.

.PARAMETER ApplicationRoot
  SOLO PARA PRUEBAS: raiz de la aplicacion que se protege, en lugar de la
  deducida de `$PSScriptRoot`. Sirve para ejercitar el guard contra una
  estructura temporal (fuentes o paquete) sin copiar el instalador a la
  aplicacion real. Si se omite, se usa la raiz deducida de `$PSScriptRoot`.
  No cambia el comportamiento de produccion.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install-tools.ps1 `
    -DataDir "C:\VIUrewards-datos"
#>
[CmdletBinding()]
param(
  [string]$DataDir = "",
  [switch]$ForceRuntime,
  [switch]$ForceTool,
  [switch]$KeepDownloads,
  [string]$ApplicationRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

# ------------------------------------------------------------------------------
# Tabla de herramientas (generada desde scripts/dist/config.ts; no editar a mano)
# ------------------------------------------------------------------------------
# BEGIN GENERATED (desde scripts/dist/config.ts; regenerar con npm run build:installer)
$script:ManifestContractVersion = 1

$script:Tools = @(
  [ordered]@{
    id = 'node'
    version = '24.22.1'
    file = 'node-v24.22.1-win-x64.zip'
    url = 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip'
    sha256 = 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
    checksumSource = 'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt'
    policy = 'match-manifest'
    install = @(
      [ordered]@{ from = 'node-v24.22.1-win-x64/node.exe'; to = 'runtime/node.exe' }
    )
    notices = @(
      [ordered]@{ from = 'node-v24.22.1-win-x64/LICENSE'; to = 'runtime/LICENSE' }
    )
    installedSha256 = [ordered]@{
      'runtime/node.exe' = 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5'
    }
  }
  [ordered]@{
    id = 'yt-dlp'
    version = '2026.10.21'
    file = 'yt-dlp.exe'
    url = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/yt-dlp.exe'
    sha256 = '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555'
    checksumSource = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/SHA2-256SUMS'
    policy = 'if-missing'
    install = @(
      [ordered]@{ from = 'yt-dlp.exe'; to = 'bin/yt-dlp.exe' }
    )
    notices = @(
    )
  }
  [ordered]@{
    id = 'ffmpeg'
    version = '9.0.2'
    file = 'ffmpeg-9.0.2-essentials_build.zip'
    url = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip'
    sha256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
    checksumSource = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256'
    policy = 'if-missing'
    install = @(
      [ordered]@{ from = 'ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe'; to = 'bin/ffmpeg.exe' }
      [ordered]@{ from = 'ffmpeg-9.0.2-essentials_build/bin/ffprobe.exe'; to = 'bin/ffprobe.exe' }
    )
    notices = @(
      [ordered]@{ from = 'ffmpeg-9.0.2-essentials_build/LICENSE'; to = 'bin/ffmpeg-LICENSE.txt' }
      [ordered]@{ from = 'ffmpeg-9.0.2-essentials_build/README.txt'; to = 'bin/ffmpeg-PROCEDENCIA.txt' }
    )
  }
)
# END GENERATED

# ------------------------------------------------------------------------------
# Salida
# ------------------------------------------------------------------------------
$script:Result = [ordered]@{
  status = "failed"
  reason = "unknown"
  message = ""
  dataDir = $null
  contractVersion = $script:ManifestContractVersion
  tools = @()
}

function Write-Result {
  param([string]$Status, [string]$Reason, [string]$Message)
  $script:Result.status = $Status
  $script:Result.reason = $Reason
  $script:Result.message = $Message
  $json = $script:Result | ConvertTo-Json -Depth 6
  Write-Output $json
}

function Stop-WithError {
  param([string]$Reason, [string]$Message, [int]$Code = 1)
  Write-Result "failed" $Reason $Message
  Write-Host ""
  Write-Host "Instalacion de herramientas: FALLO." -ForegroundColor Red
  Write-Host $Message -ForegroundColor Red
  exit $Code
}

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message" -ForegroundColor Cyan
}

# ------------------------------------------------------------------------------
# Rutas: normalizacion y validacion ANTES de escribir nada
# ------------------------------------------------------------------------------

# La ruta tiene que quedar DENTRO de `$Base` (o ser la base). Se compara sobre
# ruta completa y sin separador final: nada de `..` ni de prefijos parciales
# (`C:\datos` no contiene `C:\datos2`).
function Test-PathInside {
  param([string]$Base, [string]$Path)

  $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  $pathFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  if ($pathFull.Equals($baseFull, $comparison)) { return $true }
  # El separador es OBLIGATORIO: es lo que distingue un subdirectorio real de
  # una ruta que solo comparte prefijo de texto (`C:\VIUrewards-data` NO esta
  # dentro de `C:\VIUrewards`).
  return $pathFull.StartsWith($baseFull + [System.IO.Path]::DirectorySeparatorChar, $comparison)
}

function Assert-InsideDataDir {
  param([string]$Base, [string]$Path, [string]$What)

  $pathFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  if (Test-PathInside $Base $pathFull) { return $pathFull }
  $baseFull = [System.IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
  throw [System.InvalidOperationException]::new(
    ("{0} quedaria fuera del directorio de datos ({1}): {2}" -f $What, $baseFull, $pathFull)
  )
}

function Resolve-DataDir {
  param([string]$Requested)

  if ([string]::IsNullOrWhiteSpace($Requested)) {
    $message = "Falta el directorio de datos. Pasa -DataDir ""C:\ruta\a\los\datos"" o defini VIUREWARDS_DATA_DIR. No se escribio nada."
    Stop-WithError -Reason "data-dir-missing" -Message $message -Code 2
  }
  $value = $Requested.Trim()

  # Validacion explicita y en espanol de cada paso. Sin esto, una ruta que el
  # runtime de .NET rechaza (por ejemplo la unidad raiz con formato "C:", que
  # `IsPathRooted` no acepta) caia en el `catch` general como "error" (codigo 1)
  # con el mensaje de excepcion TRADUCIDO por Windows y sin explicar que hacer.
  $rooted = $false
  try {
    $rooted = [System.IO.Path]::IsPathRooted($value)
  } catch {
    $rooted = $false
  }
  if (-not $rooted) {
    $message = "El directorio de datos tiene que ser una ruta ABSOLUTA y valida (recibi ""{0}""): una ruta relativa dependeria del directorio de trabajo. No se escribio nada." -f $value
    Stop-WithError -Reason "data-dir-relative" -Message $message -Code 2
  }

  $full = $null
  try {
    $full = [System.IO.Path]::GetFullPath($value)
  } catch {
    $full = $null
  }
  if ([string]::IsNullOrWhiteSpace($full)) {
    $message = "No se pudo interpretar ""{0}"" como una ruta de Windows. Usa algo como ""C:\VIUrewards-datos"". No se escribio nada." -f $value
    Stop-WithError -Reason "data-dir-invalid" -Message $message -Code 2
  }

  # La raiz de una unidad ("C:\") nunca es un directorio de datos: el instalador
  # escribiria `runtime/` y `bin/` en la raiz del disco.
  if ([System.IO.Path]::GetPathRoot($full).TrimEnd('\', '/') -eq $full.TrimEnd('\', '/')) {
    $message = """{0}"" es la raiz de una unidad, no una carpeta de datos. Elegi una carpeta propia (por ejemplo ""C:\VIUrewards-datos""). No se escribio nada." -f $full
    Stop-WithError -Reason "data-dir-is-drive-root" -Message $message -Code 2
  }

  if (Test-Path -LiteralPath $full -PathType Leaf) {
    $message = """{0}"" existe pero no es una carpeta. Elegi otra ruta o quita la variable. No se escribio nada." -f $full
    Stop-WithError -Reason "data-dir-not-a-directory" -Message $message -Code 2
  }
  # Se devuelve SIN separador final: asi el resto del script (mensajes,
  # comparaciones y `Join-Path`) trabaja siempre con la misma forma.
  return $full.TrimEnd('\', '/')
}

# El cerrojo de instancia (`.viurewards.lock`) lo escribe `scripts/start.ts` en la
# raiz de los datos con `{pid, at}`, con `openSync("wx")`. Si existe y su proceso
# sigue vivo, hay una instancia usando la base, los medios y las herramientas:
# el instalador se niega ANTES de escribir nada.
#
# Si el proceso ya no existe, el archivo esta huerfano y el arranque de
# VIUrewards lo libera solo: aca se informa y se continua.
function Get-RunningInstancePid {
  param([string]$DataDir)

  $lockPath = Join-Path $DataDir ".viurewards.lock"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
  $ownerPid = $null
  try {
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    if ($null -ne $lock.pid) { $ownerPid = [int]$lock.pid }
  } catch {
    # Cerrojo ilegible: no se puede confirmar que nadie lo use, asi que se pide cerrar.
    return -1
  }
  if ($null -eq $ownerPid -or $ownerPid -le 0) { return -1 }
  $running = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($null -eq $running) {
    Write-Host ("  aviso: el cerrojo {0} quedo huerfano (el proceso {1} ya no existe)." -f $lockPath, $ownerPid)
    return $null
  }
  return $ownerPid
}

# ------------------------------------------------------------------------------
# Descarga y verificacion
# ------------------------------------------------------------------------------

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Save-Download {
  param([string]$Url, [string]$Destination)

  $previous = [System.Net.ServicePointManager]::SecurityProtocol
  try {
    # TLS 1.2 explicito: Windows PowerShell 5.1 en Windows antiguos no lo negocia solo.
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
    $client = New-Object System.Net.WebClient
    $client.Headers.Add("user-agent", "VIUrewards-installer")
    $client.DownloadFile($Url, $Destination)
    $client.Dispose()
  } finally {
    [System.Net.ServicePointManager]::SecurityProtocol = $previous
  }

  $length = (Get-Item -LiteralPath $Destination).Length
  if ($length -le 0) {
    throw [System.IO.InvalidDataException]::new("La descarga de $Url quedo vacia.")
  }
}

function Expand-ArchiveSafe {
  param([string]$Archive, [string]$Destination)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = $null
  try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    foreach ($entry in $zip.Entries) {
      $target = Join-Path $Destination $entry.FullName
      Assert-InsideDataDir $Destination $target ("La entrada """ + $entry.FullName + """ del ZIP") | Out-Null
      if ($entry.FullName.EndsWith("/") -or $entry.FullName.EndsWith("\")) {
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        continue
      }
      $parent = [System.IO.Path]::GetDirectoryName($target)
      if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      $source = $entry.Open()
      try {
        $out = [System.IO.File]::Open($target, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
        try {
          $source.CopyTo($out)
        } finally {
          $out.Dispose()
        }
      } finally {
        $source.Dispose()
      }
    }
  } finally {
    if ($null -ne $zip) { $zip.Dispose() }
  }
}

# Extrae SOLO `$EntryName` del ZIP `$Archive` a `$WorkDir` y devuelve la ruta.
# Se usa `$zip.GetEntry(nombre)`: en Windows PowerShell 5.1 la extension
# `ZipFileExtensions::OpenRead` NO es accesible por nombre, asi que la lectura
# siempre pasa por la entrada del `ZipArchive`.
function Extract-PinnedEntry {
  param([string]$Archive, [string]$EntryName, [string]$WorkDir)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = $null
  try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    $entry = $zip.GetEntry($EntryName)
    if ($null -eq $entry) {
      throw [System.IO.InvalidDataException]::new("El artefacto descargado no contiene ""$EntryName"".")
    }
    $target = Join-Path $WorkDir ([System.IO.Path]::GetFileName($EntryName))
    # La ruta de salida tiene que quedar dentro del temporal de trabajo.
    Assert-InsideDataDir $WorkDir $target ("La entrada ""$EntryName"" del ZIP") | Out-Null
    $source = $entry.Open()
    try {
      $out = [System.IO.File]::Open($target, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
      try {
        $source.CopyTo($out)
      } finally {
        $out.Dispose()
      }
    } finally {
      $source.Dispose()
    }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
      throw [System.IO.InvalidDataException]::new("No se pudo extraer ""$EntryName"" de $Archive.")
    }
    return $target
  } finally {
    if ($null -ne $zip) { $zip.Dispose() }
  }
}

# ------------------------------------------------------------------------------
# Instalacion de una herramienta
# ------------------------------------------------------------------------------

function Get-ToolState {
  param([hashtable]$Tool, [string]$DataDir)

  $existing = @()
  foreach ($item in $Tool.install) {
    $path = Assert-InsideDataDir $DataDir (Join-Path $DataDir $item.to) ("El destino """ + $item.to + """")
    if (Test-Path -LiteralPath $path -PathType Leaf) { $existing += $path }
  }
  $state = [ordered]@{
    id = $Tool.id
    version = $Tool.version
    installed = $false
    replaced = $false
    files = @()
  }

  # Ya instalado: `if-missing` lo respeta SIEMPRE.
  if ($existing.Count -eq $Tool.install.Count) {
    $state.installed = $true
    $state.files = $existing
    if ($Tool.policy -eq "match-manifest") {
      # Se compara el hash del ARCHIVO INSTALADO (`installedSha256`), no el del
      # ZIP descargado: `node.exe` es un miembro del ZIP y nunca coincide con el
      # hash del ZIP. Sin esto, cada reintento rechazaba una instalacion valida.
      if ($null -eq $Tool.installedSha256) {
        throw [System.InvalidOperationException]::new("La herramienta $($Tool.id) usa la politica match-manifest sin installedSha256 en scripts/dist/config.ts.")
      }
      $expected = $Tool.installedSha256[$Tool.install[0].to]
      if ([string]::IsNullOrWhiteSpace($expected)) {
        throw [System.InvalidOperationException]::new("Falta el hash instalado de $($Tool.install[0].to) en scripts/dist/config.ts.")
      }
      $primary = $existing[0]
      $hash = Get-Sha256 $primary
      if ($hash -ne $expected -and -not $ForceRuntime) {
        $message = "El runtime instalado ({0}) no coincide con el SHA-256 fijado para {1} {2}. No se reemplaza sin autorizacion: cerra VIUrewards y volve a ejecutar el instalador con -ForceRuntime. No se modifico nada." -f $primary, $Tool.id, $Tool.version
        Stop-WithError -Reason "runtime-differs" -Message $message
      }
      if ($hash -ne $expected) {
        # Se va a reemplazar: sigue el camino de instalacion.
        $state.installed = $false
        $state.files = @()
      }
    }
    if ($state.installed) { return $state }
  } elseif ($existing.Count -gt 0 -and $Tool.policy -eq "if-missing") {
    # Instalacion parcial: nunca se completa por encima de lo que hay (podria ser
    # una version que el usuario administra a mano). Se informa y se falla.
    $message = "La herramienta {0} ya tiene archivos instalados en {1} pero le faltan otros. No se toca una instalacion parcial: revisa el directorio o borra esos archivos a mano." -f $Tool.id, ($existing -join ", ")
    Stop-WithError -Reason "partial-install" -Message $message
  }

  if ($state.installed) { return $state }
  return $state
}

function Install-Tool {
  param([hashtable]$Tool, [string]$DataDir, [string]$DownloadsDir, [string]$WorkRoot)

  $targets = @($Tool.install + $Tool.notices)
  $destinations = @()
  foreach ($item in $targets) {
    $destinations += Assert-InsideDataDir $DataDir (Join-Path $DataDir $item.to) ("El destino """ + $item.to + """")
  }

  $state = [ordered]@{ id = $Tool.id; version = $Tool.version; installed = $true; replaced = $false; files = $destinations }

  Write-Host ("  descargando {0} {1}..." -f $Tool.id, $Tool.version)
  $download = Join-Path $DownloadsDir $Tool.file
  if (-not (Test-Path -LiteralPath $download -PathType Leaf)) {
    $partial = $download + ".part"
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    Save-Download $Tool.url $partial
    $actual = Get-Sha256 $partial
    if ($actual -ne $Tool.sha256) {
      Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
      $message = "El SHA-256 de {0} no coincide con el fijado en scripts/dist/config.ts.`n  esperado: {1} ({2})`n  obtenido: {3}`nNo se instalo nada de esa herramienta." -f $Tool.file, $Tool.sha256, $Tool.checksumSource, $actual
      Stop-WithError -Reason "checksum-mismatch" -Message $message
    }
    Move-Item -LiteralPath $partial -Destination $download -Force
  } else {
    $actual = Get-Sha256 $download
    if ($actual -ne $Tool.sha256) {
      Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
      $message = "La descarga en cache de {0} no coincide con el SHA-256 fijado. Se descarto; volve a ejecutar el instalador." -f $Tool.file
      Stop-WithError -Reason "checksum-mismatch" -Message $message
    }
    Write-Host "  (descarga ya verificada en cache)"
  }

  # Extraccion SOLO de lo declarado, en un temporal dentro del directorio de datos.
  $workDir = Join-Path $WorkRoot ("extraido-" + $Tool.id)
  if (Test-Path -LiteralPath $workDir) { Remove-Item -Recurse -Force -LiteralPath $workDir }
  New-Item -ItemType Directory -Path $workDir -Force | Out-Null

  $extracted = @{}
  foreach ($item in $targets) {
    $local = $null
    if ($Tool.file.EndsWith(".zip")) {
      $local = Extract-PinnedEntry (Join-Path $DownloadsDir $Tool.file) $item.from $workDir
    } else {
      # Un ejecutable suelto (yt-dlp): el artefacto ES el archivo.
      if ($item.from -ne $Tool.file) {
        throw [System.IO.InvalidDataException]::new("El artefacto de $($Tool.id) no contiene ""$($item.from)"".")
      }
      $local = Join-Path $DownloadsDir $Tool.file
    }
    if (-not (Test-Path -LiteralPath $local -PathType Leaf)) {
      throw [System.IO.InvalidDataException]::new("No se pudo extraer ""$($item.from)"" de $($Tool.file).")
    }
    $extracted[$item.from] = $local
  }

  # Se valida TODO antes de mover nada: si un destino es un ejecutable en uso,
  # se detecta aca (antes de haber reemplazado nada).
  for ($index = 0; $index -lt $targets.Count; $index += 1) {
    $destination = $destinations[$index]
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
      if ($Tool.policy -eq "if-missing" -and -not $ForceTool) {
        $message = "{0} ya existe en {1} y no se sobrescribe (politica if-missing): el usuario puede haberlo actualizado. No se modifico nada." -f $Tool.id, $destination
        Stop-WithError -Reason "already-installed" -Message $message
      }
      $state.replaced = $true
      try {
        $handle = [System.IO.File]::Open($destination, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $handle.Dispose()
      } catch {
        $message = "No se puede reemplazar ""{0}"" porque esta en uso. Cerra VIUrewards y volve a intentarlo. No se modifico nada." -f $destination
        Stop-WithError -Reason "file-in-use" -Message $message
      }
    }
  }

  # Escritura: primero a un temporal al lado del destino y despues se mueve.
  # Si algo falla, se borran los `.installing` que haya dejado ESTA herramienta:
  # no quedan ejecutables a medio escribir (los destinos finales no se tocan).
  $installing = @()
  try {
    for ($index = 0; $index -lt $targets.Count; $index += 1) {
      $destination = $destinations[$index]
      $parent = [System.IO.Path]::GetDirectoryName($destination)
      if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      $temp = $destination + ".installing"
      if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
      $installing += $temp
      Copy-Item -LiteralPath $extracted[$targets[$index].from] -Destination $temp -Force
      if (Test-Path -LiteralPath $destination -PathType Leaf) {
        Move-Item -LiteralPath $temp -Destination $destination -Force
      } else {
        Move-Item -LiteralPath $temp -Destination $destination
      }
    }
  } catch {
    foreach ($temp in $installing) {
      if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
    throw
  }

  Remove-Item -Recurse -Force -LiteralPath $workDir -ErrorAction SilentlyContinue
  Write-Host ("  {0} {1} instalado en {2}" -f $Tool.id, $Tool.version, ([System.IO.Path]::GetDirectoryName($destinations[0])))
  return $state
}

# ------------------------------------------------------------------------------
# Principal
# ------------------------------------------------------------------------------
# Limpieza de temporales de una ejecucion anterior (si se corto a mitad). Se
# registra ANTES de crear nada: si el script falla, `catch` la llama.
$script:WorkRoot = $null
function Remove-WorkRoot {
  if ($null -ne $script:WorkRoot -and (Test-Path -LiteralPath $script:WorkRoot)) {
    Remove-Item -Recurse -Force -LiteralPath $script:WorkRoot -ErrorAction SilentlyContinue
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Stop-WithError -Reason "unsupported-platform" -Message "Este instalador es para Windows." -Code 2
  }

  $requested = $DataDir
  if ([string]::IsNullOrWhiteSpace($requested)) {
    $requested = [Environment]::GetEnvironmentVariable("VIUREWARDS_DATA_DIR")
  }
  $dataDir = Resolve-DataDir $requested
  $script:Result.dataDir = $dataDir

  # Antes de crear nada: el directorio de datos NO puede ser la raiz de la
  # APLICACION, NI una carpeta DENTRO de ella, SIN LIMITE de profundidad. Si lo
  # es, el instalador escribiria `runtime/` y `bin/` dentro del codigo versionado.
  #
  # La raiz se deduce de la posicion del PROPIO script, que es la misma en los
  # dos contextos reales:
  #
  #   fuentes:   <repo>/scripts/dist/install-tools.ps1      -> <repo>
  #   paquete:   <paquete>/app/scripts/dist/install-tools.ps1 -> <paquete>/app
  #
  # En ambos, la raiz de la aplicacion es el directorio abuelo de
  # `$PSScriptRoot` (el padre de `scripts/`), y ambos tienen `package.json`.
  #
  # Antes se subia como maximo 4 niveles desde el DESTINO buscando marcadores
  # (`package.json`/`src`/`scripts`) y el resultado dependia de la profundidad
  # del directorio de datos: a 5 niveles o mas el guard dejaba pasar y el
  # instalador escribia DENTRO de la app. Tambien obligaba a un tope para no
  # confundir un ancestro lejano (`C:\scripts` existe en muchas maquinas).
  #
  # Ahora la comparacion es explicita entre rutas ABSOLUTAS normalizadas:
  #  - la raiz exacta se rechaza;
  #  - cualquier subdirectorio, a cualquier profundidad, se rechaza;
  #  - `C:\VIUrewards-data` NO cuenta como subdirectorio de `C:\VIUrewards`
  #    (`Assert`/`Test-PathInside` exigen el separador).
  # OJO: los nombres de variable de PowerShell NO distinguen mayusculas, asi que
  # `$applicationRoot` y el parametro `$ApplicationRoot` eran LA MISMA variable:
  # inicializarla a `$null` borraba el parametro y el guard solo podia rechazar
  # la raiz deducida. Por eso se usan nombres que no colisionan.
  $guardRoot = $null
  if (-not [string]::IsNullOrWhiteSpace($ApplicationRoot)) {
    # Solo pruebas: la raiz la indica el test (estructura temporal).
    $guardRoot = [System.IO.Path]::GetFullPath($ApplicationRoot).TrimEnd('\', '/')
  } elseif (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    $scriptsRoot = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($PSScriptRoot))
    if (-not [string]::IsNullOrWhiteSpace($scriptsRoot)) {
      $candidate = [System.IO.Path]::GetDirectoryName($scriptsRoot)
      # Solo se considera raiz de la aplicacion si tiene codigo: si el .ps1 se
      # copiara fuera de la app, no se inventa una raiz.
      if (-not [string]::IsNullOrWhiteSpace($candidate) -and
          (Test-Path -LiteralPath (Join-Path $candidate "package.json") -PathType Leaf)) {
        $guardRoot = $candidate.TrimEnd('\', '/')
      }
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($guardRoot) -and (Test-PathInside $guardRoot $dataDir)) {
    $message = """{0}"" esta dentro del directorio de la APLICACION ({1}), no es un directorio de datos. Elegi una carpeta propia, fuera de la aplicacion (por ejemplo ""C:\VIUrewards-datos""). No se escribio nada." -f $dataDir, $guardRoot
    Stop-WithError -Reason "data-dir-is-application" -Message $message -Code 2
  }

  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

  # Cerrojo de instancia: otra copia usando estos datos (base, medios, herramientas)
  # se rechaza ANTES de crear `.downloads`, descargar o extraer nada.
  $ownerPid = Get-RunningInstancePid $dataDir
  if ($null -ne $ownerPid) {
    $message = "Hay una instancia de VIUrewards usando estos datos (cerrojo ""$(Join-Path $dataDir '.viurewards.lock')""): cerrala y volve a ejecutar el instalador. No se modifico nada."
    Stop-WithError -Reason "data-in-use" -Message $message -Code 3
  }

  foreach ($sub in @("runtime", "bin")) {
    $dir = Assert-InsideDataDir $dataDir (Join-Path $dataDir $sub) "El directorio $sub"
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
  }

  # Descargas y trabajo: dentro del directorio de datos (mismo volumen que el
  # destino, asi `Move-Item` no cruza discos), fuera de `bin/` y `runtime/`.
  $downloadsDir = Join-Path $dataDir ".downloads"
  if (-not (Test-Path -LiteralPath $downloadsDir -PathType Container)) {
    New-Item -ItemType Directory -Path $downloadsDir -Force | Out-Null
  }
  $workRoot = Join-Path $downloadsDir ".trabajo"
  $script:WorkRoot = $workRoot
  if (-not (Test-Path -LiteralPath $workRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
  }

  Write-Host "VIUrewards: herramientas externas"
  Write-Host "  datos: $dataDir"

  $results = @()
  foreach ($tool in $script:Tools) {
    $state = Get-ToolState $tool $dataDir
    if ($state.installed) {
      Write-Host ("  {0} {1}: ya instalado ({2})" -f $tool.id, $tool.version, $state.files[0])
      $results += $state
      continue
    }
    $results += Install-Tool $tool $dataDir $downloadsDir $workRoot
  }
  $script:Result.tools = $results

  if (-not $KeepDownloads) {
    Remove-Item -Recurse -Force -LiteralPath $downloadsDir -ErrorAction SilentlyContinue
  } else {
    Remove-Item -Recurse -Force -LiteralPath $workRoot -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "Herramientas listas." -ForegroundColor Green
  Write-Host "  Arranca VIUrewards con VIUREWARDS_DATA_DIR=""$dataDir"" (y, si hace falta,"
  Write-Host "  VIUREWARDS_NODE_RUNTIME=""$(Join-Path $dataDir 'runtime\node.exe')"")."
  Write-Result "ok" "installed" "Herramientas externas al dia en $dataDir."
  exit 0
} catch {
  Remove-WorkRoot
  $reason = "error"
  if ($_.Exception -is [System.InvalidOperationException]) { $reason = "unsafe-path" }
  Stop-WithError -Reason $reason -Message $_.Exception.Message
}
