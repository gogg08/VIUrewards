# VIUrewards: diseño de la interfaz

Este documento es la fuente de verdad de la UX del dashboard. Resume las decisiones tomadas con el creador del proyecto y reemplaza a cualquier diseño anterior. Si el código y este documento difieren, se pregunta antes de decidir.

El proyecto pasa a llamarse **VIUrewards** (antes `czero-rewards`). El logo es un `.webp` animado con fondo translúcido propio, con un `.png` estático equivalente al primer y último cuadro; se muestra en el encabezado y en el login con **tres modos configurables** (ver §3).

## 1. Principios

- **Una sola pantalla de uso**, pensada para tenerla abierta durante el stream: recompensas, clips y cola a la vista, sin cambiar de sección.
- **Lo técnico no se ve por defecto.** Todo lo que no es de uso diario vive en una ventana flotante de Ajustes.
- **El creador agrega los clips. El público no envía links ni archivos.** No hay moderación, propuestas ni cola de aprobación (ver sección 12).
- **El creador no ve la palabra "regla".** Una recompensa reproduce un clip; la regla interna se crea por detrás.
- **Los estados nunca mienten.** Si algo falta, falló o está desconectado, la interfaz lo dice.
- **Todo el texto en español.** Todo dato externo (nombres de clips, títulos, nombres de usuario) se escapa antes de mostrarse.

## 2. Pantalla principal

Tres columnas, **cada una una caja** (borde, fondo y radios del sistema de diseño) con **scroll vertical interno** y **nunca horizontal**: la página no scrollea (el encabezado, las columnas y las cajas ocupan la altura de la ventana) y el desborde siempre ocurre dentro de una caja. La barra de pestañas Cola | Historial va **dentro** de la caja derecha.

```
┌──────────────────────────────────────────────────────────────────────┐
│ [VIUrewards] [Overlay] [Kick]              [⬇ Descargas] [⚙] [Salir]  │
├───────────────┬───────────────────────────────────┬──────────────────┤
│ Recompensas   │ Agregar un clip  [link] [Descargar]│ Cola | Historial │
│  (título +    │ ───────────────────────────────── │  [Saltar]        │
│   Recargar +  │ Biblioteca (grilla con scroll)     │  [Pausar] ...    │
│   Nueva) fijo │                                    │  en reproducción │
│  lista scroll │                                    │  en espera       │
└───────────────┴───────────────────────────────────┴──────────────────┘
```

Ventana angosta (menos de 1024 px, por ejemplo un dock de OBS): se muestra **una columna por vez** con una barra de pestañas fija arriba (Recompensas, Clips, Cola), de modo que ningún panel queda inalcanzable. La página sigue sin scrollear. Foco visible y navegación por teclado en todo.

## 3. Encabezado

- **Izquierda:** el **logo VIUrewards**, y a su derecha los indicadores de estado:
  - El **logo** tiene **tres modos** configurables en Ajustes → Apariencia (se guardan en este navegador, no en la base, y se aplican al instante):
    - **Automático** (por defecto): animado los primeros 60 s y después fijo; con `prefers-reduced-motion: reduce` arranca directo en fijo.
    - **Dinámico**: siempre el `.webp` animado.
    - **Estático**: siempre el `.png`.
  - El `.png` es idéntico al primer y último cuadro del `.webp`, así que el cambio no parpadea. Un solo `<img>` con altura fija por la variable CSS `--logo-height` (32–40 px; 28 px en ventana angosta) y ancho automático. Si la imagen no carga, se muestra el texto "VIUrewards".
  - **Overlay:** conectado / sin conexión.
  - **Kick:** no vinculado / conectado / requiere volver a vincular / reconectando.
  - Cada indicador es clicable y abre Ajustes en su pestaña (Overlay y OBS, o Kick). Un indicador en problema cambia de color.
- **Derecha:** botón Descargas, engranaje (Ajustes) y Salir.

## 4. Panel izquierdo: Recompensas

La columna es **una caja** con scroll vertical interno (nunca horizontal). Arriba, fijos: el título **Recompensas del canal**, dos botones de **ícono** y **Nueva recompensa**; el contenido (formulario y lista) scrollea dentro de la caja.

- **Recargar (ícono):** dos flechas circulares, con `aria-label`/`title` "Recargar recompensas". Mientras carga gira (animación CSS) y el botón queda deshabilitado con `aria-busy`; con `prefers-reduced-motion: reduce` no gira y se muestra con opacidad reducida. Misma acción que antes: vuelve a contrastar las recompensas con Kick.
- **Ver todas las recompensas (ícono):** un marco en L en la esquina superior derecha con una flecha diagonal; `title`/`aria-label` "Ver todas las recompensas". Abre la **ventana grande de recompensas** (sección 4.1). Queda **deshabilitado sin Kick vinculado** (mismo gris que el resto del panel) con la explicación en el `title`; con caída temporal de Kick (sin conexión) sigue habilitado y muestra las recompensas guardadas con el aviso de sin conexión.
- Los dos íconos van a la derecha del título, con `gap` `var(--space-2)` y alineados verticalmente con él; el título no se parte en el ancho actual de la columna.

Lista de recompensas con un botón "Nueva recompensa". Hasta la Etapa 4, la lista se muestra como **tarjetas compactas** con nombre (puede hacer wrap), costo, etiqueta de estado y los botones Editar/Borrar en una fila; las columnas Texto y Regla se quitan de la vista (el dato se conserva).

