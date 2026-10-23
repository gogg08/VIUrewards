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

### Dónde viven los datos (`VIUREWARDS_DATA_DIR`)

Todas las rutas **mutables** las resuelve un único módulo,
`src/server/paths.ts` (`resolveRuntimePaths`): es el **único** lugar que lee la
variable. El resto de la app recibe las rutas ya resueltas.

**Sin la variable** (desarrollo) se conserva la distribución histórica, todo
bajo el directorio de trabajo:

| Qué | Ruta histórica |
| --- | --- |
| Base SQLite | `data/app.db` |
| Biblioteca de clips | `media/` (y `media/thumbs/`) |
| Temporales de subidas | `.uploads/` |
| Logs y `pending-media.txt` | `logs/` |
| Herramientas administradas | `bin/` |
| Cerrojo de recursos compartidos | `.viurewards.lock` (raíz) |

**Con `VIUREWARDS_DATA_DIR`** (distribución) todos los recursos mutables viven
en ese directorio, que debe ser una ruta **absoluta**. Así el código de la app
se puede reemplazar al actualizar sin tocar los datos:

| Qué | Ruta configurada |
| --- | --- |
| Base SQLite | `<datos>/app.db` (sin subcarpeta `data/`) |
| Biblioteca de clips | `<datos>/media/` (y `<datos>/media/thumbs/`) |
| Temporales de subidas | `<datos>/.uploads/` |
| Logs y `pending-media.txt` | `<datos>/logs/` |
| Herramientas administradas | `<datos>/bin/` |
| Cerrojo de recursos compartidos | `<datos>/.viurewards.lock` |

- Una ruta **relativa**, vacía o que apunta a algo que no es una carpeta **no
  arranca**: se informa en español y el proceso sale con **código 2** (distinto
del 3 de "datos en uso"). Nunca inicializa en otra carpeta en silencio.
- El directorio de datos se crea si falta, junto con `bin/` y `logs/`.
- Los **recursos estáticos** (`web/`, `overlay/`) **no** dependen de esta
  variable: se resuelven con `import.meta.url`, así que cambiar el directorio de
datos no los mueve.
- Si configurás un directorio nuevo y todavía queda una base con contenido en la
  ubicación heredada (`<cwd>/data/app.db`), el arranque lo **avisa** y sigue:
  **no mueve, no copia y no borra nada**. Hay que copiar los datos a mano (o
  quitar la variable).
- El cerrojo se toma en el directorio de **datos** (no en la carpeta de la
  versión), así que sigue siendo el mismo tras una actualización.
- `scripts/play-test.ts` resuelve el **mismo** directorio de datos y toma el
  mismo cerrojo; si se configuró, escribe ahí en vez de en el cwd.

### Ciclo de vida: cierre ordenado

El dueño del proceso es `scripts/start.ts`. `AppServer.stop()` **no** cierra la
base ni el logger: eso lo hace el arranque al final (los tests comparten ese
método sin ser dueños de la base).

**Primera señal** (`SIGINT` = Ctrl+C, `SIGTERM`; en Windows también `SIGBREAK`)
→ una única secuencia de cierre, en orden de dependencias:

1. Se deja de aceptar trabajo: las rutas `/api/*` responden **503
   `SHUTTING_DOWN`** y no se crean trabajos nuevos.
2. Se detiene el **polling de Kick** (`stop()`): un ciclo en vuelo deja de
   escribir en la base en cuanto vuelve de la red.
3. Se **cancelan de verdad** las descargas/conversiones (`jobs.stop()`): se
   aborta cada trabajo, se termina el proceso externo **y su árbol**, se borran
   los parciales y se **espera** a que terminen. Un trabajo cancelado queda como
   `error`, nunca como `listo`. Lo que estaba esperando turno no arranca.
4. Se descartan las esperas de cooldown, los audios superpuestos diferidos
   (`cancelDeferred()`) y el temporizador de la cola (`queue.dispose()`).
5. Se cierran los WebSocket (overlays) y luego Fastify (`app.close()` termina
   las peticiones en vuelo).
6. Se loguea el resultado y se cierra la base y después el log, ya sin nada que
   las use. Código de salida **0**.

