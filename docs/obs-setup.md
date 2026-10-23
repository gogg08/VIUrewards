# Usar el overlay en OBS (Fase 2 + Fase 3)

El overlay es una página que el servidor local sirve y que se agrega en OBS como
**Browser Source**. Desde la Fase 3 la URL incluye un **token secreto** (`?key=…`)
para que el Browser Source de OBS, que no comparte la cookie del dashboard, pueda
autenticarse.

## Pasos

1. Levantá el servidor completo:
   ```
   npm start
   ```
   La consola muestra, entre otras cosas, la URL del overlay (con su `?key=`).
2. En OBS, en la escena donde va la alerta: **Fuentes → + → Navegador** (Browser
   Source).
3. Configurá la fuente:
   - **URL:** la que muestra el dashboard en **"Copiar URL del overlay"**, por
     ejemplo `http://127.0.0.1:8787/overlay?key=xxxxxxxx`.
   - **Ancho / Alto:** el **área de la alerta**. El video del clip llena la fuente
     respetando su relación de aspecto (`object-fit: contain`); las barras que
     sobran son **transparentes**, no negras.
     - `1920` x `1080`: la alerta ocupa toda la pantalla (útil si el clip ya viene
       con el tamaño final, por ejemplo un video a pantalla completa).
     - Para una alerta más chica: poné el **ancho y alto de la fuente**
       (Propiedades) del tamaño deseado y ubicala en OBS. El tamaño y la posición
       de la alerta se manejan **en OBS**, no desde el dashboard.
   - **Usar tamaño personalizado de lienzo:** activado (así escala con la escena).
4. Aceptar. La página tiene **fondo transparente**: solo se ve el video del clip.

> El video se escala para llenar la fuente. Subir de escala un video de baja
> resolución lo muestra **más borroso**: si el clip es de 480p y la fuente mide
> 1920x1080, se verá estirado.

> Antes de la Fase 3 la URL era `http://127.0.0.1:8787/overlay` sin token. Si ya
> tenías la fuente configurada, actualizá la URL con el `?key=` que da el panel.

## De dónde saco la URL

- **Dashboard → sección "Overlay para OBS"**: muestra la URL completa y un botón
  **Copiar URL**. También tiene **Regenerar clave**: si la regenerás, tenés que
  actualizar la URL en OBS con la nueva.
- La clave es un secreto: no la compartas ni la subas a git.

## Verificar que suena

- En el dashboard, botón **Probar alerta** de un clip: el overlay lo reproduce.
- Si no se escucha: revisá el **mezclador de audio** de OBS; la Browser Source
  aparece como una fuente de audio. Subí su volumen y asegurate de que no esté
  silenciada.
- OBS (Chromium) permite reproducir con audio automáticamente; no hace falta
  interactuar con la página.
- Si el clip no aparece: mirá la consola del servidor y que el archivo exista
  dentro de la carpeta `media/`.

## Qué respeta el overlay

- **Volumen** del ítem (0 a 1), ya multiplicado por el volumen global del panel.
- **Recorte** del clip: hace *seek* al inicio y corta al final (no modifica el mp4).
- **Duración máxima**: corta el video aunque no haya terminado. El tiempo efectivo
  es el **menor** entre el recorte y la duración máxima.
- **Animación** de entrada y salida (fade, slide-up, slide-down, zoom, none).
- **Reconexión automática**: si se corta el WebSocket, se vuelve a conectar solo.

## Actualizaciones sin tocar OBS

El overlay se sirve **sin caché** (`Cache-Control: no-store`) y con un número de
**versión** embebido en la página. El servidor manda esa misma versión en el
primer mensaje del WebSocket; si la página quedó vieja (por ejemplo OBS guardó una
copia en caché), el overlay **se recarga solo**. Con la fuente ya configurada, no
hace falta volver a cargar la página ni recrear la fuente:

- Al **reiniciar la app** la versión cambia (incluye la fecha de inicio), así que
  el overlay se pone al día en unos segundos.
- El overlay nunca entra en un bucle: se recarga como máximo una vez cada 10
  segundos y, si sigue distinto después de recargar, lo registra en la consola y
  deja de intentarlo (ahí sí conviene recargar la fuente a mano).
- El dashboard (`/web`) se sirve con `no-cache`: se revalida en cada carga, así una
  actualización de la app no exige `Ctrl+F5`.

> La **posición X/Y** de la recompensa ya no la aplica el overlay: el lugar de la
> alerta se controla moviendo la fuente en OBS. El dato se conserva en la base y
> en la API, reservado para más adelante.

## Notas

- El servidor escucha **solo en 127.0.0.1** (misma máquina que OBS).
- Si cambiás el puerto desde la Configuración del panel, hay que reiniciar la app
  y actualizar la URL del overlay en OBS.
- `TODO(verificar)`: probar con OBS real el comportamiento de la transparencia y
  del audio en las versiones recientes de OBS. Y confirmar que OBS (Chromium)
  envía la query `?key=` al conectar el WebSocket del overlay.
- `scripts/play-test.ts` sigue existiendo como herramienta de desarrollo, pero ya
  no es la forma normal de levantar el overlay: para eso está `npm start`. Ese
  script levanta el servidor sin dashboard ni base de datos.
  **Toma el mismo cerrojo compartido que `npm start`**
  (`acquireSharedResourcesLock`) sobre la raíz que contiene `media/`,
  `.uploads/` y `logs/`: escribe en esos recursos, así que no puede correr a la
  vez que la app. Si la app está abierta, se niega con un mensaje en español y
  sale sin tocar nada.
  El cerrojo se toma sobre la raíz de los recursos, no sobre una carpeta
  elegida aparte: las rutas efectivas se resuelven y validan **antes** de tomar
  el cerrojo, y `--shared-root` solo sirve para confirmar que esa raíz es la
  esperada (si no coincide, la herramienta rechaza la combinación en vez de
  escribir en un sitio protegido por otro cerrojo).