**Tarjeta colapsada** (todos los estados, incluidas las bloqueadas con los botones deshabilitados):
1. **Nombre** (hace wrap) + **cuadradito de color** a la derecha.
2. **Resumen en una línea:** costo · modo (`cooldown N s` o `superpuesto`) · ícono de parlante si es solo audio.
3. **Clip:** nombre y duración (solo si apunta a un clip local).
4. **Etiqueta de estado**, en su **propia línea**.
5. **Texto de ayuda o de advertencia**, si lo hay ("La creó otra aplicación; Kick no permite editarla desde acá.", "Datos sin sincronizar con Kick.", el error de "No se pudo aplicar"), **entre** la etiqueta y la fila de acciones.
6. **Separador sutil** (sin borde marcado).
7. **Fila de acciones, ANCLADA ABAJO:** Editar y Borrar juntos a la izquierda, el interruptor solo a la derecha (`justify-content: space-between`, centrado vertical, sin wrap en un ancho normal). La etiqueta de estado **nunca** comparte línea con los botones ni con el interruptor.

```
┌──────────────────────────────────────┐
│ Goku Ahhh!                        ■  │  1. nombre + cuadradito de color
│ 100 pts · cooldown 5 s · 🔊          │  2. resumen
│ Goku Ahhh! · 0:04                    │  3. clip
│ [HABILITADA]                         │  4. etiqueta de estado
│ (texto de ayuda, si lo hay)          │  5. ayuda/advertencia
│ ─────────────────────────────────────│  6. separador sutil
│ [Editar] [Borrar]             (●━)   │  7. fila de acciones, anclada abajo
└──────────────────────────────────────┘
```

**Anclaje de las acciones:** la tarjeta es un **flex en columna con `height: 100%`** (se estira a su celda de la grilla); el **pie** (`.reward-card-foot`: separador + fila de acciones) lleva **`margin-top: auto`**, así las acciones quedan **siempre pegadas al borde inferior** sin importar cuánto contenido haya arriba. Con tarjetas de distinta altura en una misma fila (la grilla estira todas a la más alta), las acciones de todas quedan alineadas en la misma línea inferior. El texto de ayuda **nunca** queda debajo de la fila de acciones.

Espaciado: entre líneas de texto `var(--space-2)`; entre el separador y la fila de acciones `var(--space-3)` (como antes). El **cuadradito de color es clicable**: abre el selector de color nativo del sistema (botón accesible con `aria-label` "Cambiar color"); al cerrarse o aceptarse se guarda el color, sin diálogos propios de la app. Si el guardado falla, vuelve al color anterior y se muestra el error en español. El interruptor queda deshabilitado — igual que Editar — en los estados bloqueados ("De otra app", "Falta en Kick", sin conexión, sin sincronizar). El color dentro de la ventana de crear/editar es parte del formulario y se guarda con Guardar.

**Estados de una recompensa** (se contrastan con Kick al cargar la app y al apretar "Recargar"):

| Estado | Significado | Toggle |
|---|---|---|
| Habilitada | Existe en Kick con `is_enabled` verdadero | Encendido |
| Deshabilitada | Existe en Kick con `is_enabled` falso | Apagado |
| Falta en Kick | Fue borrada a mano desde Kick | Bloqueado; ofrece "Recrear" (con otro id) o "Quitar de la app" |
| De otra app | La creó otra aplicación; Kick no permite editarla desde acá | Bloqueado, con explicación |

**Toggle (usa `is_enabled`, no borra ni recrea):**
- **Desactivar:** si hay canjes pendientes, se rechazan **antes** de deshabilitar; luego se deshabilita; luego se vuelve a revisar si se coló algún canje. Si algún rechazo falla, no se deshabilita en silencio: se muestra cuáles quedaron y se pregunta al creador.
- **Texto de confirmación:** "Se rechazarán N canjes pendientes" (no "se reembolsarán") hasta que se verifique que Kick devuelve los puntos al rechazar.
- **Activar:** pone `is_enabled` en verdadero. La recompensa conserva su id de Kick y su historial.
- Los espectadores no ven las recompensas deshabilitadas (confirmado por el creador).

**Sin Kick vinculado** (no vinculado o requiere volver a vincular): el panel completo queda en gris, sin nada interactivo, con un mensaje y un atajo a Ajustes → Kick. Si la caída es temporal (red o Kick caído), se muestran las recompensas guardadas con un aviso de "sin conexión" y los toggles bloqueados.

### 4.1 Ventana grande de recompensas

