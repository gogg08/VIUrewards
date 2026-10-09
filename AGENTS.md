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
10. **El producto es una app local para usuarios no técnicos:** nada de requerir infraestructura pública, cuentas de desarrollador por usuario o configuración manual de red para el usuario final, salvo en modos avanzados opcionales.

## Arquitectura de triggers (multi-plataforma)

- Las plataformas se integran mediante adaptadores que implementan una interfaz `EventSource` y emiten eventos normalizados: `{ id, platform, type, user, payload, timestamp }`. Tipos iniciales: `chat_command`, `reward_redeemed`, `sub`, `gift`, `follow`, `manual`.
- Ningún código fuera de `/src/platforms/<nombre>/` puede importar tipos o nombres específicos de una plataforma.
- El motor de reglas trabaja solo con eventos normalizados: trigger + condiciones (permisos, cooldown) -> acción.
- Las acciones son una interfaz (`Action`). La primera es `PlayClip`. No acoplar el motor a esa acción.
- Cada adaptador declara sus "capabilities"; el dashboard oculta los triggers que la plataforma no soporta.
- El `user_input` de un canje o comando es input NO confiable: siempre se valida antes de usarse.

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

Fase en curso: **Fase 3 completa** (dashboard local: base SQLite con migraciones, autenticación local, alta de clips con descarga en segundo plano, biblioteca con **recorte no destructivo**, vista de la **cola en vivo**, **configuración general** —volumen global, límites de descarga, whitelist de dominios, puerto, cambio de contraseña— y URL del overlay con token enmascarado). Las **Fases 1 y 2** (núcleo de media; servidor local, cola y overlay) están implementadas. La **Fase 0** (investigación de Kick) queda abierta, pendiente de los resultados de prueba del prototipo de recompensas (`scripts/kick-rewards.ts`). No empezar la **Fase 4** (integración con Kick) hasta que lleguen esos resultados. Actualizar esta línea al avanzar.
