# VIUrewards: diseño de la interfaz

Este documento es la fuente de verdad de la UX del dashboard. Resume las decisiones tomadas con el creador del proyecto y reemplaza a cualquier diseño anterior. Si el código y este documento difieren, se pregunta antes de decidir.

El proyecto pasa a llamarse **VIUrewards** (antes `czero-rewards`). El logo es un archivo `.webp` animado con fondo transparente que lo provee el creador más adelante; hasta entonces se usa el texto "VIUrewards" como marcador.

## 1. Principios

- **Una sola pantalla de uso**, pensada para tenerla abierta durante el stream: recompensas, clips y cola a la vista, sin cambiar de sección.
- **Lo técnico no se ve por defecto.** Todo lo que no es de uso diario vive en una ventana flotante de Ajustes.
- **El creador agrega los clips. El público no envía links ni archivos.** No hay moderación, propuestas ni cola de aprobación (ver sección 12).
- **El creador no ve la palabra "regla".** Una recompensa reproduce un clip; la regla interna se crea por detrás.
- **Los estados nunca mienten.** Si algo falta, falló o está desconectado, la interfaz lo dice.
- **Todo el texto en español.** Todo dato externo (nombres de clips, títulos, nombres de usuario) se escapa antes de mostrarse.

## 2. Pantalla principal

Tres columnas con **scroll independiente por columna**. La página no scrollea: el encabezado y las columnas ocupan la altura de la ventana.

```
┌────────────────────────────────────────────────────────────────────┐
│ [VIUrewards logo] [Overlay] [Kick]            [Descargas] [⚙] [Salir] │
├───────────────┬───────────────────────────────────┬────────────────┤
│ Recompensas   │ Agregar clip: [ link ] [+] [Desc.] │ Cola | Historial│
│ (lista +      │ ─────────────────────────────────  │ [Saltar][Pausar]│
│  nueva)       │ Biblioteca (scroll)                │ [Reanudar][Vaciar]│
│               │  tarjetas de clips                 │ en reproducción │
│               │                                    │ en espera       │
└───────────────┴───────────────────────────────────┴────────────────┘
```

Ventana angosta (por ejemplo un dock de OBS): las columnas se apilan o se muestran una por vez con pestañas. Foco visible y navegación por teclado en todo.

## 3. Encabezado

- **Izquierda:** logo VIUrewards, y a su derecha los indicadores de estado:
  - **Overlay:** conectado / sin conexión.
  - **Kick:** no vinculado / conectado / requiere volver a vincular / reconectando.
  - Cada indicador es clicable y abre Ajustes en su pestaña (Overlay y OBS, o Kick). Un indicador en problema cambia de color.
- **Derecha:** botón Descargas, engranaje (Ajustes) y Salir.

## 4. Panel izquierdo: Recompensas

Lista de recompensas con un botón "Nueva recompensa".

**Tarjeta colapsada:** nombre de la alerta, costo, nombre del clip, color y un **toggle** de activa/desactiva. Sin miniatura.

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

## 5. Panel central

### Agregar un clip
- Campo de link (YouTube, TikTok, etc., según los dominios permitidos) con botón **Descargar**.
- A la derecha del campo, un botón **+** para agregar un archivo local.
- **Arrastrar y soltar** un video o audio sobre cualquier parte de la página lo agrega a la biblioteca (varios a la vez, un progreso por archivo). Mientras se arrastra, aparece el aviso "Soltá para agregar a la biblioteca". Se ignora si Ajustes está abierto, y se evita que el navegador abra el archivo si se suelta fuera de la zona.
- Los errores inmediatos (URL inválida, dominio no permitido, archivo de tipo no soportado) aparecen debajo del campo y no crean una tarea.

### Biblioteca
- Grilla de tarjetas **simples**: miniatura, nombre, duración, ícono de parlante si está en modo solo audio (ícono propio si el archivo es de audio), y botón de probar.
- Filtro Todos / Video / Audio.
- Clic en una tarjeta abre la ventana de detalle (sección 7.2).

