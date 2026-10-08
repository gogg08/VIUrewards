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