Al apretar **Ver todas las recompensas** se abre una **ventana flotante que ocupa casi toda la pantalla** (mismo sistema que Ajustes: modal sobre el fondo oscurecido).

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Recompensas del canal (12)         Ordenar por: [Fecha añadida ▾] [↓]   X  │
├────────────────────────────────────────────────────────────────────────────┤
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐                    │
│ │ tarjeta   │ │ tarjeta   │ │ tarjeta   │ │ tarjeta   │  ← misma tarjeta   │
│ └───────────┘ └───────────┘ └───────────┘ └───────────┘    que el panel   │
│ ┌───────────┐ ┌───────────┐                                                │
│ └───────────┘ └───────────┘                                                │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Marco:** en pantallas anchas ocupa el **90 % del espacio disponible**: `width: calc((100vw - 3rem) * 0.9)` y `height: calc((100vh - 3rem) * 0.9)`, **sin tope de ancho fijo**, centrada. El tamaño se define **en un solo lugar**: `.modal-window` usa `var(--modal-width)`/`var(--modal-height)` y esta ventana solo sobreescribe esas variables (así no compite por especificidad con la clase base). El **encabezado** es fijo: título **"Recompensas del canal (N)"** con la cantidad entre paréntesis a la izquierda; el **control de orden** (ver abajo) y el botón **X** de cerrar a la derecha. El **cuerpo scrollea por dentro** (solo vertical, nunca horizontal, con el scroll fino de la app) y usa padding `var(--space-6)`.
- **Grilla:** `repeat(auto-fill, var(--reward-card-width))`, `justify-content: start`, `gap: var(--space-4)`. Muestra **todas** las recompensas con las **mismas tarjetas** que el panel vertical, idénticas en aspecto y **tamaño** (`var(--reward-card-width) = 286px`), en todos los estados. En pantallas anchas con pocas recompensas la grilla queda alineada arriba a la izquierda; si se ve desbalanceado, la alternativa es centrarla (`justify-content: center`), pero se deja a la izquierda para mantener el ancla visual.
- **Markup compartido:** hay **una sola definición** del markup de la tarjeta (`rewardCardHtml()` en `web/app.js`). Como Alpine local (3.14, sin build) no tiene parciales ni componentes, el panel vertical y la ventana lo pintan con `x-html` y la interactividad va por **delegación de eventos** (`data-action`) en la tarjeta: interruptor de activar/desactivar (con su flujo de canjes pendientes), cuadradito de color (guarda al aceptar), Editar, Borrar, Recrear y Quitar de la app. Una sola lista de datos y un solo Recargar: lo que se cambia en la ventana se ve de inmediato en el panel vertical y al revés (sin segundo polling ni segunda copia del estado).
- **Control de orden (solo la ventana):** mismo estilo que el filtro **Todos / Video / Audio** de la biblioteca (`.segmented`: mismo borde, fondo, radios, padding, tipografía y estados activo/hover), a la derecha del título y antes de la X: un **desplegable "Ordenar por"** con dos criterios (**Fecha añadida** y **Puntos**) y, a su lado, un **botón de dirección** con un ícono SVG de flecha (↑ ascendente / ↓ descendente) y `aria-label` "Orden ascendente"/"Orden descendente".
  - **Por defecto:** Fecha añadida, **más reciente primero** (descendente). **Puntos:** por costo; en caso de empate, por **nombre** (alfabético, sin distinguir mayúsculas ni tildes). Ambos criterios admiten las dos direcciones.
  - **Fecha añadida** usa `rewards.created_at` (la fecha local de creación, `createdAt` en la API). Las recompensas **sin fila local** (las "De otra app") no tienen fecha: van **siempre al final** de la lista, en ambas direcciones, ordenadas por nombre. No muestran una línea propia en la tarjeta (cambiaría su altura): el detalle va en el **`title` de la etiqueta "De otra app"** ("Sin fecha de creación: va al final cuando se ordena por fecha") y en el `title` del control de orden.
  - El desplegable es accesible: abre con clic o Enter/Espacio (`role="listbox"`/`role="option"` con `aria-selected`), navega con flechas, cierra con Esc o clic afuera, y devuelve el foco al botón que lo abrió.
  - La elección (criterio y dirección) se guarda en **`localStorage` de ese navegador** (`viurewards.rewardsSort`, con `try/catch`; valores inválidos caen al valor por defecto) y se recuerda entre aperturas. **Solo afecta a la ventana grande**; el panel vertical conserva el orden del servidor (por `created_at` ascendente).