## 6. Panel derecho: Cola e Historial

Un solo panel con un botón que alterna entre **Cola de alertas** e **Historial de eventos**.

- **Cola:** botones Saltar, Pausar, Reanudar y Vaciar. Muestra el clip en reproducción y los que esperan. Saltar es la forma de destrabar el clip en curso; Vaciar solo limpia la espera.
- **Historial:** eventos recientes con hora, recompensa (el título se guarda como texto en el evento, para leerse aunque la recompensa ya no exista), usuario y resultado, con el motivo si no disparó (por ejemplo cooldown).

## 7. Ventanas flotantes

Todas se muestran sobre el panel principal, que se oscurece con negro de opacidad baja. Se cierran con Esc, con la X o con clic afuera; si hay cambios sin guardar, avisan.

### 7.1 Crear y editar recompensa

**Siempre visible:**
1. **Clip:** menú desplegable con **nombre y duración** (sin miniatura).
2. **Nombre de la alerta:** por defecto el nombre del clip, limpiado (sin emojis ni hashtags) y recortado a 50 caracteres (límite de Kick), con contador. El creador puede cambiarlo.
3. **Costo en puntos.**
4. **Color:** selector de color.
5. **Descripción:** opcional, hasta 200 caracteres.
6. **Activar al guardar:** toggle.

**Opciones avanzadas (colapsadas, con valores por defecto razonables):** volumen de la alerta, duración máxima en pantalla, cooldown global y por usuario, posición y animación de entrada y salida. Si el clip es solo audio, posición y animación no se muestran.

**Botones:** Probar alerta (reproduce con la configuración actual, sin guardar), Cancelar y Guardar.

**Notas:**
- El campo "requiere texto del usuario" de Kick queda siempre apagado y oculto.
- La opción de Kick para saltar la cola de solicitudes no se muestra (pendiente de verificar).
- Al editar, nombre, costo, color y descripción se envían a Kick; el clip y las opciones de reproducción son solo de la app.
- Si el clip no existe todavía en la biblioteca, el botón de crear avisa que primero hace falta un clip.

### 7.2 Detalle del clip

- **Reproductor grande** con el video (o reproductor de audio si es un archivo de audio). Con "solo audio" activo el video sigue visible acá para elegir el recorte; solo el overlay deja de mostrarlo.
- **Recorte no destructivo:** inicio y fin, con botones "tomar del reproductor" y "restablecer", y la duración resultante.
- **Solo audio:** toggle con el aviso "Afecta a todas las recompensas que usan este clip". La marca vive en el clip, no en la recompensa. Oculto si el archivo ya es audio.
- **Nombre:** editable.
- **Origen:** link de origen o "archivo local", más tamaño y duración.
- **Probar alerta:** con la configuración actual (recorte y solo audio incluidos).
- **Guardar / Cancelar:** los cambios se aplican con Guardar, no al instante. Cambiar recorte o solo audio de un clip en reproducción o en cola aplica a las próximas reproducciones; lo que está sonando no se interrumpe.
- **Borrar** (al final, separado, en rojo):
  - Si alguna recompensa lo usa (**incluidas las desactivadas**), el borrado se **bloquea** y se listan las recompensas, con la opción de borrarlas con una advertencia extra. Las recompensas "de otra app" aparecen en la lista pero sin opción de borrado.
  - Si es un archivo local, avisa que no se puede recuperar.

### 7.3 Ajustes

Ventana con pestañas a la izquierda y **botón Guardar por pestaña** (a probar; puede cambiarse). Las acciones inmediatas (vincular, actualizar yt-dlp, limpiar caché) tienen su propio botón y su resultado a la vista. Valores numéricos validados con mensajes claros.

