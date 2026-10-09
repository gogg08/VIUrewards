# Motor de eventos y reglas (Fase 4A)

Esta fase implementa el **motor** que convierte eventos normalizados en acciones,
**sin ninguna integración real con plataformas**. La integración con Kick es la
Fase 4B y vive detrás de un adaptador (`EventSource`), en su propia carpeta
`/src/platforms/<nombre>/`. Nada de lo que hay acá conoce nombres ni tipos de una
plataforma concreta.

## Eventos normalizados (`src/events`)

Un evento es `{ id, platform, type, user: { id, name, roles }, payload, timestamp }`.
Los tipos iniciales son `chat_command`, `reward_redeemed`, `sub`, `gift`, `follow`
y `manual`. Helpers como `payloadCommand`, `payloadRewardId` y `payloadUserInput`
leen los campos conocidos sin que el motor dependa de la forma exacta del payload.

### `EventSource`

Cada plataforma implementa esta interfaz:

- `id`, `platform` y `capabilities` (`{ types, resolve }`).
- `start()`, `stop()` y `onEvent(handler)`.
- `resolve?(eventId, outcome)` **opcional**: solo para plataformas donde un canje
  queda pendiente hasta marcarlo como cumplido (`accept`) o rechazado (`reject`).

Fuentes locales de esta fase (no hablan con ninguna plataforma):

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
  El motor **no depende** de ninguna acción concreta. Las de esta fase son:
  - `PlayClip`: encola un clip fijo con sus parámetros (volumen, duración máxima,
    posición, animaciones y el recorte ya existente).
  - `SubmitUserUrl`: toma una URL del texto del usuario y la manda a la cola de
    moderación, **nunca directo a descargar**.

### Idempotencia

El motor guarda los `event.id` recientes: un mismo evento procesado dos veces no
dispara dos veces. Es necesario porque, más adelante, los canjes llegan por
polling y pueden repetirse entre consultas.

### Aislamiento de errores

Si una regla falla, se registra el error (`outcome: "error"`) y el motor sigue con
las demás. El resultado de procesar un evento es uno de:
`fired` | `skipped` | `error` | `no_match` | `duplicate`, con un motivo cuando
corresponde (`cooldown`, `sin permiso`, etc.).

## Moderación de URLs propuestas (`src/moderation`)

El público puede proponer una URL (por chat o canje). Esa URL es **input no
confiable**:

1. Se extrae el candidato a URL del texto (`extractUrlCandidate`).
2. Se valida con el validador ya existente (`validateUrl`: https, whitelist de
   dominios, longitud, sin credenciales) **antes** de entrar a la cola. Si es
   inválida, se rechaza y se registra el motivo.
3. Límites contra abuso: máximo de propuestas pendientes global y por usuario
   (configurables) y **deduplicación** de URLs iguales.

### Estados y transiciones

```
pending ──► approved ──► downloading ──► ready
   │                          │
   └──► rejected              └──► failed
```

Las transiciones están declaradas explícitamente (`PROPOSAL_TRANSITIONS`) y
`canTransition` las valida. Aprobar desde el dashboard dispara la descarga con el
job existente y, al terminar, encola el clip (`downloading → ready`); rechazar la
descarta. Si el evento de origen vino de una plataforma con `resolve`, aprobar o
rechazar llama a `resolve(accept | reject)` a través de la interfaz.

La aprobación puede ser **manual** (por defecto) o **automática** (opción por
regla); la automática **igual** pasa por validación y límites.

## Persistencia (migración 3)

- `rules`: trigger/condiciones/acción como JSON.
- `event_history`: qué regla disparó, resultado y motivo; se limpia por cantidad
  (`events.historyMax`, por defecto 500) y por antigüedad.
- `proposals`: estado y datos de cada propuesta.

## Decisiones de esta fase

- **`resolve` en memoria**: los callbacks para resolver un canje pendiente viven en
  memoria y se pierden al reiniciar. Aceptable mientras no haya una plataforma real
  (Fase 4A); en la 4B habrá que persistir el `eventId` y reintentar.
- **`approved` es transitorio**: la secuencia es `pending → approved →
  downloading`; `approved` se ve poco, pero queda explícito para que ninguna
  transición sea implícita.
- **Dedup y límites sobre `pending`**: solo cuentan las propuestas pendientes; una
  vez aprobadas o rechazadas dejan de ocupar cupo.
- **Historial por polling (2 s)** en el dashboard, igual que la cola (1 s).
- **`payloadJson`** se guarda crudo en el historial para depurar; la UI **no** lo
  muestra, así que un payload con texto hostil nunca se renderiza.

## Qué falta para la Fase 4B (adaptador de Kick)

Ver `docs/kick-research.md` (no modificar hasta tener los resultados reales):
rate limit y latencia de `GET /channels/rewards/redemptions`, si `reject` devuelve
los puntos, scopes/endpoints confirmados de recompensas y las decisiones abiertas
§11.1–11.3 (app compartida vs. propia, canjes pendientes con la app cerrada,
tokens expirados/revocados).