- **Capas:** Editar y Crear abren la ventana de edición **por encima** de la ventana grande; las confirmaciones de desactivar y borrar también. **Esc cierra de a una capa**, en orden: desplegable de orden → confirmaciones → ventana de edición → ventana grande → desplegable de Descargas → Ajustes. Clic afuera cierra la ventana grande solo si no hay otra capa abierta encima. Al cerrarla, el foco vuelve al botón que la abrió.
- **Estado vacío:** "Todavía no creaste ninguna" y el control de orden deshabilitado. Si la plataforma deja de estar vinculada con la ventana abierta, la ventana se cierra sola.
- **Responsive:** debajo de 1024 px la ventana mantiene el tamaño **casi completo** (margen de 1rem, `calc(100vw - 2rem)` × `calc(100vh - 2rem)`, sin el 90 %, porque se vería chica) y la grilla pasa a una columna centrada si el ancho no alcanza para una tarjeta; el encabezado se acomoda en dos filas si no entra (título arriba, orden y cerrar abajo); sin scroll horizontal en ninguna resolución. En el modo de una columna por vez (barra de pestañas) el botón funciona igual.
- **Accesibilidad:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` apuntando al título, foco inicial en el botón de cerrar, trampa de foco simple (Tab cicla dentro) y foco visible.

**Estado:** implementado (ventana grande con markup de tarjeta compartido y control de orden persistido).

## 5. Panel central

Dos cajas apiladas: **Agregar un clip** (fija, alto según su contenido) y **Biblioteca** (título fijo; la grilla de clips scrollea dentro de la caja). Scroll vertical interno, nunca horizontal.

### Agregar un clip
- Campo de link (YouTube, TikTok, etc., según los dominios permitidos) con botón **Descargar**.
- A la derecha del campo, un botón **+** para agregar un archivo local.
- **Arrastrar y soltar** un video o audio sobre cualquier parte de la página lo agrega a la biblioteca (varios a la vez, un progreso por archivo). Mientras se arrastra, aparece el aviso "Soltá para agregar a la biblioteca". Se ignora si Ajustes está abierto, y se evita que el navegador abra el archivo si se suelta fuera de la zona.
- Los errores inmediatos (URL inválida, dominio no permitido, archivo de tipo no soportado) aparecen debajo del campo y no crean una tarea.

**Estado:** implementado en la Etapa 3B (botón + con selector de archivo, arrastrar y soltar en toda la página con aviso, subida por `POST /api/uploads` con `@fastify/multipart`, tope de 2 subidas simultáneas en el cliente).

### Biblioteca
- Grilla de tarjetas **simples**: miniatura, nombre, duración y botón de probar.
- **Miniatura real (corrección 2.4):** la tarjeta muestra una miniatura `.jpg` extraída del clip con ffmpeg (un cuadro al ~10 % de la duración, ancho máx. 480 px, guardada en `media/thumbs/<id>.jpg`). Se carga con `loading="lazy"` y el ancho/alto los fija el CSS (`aspect-ratio: 16/9`), así no hay saltos de layout. Si la imagen no carga, se oculta y queda el **fondo neutro** de la tarjeta (respaldo). El servidor la expone como `thumbUrl` en `GET /api/clips` (`null` si todavía no existe).
- Clips **sin imagen**: en lugar de una miniatura, un **ícono de audio grande y centrado** (SVG inline), no el parlantito chico en una esquina.
- Servido por `/media/thumbs/<id>.jpg`, de solo lectura, con la **misma autenticación que `/media`** (clave del overlay o sesión) y sin path traversal. La miniatura se borra junto con el clip y la limpieza de caché la trata igual que a su clip.
- Filtro Todos / Video / Audio.
- Clic en una tarjeta abre la ventana de detalle (sección 7.2).
- **"Solo audio" ya no es una marca del clip**: se quitó el interruptor de las tarjetas. Ahora es una opción de cada recompensa (sección 7.1); el archivo de un clip sin imagen se recuerda en el clip (`has_video`), pero el creador no lo cambia desde la biblioteca.
- **Miniaturas faltantes:** Ajustes → Biblioteca y descargas tiene **"Generar miniaturas faltantes"** (solo por acción del usuario). Genera de a una en segundo plano las miniaturas de los clips con imagen que no la tengan, con progreso, y **nunca modifica ni regraba el clip**. Si ffmpeg falla, el clip queda igual (sin miniatura) y el fallo se registra en el log.

## 6. Panel derecho: Cola e Historial

**Una sola caja** con scroll vertical interno (nunca horizontal). Arriba, dentro de la caja, el **selector compacto Cola | Historial**, centrado horizontalmente; debajo, el contenido de la pestaña, que scrollea dentro de la caja.

**Selector Cola | Historial** (compacto y centrado, no de ancho completo):

```
┌──────────────────────────────────────┐
│          ┌───────┬───────────┐        │
│          │ Cola  │ Historial │        │  centrado, ancho de contenido
│          └───────┴───────────┘        │  (inline-flex / fit-content)
└──────────────────────────────────────┘
```
- Contenedor de **ancho de contenido** (`width: fit-content; margin-inline: auto`), **no** de ancho completo (sin `width: 100%` ni `flex: 1`).
- Las dos pestañas con el **mismo ancho** (grilla de 2 columnas iguales con un mínimo cómodo `var(--queue-tab-min)`), textos centrados y sin partirse (`white-space: nowrap`); así el botón verde activo **no cambia de tamaño** al alternar.
- Se conserva el estilo del contenedor (borde, fondo, radios, padding) y el de la pestaña activa (verde). La cabecera del panel usa `padding-block: var(--space-3)`.
- Accesibilidad: `role="tablist"` con `aria-label`, dos `role="tab"` con `aria-selected`, y **navegación por flechas** izquierda/derecha entre las dos pestañas (misma acción que el clic).
- Funciona con el panel angosto (ancho de dock de OBS, menos de 1024 px, una columna por vez): el selector sigue centrado y no se parte.

- **Cola:** botones Saltar, Pausar, Reanudar, Vaciar y Cortar audios en una sola fila (sin wrap). Muestra el clip en reproducción y los que esperan. **Nombre del ítem (decision):** el servidor resuelve el **nombre del clip** en un solo lugar (`title`, o `"Clip no disponible"` si el clip ya no existe, **nunca el id**) para todos los caminos (canje real, simulador, Probar alerta, reencolado). La UI muestra **"nombre del clip · título de la recompensa"** cuando el contexto de la recompensa difiere del nombre del clip (p. ej. `Goku Ahhh! · test123`); si no hay título de recompensa o coincide con el del clip, muestra solo el nombre. El texto largo **salta de línea** dentro de la caja (`overflow-wrap: anywhere`), nunca desborda ni muestra el id. Cada ítem de **solo audio** lleva un ícono de parlante junto al nombre. Saltar es la forma de destrabar el clip en curso; Vaciar solo limpia la espera. El panel **no** muestra el aviso de overlay desconectado: eso lo informa el indicador del encabezado (con tooltip "Revisá la fuente en OBS"). **Cortar audios** corta todas las voces superpuestas de los overlays conectados (modo `overlap`); no toca la cola.
- **Historial:** **filas de dos líneas**, sin truncar. Línea 1: el título de la recompensa (guardado como texto en el evento, para leerse aunque la recompensa ya no exista; si el evento no lo trae, el tipo en español) y el resultado como etiqueta (`Disparó`, `Disparó · superpuesto`, `Omitido`, etc.). Línea 2: usuario · hora · motivo si lo hay (`cooldown, faltan N s`, `sin overlay conectado`, `sin clip`), en texto secundario. Hora en formato 24 h corto (por ejemplo 18:59).

## 7. Ventanas flotantes

Todas se muestran sobre el panel principal, que se oscurece con negro de opacidad baja. Se cierran con Esc, con la X o con clic afuera; si hay cambios sin guardar, avisan.

### 7.1 Crear y editar recompensa

**Ventana flotante** (modal sobre el panel oscurecido), no un formulario dentro de la columna. Arranca chica, con **solo el menú desplegable de clip** (nombre y duración, sin miniatura), y crece hacia abajo al elegir un clip, mostrando el resto de los campos, con transición suave, altura máxima y scroll interno; no ocupa toda la pantalla. Al **editar** una recompensa existente el clip ya está elegido, así que abre expandida; si el creador cambia de clip, no se vuelve a achicar. Si no hay ningún clip en la biblioteca, el desplegable muestra un estado vacío con el aviso de que primero hace falta agregar uno.

Campos (una sola columna; ancho `min(600px, calc(100vw - 2rem))`, cuerpo con padding `--space-6` y scroll interno, encabezado y pie fijos; separación entre campos `--space-5`, entre etiqueta y control `--space-2`):
1. **Clip:** menú desplegable con nombre y duración.
2. **Nombre de la alerta:** se completa solo con el nombre del clip (limpiado: sin emojis ni hashtags), recortado a 50 caracteres, **con contador alineado a la derecha en la línea de la etiqueta**. Se actualiza al cambiar de clip **mientras el creador no lo haya editado a mano**.
3. **Costo y Color en una fila de dos columnas** (costo angosto, ~40 %; color el resto): dentro de la columna Color, el campo hex y el **selector de color nativo (36–40 px)** van en una fila propia (`.color-row`, `display: flex`, `align-items: center`, `flex-wrap: nowrap`), el cuadradito a la derecha del hex. El hex es flexible (`flex: 1 1 auto; min-width: 0`) y el cuadradito es fijo (`flex: 0 0 auto`). El tamaño del cuadradito del modal (`--color-picker-size`, 40 px) es **mayor a propósito** que el chip de la tarjeta (`--reward-swatch-size`, 20 px): uno es un control, el otro una muestra.
4. **Descripción:** opcional, hasta 200 caracteres, con contador a la derecha.
5. **Divisor sutil** y botón fantasma **Opciones avanzadas** a ancho completo, alineado a la izquierda, con chevron.

**Opciones avanzadas (colapsadas; una sola columna, cada grupo separado por `--space-5` y con su propio texto de ayuda, que es chico, secundario y va a `--space-2` del control):**
1. **Repetición:** selector segmentado (Esperar turno | Superponer) a ancho completo, dos mitades iguales, textos en una sola línea (`nowrap`). Ayuda según el modo.
2. **Solo audio:** etiqueta e interruptor en la misma fila (`space-between`). Ayuda debajo: "Suena sin mostrar la imagen"; en bloqueo, "Superponer siempre es solo audio" o "Este clip no tiene imagen". Es una opción **de la recompensa** (ya no una marca del clip). Queda **encendido y bloqueado** si lo fuerza el modo Superponer o si el clip no tiene imagen. Al volver de Superponer a Esperar turno, el interruptor recupera el valor que el creador había elegido antes. En modo **Esperar turno** con solo audio activado, el overlay reproduce el clip **sin mostrar la imagen** (el video se oculta con `visibility: hidden`, no con `display: none`, para que el audio siga sonando, el recorte y la duración máxima apliquen y los eventos `ended`/`error` sigan llegando) y **sin animación** de entrada/salida. El estado visible se decide por cada reproducción, no queda pegado de la anterior.
3. **Volumen:** porcentaje a la derecha de la etiqueta; slider a ancho completo (0 a 100 %; se guarda 0 a 1).
4. **Duración máxima** (placeholder "sin límite", ayuda "Vacío = sin límite") y **Cooldown global** (ayuda "0 = sin espera") en una fila de **dos columnas iguales**. El cooldown se **oculta** en Superponer: **la columna se conserva vacía** para que la duración no se estire ni salte. El cooldown es **solo global**; cuenta desde que la alerta se dispara y sobrevive a reinicios.
5. **Animación de entrada y de salida**, en dos columnas iguales, **ocultas** si la recompensa es solo audio (no hay imagen).

Si el ancho es menor a 520 px, las filas de dos columnas pasan a una sola. Sin overflow horizontal.

- **Esperar turno (`queue`):** la alerta espera su turno en la cola. Un clip sin imagen suena igual, sin mostrar imagen.
- **Superponer (`overlap`):** los audios suenan a la vez, sin esperar; **siempre es solo audio** (no hay imagen ni animaciones que mostrar). No hay cooldown. Línea explicativa: "Los audios suenan a la vez, sin esperar. El máximo simultáneo se cambia en Ajustes → Alertas".

**Posición X e Y:** ocultas en la interfaz; se conservan en la base, la API y el código como reservadas, y el overlay no las aplica (sección 3).

Volumen siempre como slider con porcentaje (0 a 100 %; se guarda 0 a 1).

**Interruptores:** "Activar al guardar" es un interruptor (switch), no un checkbox. La tarjeta colapsada de la lista lleva un interruptor de activa/desactiva (`is_enabled`) con los estados de la sección 4.

**Pie fijo** (borde superior sutil, padding `var(--space-4) var(--space-6)`): "Probar alerta" (fantasma) a la izquierda; "Cancelar" (secundario) y "Guardar" (primario) a la derecha, con gap `var(--space-3)`.

**Notas:**
- Se elimina "Pide texto al espectador": va siempre apagado (se envía explícitamente falso a Kick).
- La tarjeta colapsada muestra el modo de repetición como texto secundario: "cooldown N s" o "superpuesto".
- La opción de Kick para saltar la cola de solicitudes no se muestra (pendiente de verificar).
- Al editar, nombre, costo, color y descripción se envían a Kick; el clip y las opciones de reproducción son solo de la app.
- La regla interna se crea y se mantiene sola; el creador no la ve.

**Estado:** implementado en la Etapa 4B (ventana flotante que crece al elegir un clip, interruptores accesibles y confirmación de canjes pendientes).

### 7.2 Detalle del clip

- **Reproductor grande** con el video (o reproductor de audio si es un archivo de audio). El recorte se elige acá.
- **Recorte no destructivo:** inicio y fin, con botones "tomar del reproductor" y "restablecer", y la duración resultante.
- **Nombre:** editable.
- **Origen:** link de origen o "archivo local", más tamaño y duración.
- **Probar alerta:** con la configuración actual (recorte incluido).
- **Guardar / Cancelar:** los cambios se aplican con Guardar, no al instante. Cambiar el recorte de un clip en reproducción o en cola aplica a las próximas reproducciones; lo que está sonando no se interrumpe.
- **La ventana de detalle NO tiene "Solo audio":** esa opción pasó a ser de cada recompensa (sección 7.1).
- **Borrar** (al final, separado, en rojo):
  - Si alguna recompensa lo usa (**incluidas las desactivadas**), el borrado se **bloquea** y se listan las recompensas, con la opción de borrarlas con una advertencia extra. Las recompensas "de otra app" aparecen en la lista pero sin opción de borrado.
  - Si es un archivo local, avisa que no se puede recuperar.

**Estado:** implementado en la Etapa 3A (ventana con reproductor, recorte no destructivo, renombrar, probar y borrar con la guarda de recompensas que lo usan).

### 7.3 Ajustes

Ventana con pestañas a la izquierda y **botón Guardar por pestaña**. Las acciones inmediatas (vincular, actualizar yt-dlp, limpiar caché) tienen su propio botón y su resultado a la vista. Valores numéricos validados con mensajes claros (en el cliente y en el servidor, con el rango permitido).

**Cambios sin guardar (por pestaña):** cada pestaña con Guardar lleva su propio indicador de cambios pendientes y su propio mensaje de resultado (éxito o error), cerca del botón. Guardar una pestaña **no** limpia el aviso de otra. Cambiar de pestaña **no** pierde lo escrito (el estado se conserva mientras la ventana está abierta). Cerrar Ajustes con cambios pendientes abre un diálogo que **nombra las pestañas afectadas** y ofrece **Descartar**, **Seguir editando** y **Guardar todo**. Al abrir Ajustes desde un indicador del encabezado (Overlay o Kick), la ventana arranca en la pestaña correspondiente; el engranaje abre en la última pestaña usada.

**Confirmaciones propias:** las acciones destructivas dentro de Ajustes (borrar credenciales, actualizar yt-dlp) usan un **diálogo de confirmación propio de la app** (`settingsConfirm`, un modal chico con Cancelar y el botón de la acción), no el `window.confirm` del navegador. La limpieza de caché usa su propio modal de **vista previa** (muestra qué se borraría antes de confirmar).

1. **Kick:** estado; Client ID (visible) y Client Secret (solo escritura, nunca se devuelve; el campo arranca siempre vacío y avisa "Secret guardado"/"Falta el secret"); vincular, desvincular y borrar credenciales (con confirmación propia que avisa que también desvincula); **redirect URI calculada desde el puerto actual con botón de copiar**; errores de vínculo explicados en español (por ejemplo, "invalid authorization request" casi siempre es una redirect URI que no coincide exactamente: `http://localhost:<puerto>/callback`, sin barra final, `http` y no `https`, `localhost` y no `127.0.0.1`); "Probar conexión".
2. **Overlay y OBS:** URL con la clave enmascarada, Mostrar y Copiar, aviso de no mostrarla en stream; estado de conexión con la **versión del overlay** conectado; regenerar clave (con confirmación y aviso de actualizar OBS); medidas recomendadas (1920×1080); **alerta de prueba** (manda un cartel breve a los overlays conectados y avisa en español si no hay ninguno).
3. **Alertas:** volumen global, duración máxima por defecto, **audios simultáneos máximos** (1–20, por defecto 8; si se supera, se corta el audio más antiguo); qué hacer con un canje omitido (dejar pendiente por defecto, o rechazar, con la advertencia de que el reembolso no está verificado); canjes pendientes antiguos al iniciar (ignorar, rechazar o procesar), con lista y "Rechazar todos" / "Procesar ahora".
4. **Biblioteca y descargas:** límites de duración y tamaño (descargas y archivos locales); dominios permitidos (rechaza IPs, `localhost`, nombres sin punto y caracteres inválidos); **yt-dlp** (versión detectada y botón "Actualizar yt-dlp", solo por acción explícita, con el resultado a la vista; si el error de una descarga sugiere actualizar, la fila del panel Descargas lleva acá); **espacio ocupado** por la biblioteca (clips + miniaturas); **"Limpiar caché ahora"** con **vista previa** de qué se borraría (`GET /api/clips/cleanup-preview`) y confirmación; **"Generar miniaturas faltantes"** (reubicado acá) y **"Revisar archivos ahora"** (`POST /api/clips/reconcile`, la misma reconciliación del arranque, que muestra el mismo aviso descartable). El contenido de la pestaña se refresca al abrirla.
5. **Seguridad:** cambiar contraseña (pide la actual y cierra las demás sesiones).
6. **Apariencia:** modo del logo (**Automático / Dinámico / Estático**), se guarda en este navegador (`localStorage`, no en la base) y se aplica al instante, sin botón Guardar. Reservada para los temas futuros.
7. **Avanzado:** marcado visualmente como **"para casos puntuales"**; puerto (con advertencia: requiere reiniciar y actualizar la redirect URI en Kick y la URL en OBS), intervalo de polling de Kick, margen del watchdog, diagnóstico de Kick (latencia, 429, headers), **visor de logs** y simulador de eventos. El **visor de logs** (solo lectura) muestra las últimas N líneas del log del servidor (`logs/server.log`, por defecto 200, configurable), con **filtro por nivel** (info/aviso/error/debug) y **actualización manual** (botón "Actualizar") o **automática cada 3 s** (interruptor; solo corre mientras la pestaña está abierta). El servidor **redacta los secretos antes de enviar** (`***` para valores conocidos y patrones como `key=`/`token=`/`secret=`/`password=`; nunca salen tokens, claves del overlay ni cookies). Al lado hay **"Copiar para soporte"**: copia al portapapeles un resumen sin secretos (versión de la app y del overlay, versiones de yt-dlp/ffmpeg/ffprobe, sistema, puerto, estado de plataformas y del overlay, últimos errores ya redactados). La lectura del log es acotada: se lee solo el final del archivo (con límite de bytes), nunca entero en memoria.