1. **Kick:** estado; Client ID (visible) y Client Secret (solo escritura, nunca se devuelve); vincular, desvincular y borrar credenciales; **redirect URI calculada desde el puerto actual con botón de copiar**; errores de vínculo explicados en español (por ejemplo, "invalid authorization request" casi siempre es una redirect URI que no coincide exactamente: `http://localhost:<puerto>/callback`, sin barra final, `http` y no `https`, `localhost` y no `127.0.0.1`); "Probar conexión".
2. **Overlay y OBS:** URL con la clave enmascarada, Mostrar y Copiar, aviso de no mostrarla en stream; estado de conexión; regenerar clave (con confirmación y aviso de actualizar OBS); medidas recomendadas (1920×1080); alerta de prueba.
3. **Alertas:** volumen global, duración máxima por defecto; qué hacer con un canje omitido (dejar pendiente por defecto, o rechazar, con la advertencia de que el reembolso no está verificado); canjes pendientes antiguos al iniciar (ignorar, rechazar o procesar), con lista y "Rechazar todos" / "Procesar ahora".
4. **Biblioteca y descargas:** límites de duración y tamaño (descargas y archivos locales); dominios permitidos (rechaza IPs, `localhost`, nombres sin punto y caracteres inválidos); yt-dlp (versión y botón "Actualizar", solo por acción explícita); espacio ocupado y limpieza de caché (ver sección 9).
5. **Seguridad:** cambiar contraseña (pide la actual y cierra las demás sesiones).
6. **Apariencia:** vacía por ahora, reservada para los temas.
7. **Avanzado:** puerto (con advertencia: requiere reiniciar y actualizar la redirect URI en Kick y la URL en OBS), intervalo de polling de Kick, margen del watchdog, diagnóstico de Kick (latencia, 429, headers), visor de logs (sin secretos) y simulador de eventos.

## 8. Botón Descargas

A la izquierda del engranaje, con un **punto verde** mientras hay algo en curso y **rojo** si hubo un error sin ver. Abre un **desplegable anclado al botón** (no modal, no oscurece el fondo; se cierra con clic afuera o Esc).

- Una fila por elemento: nombre (o link recortado) y estado: en cola, descargando, convirtiendo, listo, error. Incluye los archivos locales y los arrastrados.
- Acciones por fila: reintentar y quitar (en errores), "ver en la biblioteca" (en los listos), y "ya estaba en la biblioteca" si es un duplicado. Arriba, "Limpiar terminados".
- Se conservan los últimos 20 durante la sesión (viven en memoria; al reiniciar se pierden, el clip ya quedó en la biblioteca).
- Al agregar algo, un aviso breve ("Agregado a descargas") y se enciende el punto, sin abrir el panel solo.
- Máximo una o dos descargas simultáneas; el resto en cola.
- Cancelar una descarga en curso requiere detener el proceso y limpiar archivos parciales.
- Si el error es por yt-dlp desactualizado, la fila lleva el atajo a Ajustes → Biblioteca y descargas.
- El progreso es por etapas; solo se muestra porcentaje si las herramientas lo permiten (a verificar).

## 9. Archivos locales, solo audio y caché

- **Archivos locales:** se copian a la carpeta de la app con un nombre generado por nosotros; el nombre original solo sirve como título por defecto (escapado y recortado). El archivo original nunca se modifica ni se borra, ni siquiera al borrar el clip.
- **Validación por contenido** (ffprobe), no por extensión; se rechaza lo que no sea audio o video. Límites configurables de tamaño y duración. Duplicados detectados por contenido.
- **Normalización:** los videos se convierten como hoy (mp4); los audios a un único formato (m4a). El servidor sigue sirviendo solo formatos de una lista corta de permitidos.
- **Solo audio** es una marca del clip (`audio_only`): el overlay reproduce el mismo archivo sin mostrar el video. No genera un archivo nuevo.
- **Subida de archivos** desde el navegador: con sesión y validación de origen. Si requiere una dependencia nueva, se pide aprobación.
- **Limpieza de caché:** la automática solo toca lo que se puede volver a descargar (clips de link). Los archivos locales **nunca se borran solos**: se muestran y el creador decide. Nunca se borra un clip usado por una recompensa activa o desactivada, ni uno que esté en la cola.

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
- El logo debe verse bien sobre fondo claro y oscuro (o tener una versión para cada uno).

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
