# Roadmap: alertas y recompensas self-hosted para Kick

Aplicación que corre en la PC del streamer, con un dashboard en el navegador (`http://localhost:PUERTO`). Se pega la URL de un video, se descarga y convierte sola, y queda lista como alerta o recompensa de Kick, reproducida en OBS como Browser Source.

## Decisiones de base

- **Stack:** Node.js + TypeScript, Fastify (o Express), `ws` para WebSocket, SQLite con `better-sqlite3`.
- **Dashboard:** React + Vite, o HTML + Alpine.js si se quiere algo más simple.
- **Todo local:** el servidor escucha solo en `127.0.0.1` por defecto.
- **Descargar y cachear clips**, no usar `yt-dlp -g`: los links directos expiran, vienen con audio y video separados y fallan por CORS.
- **Binarios externos:** yt-dlp y ffmpeg, detectados o descargados al iniciar.

## Arquitectura

```
Kick (eventos) ──► Backend Node ──► SQLite (config, cola, historial)
                      │  ▲
          yt-dlp + ffmpeg │  └── Dashboard (navegador)
                      ▼
                carpeta /media
                      │
              Overlay (Browser Source en OBS) ◄── WebSocket
```

## Fase 0: Investigación sobre Kick (1-2 días)

Es el mayor riesgo del proyecto. Se resuelve antes de escribir código.

- [ ] Leer la documentación oficial (docs.kick.com): OAuth, scopes, eventos disponibles y cómo se entregan.
- [ ] Determinar si los eventos llegan por webhooks (requiere URL pública, por ejemplo Cloudflare Tunnel) o por otra vía.
- [ ] Evaluar el WebSocket de Pusher de la web de Kick como alternativa. No es oficial y puede romperse.
- [ ] Verificar qué eventos se pueden recibir: chat, follows, subs, gift subs, canjes de recompensas.
- [ ] Verificar si Casterlabs u otros proyectos realmente soportan Kick hoy, antes de apoyarse en ellos.

**Entregable:** script de ~50 líneas que imprima en consola los eventos de un canal real.
**Si esto falla, el resto del proyecto no tiene sentido.**

## Fase 1: Núcleo de media (3-4 días)

- [ ] Endpoint que recibe una URL y la valida.
- [ ] Ejecutar yt-dlp con `spawn` y argumentos separados, nunca concatenando strings.
- [ ] Límites configurables de duración y tamaño.
- [ ] Whitelist de dominios (YouTube, TikTok, Twitch clips, etc.).
- [ ] Recodificar con ffmpeg a mp4 (H.264/AAC) o webm, normalizando el audio.
- [ ] Guardar en `/media` con metadatos en SQLite.
- [ ] Tests de la validación de URL.

**Criterio de aceptación:** pegás una URL de YouTube o TikTok y obtenés un archivo reproducible en menos de 15 segundos.

## Fase 2: Overlay y cola de alertas (3 días)

- [ ] Página `/overlay` con `<video>` que escucha por WebSocket.
- [ ] Cola de reproducción: un clip a la vez, con prioridad, skip y pausa.
- [ ] Parámetros por alerta: volumen, duración máxima, posición, animación de entrada y salida.
- [ ] Reconexión automática del overlay si se corta el WebSocket.
- [ ] Tests de la cola.

**Criterio de aceptación:** agregás la URL como Browser Source en OBS y el clip se reproduce con audio.

## Fase 3: Dashboard (5 días)

- [ ] Login local con contraseña.
- [ ] Biblioteca de clips: preview, recorte (inicio/fin), renombrar, borrar.
- [ ] Pegar una URL y ver el progreso de descarga y conversión.
- [ ] Botón "probar alerta" y vista de la cola en vivo.
- [ ] Configuración general: límites, volumen global, puerto.

**Criterio de aceptación:** una persona no técnica agrega un clip y lo prueba en OBS sin tocar la terminal.

## Fase 4: Integración con Kick (4-5 días)

- [ ] Vincular la cuenta desde el dashboard con OAuth.
- [ ] Reglas "cuando pase X, reproducí el clip Y": comando de chat, sub, gift sub, follow o canje.
- [ ] Cooldown global y por usuario.
- [ ] Permisos: todos, subs, mods.
- [ ] Comando `!alerta <URL>` para que el chat proponga clips.
- [ ] Cola de moderación: aprobar o rechazar desde el dashboard antes de reproducir.
- [ ] Historial de eventos disparados.
- [ ] Tests de las reglas y los cooldowns.

**Criterio de aceptación:** un evento real en el canal dispara el clip correcto en OBS.

## Fase 5: Robustez (3 días)

- [ ] Reconexión automática a Kick.
- [ ] Manejo de errores de yt-dlp y ffmpeg, con logs visibles en el dashboard.
- [ ] Auto-actualización de yt-dlp (se rompe seguido cuando los sitios cambian).
- [ ] Limpieza automática de la caché por tamaño o antigüedad.
- [ ] Cobertura de tests sobre las partes críticas.