## 8. Botón Descargas

**Descargas y Ajustes (engranaje) son íconos SVG inline** (`currentColor`, sin archivos externos), con `title` y `aria-label`. Van a la izquierda de Salir. El de Descargas lleva el **punto superpuesto en la esquina**: no hay punto si no hay nada en curso, verde si hay algo, rojo si hubo un error sin ver. Abre un **desplegable anclado al botón** (no modal, no oscurece el fondo; se cierra con clic afuera o Esc).

- Una fila por elemento: nombre (o link recortado) y estado: en cola, descargando, convirtiendo, listo, error. Incluye los archivos locales y los arrastrados.
- Acciones por fila: reintentar y quitar (en errores), "ver en la biblioteca" (en los listos), y "ya estaba en la biblioteca" si es un duplicado. Arriba, "Limpiar terminados".
- Se conservan los últimos 20 durante la sesión (viven en memoria; al reiniciar se pierden, el clip ya quedó en la biblioteca).
- Al agregar algo, un aviso breve ("Agregado a descargas") y se enciende el punto, sin abrir el panel solo.
- Máximo una o dos descargas simultáneas; el resto en cola.
- Cancelar una descarga en curso requiere detener el proceso y limpiar archivos parciales.
- Si el error es por yt-dlp desactualizado, la fila lleva el atajo a Ajustes → Biblioteca y descargas.
- El progreso es por etapas; solo se muestra porcentaje si las herramientas lo permiten (a verificar).

