# Roadmap: alertas y recompensas self-hosted para Kick

Aplicación que corre en la PC del streamer, con un dashboard en el navegador (`http://localhost:PUERTO`). Se pega la URL de un video, se descarga y convierte sola, y queda lista como alerta o recompensa de Kick, reproducida en OBS como Browser Source.

## Decisiones de base

- **Stack:** Node.js + TypeScript, Fastify (o Express), `ws` para WebSocket, SQLite con `better-sqlite3`.
- **Dashboard:** React + Vite, o HTML + Alpine.js si se quiere algo más simple.
- **Todo local:** el servidor escucha solo en `127.0.0.1` por defecto.
- **Descargar y cachear clips**, no usar `yt-dlp -g`: los links directos expiran, vienen con audio y video separados y fallan por CORS.
- **Binarios externos:** yt-dlp y ffmpeg, detectados o descargados al iniciar.

## Arquitectura

```
Kick (eventos) ──► Backend Node ──► SQLite (config, cola, historial)
                      │  ▲
          yt-dlp + ffmpeg │  └── Dashboard (navegador)
                      ▼
                carpeta /media
                      │
              Overlay (Browser Source en OBS) ◄── WebSocket
```

## Fase 0: Investigación sobre Kick (1-2 días)

Es el mayor riesgo del proyecto. Se resuelve antes de escribir código.

- [ ] Leer la documentación oficial (docs.kick.com): OAuth, scopes, eventos disponibles y cómo se entregan.
- [ ] Determinar si los eventos llegan por webhooks (requiere URL pública, por ejemplo Cloudflare Tunnel) o por otra vía.
- [ ] Evaluar el WebSocket de Pusher de la web de Kick como alternativa. No es oficial y puede romperse.
- [ ] Verificar qué eventos se pueden recibir: chat, follows, subs, gift subs, canjes de recompensas.
- [ ] Verificar si Casterlabs u otros proyectos realmente soportan Kick hoy, antes de apoyarse en ellos.

**Entregable:** script de ~50 líneas que imprima en consola los eventos de un canal real.
**Si esto falla, el resto del proyecto no tiene sentido.**

## Fase 1: Núcleo de media (3-4 días)

- [ ] Endpoint que recibe una URL y la valida.
- [ ] Ejecutar yt-dlp con `spawn` y argumentos separados, nunca concatenando strings.
- [ ] Límites configurables de duración y tamaño.
- [ ] Whitelist de dominios (YouTube, TikTok, Twitch clips, etc.).
- [ ] Recodificar con ffmpeg a mp4 (H.264/AAC) o webm, normalizando el audio.
- [ ] Guardar en `/media` con metadatos en SQLite.
- [ ] Tests de la validación de URL.

**Criterio de aceptación:** pegás una URL de YouTube o TikTok y obtenés un archivo reproducible en menos de 15 segundos.

## Fase 2: Overlay y cola de alertas (3 días)

- [ ] Página `/overlay` con `<video>` que escucha por WebSocket.
- [ ] Cola de reproducción: un clip a la vez, con prioridad, skip y pausa.
- [ ] Parámetros por alerta: volumen, duración máxima, posición, animación de entrada y salida.
- [ ] Reconexión automática del overlay si se corta el WebSocket.
- [ ] Tests de la cola.

**Criterio de aceptación:** agregás la URL como Browser Source en OBS y el clip se reproduce con audio.

## Fase 3: Dashboard (5 días)

- [ ] Login local con contraseña.
- [ ] Biblioteca de clips: preview, recorte (inicio/fin), renombrar, borrar.
- [ ] Pegar una URL y ver el progreso de descarga y conversión.
- [ ] Botón "probar alerta" y vista de la cola en vivo.
- [ ] Configuración general: límites, volumen global, puerto.

**Criterio de aceptación:** una persona no técnica agrega un clip y lo prueba en OBS sin tocar la terminal.

## Fase 4: Integración con Kick (4-5 días)

- [ ] Vincular la cuenta desde el dashboard con OAuth.
- [ ] Reglas "cuando pase X, reproducí el clip Y": comando de chat, sub, gift sub, follow o canje.
- [ ] Cooldown global y por usuario.
- [ ] Permisos: todos, subs, mods.
- [ ] Comando `!alerta <URL>` para que el chat proponga clips.
- [ ] Cola de moderación: aprobar o rechazar desde el dashboard antes de reproducir.
- [ ] Historial de eventos disparados.
- [ ] Tests de las reglas y los cooldowns.

**Criterio de aceptación:** un evento real en el canal dispara el clip correcto en OBS.

## Fase 5: Robustez (3 días)

- [ ] Reconexión automática a Kick.
- [ ] Manejo de errores de yt-dlp y ffmpeg, con logs visibles en el dashboard.
- [ ] Auto-actualización de yt-dlp (se rompe seguido cuando los sitios cambian).
- [ ] Limpieza automática de la caché por tamaño o antigüedad.
- [ ] Cobertura de tests sobre las partes críticas.

## Fase 6: Distribución (3 días)

- [ ] Ejecutable único (`pkg` o Node SEA) con un instalador que traiga yt-dlp y ffmpeg. Es la mejor opción para un usuario no técnico.
- [ ] Alternativa para usuarios técnicos: `docker-compose`.
- [ ] README con capturas, licencia (MIT o AGPL) y guía de configuración de OBS en `docs/`.

## Fase 7: Extras (opcional)

- [ ] Metas y barras de progreso.
- [ ] TTS.
- [ ] Widget de chat.
- [ ] Plantillas de overlay.
- [ ] Subida de archivos locales.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La API de Kick cambia o tiene limitaciones | Fase 0 primero; aislar la integración detrás de una interfaz |
| yt-dlp se rompe con cambios de los sitios | Auto-actualización y mensajes de error claros |
| Copyright de clips de terceros | Cola de moderación y nota en el README |
| Input del chat ejecutando binarios | Validación estricta, `spawn` con argumentos separados, whitelist |

## Flujo de trabajo con Zed Agent + DeepSeek

1. Una fase por vez, con tareas chicas y criterio de aceptación verificable.
2. Tests junto con el código en cola, validación y reglas.
3. Commit después de cada tarea que funcione.
4. Fase 0 y diseño de arquitectura con un modelo más fuerte en chat si es posible; DeepSeek en el agente para implementar.