## Fase 6: Distribución (3 días)

- [ ] Ejecutable único (`pkg` o Node SEA) con un instalador que traiga yt-dlp y ffmpeg. Es la mejor opción para un usuario no técnico.
- [ ] Alternativa para usuarios técnicos: `docker-compose`.
- [ ] README con capturas, licencia (MIT o AGPL) y guía de configuración de OBS en `docs/`.

## Fase 7: Extras (opcional)

- [ ] Metas y barras de progreso.
- [ ] TTS.
- [ ] Widget de chat.
- [ ] Plantillas de overlay.
- [ ] Subida de archivos locales.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La API de Kick cambia o tiene limitaciones | Fase 0 primero; aislar la integración detrás de una interfaz |
| yt-dlp se rompe con cambios de los sitios | Auto-actualización y mensajes de error claros |
| Copyright de clips de terceros | Cola de moderación y nota en el README |
| Input del chat ejecutando binarios | Validación estricta, `spawn` con argumentos separados, whitelist |

## Flujo de trabajo con Zed Agent + DeepSeek

1. Una fase por vez, con tareas chicas y criterio de aceptación verificable.
2. Tests junto con el código en cola, validación y reglas.
3. Commit después de cada tarea que funcione.
4. Fase 0 y diseño de arquitectura con un modelo más fuerte en chat si es posible; DeepSeek en el agente para implementar.

## Experiencia de instalación objetivo

Decisión del usuario sobre cómo debería instalarse VIUrewards. **Salvo lo marcado como hecho,
esto es plan, no está implementado.**

### Instalación con un comando (plan)

Un comando en PowerShell, pensado para que lo pegue una persona no técnica:

```powershell
irm <url> | iex
```

Ese comando descarga y ejecuta un **bootstrap** `install.ps1`. **Hoy ese archivo no existe.**

El bootstrap debe:

1. Descargar la aplicación desde los **releases de GitHub** de este proyecto, verificando el
   **SHA-256**.
2. Instalarla en el directorio de datos (ver `docs/managed-tools.md` y `docs/dashboard.md`).
3. Ejecutar `scripts/dist/install-tools.ps1`, que descarga **Node, yt-dlp y FFmpeg directo de
   sus proveedores** con hash fijado. **No usa Chocolatey**: Chocolatey se usa solo en CI, en el
   job `e2e` de `.github/workflows/package-windows.yml`.
4. Al final, **abrir el launcher** (`launcher-gui.ps1` vía `VIUrewards.cmd`).

### Acceso directo en el menú Inicio (plan)

Se crea un acceso directo en el menú Inicio **del usuario actual**, **sin administrador**, para
poder abrir VIUrewards como cualquier otra aplicación.

El usuario mencionó `%APPDATA%\Microsoft\Windows\Start Menu\`; lo habitual es la subcarpeta
`Programs` (`%APPDATA%\Microsoft\Windows\Start Menu\Programs`). **Confirmar al implementarlo.**

Sin ícono por ahora; el `.ico` se agrega después como propiedad del acceso directo.

### Salida del instalador más clara (plan)

La salida está pensada hoy para depurar, no para una persona:

- **Conservar el JSON** (con `contractVersion`) por ahora: falta verificar si
  `launcher-gui.ps1` lo lee. Si no lo lee, se puede revisar más adelante.
- **Quitar** la línea "Arranca VIUrewards con VIUREWARDS_DATA_DIR=..." cuando el bootstrap abra
  el launcher él mismo.

### Estado verificado

- `scripts/dist/install-tools.ps1` ya instala **Node 24.22.1, yt-dlp 2026.10.21 y FFmpeg 9.0.2**
  en una carpeta de datos nueva, con verificación de SHA-256. Probado en la PC del desarrollador
  (2026-10-30, Windows PowerShell 5.1); reportado por el usuario.
- El paquete portable (`package-windows.yml`) se construye sin redistribuir binarios de terceros,
  y el instalador de herramientas los descarga desde cada proveedor.

### Pendientes y bloqueos

- **Repo público vs. `irm`.** Decisión tomada: hacer público este mismo repo (la auditoría de
  privacidad no encontró bloqueos); el usuario lo ejecuta antes de implementar `install.ps1`.
- **Licencia GPLv3 de FFmpeg.** Las obligaciones de la compilación estática siguen abiertas
  (`docs/distribution.md` §4).
- **Probar en un Windows 11 limpio** (VM con snapshot) y con **Smart App Control** activo.
- **Confirmar las huellas GPG de Node** por un segundo canal
  (`docs/node-release-verification.md`).
- **Canal de actualizaciones** de la app (hoy solo se actualiza yt-dlp desde el dashboard).
- **Reincorporar el helper de E2E reescrito** de `wip/ci-hang-diag`, separando diagnóstico de
  lógica, y **volver a encender** el job `e2e` (hoy es opt-in con `run_e2e`).
- **F3**: el test "arranque y parada repetidos" de `launcher.test.ts` es intermitente; **sin
  causa demostrada**.