**Estado:** implementado en la Etapa 3B. El panel refleja `GET /api/jobs` (polling cada segundo); "Cancelar" llama a `POST /api/jobs/:id/cancel`, que descarta el resultado, limpia los temporales y libera el turno (el proceso externo en curso no se aborta a mitad; se documenta como pendiente).

## 9. Archivos locales, solo audio y caché

- **Archivos locales:** se copian a la carpeta de la app con un nombre generado por nosotros; el nombre original solo sirve como título por defecto (escapado y recortado). El archivo original nunca se modifica ni se borra, ni siquiera al borrar el clip.
- **Validación por contenido** (ffprobe), no por extensión; se rechaza lo que no sea audio o video. Límites configurables de tamaño y duración. Duplicados detectados por contenido.
- **Normalización:** los videos se convierten como hoy (mp4); los audios a un único formato (m4a). El servidor sigue sirviendo solo formatos de una lista corta de permitidos.
- **Solo audio** es una **opción de cada recompensa** (`rewards.audio_only`): el overlay reproduce el mismo archivo sin mostrar el video (o superpone el audio, en modo Superponer). No genera un archivo nuevo. La columna `clips.has_video` dice si el archivo tiene imagen; `clips.audio_only` quedó en desuso (no se lee).
- **Subida de archivos** desde el navegador: con sesión y validación de origen. Si requiere una dependencia nueva, se pide aprobación.
- **Limpieza de caché:** la automática solo toca lo que se puede volver a descargar (clips de link). Los archivos locales **nunca se borran solos**: se muestran y el creador decide. Nunca se borra un clip usado por una recompensa activa o desactivada, ni uno que esté en la cola.

