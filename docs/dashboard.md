# Dashboard local (Fase 3 + Fase 4A)

El dashboard es la interfaz que usa el streamer en el navegador. Todo corre en su
PC; el servidor escucha solo en `127.0.0.1`.

## Cómo se arranca

```
npm start
```

La consola muestra la URL del dashboard (por defecto `http://127.0.0.1:8787/`).
Podés cambiar el puerto con `--port=...`, la variable de entorno `PORT`, o desde
la **Configuración** del panel (requiere reiniciar). El script toma el puerto en
ese orden.

## Primer uso

La primera vez, el dashboard pide **crear una contraseña** (mínimo 8 caracteres).
Se guarda solo su hash (`crypto.scrypt` con salt aleatorio), nunca en texto plano.
Después, para entrar, se usa esa contraseña. La sesión va en una cookie
`httpOnly`, `SameSite=Strict`.

## Qué permite hoy (Fase 3 completa)

- **Agregar un clip**: pegás una URL (whitelist de dominios) y la descarga corre
  **en segundo plano** con estado consultable
  (`en cola → descargando → convirtiendo → listo / error`). No es una request que
  queda esperando.
- **Biblioteca**: lista de clips con **preview**, duración, tamaño, **renombrar**,
  **borrar** (con confirmación, elimina archivo y registro) y **Probar alerta**
  (lo encola y lo reproduce el overlay).
- **Recorte por clip (no destructivo)**: dos campos numéricos (inicio/fin en
  segundos), botón **"Desde el video"** (toma el tiempo actual del preview) y
  **Restablecer**. No recodifica ni modifica el mp4: el overlay hace *seek* al
  inicio y corta al final. El tiempo efectivo es el **menor** entre el recorte y
  la duración máxima de la alerta.
- **Cola en vivo**: muestra el clip en reproducción y los pendientes, con botones
  **Saltar / Pausar / Reanudar / Vaciar**.
- **Configuración general**: volumen global (0-100%) que multiplica el de cada
  alerta; duración máxima por defecto de una alerta; límites de descarga
  (duración y tamaño máximos, que el módulo de media relee **en cada descarga**);
  whitelist de dominios editable; puerto; **cambiar contraseña** y **regenerar la
  clave del overlay**.
- **Overlay para OBS**: la URL se muestra **enmascarada** por defecto, con botones
  **Mostrar** y **Copiar**, y un aviso de no mostrarla en pantalla durante el
  stream.

### Secciones nuevas (Fase 4A, motor de reglas sin plataformas)

- **Reglas**: crear, editar, activar/desactivar y borrar reglas. Cada regla tiene
  un *trigger* (tipo de evento y, según el tipo, comando, id de recompensa o monto
  mínimo), *condiciones* (permiso `todos/subs/mods`, cooldown global y por usuario)
  y una *acción* (`play_clip` o `submit_url`). El selector de tipo de evento se
  arma con las **capabilities** de las fuentes conectadas, así no se ofrecen
  triggers que ninguna plataforma soporta.
- **Moderación de URLs**: lista de propuestas del público pendientes, con la URL y
  botones **Aprobar / Rechazar**. Aprobar dispara la descarga con el job existente
  y, al terminar, encola el clip; rechazar la descarta.
- **Historial de eventos**: últimas 100 entradas con hora, plataforma, tipo,
  usuario, resultado (`Disparó / Omitido / Error / Sin regla / Duplicado`) y motivo
  (por ejemplo `cooldown`, `sin permiso`).
- **Simular evento**: dispara un evento de cualquier tipo sin ninguna plataforma
  conectada, y un botón **Evento manual** (el mismo que dispara `ManualEventSource`).
  Sirve para probar reglas y el flujo de moderación de punta a punta.

Ver `docs/rules.md` para el detalle del motor, las transiciones de estado y los
límites.

Todo el texto de la interfaz está en español. Los nombres de los clips se
insertan con bindings de texto (Alpine `x-text`), que escapan HTML; nunca con
`x-html`.

## Archivos y datos

- `data/app.db`: SQLite local (tablas `clips`, `settings`, `rules`,
  `event_history` y `proposals`). Ignorado en git.
- `media/`: clips `.mp4` y un sidecar `.json` por clip. Ignorado en git.
- `logs/`: salida cruda de yt-dlp/ffmpeg. Ignorado en git.