**Segunda señal** durante el cierre → salida **forzada** (código **1**): mata
los procesos externos vivos sin esperar y sale, sin repetir el cierre. Es
deliberada: no depende de que termine la misma operación que está bloqueada.

**Plazo duro** (`DEFAULT_SHUTDOWN_TIMEOUT_MS`, 10 s) → si vence, se registra y
se fuerza la salida (código 1). El temporizador **no** lleva `unref()`: tiene
que estar vivo mientras se espera el cierre; se cancela al terminar.

`stop()` es idempotente: la segunda llamada recibe la **misma** promesa, así que
nunca corren dos secuencias destructivas en paralelo.

**Cancelación real de procesos** (`src/media/run-process.ts`): todo proceso se
lanza con `spawn` y argumentos en array (`shell: false`), con `detached: true`,
y queda registrado en el supervisor mientras vive. Cancelar termina el árbol y
**espera** al evento `close` antes de resolver (`cancelled: true`, nunca éxito).
- **Windows**: `taskkill /PID <pid> /T /F` (spawn sin shell). El `/T` baja a los
  descendientes (p. ej. el ffmpeg que lanza yt-dlp). Si el proceso sigue vivo se
  reintenta (hasta 12 veces cada 250 ms).
- **Unix**: `process.kill(-pid, "SIGKILL")` al grupo (el `detached` lo hace
  líder), con caída al pid si el grupo ya no existe.
- `cancelAll()` espera a que **todos** mueran antes de resolver.

Limitación: depende del sistema operativo; probado en **Windows** (ver
`tests/e2e/shutdown.test.ts`). En Unix no se ejecutó.

**Lo que no hace todavía** (tareas aparte): el launcher de distribución.

### Arranque: exclusividad de instancia y limpieza de temporales

Antes de levantar el servidor, `scripts/start.ts` hace estas cosas, en este
orden:

1. **Toma la exclusividad de los recursos compartidos**
   (`acquireSharedResourcesLock`, `src/db/instance-lock.ts`): un archivo oculto
   `.viurewards.lock` en la **raíz de los datos** (la carpeta que contiene
   `media/`, `.uploads/` y `logs/`), creado con `openSync(..., "wx")` (atómico
   en Windows y Unix) y con `{ pid, at }`.
   - En desarrollo la raíz es el directorio de trabajo; con
     `VIUREWARDS_DATA_DIR` es el directorio de datos (así sobrevive a una
     actualización que reemplaza la carpeta de la versión).
   - Dos copias con carpetas `data/` **distintas** pero el mismo `media/` sí se
     ven entre sí (el cerrojo no vive en `data/`, vive en la raíz compartida).
   - Un cerrojo de un proceso **que ya no existe** se libera solo; uno de un
     proceso **vivo** se respeta aunque sea viejo. Uno **ilegible** se respeta
     solo si es reciente.
   - **Sin exclusividad la app NO arranca**: `main()` lanza
     `SharedDataInUseError` antes de abrir SQLite, reconciliar o levantar el
     servidor, y el punto de entrada sale con **código 3** y un mensaje en
     español (**no** es un error genérico: el launcher futuro debe leerlo como
     "ya hay una instancia usando estos datos"). Nunca borra el cerrojo de la
     otra instancia (solo se libera el que creó esta).
   - Si después de tomar el cerrojo falla la apertura de la base o el arranque
     del servidor, el cerrojo propio se libera (no queda tomado a una copia que
     no está corriendo).
   - El cerrojo queda **fuera** de `media/`: la carpeta de medios la recorre la
     reconciliación y es la que apunta OBS.
   - Está en `.gitignore` (`/.viurewards.lock`): es estado local, no código.
   - `scripts/play-test.ts` toma el **mismo** cerrojo sobre la misma raíz que
     resuelve el arranque, porque comparte `media/`, `.uploads/` y `logs/` con la
     app: si hay una instancia viva, se niega a arrancar y sale sin tocar nada.
   - **Contrato de rutas de `play-test.ts`** (corregido): primero resuelve y
     normaliza TODAS las rutas efectivas y solo después toma el cerrojo. El
     cerrojo se toma siempre sobre la raíz que **contiene** los tres
     directorios que la herramienta escribe; `--shared-root` es solo una
     **validación de coherencia** y nunca redirige el cerrojo a otra carpeta.
     La precedencia es: `VIUREWARDS_DATA_DIR` → `--media-dir` (los demás
     recursos van al padre de ese `media/`) → directorio de trabajo. Si la
     combinación dejara algún recurso fuera de la raíz del cerrojo (por ejemplo,
     medios en el directorio de datos y `--shared-root` en el del proyecto, o
     `--media-dir` con un `--shared-root` que apunta a otro lado), la
     herramienta **rechaza** la combinación con un mensaje en español que nombra
     las rutas en conflicto, antes de descargar, escribir logs o tocar
     `pending-media.txt`.