**Estado (Etapa 3B):** la ingesta valida por contenido con ffprobe (audio o video), aplica los límites de Ajustes → Biblioteca y descargas, detecta duplicados por hash de contenido, copia con un nombre generado (`<sha256>` + `.mp4`/`.m4a`) y normaliza (video a mp4, audio a m4a). El archivo original nunca se toca. `POST /api/clips/cleanup` borra solo clips de link sin recompensas y fuera de la cola. Los jobs se limitan a 2 simultáneos (el resto en cola) y se pueden cancelar.

## 10. Estados vacíos y de error

- Biblioteca vacía: "Arrastrá un video o audio acá, o pegá un link".
- Sin recompensas: "Todavía no creaste ninguna", con el botón de crear (que avisa si no hay clips).
- Kick sin vincular: panel en gris con atajo a Ajustes.
- Cola e historial vacíos: texto corto.
- Overlay desconectado o Kick reconectando: el indicador cambia de color y sigue siendo clicable; las alertas quedan en espera, sin perderse.

## 11. Sistema visual

- Tema oscuro por defecto, verde como color de acción principal (el verde se reserva para la acción principal de cada pantalla).
- **Todos los colores, espaciados, radios y tipografías son variables CSS.** Ningún componente tiene colores escritos directamente. Así los temas futuros (**OLED**, **noche**, **día**) son solo juegos de valores. No se implementan ahora.
- Botones primario, secundario, peligro y fantasma; tarjetas; formularios; estados vacíos; mensajes de error y de éxito; ventana flotante; desplegable.
- El logo trae su propio fondo translúcido y **no se adapta al tema** (es el mismo en cualquier tema futuro). Se muestra con altura fija por la variable CSS `--logo-height` (52 px; 36 px en ventana angosta) y ancho automático.
- **Scroll fino y oscuro en todos los navegadores.** Se define con las propiedades estándar `scrollbar-width: thin` y `scrollbar-color` sobre `*`, con colores en variables (`--scrollbar-thumb`, `--scrollbar-thumb-hover`, `--scrollbar-track`). Como respaldo, dentro de `@supports not (scrollbar-color: auto)`, hay reglas `::-webkit-scrollbar` (8 px) que no deben quedar fuera del bloque: en Chromium reciente anulan las propiedades estándar. `:root` fija `color-scheme: dark` para que los controles nativos (scroll, selects, inputs numéricos, selector de color) usen su variante oscura. Las cajas con scroll vertical usan `scrollbar-gutter: stable` para que el contenido no salte.
  - `scrollbar-width` / `scrollbar-color` (estándar): soportadas por **Firefox 64+** y **Chromium 121+** (Chrome/Edge).
  - `::-webkit-scrollbar`: Safari (todas las versiones) y Chromium anteriores a 121 usan el respaldo.
  - `TODO(verificar)`: confirmar las versiones exactas de Safari con soporte de las propiedades estándar y el momento en que Chromium dejó de requerir el respaldo (la documentación viva de MDN es la referencia). 