La tabla `clips` incluye `trim_start` y `trim_end` (segundos, opcionales; `null`
= sin recorte), agregadas por una migración. Al iniciar, la tabla se
**reconcilia** con los `.mp4` de `media/`: agrega los que falten (leyendo el
sidecar) y quita los registros cuyo archivo ya no está. Reprocesar una URL de la
caché **no pisa** el título ni el recorte que haya puesto el usuario.

## Seguridad

- **Contraseña**: hash con scrypt; nunca en claro ni en logs.
- **Sesión**: cookie `httpOnly` `SameSite=Strict`. Token aleatorio de 32 bytes.
- **Rate limit**: 5 intentos fallidos por IP en una ventana de 60 s bloquean
  nuevos intentos por 60 s (valores por defecto).
- **CSRF**: las requests que modifican estado deben venir de un `Origin`/`Host`
  local (`127.0.0.1`, `localhost`, `::1`); si no, se rechazan con 403.
- **Overlay**: `/overlay`, el WebSocket del overlay (`/ws`) y `/media` **no** usan
  la cookie (el Browser Source de OBS tiene su propia sesión). Se protegen con un
  **token secreto en la URL** (`?key=...`), generado la primera vez y regenerable
  desde el dashboard. Sin token válido no se entrega nada. `/media` además acepta
  la cookie de sesión, para que el dashboard pueda previsualizar los clips.
- **Whitelist de dominios**: al editarla se rechazan IPs (y por lo tanto rangos
  privados), `localhost`, nombres sin punto, caracteres inválidos y labels mal
  formados. Nunca puede usarse para apuntar a servicios internos.

## API (interna, requiere sesión)

`GET /api/state`, `POST /api/enqueue|skip|pause|resume|clear`, `POST /api/download`,
`GET /api/jobs[/:id]`, `GET /api/clips`, `POST /api/clips/:id/rename`,
`POST /api/clips/:id/trim`, `DELETE /api/clips/:id`, `POST /api/clips/:id/play`,
`GET/POST /api/settings`, `POST /api/auth/change-password`,
`GET /api/overlay`, `POST /api/overlay/regenerate`.

Fase 4A: `GET/POST /api/rules`, `DELETE /api/rules/:id`,
`POST /api/rules/:id/toggle`, `GET /api/events`, `GET /api/moderation`,
`POST /api/moderation/:id/approve|reject`, `GET /api/sources`,
`POST /api/simulate`, `POST /api/manual`. Todo input se valida con esquemas de
Fastify.

## Robustez de la cola y el overlay (fix de atascos)

Dos síntomas reportados: (A) la cola quedaba "En espera (1)" con "No hay nada
reproduciéndose" y ningún botón la destrababa; (B) el dashboard decía
REPRODUCIENDO pero el overlay no reproducía nada hasta recargar la fuente en OBS.

Causas reales encontradas (leídas en el código, no supuestas):

- **(A)** El flag interno `paused` podía quedar en `true` con `current === null`
  (p. ej. `Pausar` → `Saltar`, o `Pausar` → fin natural del clip). `getState()`
  devolvía `idle` en ese caso, y el dashboard solo ofrece **Reanudar** cuando el
  estado es `paused`, así que quedaba trabada. Ahora el estado refleja la pausa
  aunque no haya ítem actual, y `skip`/`complete` en pausa no arrancan nada (el
  siguiente espera hasta reanudar). Un test combinatorio recorre todas las
  secuencias de hasta 4 operaciones y verifica que no queden "idle con pendientes".
- **(B1)** Los mensajes `error` del overlay se **ignoraban** en el servidor, así
  que un `video.play()` rechazado nunca avanzaba la cola. Ahora el overlay maneja
  la promesa: reintenta una vez en silencio (`muted`) y, si falla, avisa el fin con
  motivo.
- **(B2)** No había **ping/pong**: un socket muerto seguía recibiendo mensajes. Se
  agrega ping periódico y se cierra el socket que no responde.
- **(B3)** El mensaje `play` traía una URL **sin la clave del overlay**
  (`/media/<id>.mp4`), que `/media` rechaza con 401; el overlay ahora arma siempre
  la URL con su propia clave.