2. **Abre la base** (`data/app.db`, o `<datos>/app.db` si está configurado) con
   las migraciones.
3. **Toma un segundo cerrojo de diagnóstico** en `data/instance.lock` (misma
   mecánica). Su falta ya no se da en uso normal (el de la raíz lo garantiza);
   el mensaje explica si hay una copia con otro `data/`.
   No se usa un `BEGIN EXCLUSIVE` de SQLite (lo que se probó antes): una
   transacción abierta dejaba al servidor sin poder escribir y una segunda
   instancia moría con `SQLITE_BUSY`.
4. **Limpia temporales huérfanos** (`src/media/cleanup.ts`), antes de crear el
   servidor y antes de reconciliar la biblioteca, para que una conversión
   interrumpida no se importe como clip:

   | Qué es | Patrón (`src/media/temp-patterns.ts`) | Se borra |
   | --- | --- | --- |
   | Subida de archivo interrumpida | `<uuid>.upload` en `.uploads/` | si tiene más de 24 h |
   | Descarga de yt-dlp | `<id>.src.*` (incluye `.info.json`, `.part`, `.ytdl`) | si tiene más de 24 h y el id no es de un clip registrado |
   | Parcial de ffmpeg | `<id>.mp4.part` / `<id>.m4a.part` | ídem |
   | Salida de conversión sin registrar | `<id>.mp4` / `<id>.m4a` **sin fila** | **solo** con evidencia |

   **Evidencia** de una conversión interrumpida: el libro
   `logs/pending-media.txt` tiene `encodes <id>` (la app misma declaró que estaba
   escribiendo ese archivo y no llegó a registrarlo) **y** no quedan `.src.*`
   vivos del mismo id. Sin evidencia, un `.mp4`/`.m4a` sin fila **nunca** se
   borra: la reconciliación los importa a propósito.

   Se conservan siempre: los clips registrados (y sus `.src`, que pueden ser la
   única copia si falta el archivo), las miniaturas (`thumbs/`, que no se
   recorre), los sidecars `<id>.json`, los archivos desconocidos, los temporales
   de menos de 24 h y los de un clip del que la reconciliación ya vio que falta
   su archivo. No hay recursión, no se siguen enlaces simbólicos y solo se miran
   `media/` y `.uploads/`. Los errores (permisos, archivo en uso) se registran y
   se sigue: un fallo de la limpieza **nunca** impide arrancar.

   Limitación de la prueba: en Windows el caso del **enlace simbólico** se
   **saltea** si el sistema exige permisos especiales para crearlo, y no hay un
   caso con el archivo **abierto** por otro proceso; ambos están cubiertos por la
   lógica (solo `lstat` de archivos regulares y errores registrados), no por una
   prueba ejecutada.

   Por qué 24 h: un temporal reciente puede pertenecer a una operación que otra
   copia de la app todavía tiene abierta. La exclusividad de la raíz
   compartida ya impide esa situación (una segunda copia no arranca), así que las
   24 h son un margen de seguridad extra, no la única protección.

   El libro vive en `logs/` (`MediaOperationJournal`): se escribe al empezar y al
   terminar cada descarga, conversión y subida, así sobrevive a un cierre
   abrupto. El arranque lo lee en **modo de solo lectura** (antes de crear el
   libro de la sesión, que reescribe el archivo) y lo usa tanto para la limpieza
   como para que la reconciliación no importe la salida interrumpida.
   Al cerrarse la sesión, el servidor borra los temporales de `media/` de **esta**
   sesión (los procesos ya no existen), sin tocar `.uploads/` ni un trabajo que
   todavía recibe o convierte un archivo.

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
- **Columna izquierda:** caja **Recompensas del canal**. Título, dos **botones de
  ícono** (**Recargar** y **Ver todas las recompensas**) y **Nueva recompensa**
  fijos arriba; el formulario y la lista scrollean dentro. La lista se muestra como
  **tarjetas compactas** (nombre que hace wrap, costo, etiqueta de estado y botones
  Editar/Borrar en una fila); las columnas Texto y Regla salen de la vista (el dato se
  conserva). El **markup de la tarjeta se define una sola vez** (`rewardCardHtml()` en
  `web/app.js`): lo usan el panel vertical y la **ventana grande de recompensas**
  (botón Ver todas), que ocupa casi toda la pantalla (`calc(100vw - 3rem)` ×
  `calc(100vh - 3rem)`) y muestra todas en una grilla con el mismo ancho
  (`var(--reward-card-width)` = 286 px) y la misma interactividad (delegación de
  eventos). El encabezado de la ventana lleva, a la derecha del título, un **control de
  orden** (desplegable **Fecha añadida** / **Puntos** + botón de dirección ↑/↓, con la
  misma estética que el filtro de la biblioteca). El orden es **solo de la ventana**
  (el panel vertical conserva el orden del servidor) y se guarda en `localStorage`
  (`viurewards.rewardsSort`); por defecto, fecha añadida más reciente primero. Las
  recompensas sin fecha local ("de otra app") van siempre al final, ordenadas por
  nombre; el detalle ("sin fecha de creación") va en el `title` de la etiqueta "De
  otra app", no como línea aparte (no altera la altura de la tarjeta).
