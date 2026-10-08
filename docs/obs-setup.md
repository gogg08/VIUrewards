# Usar el overlay en OBS (Fase 2)

El overlay es una página que el servidor local sirve en `http://127.0.0.1:PUERTO/overlay`
(por defecto el puerto es **8787**). En OBS se agrega como **Browser Source**.

## Pasos

1. Levantá el servidor. Para una prueba rápida:
   ```
   node scripts/play-test.ts <clipId|url>
   ```
   Anotá la línea `Servidor arriba. Agregá esta URL...` (por ejemplo
   `http://127.0.0.1:8787/overlay`).
2. En OBS, en la escena donde va la alerta: **Fuentes → + → Navegador** (Browser
   Source).
3. Configurá la fuente:
   - **URL:** `http://127.0.0.1:8787/overlay`
   - **Ancho / Alto:** `1920` x `1080`
   - **Usar tamaño personalizado de lienzo:** activado (así escala con la escena).
4. Aceptar. La página tiene **fondo transparente**: solo se ve el video del clip.

## Verificar que suena

- En la prueba, el script encola un clip y el overlay lo reproduce solo.
- Si no se escucha: revisá el **mezclador de audio** de OBS; la Browser Source
  aparece como una fuente de audio. Subí su volumen y asegurate de que no esté
  silenciada.
- OBS (Chromium) permite reproducir con audio automáticamente; no hace falta
  interactuar con la página.
- Si el clip no aparece, mirá la consola del servidor y que el `clipId` exista como
  `<clipId>.mp4` dentro de la carpeta `media/`.

## Qué respeta el overlay

- **Volumen** del ítem (0 a 1).
- **Duración máxima**: corta el video aunque no haya terminado.
- **Posición** (fracción del ancho/alto de la escena).
- **Animación** de entrada y salida (fade, slide-up, slide-down, zoom, none).
- **Reconexión automática**: si se corta el WebSocket, se vuelve a conectar solo.

## Notas

- El servidor escucha **solo en 127.0.0.1** (misma máquina que OBS).
- `TODO(verificar)`: probar con OBS real el comportamiento de la transparencia y
  del audio en las versiones recientes de OBS.
