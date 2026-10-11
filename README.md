# VIUrewards

App self-hosted para streamers de Kick. Corre en la PC del streamer y expone un
dashboard en el navegador. Permite pegar la URL de un video, descargarlo y
convertirlo, y usarlo como alerta reproducida en OBS (Browser Source). Con la
cuenta de Kick vinculada, también administra recompensas de canal y detecta sus
canjes.

## Requisitos

- Node.js 20 o superior.
- `yt-dlp` y `ffmpeg` en el `PATH` o en `./bin` (ver `docs/`).

## Uso

```
npm install
npm start
```

La consola muestra la URL del dashboard (por defecto `http://127.0.0.1:8787/`).
La primera vez pide crear una contraseña. Para el overlay en OBS, copiá la URL
con token desde el dashboard (ver `docs/obs-setup.md`).

## Documentación

- `ROADMAP.md` — fases del proyecto.
- `UI-DESIGN.md` — diseño de la interfaz (fuente de verdad del rediseño).
- `docs/dashboard.md` — qué permite el dashboard y decisiones.
- `docs/obs-setup.md` — overlay en OBS.
- `docs/kick-setup.md` — conectar la cuenta de Kick.
- `AGENTS.md` — reglas del proyecto para quien trabaja en el código.

## Comandos

```
npm start          # servidor completo (API, dashboard, overlay y WebSocket)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```