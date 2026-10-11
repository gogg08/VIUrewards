# AGENTS.md

Instrucciones para el agente de código. Leer completo antes de cada tarea.

## Qué es este proyecto

App self-hosted para streamers de Kick, llamada **VIUrewards**. Corre en la PC del streamer y expone un dashboard en el navegador. Permite pegar la URL de un video, descargarlo y convertirlo, y usarlo como alerta reproducida en OBS (Browser Source). Ver `ROADMAP.md` para las fases y `UI-DESIGN.md` para el diseño de la interfaz.

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
11. **El público no envía links ni archivos.** El texto libre de un canje o comando (`user_input`) es input NO confiable, nunca se usa para lanzar descargas y nunca se pasa a un proceso (yt-dlp/ffmpeg) sin validar.

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

Fase en curso: **Rediseño de la interfaz (VIUrewards)**, según `UI-DESIGN.md` (fuente de verdad). **Etapa 1 (limpieza y base) completada**: se eliminó el flujo de "el espectador envía links" (moderación de URLs, tabla y flujo de propuestas, acción `SubmitUserUrl`, y las secciones Reglas y Moderación del dashboard). El motor de reglas y `PlayClip` se conservan: cada recompensa tiene una **regla interna 1:1** que se crea y se mantiene sola. El nombre visible pasa a **VIUrewards**. **Etapa 2 (estructura y sistema de diseño) completada**: layout de tres columnas con scroll independiente y sin scroll de página, encabezado con indicadores de Overlay y Kick (clicables) y botón Descargas, panel derecho con Cola/Historial, y **Ajustes como ventana flotante con pestañas** (Kick, Overlay y OBS, Alertas, Biblioteca y descargas, Seguridad, Apariencia vacía, Avanzado), con Esc/X/clic afuera y aviso de cambios sin guardar. Sistema de diseño en **variables CSS** (botones primario/secundario/peligro/fantasma, tarjetas, formularios, estados vacíos, mensajes de error/éxito, ventana flotante y desplegable anclado); en esta etapa el contenido se movió de lugar, sin rediseñar cada pestaña. **Etapa 2B (presentación) completada**: cada columna es una **caja** con scroll vertical interno y **sin scroll horizontal** (las tablas se reemplazaron por tarjetas en Recompensas y por filas de dos líneas en el Historial), la barra **Cola | Historial** vive dentro de la caja derecha, los cuatro controles de la cola van en una sola fila, el encabezado usa **íconos SVG** para Descargas y Ajustes (el punto solo aparece con actividad o error), el aviso de cambios sin guardar de Ajustes es **por pestaña**, y en ventana angosta (<1024 px) se muestra **una columna por vez** con una barra de pestañas fija. Las **Fases 1, 2, 3, 4A y 4B** están implementadas; la 4B (adaptador de Kick, solo canjes de recompensas por REST + polling) sigue **pendiente de probar contra un canal de Kick real** (`docs/kick-setup.md`). La **Fase 0** (investigación de Kick) queda abierta: falta completar §11.4 de `docs/kick-research.md` con las mediciones del panel de diagnóstico, y `scripts/kick-rewards.ts` **no se debe tocar**. Próximas etapas del rediseño: 3) clips y descargas, 4) recompensas, 5) Ajustes completos. Actualizar esta línea al avanzar.