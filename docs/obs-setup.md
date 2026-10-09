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
   - **Ancho / Alto:** `1920` x `1080`
   - **Usar tamaño personalizado de lienzo:** activado (así escala con la escena).
4. Aceptar. La página tiene **fondo transparente**: solo se ve el video del clip.

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
- **Posición** (fracción del ancho/alto de la escena).
- **Animación** de entrada y salida (fade, slide-up, slide-down, zoom, none).
- **Reconexión automática**: si se corta el WebSocket, se vuelve a conectar solo.

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