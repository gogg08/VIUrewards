# AGENTS.md

Instrucciones para el agente de código. Leer completo antes de cada tarea.

## Qué es este proyecto

App self-hosted para streamers de Kick. Corre en la PC del streamer y expone un dashboard en el navegador. Permite pegar la URL de un video, descargarlo y convertirlo, y usarlo como alerta o recompensa reproducida en OBS (Browser Source). Ver `ROADMAP.md` para las fases.

## Stack

- Node.js 20+ y TypeScript en modo estricto.
- Fastify para HTTP, `ws` para WebSocket.
- SQLite con `better-sqlite3`.
- Dashboard: React + Vite (o la opción que decida el roadmap).
- Tests con Vitest.
- Binarios externos: `yt-dlp` y `ffmpeg`.

## Estructura

```
/src
  /server        # Fastify, rutas, WebSocket
  /media         # descarga, conversión, validación de URL
  /queue         # cola de alertas
  /rules         # reglas evento -> clip, cooldowns, permisos
  /kick          # integración con Kick (detrás de una interfaz)
  /db            # esquema y acceso a SQLite
/web             # dashboard
/overlay         # página del Browser Source
/media           # clips descargados (ignorado en git)
/docs
```

## Reglas críticas (no negociables)

1. **Nunca usar `exec` ni `execSync` con strings.** Siempre `spawn` o `execFile` con argumentos en array. Aplica a yt-dlp, ffmpeg y cualquier proceso.
2. **Toda URL se valida antes de usarse:** protocolo http/https, dominio en whitelist, longitud máxima. Nunca pasar input del usuario a un proceso sin validar.
3. **No usar `yt-dlp -g`.** Los clips se descargan, se recodifican con ffmpeg y se sirven desde `/media`.
4. **Límites siempre aplicados:** duración máxima, tamaño máximo y timeout de procesos, todos configurables.
5. **El servidor escucha solo en `127.0.0.1`** salvo que el usuario lo cambie explícitamente.
6. **Nunca escribir tokens o secretos en logs ni en git.** Van en SQLite o en `.env` ignorado.
7. **La integración con Kick vive detrás de una interfaz** (`KickEventSource`), para poder cambiar entre API oficial y otras vías sin tocar el resto.
8. **No inventar endpoints ni campos de la API de Kick.** Si no está documentado o no se verificó, preguntar o marcar con `TODO(verificar)`.
9. **Rutas de archivos:** nunca construir paths con input del usuario sin normalizar y verificar que queden dentro de `/media`.

## Convenciones de código

- TypeScript estricto, sin `any` salvo justificación en un comentario.
- Funciones chicas y puras donde se pueda; efectos secundarios en los bordes.
- Nombres en inglés en el código; mensajes de interfaz en español.
- Errores explícitos con tipos o códigos, sin tragar excepciones.
- Dependencias nuevas: justificarlas y preferir las más estándar. Preguntar antes de agregar una.

## Cómo trabajar

- Hacer **una tarea por vez** y limitarla a lo pedido. No refactorizar ni agregar funcionalidad no solicitada.
- Para lógica crítica (validación de URL, cola, reglas, cooldowns) escribir tests junto con el código.
- Antes de dar una tarea por terminada: correr `npm run typecheck` y `npm test`, y reportar el resultado real.
- Si un requisito es ambiguo, preguntar en vez de suponer.
- Al terminar, resumir qué cambió, qué archivos se tocaron y qué quedó pendiente.
- Sugerir un mensaje de commit por tarea.

## Comandos

```
npm run dev        # servidor en modo desarrollo
npm run build      # compilar
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## Estado actual

Fase en curso: **Fase 0** (investigación de Kick). Actualizar esta línea al avanzar.
