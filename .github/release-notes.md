# VIUrewards {{VERSION}}

Aplicación local para streamers de Kick. Esta entrega es un **paquete portable
para Windows x64**: no trae instalador compilado, no requiere administrador y no
abre puertos ni necesita configuración de red.

## Instalación en un solo paso

Abrí **Windows PowerShell** (no hace falta ejecutarlo como administrador) y pegá:

```powershell
irm https://github.com/gogg08/VIUrewards/releases/latest/download/install.ps1 | iex
```

El script descarga este mismo paquete, verifica su SHA-256, lo instala, prepara
las herramientas que faltan y abre el launcher.

## Qué deja en la PC

- **Aplicación:** `%LOCALAPPDATA%\Programs\VIUrewards`
- **Datos** (base, clips, logs y herramientas): `%LOCALAPPDATA%\VIUrewards`
- **Acceso directo:** menú Inicio del usuario actual.

Los datos están **aparte de la aplicación**: al reinstalar o actualizar VIUrewards
se reemplaza solo la carpeta de la aplicación y **los datos no se tocan**.

## Herramientas externas

El paquete **no incluye** Node.js, yt-dlp ni FFmpeg: se descargan desde el
proveedor de cada uno y se verifican contra un SHA-256 fijado.

- Node.js — <https://nodejs.org>
- yt-dlp — <https://github.com/yt-dlp/yt-dlp>
- FFmpeg y ffprobe — <https://www.gyan.dev/ffmpeg/builds/>

La compilación de FFmpeg de gyan.dev es **GPLv3**; su origen, commit y aviso
viajan en el archivo `licenses/FFMPEG.md` dentro del paquete.

## Requisitos

- Windows 10 u 11, **x64**
- **Windows PowerShell 5.1** (el que trae Windows)

## Verificación de la descarga

SHA-256 del ZIP `VIUrewards-{{VERSION}}-portable-win-x64.zip`:

```
{{SHA256}}
```

## Desinstalación

Borrá la carpeta de la aplicación (`%LOCALAPPDATA%\Programs\VIUrewards`) y el
acceso directo del menú Inicio. Si también querés borrar los datos, borrá
`%LOCALAPPDATA%\VIUrewards`.

## Aviso sobre la firma digital

VIUrewards **no está firmado digitalmente**, así que Windows puede mostrar
advertencias al ejecutarlo (por ejemplo, SmartScreen). Es un aviso esperado, no
un indicio de que el archivo esté alterado: lo que se puede comprobar es el
SHA-256 de arriba.
