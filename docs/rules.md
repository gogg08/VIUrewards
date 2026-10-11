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
- **Condiciones**: `permission` (`everyone` | `subs` | `mods`), `cooldownSec`
  (global) y `userCooldownSec` (por usuario). Los cooldowns usan un **reloj
  inyectable**, así que se testean sin esperar.
- **Acción**: una implementación de la interfaz `RuleAction` (`kind` + `execute`).
  El motor **no depende** de ninguna acción concreta. La única acción es
  `PlayClip`: encola un clip fijo con sus parámetros (volumen, duración máxima,
  posición, animaciones y el recorte ya existente).

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