- **Sin overlay conectado**: un clip encolado pasaba a "reproduciendo" aunque no
  hubiera nadie que lo reprodujera (nunca llegaba el fin). Ahora, si no hay overlay,
  el ítem **queda en espera** y arranca al conectarse. El dashboard muestra
  **"Overlay conectado / sin conexión"** y, si no hay ninguno, "No hay ningún
  overlay conectado. Revisá la fuente en OBS".
- **Watchdog**: si un clip supera su duración efectiva más un margen (configurable,
  por defecto 10 s) sin fin, la cola lo da por terminado y sigue.
- **Reconexión**: el overlay reconecta con backoff (1 s → 10 s). Al reconectar, el
  servidor reenvía el estado y, si hay un clip en curso, **se reinicia desde el
  principio** (los clips de alerta son cortos y es lo más simple y robusto; sin
  reinicio habría que calcular el tiempo restante del lado del servidor).

Logs de depuración: con `CZERO_DEBUG=1` el servidor imprime cada `play` con la
cantidad de overlays destinatarios, cada transición de la cola, cada mensaje
descartado y cada evento procesado por el motor de reglas. Nunca se registra la
clave del overlay.

## Decisiones tomadas

- **Sesiones en memoria**: al reiniciar el servidor hay que volver a entrar. Es una
  app local de un solo usuario; persistirlas no aportaba y suma superficie.
  Cambiar la contraseña invalida las demás sesiones (salvo la actual).
- **Cola en vivo por polling (1 s)** en vez de SSE o WebSocket: es una app local
  de un solo usuario y el costo es despreciable; evita conexiones de larga vida y
  los problemas de cierre que traen en los tests. Se consulta el `GET /api/state`
  que ya existía. Si más adelante hiciera falta, se puede migrar a SSE. La
  **moderación y el historial** también usan polling (2 s), por la misma razón.
- **`resolve` de moderación en memoria**: cuando un evento de origen viene de una
  plataforma que soporta marcar el canje como cumplido/rechazado, ese callback vive
  **en memoria** y se pierde al reiniciar el servidor. Es aceptable mientras no
  haya ninguna plataforma real conectada (Fase 4A); en la Fase 4B habrá que
  persistir el `eventId` y reintentar. Ver `docs/rules.md`.
- **Assets de `/web` públicos**: el HTML, Alpine (archivo local, sin CDN), CSS y JS
  del dashboard se sirven sin sesión; **los datos** salen siempre por `/api`, que
  sí está protegida. La ruta `/` (dashboard) redirige a `/login` sin sesión.
- **Orden de scripts**: los scripts que definen el componente (`app.js`,
  `login.js`) van **antes** de `alpine.min.js`. Alpine arranca en un microtask
  apenas se ejecuta, así que la expresión `x-data="..."` ya tiene que poder
  resolverse. Alpine llama solo al método `init()` (no hace falta `x-init`), y los
  nombres de propiedades del componente evitan chocar con globales del navegador
  (`confirm`, `alert`, `name`, `status`, `open`, `close`, `top`, `parent`,
  `event`). Ver `src/server/web-assets.test.ts`.
- **Sin `@fastify/cookie`**: el parseo y la serialización de cookies son propios
  (`src/server/cookies.ts`) para no sumar una dependencia sin consultar.
- **Sin `@types/better-sqlite3`**: hay una declaración ambiental mínima en
  `src/types/better-sqlite3.d.ts`.
- **Runtime TS de Node**: el código se ejecuta con el *type stripping* nativo de
  Node 22 (`node scripts/start.ts`), que **no soporta `enum` ni parameter
  properties**.

## Qué no se puede verificar sin navegador

Las verificaciones de `src/server/web-assets.test.ts` son **estáticas** (orden de
los `<script>`, existencia de los archivos, favicon). No cubren el render real de
Alpine, el comportamiento de `<video>` (seek del recorte), el panel de la cola, el
formulario de reglas, la tabla de moderación, el historial ni el cambio de
configuración en vivo. Eso hay que probarlo a mano en el navegador. Una prueba real
con Playwright cubriría esto, pero no se instala sin confirmación.

## Pendiente

- Sesiones persistentes, si se decide.
- Migrar la cola en vivo a SSE si el polling molesta.
- Persistir las resoluciones de canjes pendientes (Fase 4B).