## 12. Decisiones eliminadas

- **El espectador no envía links ni archivos.** Se quitan: la moderación de URLs, las propuestas, la acción `SubmitUserUrl`, los límites de propuestas y el comando `!alerta <URL>`.
- **"Reglas" como sección visible.** Las reglas internas se conservan en el motor, con vínculo 1:1 a cada recompensa, pero el creador no las ve. Las reglas por comando de chat, si algún día existen, serán un modo avanzado.
- **Texto libre del espectador** en los canjes: el campo no se usa. Si llega en un evento, sigue siendo input no confiable y no se pasa a ningún proceso.
- **Borrar y recrear recompensas** para activarlas y desactivarlas: se reemplaza por `is_enabled`.

## 13. Reglas técnicas para implementarlo

- HTML + Alpine.js local y CSS propio, sin paso de build. Sin dependencias nuevas sin preguntar.
- Lecciones ya aprendidas: scripts de componentes **antes** de Alpine; nombres de propiedades que no choquen con globales del navegador (`confirm`, `name`, `status`, `open`, `event`, etc.); `x-if` (no `x-show`) para estado que puede ser `null`; todo handler `@click` definido en el JS (hay un test estático que lo verifica).
- Modelo de datos:
  - **Recompensa:** id local propio; el id de Kick es un dato que se puede reemplazar; clip asociado; título, costo, color, descripción; estado deseado; opciones de reproducción.
  - **Clip:** origen (`link` o `local`); marca `audio_only`; si el archivo es de audio; recorte.
- Los títulos de Kick tienen un máximo de 50 caracteres y las descripciones de 200.
- El texto de las ventanas y los estados vive en un solo lugar para poder ajustarlo.

## 14. Pendientes de verificar

- Si `reject` devuelve los puntos al espectador (probar con una cuenta de puntos limitados; hoy se asume que sí).
- Qué hace Kick con los canjes pendientes de una recompensa deshabilitada.
- Qué pasa en Kick al cambiar el costo de una recompensa con canjes pendientes.
- Efecto de la opción de Kick para saltar la cola de solicitudes.
- Si se puede leer el porcentaje de avance de yt-dlp.
- Si el login con cookie funciona dentro de un dock de OBS.
- Latencia y límites de frecuencia (429) del polling de Kick.

## 15. Dónde queda cada función actual

| Hoy | Nuevo lugar |
|---|---|
| Cola de alertas | Panel derecho, pestaña Cola |
| Historial de eventos | Panel derecho, pestaña Historial |
| Agregar clip por URL | Panel central, campo de link |
| Biblioteca (renombrar, recortar, borrar, probar) | Tarjetas + ventana de detalle |
| Reglas | Internas; se crean al guardar una recompensa |
| Recompensas de Kick (crear, editar, borrar) | Panel izquierdo + ventana de crear/editar |
| Moderación y propuestas | **Eliminadas** |
| Vincular Kick, credenciales | Ajustes → Kick |
| URL del overlay y regenerar clave | Ajustes → Overlay y OBS |
| Volumen global, duración por defecto, políticas de canjes | Ajustes → Alertas |
| Límites, dominios, yt-dlp, caché | Ajustes → Biblioteca y descargas |
| Cambiar contraseña | Ajustes → Seguridad |
| Puerto, polling, watchdog, diagnóstico, logs, simulador | Ajustes → Avanzado |
| Progreso de descargas | Botón Descargas |
