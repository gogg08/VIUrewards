
<#
  VIUrewards - instalador de un solo paso (bootstrap).

  Uso normal, desde PowerShell:

      irm https://github.com/gogg08/VIUrewards/releases/latest/download/install.ps1 | iex

  Tambien se puede ejecutar como archivo:

      powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

  Que hace, en orden:
    1. Comprueba Windows x64 y Windows PowerShell 5.1 o superior.
    2. Descarga el ZIP del release, verifica su SHA-256 y lo borra.
    3. Extrae a una carpeta temporal HERMANA de la carpeta de la app.
    4. Reemplaza la instalacion anterior (con rollback) y borra la copia vieja.
    5. Ejecuta el instalador de herramientas externas (Node.js, yt-dlp, FFmpeg).
    6. Crea el acceso directo del Menu Inicio y abre el launcher.

  Que NO hace:
    - No crea ni modifica el directorio de datos: solo se lo pasa al instalador
      de herramientas como -DataDir.
    - No crea el acceso directo de "Iniciar con Windows": ese vive en la carpeta
      Inicio, lleva -AutoStart y lo gestiona el launcher desde Ajustes. Aca se
      crea el del MENU Inicio, SIN -AutoStart, para que el usuario vea la ventana.
    - No cambia la ExecutionPolicy ni el PSModulePath del usuario.
    - No usa Get-FileHash ni Expand-Archive: el hash se calcula con .NET y la
      extraccion con System.IO.Compression. Un PSModulePath heredado de
      PowerShell 7 puede dejar a Windows PowerShell 5.1 sin esos cmdlets.

  Overrides SOLO por variables de entorno, porque "irm | iex" no admite
  parametros:

      VIUREWARDS_INSTALL_VERSION         Version a instalar (por defecto @@VERSION@@).
      VIUREWARDS_INSTALL_SHA256          SHA-256 esperado del ZIP (por defecto @@SHA256@@).
      VIUREWARDS_INSTALL_BASE_URL        Base de descarga. Por defecto
                                         https://github.com/gogg08/VIUrewards/releases/download/v<VERSION>
      VIUREWARDS_INSTALL_DIR             Carpeta de la app.
                                         Por defecto %LOCALAPPDATA%\Programs\VIUrewards
      VIUREWARDS_INSTALL_START_MENU_DIR  Carpeta del Menu Inicio donde se crea el
                                         .lnk. Por defecto el Menu Inicio
                                         "Programs" del usuario actual.
      VIUREWARDS_INSTALL_DATA_DIR        Directorio de datos que se le pasa al
                                         instalador de herramientas. Por defecto
                                         VIUREWARDS_DATA_DIR o %LOCALAPPDATA%\VIUrewards
      VIUREWARDS_INSTALL_NO_LAUNCH       "1" para no abrir el launcher al final.
      VIUREWARDS_INSTALL_SKIP_TOOLS      "1" para no instalar Node.js, yt-dlp ni FFmpeg.

  Codigos de salida (SOLO cuando corre como archivo):
      0  instalacion completa (aunque el instalador de herramientas haya avisado).
      1  fallo general.
      2  entorno o rutas invalidas, o marcadores sin reemplazar.
      3  hay una instancia de VIUrewards en ejecucion.

  Cuando corre por "iex" NO llama a exit (cerraria la consola del usuario): el
  cuerpo principal termina sin salir y deja el codigo en $global:LASTEXITCODE.

  Windows PowerShell 5.1, ASCII puro y CRLF. La version publicada reemplaza los
  marcadores @@VERSION@@ y @@SHA256@@.
#>

