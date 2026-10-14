# Motor de eventos y reglas (Fase 4A)

Esta fase implementa el **motor** que convierte eventos normalizados en acciones.
La integración con Kick es la Fase 4B y vive detrás de un adaptador (`EventSource`),
en su propia carpeta `/src/platforms/<nombre>/`. Nada de lo que hay acá conoce
nombres ni tipos de una plataforma concreta.

> **Rediseño (VIUrewards).** El público ya **no envía links**: se eliminaron la
> moderación de URLs, la tabla de propuestas y la acción `SubmitUserUrl`. El texto
> libre de un canje o comando (`userInput`) sigue marcado como **input no
> confiable** y nunca se pasa a un proceso. Cada recompensa tiene una **regla
> interna 1:1** que se crea y se mantiene sola; la acción es siempre `PlayClip`.

## Eventos normalizados (`src/events`)

Un evento es `{ id, platform, type, user: { id, name, roles }, payload, timestamp }`.
Los tipos iniciales son `chat_command`, `reward_redeemed`, `sub`, `gift`, `follow`
y `manual`. Helpers como `payloadCommand` y `payloadRewardId` leen los campos
conocidos sin que el motor dependa de la forma exacta del payload.

### `EventSource`

Cada plataforma implementa esta interfaz:

- `id`, `platform` y `capabilities` (`{ types, resolve }`).
- `start()`, `stop()` y `onEvent(handler)`.
- `resolve?(eventId, outcome)` **opcional**: solo para plataformas donde un canje
  queda pendiente hasta marcarlo como cumplido (`accept`) o rechazado (`reject`).

Fuentes locales (no hablan con ninguna plataforma):

- `ManualEventSource`: emite un evento `manual` (botón del dashboard).
- `SimulatedEventSource`: emite cualquier tipo y registra las resoluciones, para
  probar el flujo completo sin conectar nada.

## Regla (`src/rules`)

Una regla es trigger + condiciones + acción:

- **Trigger**: tipo de evento y, según el tipo, `command` (comando de chat, con o
  sin `!`), `rewardId` (canje) o `minAmount` (subs/gifts/follows).
- **Condiciones**: `permission` (`everyone` | `subs` | `mods`). El **cooldown ya no
  vive en la regla**: es un atributo de la recompensa y lo aplica el despachador
  del servidor (ver más abajo).
