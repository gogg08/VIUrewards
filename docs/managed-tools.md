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

Se resuelven con la misma regla, así que en distribución pueden ir en
`<datos>/bin/` junto a yt-dlp. **Todavía no se decide** qué distribución o
compilación se empaqueta (depende de las licencias): esa decisión es de la
etapa de empaquetado.

## Pruebas

- `src/media/binaries.test.ts`: prioridad de `binDir`, orden de búsqueda,
  `.cmd` rechazado, rutas con espacios.
- `src/server/tools-managed.test.ts`: el actualizador opera sobre el binario
  administrado y no reescribe el ejecutable.
- `src/media/js-runtime.test.ts` y `runtime-propagation.test.ts`: la forma
  `--js-runtimes node:<ruta>` llega al argv real (con `run` simulado).

No se ejecuta `yt-dlp -U` en ninguna prueba.