- **Columna central:** dos cajas apiladas, **Agregar un clip** (fija) y **Biblioteca**
  (título fijo; la grilla scrollea dentro).
- **Columna derecha:** **una sola caja** con el **selector compacto y centrado**
  **Cola | Historial** dentro; el contenido de la pestaña scrollea dentro. El selector
  es de **ancho de contenido** (`fit-content` + `margin-inline: auto`), con las dos
  pestañas del **mismo ancho** (`--queue-tab-min`) y navegación por flechas
  (`role="tablist"`/`role="tab"`). Los cuatro controles de la cola
  (Saltar/Pausar/Reanudar/Vaciar) van en una sola fila, sin wrap (Vaciar en estilo
  peligro). El panel **no** repite el aviso de overlay desconectado. El Historial usa
  **filas de dos líneas** (título/recompensa + resultado; usuario · hora en 24 h
  corto · motivo).
- **Ajustes** es una **ventana flotante** con pestañas a la izquierda (Kick, Overlay
  y OBS, Alertas, Biblioteca y descargas, Seguridad, Apariencia y Avanzado). Se cierra con Esc, con la X o con clic afuera; si hay cambios sin
  guardar, avisa **y dice qué pestaña** los tiene. Cada pestaña tiene su propio botón
  de guardado o su acción inmediata; el aviso de "sin guardar" es **por pestaña**
  (guardar una no limpia el de otra). La pestaña **Apariencia** elige el tema, el color
  de acento y el modo del logo, y aplica al instante (sin Guardar); su contenido se
define en la sección 7.3 de `UI-DESIGN.md`.

El **sistema de diseño** vive en `web/style.css` y está hecho **solo con variables
CSS** (colores, espaciados, radios y tipografías). Ningún componente escribe colores
literales, así los temas (**Noche**, **OLED** y **Día**, más **Automático**) son otro
juego de valores (ver "Temas, acento y logo").

## Temas, acento y logo

El aspecto del dashboard se elige en **Ajustes → Apariencia** y se aplica **al
instante**, sin botón Guardar. La preferencia es **de cada navegador** (`localStorage`,
claves `viurewards.theme` y `viurewards.accent`), **no** de la instalación: no va a la
base de datos.

**Temas** (`web/style.css`, juegos de variables CSS):

- **Noche** (por defecto): reproduce el aspecto anterior exactamente.
- **OLED**: fondo negro puro.
- **Día**: claro.
- **Automático**: sigue al sistema (`prefers-color-scheme`); oscuro → Noche, claro →
  Día. El modo oscuro del sistema **nunca** usa OLED (OLED es una elección explícita).

