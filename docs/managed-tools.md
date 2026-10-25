# Herramientas externas y directorio administrado

VIUrewards usa tres binarios externos: **yt-dlp**, **ffmpeg** y **ffprobe**.
Nunca se lanzan con shell: siempre `spawn` con argumentos en un array
(`shell: false`, AGENTS.md #1).

## Dónde se buscan

`detectBinaries` (`src/media/binaries.ts`) los busca en este orden:

1. **`binDir`**: el directorio de herramientas administradas, ya resuelto como
   ruta **absoluta** por el arranque. Tiene prioridad sobre todo lo demás.
2. `extraDirs`, si se pasan.
3. El **PATH** del sistema.

`binDir` lo decide `resolveRuntimePaths` (`src/server/paths.ts`):

| Modo | `binDir` |
| --- | --- |
| Desarrollo (sin `VIUREWARDS_DATA_DIR`) | `<directorio de trabajo>/bin` |
| Distribución (`VIUREWARDS_DATA_DIR`) | `<directorio de datos>/bin` |

Sin `binDir` explícito se conserva el comportamiento histórico: `bin/` relativo
al directorio de trabajo.

En Windows solo se aceptan ejecutables (`.exe`): un `.cmd` o `.bat` no se puede
lanzar sin shell.

### De dónde salen los binarios

**VIUrewards no redistribuye** `yt-dlp.exe`, `ffmpeg.exe` ni `ffprobe.exe`, ni
`node.exe`: el paquete portable solo lleva la aplicación. El instalador
(`scripts/dist/install-tools.ps1`, ver `docs/distribution.md` §8) los descarga
desde el proveedor, verifica el SHA-256 fijado en `scripts/dist/config.ts` y los
deja en el directorio de datos:

| Herramienta | Ruta instalada | Política si ya existe |
| --- | --- | --- |
| Node.js | `<datos>/runtime/node.exe` | `match-manifest` (lo controla el instalador) |
| yt-dlp | `<datos>/bin/yt-dlp.exe` | `if-missing` (el dashboard manda) |
| ffmpeg / ffprobe | `<datos>/bin/ffmpeg.exe`, `bin/ffprobe.exe` | `if-missing` |

La instalación **nunca sobrescribe** yt-dlp ni FFmpeg ya instalados, así que una
actualización de VIUrewards no pisa la versión que el usuario actualizó desde el
dashboard. Para Node se compara el SHA-256 del **archivo instalado**
(`installedSha256` en `config.ts`), no el del ZIP descargado: son hashes
distintos y usar el del ZIP rechazaba una instalación válida en cada reintento.

### Procedencia y avisos (Etapa 3D)

Cada `ManagedTool` declara un `provenance: ToolProvenance` **obligatorio** con
hechos verificables del artefacto, no instrucciones de instalación:

| Campo | Qué es |
| --- | --- |
| `vendor` | Proveedor real del archivo. Para FFmpeg dice expresamente que **no** es el upstream de FFmpeg. |
| `vendorPage` | Página del proveedor donde se publica esa compilación concreta. |
| `license` | Licencia declarada por el proveedor. |
| `sourceCode` | Fuente del **código** de esa compilación, si el proveedor la publica. `undefined` cuando no la identifica: no se inventa un enlace. |
| `verified` | Cómo se obtuvo y comprobó la información. |

`provenance` viaja al manifiesto (`managedTools[].provenance`) y lo usan los tests
para comprobar que los avisos coinciden con el pin. `licenses/FFMPEG.md` del
paquete se genera desde estos mismos datos.

### Licencia del código propio

`PROJECT_LICENSE` en `config.ts` declara **0BSD** (SPDX `0BSD`) para el código de
VIUrewards. El texto completo está en `LICENSE` (raíz del repo) y se copia a la
raíz del paquete; `manifest.json` lo expone como `projectLicense`.
`coversProjectCodeOnly: true` marca que cubre **solo** el código propio: las
dependencias npm, SQLite y los ejecutables externos mantienen sus licencias.

### Firma del release de Node

`NODE_RELEASE_KEYS` fija el repositorio oficial de claves (`nodejs/release-keys`)
y las huellas de los firmantes activos. `npm run verify:node-release` verifica la
firma GPG de `SHASUMS256.txt` y que el hash fijado provenga del manifiesto
**firmado**. Es un paso de **mantenimiento**: ni el instalador ni el launcher
usan GPG. Ver `docs/node-release-verification.md`.

## El actualizador del dashboard

Ajustes → **Biblioteca y descargas** muestra la versión de yt-dlp y ofrece
**Actualizar yt-dlp**. Ese botón (`updateYtdlp`, `src/server/tools.ts`) invoca
`yt-dlp -U` sobre el **mismo ejecutable que usa la app** (el de `binDir`), no
sobre otro que aparezca en el PATH.

- El binario se actualiza a **sí mismo** (lo escribe el propio yt-dlp). La app no
  copia, reemplaza ni reescribe ejecutables: un fallo de permisos o de red no
  daña el binario.
- En distribución, `bin/` está dentro del **directorio de datos**, así que una
  actualización de VIUrewards (que reemplaza el código) **no** sobrescribe el
  yt-dlp que el usuario actualizó desde el dashboard.
- No hay un segundo actualizador en PowerShell ni en el launcher: esta es la
  única vía.

Las rutas de versión, actualización, miniaturas y reconstrucción comparten la
misma búsqueda (`binarySearch` en `src/server/server.ts`), así que el dashboard
informa y actualiza exactamente lo que la app ejecuta.

## ffmpeg y ffprobe

Se resuelven con la misma regla, así que en distribución van en
`<datos>/bin/` junto a yt-dlp.

**Decidido para la distribución (Etapa 2C):** FFmpeg **9.0.2 essentials de
gyan.dev**, compilación **estática** (un `.exe` por herramienta, sin DLL
externas) porque trae `libx264`, que es lo que la app usa para recodificar. La
versión y el hash de origen se fijan en `scripts/dist/config.ts`.

gyan.dev es un **proveedor externo**: un sitio de terceros que la página de
descargas de FFmpeg.org **enlaza**, **no** el upstream de FFmpeg. El instalador
descarga el ZIP del proveedor y deja junto a los binarios su texto de licencia y
su información de procedencia (`ffmpeg-LICENSE.txt`, `ffmpeg-PROCEDENCIA.txt`).

> Ese build es **GPLv3**: las obligaciones de la GPLv3 recaen sobre quien
> **redistribuya** los binarios, y descargarlos del proveedor no las elimina. La
> licencia de VIUrewards todavía no está declarada, así que esto es un
> **bloqueante antes de publicar** una release. Ver `docs/distribution.md` §4.

El hash fijado **no es una firma digital**: detecta corrupción y cambios de
archivo, no autoría.

## Runtime de JavaScript para yt-dlp

`VIUREWARDS_NODE_RUNTIME` permite apuntar al `node.exe` portable; el argv recibe
`--js-runtimes node:<ruta>` como **un solo elemento** (las rutas con espacios no
se rompen). Ver `docs/media-js-runtime.md`.

Si la variable no está, `resolveRuntimePaths` busca el runtime en
`<datos>/runtime/node[.exe]` (donde lo instala el instalador) y después en
`<datos>/bin/` (ubicación anterior). Sin ninguno, yt-dlp usa el Node que ejecuta
la app.

## Pruebas

- `src/media/binaries.test.ts`: prioridad de `binDir`, orden de búsqueda,
  `.cmd` rechazado, rutas con espacios.
- `src/server/tools-managed.test.ts`: el actualizador opera sobre el binario
  administrado y no reescribe el ejecutable.
- `src/media/js-runtime.test.ts` y `runtime-propagation.test.ts`: la forma
  `--js-runtimes node:<ruta>` llega al argv real (con `run` simulado).
- `tests/dist/package.test.ts` (`npm run test:dist`): el paquete extraído no
  contiene ejecutables de terceros y el manifiesto declara las herramientas con
  su URL, SHA-256 y política de instalación. Las herramientas **ya no viajan en
  el paquete**: no hay una prueba de ffmpeg/ffprobe empaquetados.
- `tests/dist/installer.test.ts` (`npm run test:dist`): el instalador **real**
  contra directorios temporales — instala y verifica hashes, `node.exe` se
  ejecuta, reinstalar no cambia bytes, conserva yt-dlp/FFmpeg del usuario, código
  3 con el cerrojo en uso y nada escrito (también con `-ForceRuntime`: cerrojo y
  `node.exe` intactos, ningún proceso terminado), cerrojo huérfano, hash
  incorrecto, extracción insegura, rutas inválidas (incluidas la raíz de unidad y
  una **estructura de aplicación temporal**, con sus subcarpetas y formas
  equivalentes), fallo a mitad de instalación con reintento y fallo al mover el
  ejecutable.
- `tests/dist/config.test.ts`: el bloque `$Tools` del `.ps1` coincide con
  `config.ts`, el archivo es ASCII + CRLF, parsea en PowerShell 5.1 y conserva el
  guard contra escribir dentro de la aplicación (raíz deducida de `$PSScriptRoot`,
  sin tope de profundidad y **sin** una variable local `$applicationRoot` que
  colisione con el parámetro `$ApplicationRoot`, porque PowerShell no distingue
  mayúsculas entre nombres de variable).

No se ejecuta `yt-dlp -U` en ninguna prueba.