# Todo vive dentro de este scriptblock: al ejecutarse por "iex" no se define
# ninguna funcion ni variable en la sesion del usuario, y Set-StrictMode y
# $ErrorActionPreference quedan acotados a este bloque.
& {
  Set-StrictMode -Version 2.0
  $ErrorActionPreference = "Stop"

  $VersionFallback = "@@VERSION@@"
  $Sha256Fallback = "@@SHA256@@"
  $DefaultBaseUrlPrefix = "https://github.com/gogg08/VIUrewards/releases/download/v"
  $RequiredRelativePaths = @(
    "VIUrewards.cmd",
    "app\scripts\dist\install-tools.ps1",
    "app\scripts\dist\launcher-gui.ps1"
  )
  # Nombre del .lnk del Menu Inicio. El de "Iniciar con Windows" es otro (carpeta
  # Inicio, con -AutoStart) y lo maneja el launcher: aca no se toca.
  $StartMenuLinkName = "VIUrewards.lnk"

  # ----------------------------------------------------------------------------
  # Helpers
  # ----------------------------------------------------------------------------

  function Get-EnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $value) { return "" }
    return $value.Trim()
  }

  function Test-EnvFlag {
    param([Parameter(Mandatory = $true)][string]$Name)
    $value = (Get-EnvValue $Name).ToLowerInvariant()
    if ($value -eq "1" -or $value -eq "true" -or $value -eq "yes") { return $true }
    return $false
  }

  function Write-Step {
    param([string]$Message)
    Write-Host ("  " + $Message)
  }

  function Write-Warn {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Yellow
  }

  # Ruta completa sin separador final.
  function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd("\", "/")
  }

  # $Path esta dentro de $Base (o es la base). Separador OBLIGATORIO: asi
  # C:\VIUrewards-data no cuenta como hijo de C:\VIUrewards.
  function Test-PathInside {
    param([Parameter(Mandatory = $true)][string]$Base, [Parameter(Mandatory = $true)][string]$Path)
    $baseFull = Get-NormalizedPath $Base
    $pathFull = Get-NormalizedPath $Path
    $comparison = [System.StringComparison]::OrdinalIgnoreCase
    if ($pathFull.Equals($baseFull, $comparison)) { return $true }
    return $pathFull.StartsWith($baseFull + [System.IO.Path]::DirectorySeparatorChar, $comparison)
  }

  # Se usa .NET y no Get-FileHash: ese cmdlet viene de
  # Microsoft.PowerShell.Utility y un PSModulePath heredado de PowerShell 7 deja
  # al 5.1 sin el comando (fallo real del empaquetado en los runners).
  function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $hash = $sha.ComputeHash($stream)
      } finally {
        $sha.Dispose()
      }
    } finally {
      $stream.Dispose()
    }
    return ([System.BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
  }

  # Una instancia en ejecucion se detecta con el MISMO criterio que
  # install-tools.ps1 (funcion Get-RunningInstancePid): el cerrojo
  # .viurewards.lock en la raiz de los datos con un PID todavia vivo. Un cerrojo
  # ilegible tambien cuenta como "en uso" (no se puede confirmar lo contrario).
  # Nunca se termina ningun proceso.
  function Get-RunningInstancePid {
    param([Parameter(Mandatory = $true)][string]$DataDir)
    $lockPath = Join-Path $DataDir ".viurewards.lock"
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
    $ownerPid = $null
    try {
      $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
      if ($null -ne $lock.pid) { $ownerPid = [int]$lock.pid }
    } catch {
      return -1
    }
    if ($null -eq $ownerPid -or $ownerPid -le 0) { return -1 }
    $running = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($null -eq $running) { return $null }
    return $ownerPid
  }

  # Hay algo de ESTA instalacion en ejecucion (launcher o servidor con su
  # node.exe/runtime): cualquiera de sus ejecutables corre desde InstallDir.
  # Los datos NO se miran aca: se cubren con el cerrojo de arriba.
  function Get-RunningAppProcess {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
      $processPath = $null
      try {
        $processPath = $process.Path
      } catch {
        # Un proceso de otro usuario no expone la ruta: no es este.
        $processPath = $null
      }
      if ([string]::IsNullOrWhiteSpace($processPath)) { continue }
      if ($process.Id -eq $PID) { continue }
      if (Test-PathInside $InstallDir $processPath) { return $process.Id }
    }
    return $null
  }

  # Corre un proceso hijo esperando su salida. La ruta va como UN solo argumento
  # entrecomillado: el launcher aprendio que un arreglo re-entrecomilla y parte
  # las rutas con espacios.
  function Invoke-ChildProcess {
    param(
      [Parameter(Mandatory = $true)][string]$FilePath,
      [Parameter(Mandatory = $true)][string]$Arguments,
      [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $code = 1
    try {
      # La salida del hijo va directo a la consola del usuario.
      $process.WaitForExit()
      $code = $process.ExitCode
    } finally {
      $process.Dispose()
    }
    return $code
  }

  function Remove-Temporary {
    if (-not [string]::IsNullOrWhiteSpace($State.StagingDir) -and (Test-Path -LiteralPath $State.StagingDir)) {
      Remove-Item -Recurse -Force -LiteralPath $State.StagingDir -ErrorAction SilentlyContinue
    }
    if (-not [string]::IsNullOrWhiteSpace($State.DownloadFile) -and (Test-Path -LiteralPath $State.DownloadFile)) {
      Remove-Item -Force -LiteralPath $State.DownloadFile -ErrorAction SilentlyContinue
    }
  }

  # Todo el estado temporal vive en esta tabla hash, que queda encerrada en el
  # scriptblock: por "iex" no se deja nada en la sesion del usuario. (Las
  # variables de ambito script SI se escaparian a la sesion, porque ahi el ambito
  # "script" es el global.)
  $State = @{
    IsFileMode = -not [string]::IsNullOrWhiteSpace($PSCommandPath)
    StagingDir = $null
    DownloadFile = $null
  }

  # Un aborto NO vuelve por si solo al cuerpo principal: lanza una excepcion con
  # el codigo y el mensaje, y el UNICO try/catch/finally del cuerpo principal
  # hace la finalizacion y decide con que codigo se termina. Asi ningun camino
  # puede seguir ejecutando el paso siguiente por olvidarse de un return.
  #
  # Por "iex" NO se llama a exit (cerraria la consola del usuario): el cuerpo
  # termina y el codigo queda en $global:LASTEXITCODE. Como archivo, el cuerpo
  # llama a exit con ese codigo.
  function New-BootstrapAbort {
    param([int]$Code, [string]$Message)
    $exception = New-Object System.InvalidOperationException ($Message)
    $exception.Data["ViuBootstrapCode"] = $Code
    return $exception
  }

  # ----------------------------------------------------------------------------
  # Cuerpo principal: cualquier aborto lanza una excepcion (New-BootstrapAbort) y
  # cae en el catch de aca abajo. Un solo lugar finaliza, informa y decide el
  # codigo de salida: ningun camino depende de que el llamador recuerde un
  # return, asi que un aborto nunca sigue con el paso siguiente.
  # ----------------------------------------------------------------------------
  try {
    # ----------------------------------------------------------------------------
    # (a) Entorno
    # ----------------------------------------------------------------------------

    # $IsWindows NO existe en Windows PowerShell 5.1 (solo en Core): se consulta
    # la plataforma por .NET, que esta en las dos.
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
      throw (New-BootstrapAbort 2 "Este instalador es para Windows.")
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
      throw (New-BootstrapAbort 2 "VIUrewards necesita Windows x64.")
    }
    if ($PSVersionTable.PSVersion.Major -lt 5 -or
        ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -lt 1)) {
      throw (New-BootstrapAbort 2 "Hace falta Windows PowerShell 5.1 o superior.")
    }

    # TLS 1.2: Windows PowerShell 5.1 en Windows antiguos no lo negocia solo. Se
    # AGREGA al valor actual, sin quitar los protocolos que ya estaban.
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

    # ----------------------------------------------------------------------------
    # Version y SHA-256: variables de entorno o los marcadores del release
    # ----------------------------------------------------------------------------

    $version = Get-EnvValue "VIUREWARDS_INSTALL_VERSION"
    if ([string]::IsNullOrWhiteSpace($version)) { $version = $VersionFallback }
    $sha256 = Get-EnvValue "VIUREWARDS_INSTALL_SHA256"
    if ([string]::IsNullOrWhiteSpace($sha256)) { $sha256 = $Sha256Fallback }
    $baseUrl = Get-EnvValue "VIUREWARDS_INSTALL_BASE_URL"

    # Un marcador sin reemplazar (o con cualquier resto @@...@@) significa que este
    # .ps1 no salio de un release: con esa version la URL no existe.
    if ($version.Contains("@@") -or $sha256.Contains("@@")) {
      throw (New-BootstrapAbort 2 "Este script no corresponde a un release de VIUrewards (faltan la version o el SHA-256). Descarga install.ps1 desde la pagina de releases del proyecto.")
    }
    if ($sha256 -notmatch "^[0-9a-fA-F]{64}$") {
      throw (New-BootstrapAbort 2 "El SHA-256 configurado (VIUREWARDS_INSTALL_SHA256) no tiene la forma de un SHA-256 en hexadecimal.")
    }
    $sha256 = $sha256.ToLowerInvariant()

    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
      $baseUrl = $DefaultBaseUrlPrefix + $version
    }
    $baseUrl = $baseUrl.TrimEnd("/")
    $zipName = "VIUrewards-" + $version + "-portable-win-x64.zip"
    $zipUrl = $baseUrl + "/" + $zipName

    # ----------------------------------------------------------------------------
    # (b) Carpeta de la app
    # ----------------------------------------------------------------------------

    $installDir = Get-EnvValue "VIUREWARDS_INSTALL_DIR"
    if ([string]::IsNullOrWhiteSpace($installDir)) {
      $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
      $installDir = Join-Path (Join-Path $localAppData "Programs") "VIUrewards"
    }
    if (-not [System.IO.Path]::IsPathRooted($installDir)) {
      throw (New-BootstrapAbort 2 ("La carpeta de instalacion tiene que ser una ruta ABSOLUTA (recibi ""{0}"")." -f $installDir))
    }
    $installDir = Get-NormalizedPath $installDir
    if (([System.IO.Path]::GetPathRoot($installDir)).TrimEnd("\", "/") -eq $installDir) {
      throw (New-BootstrapAbort 2 "La raiz de una unidad no puede ser la carpeta de la aplicacion.")
    }
    if (Test-Path -LiteralPath $installDir -PathType Leaf) {
      throw (New-BootstrapAbort 2 ("{0} existe y no es una carpeta." -f $installDir))
    }

    # Directorio de datos: el que ya use el usuario, o el valor por defecto del
    # launcher (Get-DefaultDataDir, %LOCALAPPDATA%\VIUrewards). Este script NO
    # crea ni modifica esa carpeta: solo se la pasa al instalador de herramientas.
    $dataDir = Get-EnvValue "VIUREWARDS_INSTALL_DATA_DIR"
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
      $dataDir = Get-EnvValue "VIUREWARDS_DATA_DIR"
    }
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
      $localAppDataForData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
      $dataDir = Join-Path $localAppDataForData "VIUrewards"
    }
    if (-not [System.IO.Path]::IsPathRooted($dataDir)) {
      throw (New-BootstrapAbort 2 ("El directorio de datos tiene que ser una ruta ABSOLUTA (recibi ""{0}"")." -f $dataDir))
    }
    $dataDir = Get-NormalizedPath $dataDir
    # Misma regla que el launcher y que el instalador de herramientas: los datos
    # nunca quedan DENTRO de la app.
    if (Test-PathInside $installDir $dataDir) {
      throw (New-BootstrapAbort 2 ("{0} esta dentro de la aplicacion ({1}); el directorio de datos tiene que quedar fuera." -f $dataDir, $installDir))
    }

    # ----------------------------------------------------------------------------
    # (c) Instancia en ejecucion: se pide cerrarla, nunca se mata
    # ----------------------------------------------------------------------------

    $lockOwner = Get-RunningInstancePid $dataDir
    if ($null -ne $lockOwner) {
      $lockPath = Join-Path $dataDir ".viurewards.lock"
      throw (New-BootstrapAbort 3 ("Hay una instancia de VIUrewards en ejecucion (cerrojo ""{0}""): cerrala y volve a ejecutar la instalacion. No se modifico nada." -f $lockPath))
    }
    $appProcess = Get-RunningAppProcess $installDir
    if ($null -ne $appProcess) {
      throw (New-BootstrapAbort 3 ("Hay una instancia de VIUrewards en ejecucion desde ""{0}"" (proceso {1}): cerrala y volve a ejecutar la instalacion. No se modifico nada." -f $installDir, $appProcess))
    }

    Write-Host ""
    Write-Host ("VIUrewards {0}" -f $version)
    Write-Step ("aplicacion: {0}" -f $installDir)
    Write-Step ("datos:      {0}" -f $dataDir)

    # ----------------------------------------------------------------------------
    # (d) Descarga y verificacion
    # ----------------------------------------------------------------------------

    $token = [System.Guid]::NewGuid().ToString("N")
    $workName = "viurewards-instalacion-" + $token
    $State.DownloadFile = Join-Path ([System.IO.Path]::GetTempPath()) ($workName + "-paquete.zip")
    $State.StagingDir = Join-Path ([System.IO.Path]::GetDirectoryName($installDir)) ($workName + "-staging")

    Write-Host ""
    Write-Host ("Descargando {0}..." -f $zipName)
    try {
      $client = New-Object System.Net.WebClient
      try {
        $client.Headers.Add("user-agent", "VIUrewards-installer")
        $client.DownloadFile($zipUrl, $State.DownloadFile)
      } finally {
        $client.Dispose()
      }
    } catch {
      throw (New-BootstrapAbort 1 ("No se pudo descargar ""{0}"": {1}" -f $zipUrl, $_.Exception.Message))
    }
    $downloadedBytes = 0
    try {
      $downloadedBytes = (Get-Item -LiteralPath $State.DownloadFile).Length
    } catch {
      $downloadedBytes = 0
    }
    if ($downloadedBytes -le 0) {
      throw (New-BootstrapAbort 1 "La descarga quedo vacia. No se modifico nada.")
    }
    $actual = Get-Sha256 $State.DownloadFile
    if ($actual -ne $sha256) {
      throw (New-BootstrapAbort 1 ("El SHA-256 del paquete no coincide con el esperado.\x60n  esperado: {0}\x60n  obtenido: {1}\x60nNo se instalo nada." -f $sha256, $actual))
    }
    Write-Step "SHA-256 verificado."

    # ----------------------------------------------------------------------------
    # (e) Extraccion a un staging HERMANO (mismo volumen: el renombre es atomico)
    # ----------------------------------------------------------------------------

    Write-Host "Extrayendo..."
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($State.DownloadFile)
    try {
      $rootPrefix = $null
      foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        $parts = @($name.Replace("\", "/").Split("/"))
        $clean = @()
        foreach ($part in $parts) {
          if ($part.Length -gt 0) { $clean += $part }
        }
        if ($clean.Count -eq 0) { continue }
        # El ZIP tiene UNA carpeta raiz (VIUrewards-<version>-portable-win-x64/):
        # se descarta para que el contenido quede directo en la carpeta de la app.
        if ($null -eq $rootPrefix) { $rootPrefix = $clean[0] }
        if ($clean[0] -ne $rootPrefix) {
          throw (New-BootstrapAbort 1 ("El paquete tiene mas de una carpeta raiz (""{0}"" y ""{1}""). No se instalo nada." -f $rootPrefix, $clean[0]))
        }
        if ($clean.Count -lt 2) { continue }
        $segments = @()
        foreach ($segment in $clean[1..($clean.Count - 1)]) {
          # Nada de .. , . ni dos puntos: son las formas de escapar de la
          # carpeta destino (saltos de directorio o rutas absolutas).
          if ($segment -eq "." -or $segment -eq ".." -or $segment.Contains(":")) {
            throw (New-BootstrapAbort 1 ("La entrada ""{0}"" del ZIP tiene una ruta que no es segura. No se instalo nada." -f $name))
          }
          $segments += $segment
        }
        $target = $State.StagingDir
        foreach ($segment in $segments) {
          $target = Join-Path $target $segment
        }
        $target = Get-NormalizedPath $target
        if (-not (Test-PathInside $State.StagingDir $target)) {
          throw (New-BootstrapAbort 1 ("La entrada ""{0}"" del ZIP queda fuera de la carpeta destino. No se instalo nada." -f $name))
        }
        if ($name.EndsWith("/") -or $name.EndsWith("\")) {
          if (-not (Test-Path -LiteralPath $target -PathType Container)) {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
          }
          continue
        }
        $parent = [System.IO.Path]::GetDirectoryName($target)
        if (-not [string]::IsNullOrWhiteSpace($parent)) {
          if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
          }
        }
        $source = $entry.Open()
        try {
          $outStream = [System.IO.File]::Open($target, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
          try {
            $source.CopyTo($outStream)
          } finally {
            $outStream.Dispose()
          }
        } finally {
          $source.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }

    # El ZIP ya no hace falta y todavia no se movio nada a su lugar.
    Remove-Item -Force -LiteralPath $State.DownloadFile -ErrorAction SilentlyContinue
    $State.DownloadFile = $null

    foreach ($required in $RequiredRelativePaths) {
      if (-not (Test-Path -LiteralPath (Join-Path $State.StagingDir $required) -PathType Leaf)) {
        throw (New-BootstrapAbort 1 ("El paquete no tiene ""{0}"": no es un paquete de VIUrewards valido." -f $required))
      }
    }

    # ----------------------------------------------------------------------------
    # (f) Reemplazo con rollback
    # ----------------------------------------------------------------------------

    $oldDir = $installDir + ".old"
    $hadPrevious = Test-Path -LiteralPath $installDir
    if ($hadPrevious) {
      if (Test-Path -LiteralPath $oldDir) {
        Remove-Item -Recurse -Force -LiteralPath $oldDir -ErrorAction SilentlyContinue
      }
      try {
        Move-Item -LiteralPath $installDir -Destination $oldDir
      } catch {
        throw (New-BootstrapAbort 1 ("No se pudo apartar la instalacion anterior ({0}). Cerra VIUrewards y volve a intentarlo." -f $_.Exception.Message))
      }
    }
    try {
      Move-Item -LiteralPath $State.StagingDir -Destination $installDir
      $State.StagingDir = $null
    } catch {
      if ($hadPrevious) {
        # Rollback: la instalacion anterior vuelve a su lugar.
        try {
          Move-Item -LiteralPath $oldDir -Destination $installDir
        } catch {
          Write-Warn ("No se pudo restaurar la instalacion anterior en ""{0}"". La copia quedo en ""{1}""." -f $installDir, $oldDir)
        }
      }
      throw (New-BootstrapAbort 1 ("No se pudo mover la instalacion nueva a ""{0}"" ({1})." -f $installDir, $_.Exception.Message))
    }
    if ($hadPrevious) {
      try {
        Remove-Item -Recurse -Force -LiteralPath $oldDir
      } catch {
        # No es un fallo de la instalacion: queda una carpeta que se puede borrar.
        Write-Warn ("No se pudo borrar la carpeta anterior ""{0}""; podes borrarla a mano." -f $oldDir)
      }
    }
    Write-Step ("aplicacion instalada en {0}" -f $installDir)

    $launcherPath = Join-Path $installDir "app\scripts\dist\launcher-gui.ps1"
    $toolsInstaller = Join-Path $installDir "app\scripts\dist\install-tools.ps1"
    $launcherArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'

    # ----------------------------------------------------------------------------
    # (g) Herramientas externas (Node.js, yt-dlp, FFmpeg), directo del proveedor
    # ----------------------------------------------------------------------------

    if (Test-EnvFlag "VIUREWARDS_INSTALL_SKIP_TOOLS") {
      Write-Warn "Se omitio la instalacion de Node.js, yt-dlp y FFmpeg (VIUREWARDS_INSTALL_SKIP_TOOLS)"
    } else {
      Write-Host ""
      Write-Host "Instalando herramientas (Node.js, yt-dlp y FFmpeg)..."
      $toolsArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $toolsInstaller + '" -DataDir "' + $dataDir + '"'
      $toolsCode = 1
      try {
        $toolsCode = Invoke-ChildProcess -FilePath "powershell.exe" -Arguments $toolsArguments -WorkingDirectory $installDir
      } catch {
        $toolsCode = 1
      }
      if ($toolsCode -ne 0) {
        # No se deshace la instalacion: el launcher vuelve a intentarlo al arrancar.
        Write-Warn ("La instalacion de herramientas termino con codigo {0}. La aplicacion quedo instalada: el launcher reintenta cuando la abras." -f $toolsCode)
      }
    }

    # ----------------------------------------------------------------------------
    # (h) Acceso directo del MENU Inicio (SIN -AutoStart)
    # ----------------------------------------------------------------------------

    $startMenuDir = Get-EnvValue "VIUREWARDS_INSTALL_START_MENU_DIR"
    if ([string]::IsNullOrWhiteSpace($startMenuDir)) {
      $startMenuDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    }
    $shortcutCreated = $false
    if ([string]::IsNullOrWhiteSpace($startMenuDir)) {
      Write-Warn "No se encontro la carpeta del Menu Inicio: no se creo el acceso directo."
    } else {
      try {
        if (-not (Test-Path -LiteralPath $startMenuDir -PathType Container)) {
          New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
        }
        $linkPath = Join-Path $startMenuDir $StartMenuLinkName
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($linkPath)
        $shortcut.TargetPath = "powershell.exe"
        # SIN -AutoStart: ese arranca el servidor oculto (es el de "Iniciar con
        # Windows"). Desde el Menu Inicio el usuario tiene que ver la ventana.
        $shortcut.Arguments = $launcherArguments
        $shortcut.WorkingDirectory = $installDir
        $shortcut.Description = "VIUrewards"
        # IconLocation: pendiente. Cuando exista el .ico del proyecto se agrega aca:
        #   $shortcut.IconLocation = (Join-Path $installDir "app\VIUrewards.ico")
        $shortcut.Save()
        $shortcutCreated = $true
      } catch {
        Write-Warn ("No se pudo crear el acceso directo del Menu Inicio ({0})." -f $_.Exception.Message)
      }
    }

    # ----------------------------------------------------------------------------
    # (i) Abrir el launcher
    # ----------------------------------------------------------------------------

    if (-not (Test-EnvFlag "VIUREWARDS_INSTALL_NO_LAUNCH")) {
      try {
        Start-Process -FilePath "powershell.exe" -ArgumentList $launcherArguments -WorkingDirectory $installDir | Out-Null
      } catch {
        Write-Warn ("No se pudo abrir el launcher ({0}). Abrelo desde el Menu Inicio." -f $_.Exception.Message)
      }
    }

    # ----------------------------------------------------------------------------
    # (j) Resumen
    # ----------------------------------------------------------------------------

    Write-Host ""
    Write-Host "VIUrewards quedo instalado."
    Write-Step ("aplicacion:  {0}" -f $installDir)
    Write-Step ("datos:       {0}" -f $dataDir)
    if ($shortcutCreated) {
      Write-Step "como abrirla: Menu Inicio -> VIUrewards"
    } else {
      Write-Step ("como abrirla: doble clic en {0}" -f (Join-Path $installDir "VIUrewards.cmd"))
    }
    Write-Step "como desinstalar: borra la carpeta de la aplicacion y el acceso directo."
    Write-Step ("                  los datos ({0}) quedan aparte: borralos vos si queres empezar de cero." -f $dataDir)

    $global:LASTEXITCODE = 0
  } catch {
    $abort = $_.Exception
    $isBootstrapAbort = $false
    $abortCode = 1
    $abortMessage = $null
    if ($abort -is [System.InvalidOperationException] -and
        $null -ne $abort.Data -and $abort.Data.Contains("ViuBootstrapCode")) {
      $isBootstrapAbort = $true
      $abortCode = [int]$abort.Data["ViuBootstrapCode"]
      $abortMessage = $abort.Message
    } else {
      # Error inesperado: se informa con el mismo formato que un aborto.
      $abortMessage = ("Fallo inesperado: {0}" -f $abort.Message)
    }
    # Los temporales se borran SIEMPRE: aborto o error inesperado.
    Remove-Temporary
    Write-Host ""
    Write-Warn $abortMessage
    $global:LASTEXITCODE = $abortCode
    if (-not $isBootstrapAbort -and -not [string]::IsNullOrWhiteSpace($PSCommandPath)) {
      # Solo como archivo: por "iex" no se escupe el volcado de la excepcion.
      Write-Warn $abort.StackTrace
    }
  } finally {
    # Red de seguridad: si algun camino saliera sin pasar por el catch, igual no
    # queda staging ni descarga a medio bajar.
    Remove-Temporary
  }

  # Por "iex" NO se llama a exit (cerraria la consola del usuario): el cuerpo
  # termina aca y el codigo quedo en $global:LASTEXITCODE.
  if ($State.IsFileMode) {
    exit $global:LASTEXITCODE
  }
  return
}