# Dashboard local (VIUrewards)

El dashboard es la interfaz que usa el streamer en el navegador. Todo corre en su
PC; el servidor escucha solo en `127.0.0.1`.

## Cómo se arranca

```
npm start
```

La consola muestra la URL del dashboard (por defecto `http://127.0.0.1:8787/`).
Podés cambiar el puerto con `--port=...`, la variable de entorno `PORT`, o desde
la **Configuración** del panel (requiere reiniciar). El script toma el puerto en
eso orden.

Si el puerto ya está en uso, la app no arranca y muestra un mensaje claro en
español: probablemente **ya hay otra copia de VIUrewards corriendo** (quizá en
otra terminal). Cerrá esa copia o elegí otro puerto. Si el puerto lo ocupa un
programa ajeno, el mensaje también lo aclara.

### Diagnóstico del overlay

Con `CZERO_DEBUG=1` el servidor registra, además de lo habitual, el diagnóstico
que manda el overlay: **no incluye la clave del overlay**. Al conectarse reporta
su **versión**, el `userAgent` y el resultado de `canPlayType` para `audio/mp4`
(AAC), `video/mp4` (H.264 + AAC) y `audio/x-m4a`; en cada reproducción reporta la
URL del medio **sin la clave**, `readyState`, `networkState`, el código y mensaje
de error del elemento, y el momento en que se disparó cada evento
(`loadedmetadata`, `canplay`, `playing`, `ended`, `error`).

## Primer uso

La primera vez, el dashboard pide **crear una contraseña** (mínimo 8 caracteres).
Se guarda solo su hash (`crypto.scrypt` con salt aleatorio), nunca en texto plano.
Después, para entrar, se usa esa contraseña. La sesión va en una cookie
`httpOnly`, `SameSite=Strict`.

## Estructura de la interfaz (Etapas 2 y 2B del rediseño)

El dashboard es una **sola pantalla de uso** con **tres columnas**; la página no
scrollea (el encabezado y las columnas ocupan la altura de la ventana).

**Cada columna es una caja** (borde, fondo y radios del sistema) con **scroll
vertical interno** y **sin scroll horizontal** (`overflow-y: auto; overflow-x:
hidden`). El desborde siempre ocurre dentro de una caja, nunca en la página ni en
una columna. En ventana angosta (<1024 px) se muestra **una columna por vez** con
una **barra de pestañas fija** arriba (Recompensas, Clips, Cola).

- **Encabezado:** logo VIUrewards con **tres modos** (Automático por defecto, Dinámico y Estático; se eligen en Ajustes → Apariencia, se guardan en `localStorage` y se aplican al instante); indicadores de **Overlay** (conectado / sin
  conexión) y **Kick** (no vinculado / conectado / requiere volver a vincular),
  ambos clicables y abren **Ajustes** en su pestaña. El indicador de Overlay, sin
  conexión, muestra el tooltip "Revisá la fuente en OBS". A la derecha, **Descargas**
  y **Ajustes** son **íconos SVG inline** (`currentColor`, sin archivos externos),
  con `title`/`aria-label`; el de Descargas lleva el punto superpuesto en la esquina
  (sin punto sin actividad, verde si hay algo en curso, rojo si hubo un error sin
  ver). Después, Salir. El desplegable de Descargas sigue vacío (Etapa 3).
- **Columna izquierda:** caja **Recompensas del canal**. Título, **Recargar** y
  **Nueva recompensa** fijos arriba; el formulario y la lista scrollean dentro. La
  lista se muestra como **tarjetas compactas** (nombre que hace wrap, costo, etiqueta
  de estado y botones Editar/Borrar en una fila); las columnas Texto y Regla salen de
  la vista (el dato se conserva). Es provisional hasta la Etapa 4.
- **Columna central:** dos cajas apiladas, **Agregar un clip** (fija) y **Biblioteca**
  (título fijo; la grilla scrollea dentro).
- **Columna derecha:** **una sola caja** con el selector **Cola | Historial** dentro;
  el contenido de la pestaña scrollea dentro. Los cuatro controles de la cola
  (Saltar/Pausar/Reanudar/Vaciar) van en una sola fila, sin wrap (Vaciar en estilo
  peligro). El panel **no** repite el aviso de overlay desconectado. El Historial usa
  **filas de dos líneas** (título/recompensa + resultado; usuario · hora en 24 h
  corto · motivo).