Cada tema fija `color-scheme` (`dark` en Noche/OLED, `light` en Día) y sus propias
variables de scrollbar y de sombra. Los colores de estado (`danger`/`warn`/éxito) **no**
dependen del acento.

El tema se aplica con `web/theme.js`, cargado **sincrónicamente** en el `<head>` (antes
de la hoja de estilos) en `index.html` y `login.html`, para que no haya un destello del
tema por defecto al abrir; pone `data-theme` y las variables de acento en `<html>`.

**Color de acento.** Paleta de **7 preajustes** (Verde por defecto, Violeta, Azul, Rosa,
Naranja, Cian y **Gris claro**, este último pensado para OLED) más un **selector libre**
con hex validado (`#RRGGBB`). El acento se usa en el botón primario, la pestaña/segmento
activo, el interruptor encendido, el anillo de foco, los enlaces, los elementos activos y
los **estados positivos** (habilitada/conectado). El color del texto sobre el acento se
elige por contraste (negro o blanco), siempre.

**Contraste del acento.** Por **defecto** el acento se **ajusta** solo: si el color no
alcanza 2:1 contra el fondo del tema, se corrige. Un interruptor **"Ajustar contraste"**
(por defecto **encendido**, en `localStorage`; clave ausente o valor inválido = encendido,
solo `false`/`0`/`off` lo apaga) cambia esto: encendido, `viuAccentForTheme(hex, theme,
fixContrast)` aplica la corrección **más suave posible** y lleva el acento **hasta 2:1**
contra el fondo (el umbral es la constante única `ACCENT_MIN_CONTRAST`; si el acento ya
cumple, se devuelve idéntico). No garantiza 3:1: el umbral se eligió para que el acento se
distinga del fondo, no para legibilidad de texto. Apagado, si el contraste acento/fondo es
**< 2:1** se muestra una **advertencia con el ratio** que sugiere activar el toggle; no
bloquea ni cambia el color. **Restablecer** vuelve el acento al verde por defecto y el
toggle a su default (encendido). Los estados positivos **siguen al acento**
(`--color-success` es un alias de `--color-accent`): con un acento rojo "Habilitada" y
"Conectado" se ven rojos. `danger` y `warn` siguen semánticos y no cambian.

**Logo por tema.** El logo busca un archivo distinto según el tema en `web/assets/`
(`VIUrewards-dark.webp`/`.png` para Noche y OLED, `VIUrewards-light.webp`/`.png` para
Día), combinado con sus tres modos (Automático, Dinámico, Estático). El juego **oscuro**
es el **canónico**: es el `src` fijo del HTML (dashboard, login y guía) y el respaldo si
el claro no carga (`logo.js` lo recuerda, sin repetir el 404).

Todo el tema es **solo del dashboard**: el **overlay de OBS es transparente y no tiene
tema ni acento**, y no se tocó.

En **Ajustes → Apariencia**, el tema y la paleta son grupos de radio (`radiogroup` +
`radio` + `aria-checked`) con **foco visible y navegación por flechas** (←/↑ y →/↓
mueven el foco y aplican el valor como un clic); solo el elegido entra en el orden de
tabulación.

Los tests de lógica (`src/server/theme-logic.test.ts`) y los estáticos
(`src/server/theme-ui.test.ts`) cubren el contraste, la elección de la tinta, la
validación del hex, el respaldo de `localStorage` y que cada tema defina las mismas
variables. Un **humo con Playwright** para el cambio de tema todavía está pendiente
(la suite `test:e2e` aún no cubre temas).

## Controles globales de reproducción (panel de Cola)

Al fondo del panel vertical **Cola** hay una sección **Global** (siempre visible, aunque la
lista scrollee: es hermana del área con scroll) con dos toggles y un **engranaje a la
**izquierda** del toggle de Chill** (orden del markup: engranaje y después switch)
para abrir sus ajustes. Todo se aplica **al instante** y se guarda en la tabla `settings`
(claves `playback.globalAudioOnly`, `playback.chillMode`, `playback.chillVolume`,
`playback.chillCooldownSec`), así que sobrevive a la recarga del dashboard y al reinicio
del servidor. No toca la configuración individual de recompensas ni de clips.