- **Acción**: una implementación de la interfaz `RuleAction` (`kind` + `execute`).
  El motor **no depende** de ninguna acción concreta. La única acción es
  `PlayClip`: encola un clip fijo con sus parámetros (volumen, duración máxima,
  posición, animaciones y el recorte ya existente). Una acción puede devolver
  `{ fired: false, reason }` para omitir el evento con un motivo (p. ej. "sin
  overlay conectado").

### Idempotencia

El motor guarda los `event.id` recientes: un mismo evento procesado dos veces no
dispara dos veces. Es necesario porque los canjes llegan por polling y pueden
repetirse entre consultas (además, la fuente de Kick lleva su propia idempotencia
persistente).

### Aislamiento de errores

Si una regla falla, se registra el error (`outcome: "error"`) y el motor sigue con
las demás. El resultado de procesar un evento es uno de:
`fired` | `skipped` | `error` | `no_match` | `duplicate`, con un motivo cuando
corresponde (`cooldown`, `sin permiso`, etc.).

## Cooldown y superposición (rework, Parte B)

El cooldown pasó de la regla a la **recompensa** y se reescribió para que sea
predecible con canjes reales.

### Causa del comportamiento errático anterior

Con el diseño anterior, los canjes de un mismo ciclo de polling se procesaban en
**paralelo**: `RuleEngine.handle` hacía `cooldowns.check()` → `await` (que podía
resolver el canje por red) → `cooldowns.mark()`, así que dos canjes podían pasar
la comprobación antes de que el primero marcara. Además el cooldown vivía **solo
en memoria** y se perdía al reiniciar. (Se descartó como causa el uso del
`redeemed_at` de la plataforma: el motor siempre usó el reloj local.)

### Semántica

- Cada recompensa tiene un **modo de repetición**: `queue` (esperar turno) u
  `overlap` (superponer).
- Solo hay **cooldown global por recompensa**, en segundos (0 = sin cooldown). El
  cooldown por usuario se eliminó de todo el sistema.
- El cooldown cuenta desde el momento en que la alerta **se dispara**, con un
  único **reloj local inyectable**. No se usa el `redeemed_at` de la plataforma.
- `last_fired_at` se persiste en la fila de la recompensa (clave: id local) y
  sobrevive reinicios. Un `last_fired_at` en el futuro (cambio de hora) se
  considera vencido. Editar, activar, desactivar, recrear en la plataforma o
  cambiar el modo **no reinician** el cooldown; cambiar su duración se aplica desde
  el `last_fired_at` existente.
- La decisión es una **función pura** `decide(recompensa, ahora, lastFiredAt)` y la
  comprobación + el registro son **una sola operación atómica** (sin `await` en el
  medio), en `RewardDispatcher` (`src/server/reward-dispatch.ts`). Los canjes de un
  mismo ciclo se procesan **de a uno**, ordenados por `redeemed_at`.
- **Modo `queue`**: si dispara, se encola un `PlayClip` y el canje se acepta **al
  encolar**. Si no, el canje queda omitido según la política global de omitidos,
  con motivo `cooldown, faltan N s`.
- **Modo `overlap`**: **siempre es solo audio** (el interruptor "Solo audio" queda encendido y bloqueado). Nunca lo bloquea un
  cooldown, no entra en la cola y no lo afectan Saltar/Pausar/Reanudar/Vaciar. Al
  dispararse, el servidor manda un `playAudio` fire-and-forget a los overlays; el
  canje se acepta cuando el mensaje llegó a **al menos un overlay**. Si no hay
  ninguno, queda omitido con el motivo `sin overlay conectado`; si la recompensa
  no tiene clip, con `sin clip`. Al reconectar un overlay **no
  se reenvía** nada.

**"Solo audio" es una opción de la recompensa** (`rewards.audio_only`), no una
marca del clip. El modo `overlap` la fuerza; un clip sin imagen también la fuerza
(`clips.has_video = 0`). En modo `queue`, un clip sin imagen suena igual: el
overlay reproduce el medio sin mostrar la imagen. `clips.audio_only` quedó en
desuso (no se lee).

### Voces superpuestas en el overlay

El overlay mantiene un **pool de voces** independiente del reproductor de video.
Cada voz se libera al terminar, al llegar al recorte, a la duración máxima o por
error; si al llegar un audio ya hay el máximo de voces, se corta la más antigua.
El máximo simultáneo se configura en Ajustes → Alertas (`maxAudioVoices`, 1–20,
por defecto 8). En el overlay cada voz es un `<video>` oculto: el medio es un mp4
con audio y video, así que un `<video>` garantiza que el navegador decodifique el
audio del contenedor (un `<audio>` dependería del soporte de mp4).

### Historial

El historial muestra `Disparó`, `Disparó · superpuesto` y los omitidos con el
motivo exacto: `cooldown, faltan N s`, `sin overlay conectado`, `sin clip`.

## Persistencia

- `rules`: trigger/condiciones/acción como JSON.
- `event_history`: qué regla disparó, resultado y motivo; se limpia por cantidad
  (`events.historyMax`, por defecto 500) y por antigüedad.

## Decisiones de esta fase

- **`resolve` en memoria**: los callbacks para resolver un canje pendiente viven en
  memoria y se pierden al reiniciar. En la Fase 4B la idempotencia persistente y el
  coordinador cubren el caso real.
- **Historial por polling (2 s)** en el dashboard, igual que la cola (1 s).
- **`payloadJson`** se guarda crudo en el historial para depurar; la UI **no** lo
  muestra, así que un payload con texto hostil nunca se renderiza.

## Notas para la Fase 4B (adaptador de Kick)

Ver `docs/kick-research.md` (no modificar hasta tener los resultados reales):
rate limit y latencia de `GET /channels/rewards/redemptions`, si `reject` devuelve
los puntos, scopes/endpoints confirmados de recompensas y las decisiones abiertas
§11.1–11.3 (app compartida vs. propia, canjes pendientes con la app cerrada,
tokens expirados/revocados).