- **Ajustes** es una **ventana flotante** con pestañas a la izquierda (Kick, Overlay
  y OBS, Alertas, Biblioteca y descargas, Seguridad, Apariencia —vacía por ahora— y
  Avanzado). Se cierra con Esc, con la X o con clic afuera; si hay cambios sin
  guardar, avisa **y dice qué pestaña** los tiene. Cada pestaña tiene su propio botón
  de guardado o su acción inmediata; el aviso de "sin guardar" es **por pestaña**
  (guardar una no limpia el de otra). En esta etapa el contenido se movió a su pestaña
  **sin rediseñar cada una** (la sección 7.3 de `UI-DESIGN.md` define el contenido
  final, Etapa 5).

El **sistema de diseño** vive en `web/style.css` y está hecho **solo con variables
CSS** (colores, espaciados, radios y tipografías). Ningún componente escribe colores
literales, así los temas futuros (OLED, noche, día) son otro juego de valores.

## Qué permite hoy (Fase 3 completa)

- **Agregar un clip**: pegás una URL (whitelist de dominios) y la descarga corre
  **en segundo plano** con estado consultable
  (`en cola → descargando → convirtiendo → listo / error`). No es una request que
  queda esperando.
- **Biblioteca**: grilla de tarjetas con **miniatura real** (`.jpg` extraída con
  ffmpeg al agregar el clip), duración, tamaño, **renombrar**, **borrar** (con
  confirmación, elimina archivo, registro y miniatura) y **Probar alerta** (lo
  encola y lo reproduce el overlay). El clic abre la ventana de detalle con
  reproductor grande, recorte, renombrar y borrado. Los clips **sin imagen**
  muestran un ícono de audio grande; si una miniatura falta, Ajustes →
  Biblioteca y descargas tiene **"Generar miniaturas faltantes"** (de a una en
  segundo plano, sin regrabar el clip).
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

### Motor de reglas (interno)

Las **reglas** ya no son una sección visible: cada recompensa tiene una **regla
interna 1:1** que se crea y se mantiene sola al crear/editar la recompensa (trigger
`reward_redeemed` con el id de la recompensa y acción `PlayClip`). El motor de
eventos sigue igual por debajo; ver `docs/rules.md`.

- **Historial de eventos**: últimas 100 entradas con hora, plataforma, tipo,
  usuario, resultado (`Disparó / Omitido / Error / Sin regla / Duplicado`) y motivo
  (por ejemplo `cooldown`, `sin permiso`).
- **Simular evento**: dispara un evento de cualquier tipo sin ninguna plataforma
  conectada, y un botón **Evento manual** (el mismo que dispara `ManualEventSource`).
  Sirve para probar las reglas internas de punta a punta.

Todo el texto de la interfaz está en español. Los nombres de los clips se
insertan con bindings de texto (Alpine `x-text`), que escapan HTML; nunca con
`x-html`.

### Sección nueva (Fase 4B + Etapa 4A del rediseño: integración real con Kick)

- **Plataformas**: vínculo de la cuenta por OAuth con PKCE, con estado visible
  (no vinculado / conectado / requiere volver a vincular). Carga del **Client ID**
  y **Client Secret** (el secret es **de solo escritura**: nunca se devuelve ni se
  loguea). Vincular abre la página de Kick; el callback valida solo con
  `state` + PKCE y redirige al dashboard. Desvincular borra los tokens pero
  conserva las credenciales.