- **Solo audio** (`globalAudioOnly`, default apagado): fuerza que **todas** las alertas
  suenen sin imagen. El servidor manda el estado al overlay por WebSocket (mensaje
  `global`, al conectar y cuando cambia) y el overlay lo aplica al **inicio de cada
  reproducción**: marca `params.audioOnly` en su copia del ítem, así que el recorte, la
  duración máxima, los eventos de fin y el avance de la cola siguen igual. Una alerta que
  ya está sonando **no** se reinicia ni se corta; el cambio afecta a las que arrancan
  después (pendientes y nuevas). Un clip que ya es solo audio no cambia.
- **Modo Chill** (`chillMode`, default apagado) tiene dos efectos mientras está activo:
  - **Volumen** (`chillVolume`, 0-100, default **25**): se manda al overlay como factor
    (`volume = chillVolume / 100`) y el overlay **multiplica** el volumen del ítem y el de
    cada voz superpuesta. Con Chill apagado el factor es `1` (sin atenuación). No se aplica
    dos veces con el volumen global, que se resuelve en el servidor en su propio camino.
    Ejemplo: alerta al 50 % con Chill al 25 % → 12,5 %.
  - **Espera tras terminar** (`chillCooldownSec`, 0-600, default **5**; 0 = sin espera):
    es el tiempo mínimo **desde el FIN de una alerta hasta el INICIO de la siguiente**. Lo
    implementa un único `StartGate` (`src/server/start-gate.ts`) compartido por la cola y
    el despachador, así que no hay cooldowns duplicados. El fin lo sella el servidor
    cuando el overlay avisa `ended` (o `audioEnded` para un audio superpuesto), el
    watchdog da por terminado un clip, o se salta/vacía lo que estaba sonando. En
    «Esperar turno» la cola reprograma la promoción del siguiente ítem cuando falta
    tiempo; en «Superponer» el despachador programa el envío del audio y **acepta** el
    canje igual (no bloquea el ciclo de canjes); ahí además se respeta el intervalo
    entre **inicios**, así que dos audios superpuestos tampoco arrancan pegados. Es
    independiente del cooldown por recompensa y no lo modifica.

**Limitación conocida:** «Probar alerta» desde la biblioteca y la alerta de prueba del
overlay son acciones manuales y **no** pasan por el intervalo de Chill. Los cambios de
volumen o de intervalo tampoco alteran la alerta que ya está sonando.

## Responsive y alineaciones

Reglas de acomodo en `web/style.css` (solo estilos/markup, sin cambios de lógica):

- **Estado Overlay/Kick:** el punto y el texto comparten la clase de estado del contenedor
  (`.status-line.ok` = acento, `.status-line.error` = peligro) y se alinean con flex; la
  barra superior y Plataformas usan el mismo componente (`.status-pill` + `.dot`).
- **Seguridad:** los tres campos de contraseña tienen `max-width: 360px` y el botón queda
  alineado con ellos.
- **Barra superior (<= 600 px):** se oculta el logo, los pills no se parten y permiten
  `wrap`; en **<= 480 px** muestran solo punto + nombre corto (el estado va en color,
  `title` y `aria-label`) y Salir pasa a ícono.
- **Panel Descargas (<= 600 px):** `fixed`, acotado al viewport
  (`max-width: calc(100vw - 16px)`, `max-height: calc(100dvh - 80px)`, `overflow-y: auto`).
- **Ajustes:** las pestañas tienen la misma caja siempre (borde transparente base, altura
  mínima fija) y la navegación no se estira; en **<= 720 px** pasan a una fila con scroll
  horizontal; el modal tiene **altura estable** entre pestañas (`min(80dvh, 640px)`).

El **humo con Playwright** para estos casos (viewport de 360x780 que abra Descargas y
Ajustes → Seguridad, verifique que nada excede el viewport y que la altura del modal es
igual entre pestañas) queda **pendiente**: la suite `test:e2e` corre sin navegador.

## Login y página pública de la guía

