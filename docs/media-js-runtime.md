# Runtime de JavaScript para yt-dlp (descargas de YouTube)

yt-dlp necesita un **runtime de JavaScript externo** para resolver los desafíos JS
que presenta YouTube. Sin él, emite una advertencia y algunos formatos pueden
faltar:

```
WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is
enabled by default; to use another runtime add --js-runtimes RUNTIME[:PATH] ...
YouTube extraction without a JS runtime has been deprecated, and some formats
may be missing.
```

Fuente oficial: <https://github.com/yt-dlp/yt-dlp/wiki/EJS> (verificado 2026-10).

## Qué hace falta en nuestra app

- **Runtime:** Node, que ya es requisito del proyecto. Se habilita con el flag
  `--js-runtimes node`. Versión mínima soportada: **Node 22.0.0** (Node ≥ 22 es
  además lo que ya usa la app, verificado localmente: `node-22.23.2`).
- **Scripts del desafío (EJS):** el paquete `yt-dlp-ejs` viene **incluido** en el
  ejecutable oficial (`yt-dlp.exe`). No hace falta instalar nada aparte. En la
  máquina de prueba yt-dlp reporta `yt_dlp_ejs-0.8.0`.
- No hace falta Deno, ni QuickJS, ni Bun.

Es decir: en una instalación normal solo se necesita **el flag**, nada más.

## Qué hace la app

`buildYtdlpArgs` agrega `--js-runtimes node` cuando el Node que corre la app es
≥ 22 (`nodeSupportsEjs`). Si el Node es anterior, no se agrega el flag y todo
sigue funcionando como antes (con la advertencia de yt-dlp).

## Runtime con ruta explícita (distribución portable)

En desarrollo, yt-dlp usa el Node **que ejecuta la app**: no hace falta indicar
ruta. En una distribución portable pueden ser **dos cosas distintas**:

1. El Node portable que **ejecuta el servidor** de VIUrewards.
2. Ese mismo Node usado como **runtime JS de yt-dlp**.

Cuando se conoce la ruta del segundo, `MediaOptions.nodeRuntime` la propaga y
el argumento real es `--js-runtimes node:<ruta>`. La ruta va como **un solo
elemento de argv** (nunca concatenada ni en una shell), así que funciona con
espacios.

¿De dónde sale la ruta? De `resolveRuntimePaths` (`src/server/paths.ts`):

- `VIUREWARDS_NODE_RUNTIME`: ruta **absoluta** al binario de Node. Si no es
  absoluta se **ignora con un aviso** y se usa el Node del proceso (no rompe el
  arranque).
- Si no está definida, se busca `node[.exe]` dentro de `<binDir>` (en desarrollo
  `./bin`, en distribución `<VIUREWARDS_DATA_DIR>/bin`).
- Si no se encuentra ninguna, `nodeRuntime` queda vacío y se usa el
  comportamiento histórico (`--js-runtimes node`).

**Verificado contra el yt-dlp real instalado** (`yt-dlp --version` →
`2026.08.19`, `--help`): la opción es exactamente
`--js-runtimes RUNTIME[:PATH]` y el PATH puede ser el binario **o su carpeta**.

**Verificado localmente**: Node `v22.23.2` (≥ 22, el mínimo documentado).

**Sin verificar**: que el Node **portable empaquetado** funcione como runtime
(no hay paquete todavía), y el comportamiento con un yt-dlp más viejo. La
integración con un binario portable queda **pendiente de la Etapa 2**
(empaquetado): no se descargó ni se empaquetó ningún binario.

## Limitaciones / a verificar

- `TODO(verificar)`: si el usuario tiene Node 20 o 21, no se habilita el runtime
  y YouTube puede ofrecer menos formatos. Conviene exigir Node 22+ en la
  distribución (Fase 6).
- `TODO(verificar)`: el flag `--js-runtimes` requiere un yt-dlp con soporte EJS
  (2025+). Con un yt-dlp muy viejo la descarga falla con un error de opción
  desconocida. El proyecto asume yt-dlp actualizado (ver Fase 5 del roadmap).
- La opción `--remote-components ejs:npm` **no** sirve con Node (solo Deno/Bun
  descargan paquetes npm al vuelo). Alternativa: `--remote-components ejs:github`.
  No la usamos porque el ejecutable oficial ya trae los scripts.