- **Recompensas del canal**: listar, crear, editar activar/desactivar, borrar,
  **Recrear** y **Quitar de la app**, con la API oficial. La **vista unificada**
  calcula el estado de cada recompensa: **Habilitada**, **Deshabilitada**, **Falta
  en Kick**, **De otra app**, **Sin conexión** y "No se pudo aplicar". Cada
  recompensa tiene una **regla interna 1:1** (`PlayClip`) que se crea y se mantiene
  sola; el creador nunca la ve. Al **desactivar** o **borrar** una recompensa con
  canjes pendientes, se **rechazan primero** (con confirmación: "Se rechazarán N
  canjes pendientes").
- **Canjes pendientes antiguos**: los que superan la antigüedad configurada, con
  botones **Rechazar todos** y **Procesar ahora**.
- **Diagnóstico**: intervalo de polling, último chequeo/resultado/error, latencias
  de detección (últ/min/típ/máx), cantidad de respuestas 429 y headers de rate
  limit observados. Sin tokens ni secretos.
- **Configuración**: se agregaron **intervalo de polling de canjes**, **al omitir
  un canje**, **canjes con más de N minutos** y **qué hacer con canjes viejos**.

Guía de alta paso a paso: `docs/kick-setup.md`.

## Archivos y datos

- `data/app.db`: SQLite local (tablas `clips`, `settings`, `rules` y
  `event_history`). Ignorado en git.
- `media/`: clips `.mp4` (video) y `.m4a` (audio local), con un sidecar `.json`
  por clip y las miniaturas en `media/thumbs/<id>.jpg`. Ignorado en git.
- `logs/`: salida cruda de yt-dlp/ffmpeg. Ignorado en git.

La tabla `clips` incluye `trim_start` y `trim_end` (segundos, opcionales; `null`
= sin recorte), `has_video` (si el archivo tiene imagen) y `missing` (si el
archivo ya no está en `media/`), agregadas por migraciones. Reprocesar una URL de
la caché **no pisa** el título ni el recorte que haya puesto el usuario.

## Reconciliación de la biblioteca al arrancar

Al iniciar, la app pone la tabla `clips` de acuerdo con lo que hay en `media/`
(`reconcileClips`, en `src/db/clips.ts`). Reglas (nunca borra en silencio):

**Qué lee**

- Los nombres de archivo de `media/`, reconociendo **todos los formatos
  permitidos** por la lista única compartida (`src/media/formats.ts`: hoy
  `.mp4` y `.m4a`), no una extensión fija.
- El sidecar `<id>.json` de cada clip (título, duración, tamaño, `hasVideo`).
- Las filas de la tabla `clips`.

**Qué escribe**

- **Agrega** la fila de un archivo que está en `media/` y no tiene fila: desde
  el sidecar si existe; si no, reconstruye con **ffprobe** (`createClipRebuilder`,
  en `src/media/rebuild.ts`, con `-protocol_whitelist file` y la lista corta de
  `format_name`), con título derivado (`Audio <id corto>` / `Clip <id corto>`).
  El **id y el nombre de archivo nunca cambian**.
- **Marca** `missing = 1` en un clip cuyo archivo ya no está (no lo borra): la
  biblioteca muestra "Falta el archivo" y se puede borrar a mano.
- **Desmarca** `missing` si el archivo reaparece.

**Qué nunca hace**

- **No borra filas** de clips.
- **No toca** un clip usado por una recompensa (ni activa ni desactivada).
- **No modifica nada** si la carpeta `media/` no existe, no es una carpeta, no
  se puede leer o está **vacía** (se interpreta como una unidad sin montar):
  aborta y avisa, sin marcar todos los clips como ausentes.
- **No modifica** el archivo de un clip ni su sidecar.

Cada cambio automático se registra en el log (con los ids y el motivo) y el
arranque imprime un resumen (`+N recuperados`, `N sin archivo`, etc.).

Esta reconciliación nació de un bug real: solo reconocía `.mp4`, así que un
audio local `.m4a` quedaba invisible y su fila se borraba al reiniciar (el
archivo seguía en `media/`, pero desaparecía de la biblioteca).

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
  la cookie de sesión, para que el dashboard pueda previsualizar los clips. Las
  **miniaturas** (`/media/thumbs/<id>.jpg`) usan la misma autenticación, son de
  solo lectura (solo `.jpg`) y no permiten path traversal.
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
`POST /api/rules/:id/toggle`, `GET /api/events`, `GET /api/sources`,
`POST /api/simulate`, `POST /api/manual`. Todo input se valida con esquemas de
Fastify.

Fase 4B + Etapa 4A: `GET /api/platforms`, `POST/DELETE /api/platforms/:id/credentials`,
`POST /api/platforms/:id/link|unlink|test`, `GET /api/platforms/:id/diagnostics`,
`GET /api/platforms/:id/rewards` (vista unificada), `POST /api/platforms/:id/rewards`,
`PATCH|DELETE /api/platforms/:id/rewards/:localId`,
`POST /api/platforms/:id/rewards/:localId/enable|disable|recreate|detach`,
`GET /api/platforms/:id/rewards/:localId/pending`, `GET /api/platforms/:id/redemptions`,
`POST /api/platforms/:id/redemptions/reject-all|process-now`. La ruta
`GET /callback` es **pública** (no usa cookie): valida solo `state` + PKCE y
redirige al dashboard.

Etapa 3B (archivos locales y Descargas): `POST /api/uploads`,
`POST /api/jobs/:id/cancel`, `DELETE /api/jobs/:id`, `POST /api/jobs/clear-finished`,
`POST /api/clips/cleanup`, `POST /api/clips/thumbs/backfill`.

Etapa 5 (Ajustes completos, Parte B): `GET /api/clips/cleanup-preview` (vista previa de
la limpieza), `POST /api/clips/reconcile` (reconciliación a demanda),
`GET /api/library/usage` (espacio ocupado y versiones de las herramientas),
`POST /api/tools/ytdlp/update` y `POST /api/overlay/test` (alerta de prueba).

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
  que ya existía. Si más adelante hiciera falta, se puede migrar a SSE. El
  **historial** también usa polling (2 s), por la misma razón.
- **Assets de `/web` públicos**: el HTML, Alpine (archivo local, sin CDN), CSS y JS
  del dashboard se sirven sin sesión; **los datos** salen siempre por `/api`, que
  sí está protegida. La ruta `/` (dashboard) redirige a `/login` sin sesión.
- **Orden de scripts**: los scripts que definen los componentes y el logo
  (`logo.js`, `app.js`, `login.js`) van **antes** de `alpine.min.js`. Alpine arranca en un microtask
  apenas se ejecuta, así que la expresión `x-data="..."` ya tiene que poder
  resolverse. Alpine llama solo al método `init()` (no hace falta `x-init`), y los
  nombres de propiedades del componente evitan chocar con globales del navegador
  (`confirm`, `alert`, `name`, `status`, `open`, `close`, `top`, `parent`,
  `event`). Ver `src/server/web-assets.test.ts`.
- **Sin `@fastify/cookie`**: el parseo y la serialización de cookies son propios
  (`src/server/cookies.ts`) para no sumar una dependencia sin consultar.
- **Sin `@types/better-sqlite3`**: hay una declaración ambiental mínima en
  `src/types/better-sqlite3.d.ts`.
- **Título de la recompensa en el Historial (Etapa 2B)**: el evento lo guarda como
  texto dentro del `payload` serializado (`payload_json`), que `/api/events` ya
  devuelve; el frontend lo parsea y, si no viene, muestra el tipo de evento en
  español. No hizo falta cambiar la API.
- **Runtime TS de Node**: el código se ejecuta con el *type stripping* nativo de
  Node 22 (`node scripts/start.ts`), que **no soporta `enum` ni parameter
  properties**.

## Qué no se puede verificar sin navegador

Las verificaciones de `src/server/web-assets.test.ts` son **estáticas** (orden de
los `<script>`, existencia de los archivos, favicon). No cubren el render real de
Alpine, el comportamiento de `<video>` (seek del recorte), el panel de la cola, el
historial ni el cambio de configuración en vivo. Eso hay que probarlo a mano en el
navegador. Una prueba real con Playwright cubriría esto, pero no se instala sin
confirmación.

En la Fase 4B se sumó `src/server/platforms-ui.test.ts`, que verifica
**estáticamente** que cada handler `@click` del HTML está definido en `app.js`
(regresión del bug de métodos referenciados pero sin definir), que la sección
Plataformas existe y que no hay tokens de OAuth en el frontend. Sigue sin cubrir
el render real: el vínculo OAuth contra Kick, la tabla de recompensas, el panel de
diagnóstico y el flujo de canjes hay que probarlos a mano.

La Etapa 2B (presentación: cajas, scroll interno, íconos SVG del encabezado, aviso
por pestaña, una columna por vez en ventana angosta) es **solo CSS/HTML/JS de
presentación**: el no-scroll horizontal, el punto de Descargas, el tooltip del
indicador de Overlay y la barra de pestañas angosta **no** se pueden verificar sin
navegador. Los tests existentes siguen cubriendo el orden de scripts, la existencia
de assets, los handlers `@click`/`@change` y la ausencia de tokens.

El **logo** (Parte C): el modo Automático (animado los primeros 60 s y después
fijo), el arranque en fijo con `prefers-reduced-motion`, el cambio sin parpadeo y
la caída al texto "VIUrewards" si la imagen no carga **no** se pueden verificar sin
navegador. El ciclo del WebP animado (69 cuadros, 5.040 s) se midió del archivo;
los tests solo comprueban que la constante y las rutas existen.

## Pendiente

- Sesiones persistentes, si se decide.
- Migrar la cola en vivo a SSE si el polling molesta.
- Medir los rate limits reales de Kick y completar §11.4 de `docs/kick-research.md`.