El **login** (`web/login.html`) tiene el logo **centrado y más grande**
(`--logo-height-login: 72px`) y un botón/enlace **Guía** (`<a href="/guia">`) en el
extremo opuesto de **Entrar** (también en el modo de primer uso), con apariencia de botón
secundario (borde y texto con el acento, **fondo transparente**, misma caja que Entrar).

La página **`/guia`** explica, sin sesión, cómo conectar VIUrewards con Kick (crear la app
en `kick.com/settings/developer`, la redirect URI exacta, las credenciales, los permisos y
problemas comunes). Es **pública y de solo lectura**: no exige sesión, no usa cookies, no
llama a ninguna API protegida y no recibe datos sensibles del servidor. El único enlace
externo es `kick.com`.

La **redirect URI** se calcula en el navegador (`web/guia.js`) como
`http://localhost:<puerto>/callback`, tomando el puerto de `window.location.port` (y `80`
si está vacío) — con `localhost`, no `127.0.0.1`, porque Kick lo rechaza.

Las **capturas** son opcionales: la página pide la lista al servidor
(`GET /api/guide-shots`) y muestra **solo** los archivos que existen, así que si todavía no
hay ninguna no aparece un hueco y **no hay 404 ni errores en consola**. El **NN del nombre
es el número de paso** (`guia-01-…` … `guia-06-…`) y puede haber varias por paso, en orden
alfabético; la página las agrupa con `stepShots('guia-paso-N')` y oculta el bloque si el
paso no tiene ninguna. Cada captura va en un `<figure>` con pie de foto y se amplía desde
un **botón** accesible (`.guide-shot-open`) con un **visor** (`role="dialog"`) que se
cierra con Esc, el botón X o un clic afuera, atrapa el Tab y devuelve el foco al botón.
Nombres y tamaño recomendado en `docs/guia-capturas.md`.

Si la URL trae un ancla (`/guia#guia-paso-3`), al terminar de montarse la página se vuelve
a ubicar ese bloque (`scrollToHash`), porque las capturas pueden cambiar la altura después
del salto inicial del navegador.

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
  **Saltar / Pausar / Reanudar / Vaciar**. Debajo de los pendientes aparece la
  sección **"En espera de cooldown"** cuando una recompensa tiene canjes
  esperando su turno: muestra el nombre de la recompensa, el usuario y los
  segundos restantes (se refresca con el polling de 1 s). Esos canjes no son
  ítems de la cola de reproducción y no tienen botones por ítem.
- **Configuración general**: volumen global (0-100%) que multiplica el de cada
  alerta; duración máxima por defecto de una alerta; límites de descarga
  (duración y tamaño máximos, que el módulo de media relee **en cada descarga**);
  whitelist de dominios editable (por defecto: youtube.com, youtu.be,
  tiktok.com, **instagram.com**, clips.twitch.tv y kick.com); puerto; **cambiar
  contraseña** y **regenerar la clave del overlay**.
- **Duración desconocida**: algunos reels de Instagram no traen `duration` en la
  extracción. El filtro de yt-dlp es **tolerante** a un valor desconocido
  (`duration <=? N`), así que esos videos se descargan y la duración real se
  valida **después** con ffprobe; si supera el límite, el archivo se borra y la
  descarga falla. Un fallo real (login requerido, rate limit) muestra su motivo,
  no un mensaje de duración. Ver `docs/media-limits.md`.
- **Overlay para OBS**: la URL se muestra **enmascarada** por defecto, con botones
  **Mostrar** y **Copiar**, y un aviso de no mostrarla en pantalla durante el
  stream.

### Motor de reglas (interno)

Las **reglas** ya no son una sección visible: cada recompensa tiene una **regla
interna 1:1** que se crea y se mantiene sola al crear/editar la recompensa (trigger
`reward_redeemed` con el id de la recompensa y acción `PlayClip`). El motor de
eventos sigue igual por debajo; ver `docs/rules.md`.

- **Historial de eventos**: últimas 100 entradas con hora, plataforma, tipo,
  usuario, resultado (`Disparó / En espera por cooldown / Omitido / Error / Sin
  regla / Duplicado`) y motivo (por ejemplo `cooldown, faltan N s`,
  `cola de espera llena`, `sin permiso`).
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
  formados. Nunca puede usarse para apuntar a servicios internos. Al sumar
  `instagram.com` a la lista por defecto, las instalaciones existentes **migran
  solo si su lista guardada es exactamente la anterior** (sin `instagram.com`);
  una lista personalizada no se toca.

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

Etapa 5 (Parte C): `GET /api/logs` (últimas N líneas del log, con `limit` y
`level`; **redactadas** antes de salir) y `GET /api/support/summary` (resumen de
soporte sin secretos). Ambas exigen sesión (401) y las de estado también validan
el origen cuando corresponde.

**Públicas (sin sesión)**: `GET /callback` (OAuth de Kick, valida solo `state` + PKCE) y
las de la guía: `GET /guia` (sirve `web/guia.html`, con `Cache-Control: no-cache`) y
`GET /api/guide-shots` (lista de solo lectura de las capturas existentes en
`web/assets/guide/`, solo nombres que matchean `^guia-\d\d-[a-z0-9-]+\.(png|webp|jpg)$`,
`[]` si la carpeta no existe o no se puede leer, sin rutas ni metadatos). Ninguna de las
dos habilitó nada más: el resto de `/api/*` sigue en 401 sin sesión.

## Log del servidor

El servidor escribe `logs/server.log` (junto a `media/`, fuera de lo servido por
HTTP), con líneas `fecha [nivel] mensaje` y rotación por tamaño (2 MiB →
`server.log.1`). Lo hace `createFileLogger` en `src/server/logs.ts`; si no se
puede abrir el archivo, degrada a un logger inerte (un fallo de log nunca rompe
la app). Los mensajes de diagnóstico (plataforma, reglas, despacho, canjes,
recompensas, biblioteca) se escriben con nivel `debug`, que solo se registra con
`CZERO_DEBUG=1`; también siguen saliendo por consola en ese modo.

El visor (Ajustes → Avanzado) pide las líneas con `GET /api/logs`; el servidor
lee **solo el final del archivo** (con un límite de bytes, nunca entero) y
**redacta los secretos** antes de responder: reemplaza por `***` los valores
conocidos (la clave del overlay) y todo lo que matchee `key=`, `token=`,
`secret=`, `password=`, `client_secret`, etc. `GET /api/support/summary` arma el
resumen de "Copiar para soporte" con las mismas reglas de redacción.

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
- **Markup de la tarjeta de recompensa compartido (retoces de UI)**: el panel
  vertical y la ventana grande necesitan la **misma** tarjeta. Como Alpine local
  (3.14.9, sin build) no tiene parciales ni componentes reutilizables, se eligió una
  **función de renderizado** (`rewardCardHtml(reward)` en `web/app.js`) que devuelve
  el HTML y se pinta con `x-html` en los dos contenedores; la interactividad va por
  **delegación de eventos** (`data-action` + `@click`/`@change` en la tarjeta). Los
  datos externos (título, color, mensajes) se **escapan** con `escapeHtml()` porque
  `x-html` no escapa. Así el markup de la tarjeta se define **una sola vez**.
- **Control de orden solo en la ventana grande**: el requisito es que el panel
  vertical conserve su orden (el del servidor, por `created_at`) y que el orden de la
  ventana se recuerde entre aperturas. Por eso el estado (`rewardsSort`) vive en el
  componente pero `sortedRewardsForWindow` es un **getter** que copia y ordena sin
  mutar `this.rewards`; la elección se persiste en `localStorage`
  (`viurewards.rewardsSort`) y no se envía al servidor. Se agregó `createdAt` a la
  API de recompensas (la columna `rewards.created_at` ya existía desde la migración
  v6, no se creó ninguna migración nueva); las recompensas "de otra app" no tienen
  fila local, así que su `createdAt` es `null` y van al final con el texto "sin
  fecha".
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
- **Humo con Playwright de `/guia`**: la suite `test:e2e` corre sin navegador. Falta
  verificar consola sin errores en los tres temas, 360 px sin scroll horizontal, que
  "Volver" y las entradas del índice sean alcanzables con Tab, el visor de capturas
  (Esc, foco de vuelta al botón) y que `/guia#guia-paso-3` quede con el paso 3 a la vista.