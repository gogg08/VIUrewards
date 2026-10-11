# Investigación: integración con Kick (Fase 0)

Objetivo de la fase: demostrar que se pueden recibir eventos reales de un canal
de Kick (chat, follows, subs, gift subs y canjes de recompensas) e imprimirlos
en consola, y decidir la vía técnica antes de escribir código del resto.

## Metodología y leyenda

- Fecha de la investigación: 2026-10-07.
- Fuentes primarias: documentación oficial en `https://docs.kick.com`
  (índice en `https://docs.kick.com/llms.txt`; cualquier página tiene versión
  markdown limpia agregando `.md`, p. ej. `.../getting-started/scopes.md`).
- Fuentes secundarias (para la vía no oficial): código de proyectos de
  comunidad en GitHub, citados en cada caso.
- Cada dato va etiquetado:
  - **[verificado]** — comprobado en la fuente citada.
  - **[suposición]** — inferencia razonable, sin confirmar.
  - **[TODO(verificar)]** — no comprobado; requiere fuente primaria o prueba
    empírica antes de apoyarse en ello.

> Regla del proyecto (AGENTS.md #8): no inventar endpoints, scopes, nombres de
> eventos ni formatos de payload. Todo lo no verificado va como
> `TODO(verificar)`.

---

## 1. Autenticación de la API oficial

**[verificado]** fuente: `docs.kick.com/getting-started/generating-tokens-oauth2-flow`.

- OAuth2 con dos servidores distintos:
  - Servidor de identidad/OAuth: `https://id.kick.com`.
  - Servidor de API: `https://api.kick.com`.
- Hay dos tipos de token:

### 1.1 App Access Token (client credentials)

- `POST https://id.kick.com/oauth/token`
- `Content-Type: application/x-www-form-urlencoded`
- Body: `grant_type=client_credentials&client_id=...&client_secret=...`
- Accede a datos públicos y **puede suscribirse a los eventos de cualquier
  canal** si se pasa `broadcaster_user_id` en la suscripción.
- Es la vía natural para un backend self-hosted que no quiere pedir login de
  usuario: alcanza con las credenciales de la app.

### 1.2 User Access Token (authorization code + PKCE)

- `GET https://id.kick.com/oauth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=...&code_challenge=...&code_challenge_method=S256&state=...`
- `POST https://id.kick.com/oauth/token` con
  `grant_type=authorization_code&client_id=...&client_secret=...&redirect_uri=...&code_verifier=...&code=...`
- Devuelve `access_token`, `token_type`, `refresh_token`, `expires_in`,
  `scope`.
- Necesario para acciones en nombre del usuario (p. ej. escribir en chat,
  moderar, gestionar recompensas).

### 1.3 Gestión de tokens

- **[verificado]** Refresh: `POST /oauth/token` con
  `grant_type=refresh_token` (reutilizable desde 2025-11-25).
- **[verificado]** Revoke: `POST /oauth/revoke?token=...&token_hint_type=access_token|refresh_token`.
- **[verificado]** Introspect: `POST /oauth/token/introspect` con
  `Authorization: Bearer`.
- **[verificado]** Si el `redirect_uri` es `127.0.0.1` hay un bug conocido de
  Next.js; la doc recomienda usar `localhost` y menciona un workaround con un
  parámetro "sacrificio" `redirect=127.0.0.1` antes de `redirect_uri`.

### 1.4 Scopes

**[verificado]** fuente: `docs.kick.com/getting-started/scopes`. Lista completa:

`user:read`, `channel:read`, `channel:write`, `channel:rewards:read`,
`channel:rewards:write`, `chat:write`, `streamkey:read`, `events:subscribe`,
`moderation:ban`, `moderation:chat_message:manage`, `kicks:read`, `ads:read`,
`ads:write`.

- El scope relevante para recibir eventos es **`events:subscribe`**.
- `channel:rewards:read` / `channel:rewards:write` para recompensas.
- `chat:write` para enviar mensajes (no necesario solo para leer eventos).

### 1.5 Alta de la app

**[verificado]** fuente: `docs.kick.com/getting-started/kick-apps-setup`.

- Requiere cuenta de Kick con **2FA activado**.
- Se crea la app en `https://kick.com/settings/developer`.
- Genera `ClientID`, `ClientSecret` y pide un `redirectURL`.

---

## 2. Entrega de eventos (vía oficial)

**[verificado]** fuentes: `docs.kick.com/events/introduction` y
`docs.kick.com/events/subscribe-to-events`.

- **Solo webhooks. No hay WebSocket oficial de eventos.**
- Se habilita en Account Settings → Developer (toggle "Enable Webhooks" +
  "Webhook URL").
- **La URL del webhook debe ser pública.** `localhost` no sirve salvo que se
  use un túnel.
- Suscripción por API:
  - `POST https://api.kick.com/public/v1/events/subscriptions`
    - Body: `method: "webhook"`, `events: [{ name, version }]`,
      `broadcaster_user_id` (requerido con App Token; con User Token se infiere
      del usuario autenticado).
  - `GET` en la misma ruta para listar suscripciones.
  - `DELETE /public/v1/events/subscriptions?id=...` para borrar.
- Límites **[verificado]**:
  - 10.000 suscripciones por tipo de evento por app.
  - `chat.message.sent` limitado a 1.000 en apps no verificadas; la
    verificación (por email al Kick Dev Team) sube el tope a 10.000.
  - Si un webhook falla por más de 1 día, Kick **desuscribe** el evento.

### 2.1 Seguridad de los webhooks

**[verificado]** fuente: `docs.kick.com/events/webhook-security`. Headers:

- `Kick-Event-Message-Id` (ULID)
- `Kick-Event-Subscription-Id` (ULID)
- `Kick-Event-Signature` (Base64)
- `Kick-Event-Message-Timestamp` (RFC3339)
- `Kick-Event-Type`
- `Kick-Event-Version`

- La firma es **RSA** sobre la cadena `"{messageID}.{timestamp}.{rawBody}"`.
- Se verifica con la clave pública de
  `GET https://api.kick.com/public/v1/public-key` (PEM).
- **No hardcodear la clave** (rota). Verificación con `RSA` + `SHA256`
  (en Node: `crypto.verify("sha256", ...)` / equivalentes PKCS#1 v1.5).

---

## 3. URL pública y PC doméstica

**[verificado]** (documentación y sentido común del stack): los webhooks
oficiales requieren una URL accesible desde internet. Opciones para una PC
detrás de NAT doméstico:

| Opción | Notas | Estado |
|---|---|---|
| **Cloudflare Tunnel** (`cloudflared`) | Túnel saliente, no requiere abrir puertos. Mencionado como ejemplo en la doc de Kick. | **[verificado]** que Kick menciona túneles; configuración concreta **[TODO(verificar)]** por el usuario |
| ngrok | También mencionado como ejemplo. Requiere cuenta; free tier con URL efímera. | **[verificado]** como ejemplo en la doc |
| Redirección de puertos en el router | Expone la PC a internet; menos seguro. | **[suposición]** funciona, no recomendado |
| VPS intermedio | Proxy hacia la PC. Más infra, más costo. | **[suposición]** |

Implicancia: la vía oficial obliga a que el streamer tenga un túnel activo y
una URL estable para que Kick pueda entregar los eventos. Es fricción real para
un producto self-hosted "no técnico".

---

## 4. Alternativas no oficiales: WebSocket de Pusher

La web de Kick usa un **WebSocket de Pusher** para el tiempo real. **[verificado]**
a partir del código de dos proyectos de comunidad independientes:

- `retconned/kick-js` (`src/core/websocket.ts`, `src/core/message-handling.ts`,
  `src/types/events.ts` en la rama `main`).
- `pjvjay/kick-chat-monitor` (`kick_chat_monitor.py`, `README.md` en la rama
  `main`).

### 4.1 Detalles técnicos

**[verificado]** por coincidencia de ambos proyectos:

- Endpoint base: `wss://ws-us2.pusher.com/app/{app_key}`
- App key pública: `32cbd69e4b950bf97679`
- Query string de conexión:
  `?protocol=7&client=js&version=8.4.0&flash=false`
  (`pjvjay` usa `version=8.4.0-rc2`; `retconned` usa `8.4.0` — diferencia menor).
- Suscripción: enviar
  `{"event":"pusher:subscribe","data":{"auth":"","channel":"chatrooms.<chatroomId>.v2"}}`
  tras recibir `pusher:connection_established`.
- Frames internos de control a manejar: `pusher:connection_established`,
  `pusher:ping` (responder `{"event":"pusher:pong","data":{}}`),
  `pusher_internal:subscription_succeeded`.
- El `chatroomId` se obtiene de `https://kick.com/api/v2/channels/<slug>`
  → campo `chatroom.id`. **[TODO(verificar)]** este endpoint no es oficial y
  está detrás de Cloudflare (los proyectos lo tratan explícitamente: el código
  de `retconned` detecta `403` y lo reporta como "Cloudflare protection").

### 4.2 Discrepancia abierta

**[TODO(verificar)]** El nombre exacto del canal difiere entre los proyectos:

- `retconned/kick-js`: `chatrooms.<id>.v2`
- `pjvjay/kick-chat-monitor`: `chatrooms.<id>`

Probablemente `.v2` sea el canal vigente y el otro haya quedado viejo, pero no
está confirmado. Se resuelve empíricamente en el prototipo (suscripto a uno y,
si no llegan frames, al otro).

### 4.3 Eventos que viajan por Pusher

**[verificado]** por el mapa `EVENT_NAME_TO_TYPE` de `retconned/kick-js`
(nombres `App\Events\...`):

- `ChatMessageEvent` — chat.
- `SubscriptionEvent` — sub.
- `GiftedSubscriptionsEvent` — gift subs (incluye `gifter_username` y
  `gifted_usernames`).
- `StreamHostEvent` — host/raid entrante (**no** es un evento de la API
  oficial; solo aparece acá).
- `MessageDeletedEvent`, `UserBannedEvent`, `UserUnbannedEvent`,
  `PinnedMessageCreatedEvent`, `PinnedMessageDeletedEvent`,
  `PollUpdateEvent`, `PollDeleteEvent`.

Observaciones:

- No aparece ningún evento explícito de **follow** ni de **canje de
  recompensas** en ese mapa. **[suposición]** follows y rewards probablemente
  no lleguen por Pusher (o usen nombres no mapeados por esta librería).
  **[TODO(verificar)]** con prueba empírica.
- El payload de chat (según `types/events.ts`) es
  `{ id, chatroom_id, content, type, created_at, sender: { id, username, slug, identity: { color, badges } } }`.
  El formato **no está documentado por Kick** (es ingeniería inversa).

### 4.4 Riesgos de la vía Pusher

- **No oficial**: puede romperse sin aviso (cambio de app key, de canal, de
  pool de Pusher, etc.).
- **Sin firma ni autenticación**: cualquiera puede consumirlo; no hay garantía
  de integridad.
- **Cobertura incierta**: chat y subs/gifts confirmados por el código de
  terceros; follows y rewards no confirmados.
- **Dependencia de un endpoint HTML/JSON no oficial** (`kick.com/api/v2/...`)
  para obtener el `chatroomId`, con riesgo de Cloudflare.
- No permite **enviar** al chat ni moderar sin credenciales de sesión
  (harvesting de cookies), lo que es frágil y va contra las buenas prácticas.

---

## 5. Matriz de eventos pedidos

| Evento pedido | Vía oficial (webhook) | Vía Pusher |
|---|---|---|
| Chat | `chat.message.sent` **[verificado]** | `App\Events\ChatMessageEvent` **[verificado]** |
| Follows | `channel.followed` **[verificado]** | No observado **[suposición / TODO(verificar)]** |
| Subs | `channel.subscription.new` **[verificado]** | `App\Events\SubscriptionEvent` **[verificado]** |
| Gift subs | `channel.subscription.gifts` **[verificado]** | `App\Events\GiftedSubscriptionsEvent` **[verificado]** |
| Canjes de recompensas | `channel.reward.redemption.updated` **[verificado]** + REST de redemptions | No observado **[suposición / TODO(verificar)]** |

### Eventos oficiales disponibles (todos `version 1`)

**[verificado]** fuente: `docs.kick.com/events/event-types`.

`chat.message.sent`, `channel.followed`, `channel.subscription.renewal`,
`channel.subscription.new`, `channel.subscription.gifts`,
`channel.reward.redemption.updated` (status `pending|accepted|rejected`),
`livestream.status.updated`, `livestream.metadata.updated`, `moderation.banned`,
`kicks.gifted`.

### Redemptions por REST (además del webhook)

**[verificado]** fuente: `docs.kick.com/apis/channel-rewards`. Detalle completo
en la Sección 8.

- `GET /public/v1/channels/rewards` — listar (máx. 50 recompensas por canal,
  contando habilitadas y deshabilitadas).
- `POST /public/v1/channels/rewards` — crear.
- `PATCH /public/v1/channels/rewards/{id}` — editar (solo la app que la creó).
- `DELETE /public/v1/channels/rewards/{id}` — borrar (solo la app que la creó).
- `GET /public/v1/channels/rewards/redemptions` — listar canjes (paginado;
  `status` por defecto `pending`).
- `POST /public/v1/channels/rewards/redemptions/accept` — aceptar (body
  `{ "ids": [...] }`, máx. 25).
- `POST /public/v1/channels/rewards/redemptions/reject` — rechazar (body
  `{ "ids": [...] }`, máx. 25).
- `GET /public/v1/channels?broadcaster_user_id=...|slug=...` (no mezclar
  ambos parámetros).

---

## 6. Librerías de comunidad y Casterlabs

**[verificado]** fuente: `docs.kick.com/how-do-i-contribute/community-projects`.

- JS/TS: `@botk4cp3r/kick.js`, `kick-auth`, `kient` (zSoulweaver),
  `kick-api-types`. También hay librerías en Python, PHP, C#, Java y Go.
- Nota: **`kient` hoy usa la API oficial + webhooks** (su rama `master` tiene
  `webhook.server.ts` y `verify-webhook-signature.ts`, sin código de Pusher).
  Es una buena referencia de la vía oficial en TypeScript.

Casterlabs (mencionado en el `ROADMAP.md` como "otros proyectos"):

- **[verificado, indirecto]** El plugin `KiraLovey/chatincluded` para
  "Casterlabs Caffeinated" se describe como soporte de chat de Twitch, Kick,
  YouTube, Trovo y TikTok. Es decir, Caffeinated soporta Kick al menos a nivel
  de chat.
- **[TODO(verificar)]** Grado real de soporte de Kick en Caffeinated (eventos
  de subs/follows/rewards, versión actual, mantenimiento).
- **Decisión**: no nos apoyamos en Casterlabs. Es una app Java pensada para
  widgets de OBS, no una dependencia que queramos integrar en el backend. Se
  deja como referencia.

---

## 7. Viabilidad en app local

Contexto: el producto es una **app local** que corre en la PC de un streamer
**no técnico** (instalar, abrir, dashboard en el navegador), distribuida como
open source. Esto condiciona fuertemente la elección de la vía de eventos.

### 7.1 OAuth con redirect a localhost y PKCE (¿sin client secret?)

- **[verificado]** El endpoint `GET /oauth/authorize` **exige PKCE**
  (`code_challenge` + `code_challenge_method=S256`).
- **[verificado]** La doc recomienda `localhost` como redirect/callback para
  apps que corren localmente (p. ej. `http://localhost/auth/callback`), y
  documenta el workaround del bug de Next.js cuando se usa `127.0.0.1`.
- **[verificado — dato crítico]** El endpoint `POST /oauth/token`
  (grant `authorization_code`) marca **`client_secret` como `Required: Yes`**.
  Es decir, **PKCE no exime del client secret** en la doc: Kick no describe un
  flujo de cliente público sin secreto.
- **[TODO(verificar)]** Si el servidor, en la práctica, acepta omitir
  `client_secret` cuando se usa PKCE (algunos proveedores lo permiten aunque la
  doc lo marque como requerido). Hay que probarlo empíricamente antes de
  diseñar el onboarding.

**Conclusión:** sí se puede vincular la cuenta desde la app con redirect a
`localhost` y PKCE, pero **con un `client_secret` presente** (el de la app). No
es un flujo “sin secreto”.

### 7.2 App de desarrollador compartida vs. app propia (pregunta 2)

- **[verificado]** Crear una app exige una cuenta de Kick con **2FA** y hacerlo
  a mano en `kick.com/settings/developer`; genera `ClientID`, `ClientSecret` y
  `redirectURL` propios.
- **[TODO(verificar)]** La doc **no dice explícitamente** si está permitido
  distribuir una app que sirva a múltiples streamers. Habría que revisar los
  *Developer Terms and Conditions* (la doc de App Setup los menciona) o
  preguntar al Kick Dev Team.
- Implicancias técnicas **verificadas** que empujan hacia “una app por
  streamer”:
  1. La **URL de entrega del webhook es un ajuste a nivel de app** (ver 7.3):
     una app compartida tendría **una sola URL** para todos los usuarios.
  2. Los **límites son por app**: 10.000 suscripciones por tipo de evento, y
     1.000 para `chat.message.sent` si la app no está verificada (**[verificado]**
     en `events/subscribe-to-events` y en las FAQs). Una app compartida reparte
     ese cupo entre todos. *[inferencia sobre dato verificado]*
  3. El intercambio de token exige `client_secret` **[verificado]**: un secreto
     **compartido** embebido en software open source distribuido queda de hecho
     **público**. Cualquiera podría impersonar la app y consumir sus límites.
     (El riesgo principal es abuso de cuota/rate limits y suscripción a canales
     ajenos, no la lectura de datos privados de los usuarios.)

**Conclusión:** para una app self-hosted y open source, lo limpio es **una app
por streamer** (el secreto vive solo en la PC de ese streamer y nunca se
distribuye). El costo es la fricción: el usuario tendría que activar 2FA y crear
su app a mano, salvo que la app lo guíe paso a paso.

### 7.3 Túnel automático y suscripciones a webhooks (pregunta 3)

- **[verificado — Cloudflare]** `cloudflared tunnel --url http://localhost:PUERTO`
  crea un **Quick Tunnel** con URL `*.trycloudflare.com`, **sin cuenta ni
  dominio**. Limitaciones documentadas: **el hostname cambia en cada arranque**,
  no hay garantía de uptime, y el túnel deja de funcionar al terminar el
  proceso. (Para hostname estable hace falta un Cloudflare Tunnel con cuenta +
  dominio.)
- **[verificado — Kick]** La URL del webhook se configura en el **dashboard de
  Developer** (switch “Enable Webhooks” + “Webhook URL”). El body de
  `POST /public/v1/events/subscriptions` **no incluye URL** (confirmado por el
  esquema OpenAPI): la entrega es un ajuste **a nivel de app**, no por
  suscripción.
- **[verificado]** La API pública solo expone CRUD de **suscripciones**
  (POST/GET/DELETE). **No hay** endpoint para editar la configuración ni la
  URL de la app. **[TODO(verificar)]** si existe alguna vía por API para
  setear/actualizar la webhook URL; por la doc disponible, **parece que no**
  (solo dashboard).
- **[verificado]** Las suscripciones se crean, listan y borran por API. La doc
  **no documenta expiración** de las suscripciones; sí documenta que Kick
  **desuscribe** un evento si su webhook falla por más de 1 día.
- **[TODO(verificar)]** Qué pasa con suscripciones viejas que apuntan a un
  hostname muerto: ¿se acumulan hasta el límite? ¿hay que borrarlas a mano?

**Implicancia:** con Quick Tunnel la URL **cambia en cada arranque**, pero la
webhook URL es un ajuste **manual del dashboard por app**. Eso **no encaja** en
un flujo autocontenido “instalar y abrir”: habría que actualizar la URL a mano
cada vez. Alternativas: Cloudflare Tunnel con hostname estable (requiere cuenta
—y dominio— del usuario) o un servicio central de retransmisión (rompe el
“todo local”).

### 7.4 Qué se pierde con solo-Pusher y qué se gana con webhooks (pregunta 4)

| Dimensión | Solo Pusher (sin cuenta, sin túnel) | Webhooks oficiales |
|---|---|---|
| Fricción de setup | Cero: no requiere OAuth ni app ni URL pública. **[verificado]** | Alta: app + 2FA + URL pública (túnel). **[verificado]** |
| Chat | Sí (`ChatMessageEvent`). **[verificado]** | Sí (`chat.message.sent`). **[verificado]** |
| Subs / gift subs | Sí (según terceros). **[verificado]** | Sí. **[verificado]** |
| **Follows** | **No observado** **[TODO(verificar)]** | Sí (`channel.followed`). **[verificado]** — **no hay endpoint REST de follows**, así que son webhook-only |
| **Canjes de recompensas** | **No observado** **[TODO(verificar)]** | Sí (`channel.reward.redemption.updated`) + REST de redemptions. **[verificado]** |
| Livestream / bans / kicks | No observado (excepto host/polls). **[verificado parcial]** | Sí. **[verificado]** |
| Integridad | Sin firma. **[verificado]** | Firma RSA verificable. **[verificado]** |
| Estabilidad | Ingeniería inversa, puede romperse sin aviso. **[suposición]** | API soportada. **[verificado]** |
| Acciones autenticadas (escribir, moderar, gestionar rewards) | No (requeriría credenciales de sesión tipo harvesting, frágil). **[verificado]** | Sí, con User Access Token. **[verificado]** |

**En una frase:** solo-Pusher es perfecto para arrancar y para features de chat,
pero **pierde los follows**, que son webhook-only. Los **canjes**, en cambio, no
se observaron por Pusher pero **sí se consiguen por REST** (ver Sección 8), así
que no dependen de un túnel.

### 7.5 Recomendación para el producto final (actualizada)

**Arquitectura local-first: la detección de canjes de recompensas —el core del
producto— se hace por REST polling, sin túnel ni URL pública.** Los eventos en
tiempo real (chat, follows, subs) se agregan como capa opcional. Ver la
**Sección 8** para el detalle verificado de la API de recompensas.

Por qué (a partir de la Sección 8):

1. **Recompensas 100% locales.** Crear/editar/borrar recompensas y **listar
   canjes pendientes por polling** (`GET .../redemptions?status=pending`), más
   aceptar/rechazar, son endpoints REST con User Token que **funcionan desde una
   app local sin URL pública** (tráfico saliente). Es exactamente el flujo tipo
   Fenskald.
2. **Los follows son la única feature que hoy obliga a un túnel.** No hay REST
   de follows; solo el webhook `channel.followed`. Chat y subs pueden ir por
   Pusher sin túnel (best-effort) o por webhook si se quiere firma y estabilidad.
3. **Una app por streamer** sigue siendo lo recomendado (secreto no compartido,
   límites propios), y ahora es menos oneroso: el onboarding del core (login +
   recompensas) **no depende de un túnel**.

Estrategia por feature:

| Feature | Vía | ¿Necesita túnel? |
|---|---|---|
| Crear/editar/borrar recompensas | REST (`channel:rewards:write`, User Token) | No |
| Detectar canjes | REST polling (`GET .../redemptions`, default `pending`) | No |
| Aceptar/rechazar canjes | REST (`.../redemptions/accept` / `/reject`) | No |
| Chat | Pusher (best-effort) o webhook | No / Sí |
| Subs y gift subs | Pusher (best-effort) o webhook | No / Sí |
| Follows | Solo webhook `channel.followed` | Sí |

**Recomendación concreta:** construir el core local con OAuth del broadcaster +
REST para recompensas y canjes (sin túnel), y ofrecer la vía de webhooks como
**modo avanzado opcional** para tiempo real y follows. Mantener Pusher como modo
“simple” best-effort para chat.

**Si se adopta el modo webhooks**, el punto de fricción sigue siendo el túnel y
la URL del webhook: como la webhook URL es un ajuste **de app** en el dashboard,
un Quick Tunnel (URL cambiante) **no es viable** de forma automática. Opciones,
por orden de preferencia: (1) Cloudflare Tunnel con hostname estable, configurado
una vez en el onboarding (requiere cuenta —y dominio— del streamer); (2)
servicio central de retransmisión del proyecto (rompe “todo local”, agrega costo
operativo y reintroduce el problema del secreto/límites compartidos).

**[TODO(verificar) antes de comprometer el diseño de onboarding]:**
- Rate limits de los endpoints REST de rewards/redemptions (para el polling). (8.2)
- ¿Kick permite realmente una app compartida/distribuida? (7.2)
- ¿El token endpoint acepta PKCE sin `client_secret`? (7.1)
- ¿Existe alguna vía por API para actualizar la webhook URL de la app? (7.3)

## 8. Channel Rewards: gestión y detección de canjes

Motivación: un producto de referencia (Fenskald) permite al streamer vincular
su cuenta de Kick y **crear recompensas de canal desde su editor** (nombre,
costo en puntos, video, volumen, duración máxima). Verifiqué en la documentación
oficial (`docs.kick.com/apis/channel-rewards`) qué permite realmente la API.

> **Nota importante [verificado]:** **todos** los endpoints de recompensas
exigen **User Access Token** del broadcaster (scopes `channel:rewards:read` /
`channel:rewards:write`). **No aceptan App Access Token.** Es decir, requieren
que el streamer **vincule su cuenta por OAuth**.

### 8.1 Endpoints y scopes (pregunta 1) — [verificado]

| Acción | Método y ruta | Scope | Notas |
|---|---|---|---|
| Listar | `GET /public/v1/channels/rewards` | `channel:rewards:read` (o `write`) | Máx. 50 por canal |
| Crear | `POST /public/v1/channels/rewards` | `channel:rewards:write` | — |
| Editar | `PATCH /public/v1/channels/rewards/{id}` | `channel:rewards:write` | Solo la app que la creó |
| Borrar | `DELETE /public/v1/channels/rewards/{id}` | `channel:rewards:write` | Solo la app que la creó |

Campos de la recompensa (Create / Patch) — **[verificado]**:

- `title` — string, ≤50, **requerido**.
- `cost` — int ≥1, **requerido**.
- `description` — string, ≤200.
- `background_color` — hexcolor, default `#00e701`.
- `is_enabled` — bool, default `true`.
- `is_user_input_required` — bool, default `false`.
- `should_redemptions_skip_request_queue` — bool, default `false`.

Respuesta `ChannelReward`: `id` (ulid), `title`, `cost`, `description`,
`background_color`, `is_enabled`, `is_paused`, `is_user_input_required`,
`should_redemptions_skip_request_queue`.

**[verificado por ausencia]** La API **no** tiene campos de **video, volumen ni
duración máxima**. Eso es 100% del lado de la app (como en Fenskald): se guarda
en el almacenamiento propio y se mapea a la recompensa por su `id` (o título y
costo). Encaja con el modelo del proyecto: el clip es local y se reproduce en
OBS.

### 8.2 Detección de canjes (pregunta 2) — [verificado]

Dos vías (no excluyentes):

1. **Webhook** `channel.reward.redemption.updated` — push; requiere URL pública.
2. **REST polling** (sin URL pública, ideal para app local):
   `GET /public/v1/channels/rewards/redemptions`
   - Scope: `channel:rewards:read`.
   - Query: `reward_id` (opcional); `status` = `pending | accepted | rejected`
     (**por defecto `pending`**); `id` (lista de redemptions; si se usa, no se
     permiten otros filtros); `cursor` (paginación, base64).
   - Respuesta paginada: `{ data: [ { reward, redemptions: [...] } ],
     pagination: { next_cursor } }`.

Marcar **cumplido / rechazado** — **[verificado]**:

- `POST /public/v1/channels/rewards/redemptions/accept` — body
  `{ "ids": [ulid, ...] }`, **máx. 25**.
- `POST /public/v1/channels/rewards/redemptions/reject` — body
  `{ "ids": [ulid, ...] }`, **máx. 25**.
- La respuesta **solo incluye los que fallaron**: `{ id, reason }` con `reason`
  ∈ `UNKNOWN | NOT_PENDING | NOT_FOUND | NOT_OWNED`.

**[suposición / TODO(verificar)]** Que `reject` **reembolse** los channel points
al espectador. La doc dice “reject”, no “refund”; falta confirmarlo.

**Rate limits:** **[TODO(verificar)]** No aparecen documentados en las páginas
accesibles (readme, FAQs ni la propia de channel-rewards). Hay que medirlos o
preguntar al Kick Dev Team antes de fijar el intervalo de polling.

### 8.3 Campos de un canje (pregunta 3) — [verificado]

**Webhook** (`channel.reward.redemption.updated`):

```json
{
  "id": "01KBHE78QE4HZY1617DK5FC7YD",
  "user_input": "unban me",
  "status": "rejected",
  "redeemed_at": "2025-12-02T22:54:19.323Z",
  "reward": { "id": "01KBHE7RZNHB0SKDV1H86CD4F3", "title": "Uban Request", "cost": 1000, "description": "Only good reasons pls" },
  "redeemer": { "user_id": 123, "username": "naughty-user", "is_verified": false, "profile_picture": "", "channel_slug": "naughty_user" },
  "broadcaster": { "user_id": 333, "username": "gigachad", "is_verified": true, "profile_picture": "", "channel_slug": "gigachad" }
}
```

- El **texto libre** que ingresa el espectador es **`user_input`** [verificado].
- `status` ∈ `pending | accepted | rejected`.
- `redeemer` incluye `username`, `is_verified`, `profile_picture`,
  `channel_slug` (el webhook trae más que el REST).

**REST** (`GET .../redemptions`), estructura `ChannelRewardRedemption`:

- `id` (ulid), `redeemed_at` (date-time), `status`, `user_input`.
- `redeemer`: **solo `{ user_id }`** — **[verificado]** el REST **no** trae el
  username.
- Envuelto en `{ reward: {...}, redemptions: [...] }` + `pagination.next_cursor`.

Para resolver el **username** al usar polling:
`GET /public/v1/users?id=<user_id>` → campo `name` (scope `user:read` o App
Token) **[verificado]**.

> **Seguridad [nota]:** `user_input` es **input no confiable** (lo escribe el
espectador). Nunca pasarlo a un proceso ni a una ruta. Antes de usarlo (p. ej.
para yt-dlp), **validarlo como URL**: protocolo `http`/`https`, dominio en
**whitelist**, longitud máxima. Ver AGENTS.md #2, #3 y #9, y la Sección 12.1.

### 8.4 Arquitectura: centralizado vs. app local (pregunta 4)

| Aspecto | Servicio centralizado (una app + servidor con URL pública) | App local |
|---|---|---|
| Config. de webhook | Una URL central; un solo lugar a mantener | URL por app/streamer; se toca a mano en el dashboard |
| Límites de suscripción | Compartidos entre todos los usuarios | Propios por streamer |
| Secreto | `client_secret` compartido → efectivamente público | Solo en la PC del streamer |
| Costo / operación | Servidor + uptime + dominio | Ninguno |
| Privacidad | Los eventos pasan por un tercero (el proyecto) | Todo en la PC del streamer |

**Qué desaparece si los canjes se reciben por polling (app local):**

- El **túnel** y la **URL pública** para la feature de canjes.
- La configuración manual de la **Webhook URL** en el dashboard de Kick.
- La verificación de **firma** y toda la infra de recepción de webhooks.
- El problema del **secreto / límites compartidos** (no hace falta app compartida).
- Basta con **salida a internet** + **OAuth del broadcaster**.

**Qué NO desaparece:**

- Los **follows** siguen siendo **webhook-only** (no hay REST de follows): el
  polling **no** los cubre. Si se quieren follows en tiempo real → túnel + webhook.
- El login OAuth del broadcaster y el `client_secret` (ver 7.1) siguen siendo
  necesarios.
- El polling introduce **latencia** (depende del intervalo) en vez de push;
  para canjes de puntos suele ser aceptable.

## 9. Conclusiones

1. La **única vía oficial y estable** es **webhooks** con OAuth2
   (`events:subscribe`), firma RSA y URL pública.
2. El **WebSocket de Pusher** es viable **sin autenticación ni URL pública**, y
   cubre chat y (según terceros) subs/gifts; follows y canjes no se observaron
   por Pusher. Es frágil y no oficial.
3. Para el criterio de aceptación de Fase 0 (escribir en el chat → ver el
   evento), Pusher es la vía más simple; los webhooks exigen túnel + app
   registrada + 2FA.
4. La integración debe quedar detrás de la interfaz `KickEventSource`
   (AGENTS.md #7), de modo que podamos empezar con Pusher y migrar a webhooks
   sin tocar el resto.
5. Las **recompensas de canal se gestionan y detectan por REST** desde la app
   local (crear/editar/borrar + polling de canjes + accept/reject), **sin URL
   pública**. Los **follows** son la única feature que hoy exige webhooks con túnel
   (ver Sección 8).

## 10. Pendiente de verificar (resumen)

- [ ] Rate limits de los endpoints REST de rewards/redemptions (para el polling).
- [ ] Si `reject` de un canje reembolsa los channel points al espectador.
- [ ] Si Kick permite una app distribuida/compartida, y qué dicen los Developer
      Terms.
- [ ] Si el token endpoint acepta PKCE sin `client_secret`.
- [ ] Si existe API para actualizar la webhook URL de la app (parece que no).
- [ ] Cómo se comportan las suscripciones viejas cuando el webhook URL deja de
      responder (acumulación vs. límite).
- [ ] Nombre exacto del canal Pusher: `chatrooms.<id>.v2` vs `chatrooms.<id>`.
- [ ] Si follows y canjes de recompensas llegan por Pusher (probablemente no).
- [ ] Estabilidad/mantenimiento actual de `kick.com/api/v2/channels/<slug>`
      frente a Cloudflare.
- [ ] Soporte real de Kick en Casterlabs Caffeinated (no bloqueante).
- [ ] Configuración concreta de Cloudflare Tunnel para webhooks (si se elige
      esa vía para el prototipo o para fases posteriores).

---

## 11. Decisiones abiertas (documentadas, sin resolver)

Quedan explícitamente para más adelante; no se resuelven ahora.

### 11.1 (a) App compartida vs. una app por streamer

Remite a la Sección 7.2. Depende de si Kick permite distribuir una app que
sirva a varios streamers (Developer Terms, **[TODO(verificar)]**) y del costo
operativo de un relay central. Restricciones conocidas que inclinan hacia “una
por streamer”: la webhook URL es un ajuste a nivel de app, los límites de
suscripción son por app, y el `client_secret` no se puede compartir en software
open source distribuido.

### 11.2 (b) Canjes pendientes cuando la app estuvo cerrada

- **[verificado]** `GET .../redemptions?status=pending` devuelve **todos** los
  canjes pendientes; no hay filtro temporal documentado. `redeemed_at` permite
  distinguir los viejos.
- **[TODO(verificar)]** Si Kick **expira** canjes pendientes automáticamente (no
  está documentado).
- **Decisión pendiente:** al arrancar la app, ¿se procesan los `pending` viejos
  o se ignoran? Impacta la UX (“¿por qué se reprodujo un clip canjeado hace tres
  días?”).

### 11.3 (c) Tokens expirados o revocados

- **[verificado]** Existen refresh (`grant_type=refresh_token`) y revoke.
- **[TODO(verificar)]** Código/error exacto cuando el refresh falla porque el
  `refresh_token` fue revocado o venció.
- **Decisión pendiente:** UX ante refresh fallido: pedir re-login sin perder la
  configuración local.

### 11.4 Resultados medidos con el prototipo (plantilla — completar)

Completar acá con datos **reales** medidos con `scripts/kick-rewards.ts`.
Hasta que se complete, cada dato sigue siendo **[TODO(verificar)]**.

**Entorno:** fecha ____ · canal ____ · Node ____ · `KICK_POLL_INTERVAL_MS` ____ ms

| # | Qué medir | Cómo se obtiene | Resultado |
|---|---|---|---|
| 1 | Intervalo de polling usado | valor de `KICK_POLL_INTERVAL_MS` | ____ ms |
| 2 | Headers de rate limit | líneas `[rate-limit] ...` que imprime el `watch` en cada request | ____ |
| 3 | ¿Hubo `429`? | aviso `[rate-limit] 429 Too Many Requests` | sí / no |
| 4 | Latencia canje → detección | línea `latencia de detección ≈ N ms` del `watch` | mín ____ / típica ____ / máx ____ ms |
| 5 | ¿`reject` devuelve los puntos? | saldo del redeemer antes y después de rechazar | sí / no / no verificable |

**Observaciones:** _(intervalo mínimo que toleró, logs crudos relevantes, etc.)_

#### 11.4.1 Mediciones desde el panel de diagnóstico (Fase 4B)

Con la integración real (Fase 4B) estas mismas mediciones se obtienen del
dashboard, sección **Plataformas → Diagnóstico**, sin depender del prototipo.

**Entorno:** fecha ____ · canal ____ · puerto ____ · intervalo configurado ____ ms

| # | Qué medir | Dónde sale en el panel | Resultado |
|---|---|---|---|
| 1 | Intervalo de polling actual | campo "Intervalo (ms)" | ____ ms |
| 2 | Headers de rate limit observados | campo "Headers de rate limit" (última respuesta) | ____ |
| 3 | Cantidad de respuestas 429 | campo "Respuestas 429" | ____ |
| 4 | Latencia canje → detección (últ/min/típ/máx) | campo "Latencia (últ/min/típ/máx) ms" | ____ ms |
| 5 | ¿`reject` devuelve los puntos? | saldo del redeemer antes/después de rechazar en Kick | sí / no / no verificable |
| 6 | Último resultado / último error | campos "Último resultado" y "Último error" | ____ |

**Observaciones:** _(intervalo mínimo que toleró, 429 y `Retry-After`, etc.)_

#### 11.4.2 Verificaciones pendientes de la Etapa 4A (recompensas)

Datos que **no** se pudieron confirmar con la documentación; quedan como
**[TODO(verificar)]** hasta probarlos contra un canal real.

| # | Qué verificar | Por qué importa | Estado |
|---|---|---|---|
| 1 | Qué hace Kick con los **canjes pendientes** de una recompensa que se **deshabilita** | Define si hace falta rechazarlos a mano (la app los rechaza **antes** de deshabilitar y vuelve a revisar) | **[TODO(verificar)]** |
| 2 | Qué pasa al **cambiar el costo** de una recompensa que tiene canjes pendientes | Si Kick re-valida los puntos o los deja pendientes | **[TODO(verificar)]** |
| 3 | Efecto de **`should_redemptions_skip_request_queue`** | La app **no** lo envía (deja el valor por defecto); confirmar que no cambia la cola de pedidos | **[TODO(verificar)]** |
| 4 | Si **`reject` reembolsa los puntos** al espectador | La UI nunca promete "reembolsar", solo "rechazar" | **[TODO(verificar)]** |
| 5 | ¿`GET .../redemptions` filtra por **`reward_id` y `status` a la vez**? | La app usa ese filtro para contar los pendientes de una recompensa | **[verificado en docs]** (§8) — confirmar en la práctica |
| 6 | ¿`PATCH .../rewards/{id}` acepta **`is_enabled`**? | Es lo que usa el interruptor de activa/desactivada | **[verificado en docs]** (§8) — confirmar en la práctica |
| 7 | Solo la app que creó la recompensa puede editarla/borrarla | Por eso las recompensas de otras apps se marcan "De otra app" | **[verificado en docs]** (§8) |

**Notas de arquitectura (Etapa 4A):**

- Las recompensas y los canjes se manejan **por REST, sin túnel ni webhooks**,
  desde la app local. El `client_secret` es de **solo escritura** (nunca sale al
  frontend ni a los logs).
- En esta etapa el público **no envía links**: eso se quitó del producto. El
  `user_input` de un canje igual se trata como input **no confiable** (§12.1) y,
  si algún día se usa, se valida como URL con whitelist antes de pasarlo a yt-dlp.
- La recompensa local tiene un **id propio y estable**; el id remoto de la
  plataforma es un dato reemplazable (por eso "Recrear" funciona).

---

## 12. Notas de seguridad del prototipo

### 12.1 `user_input` es input no confiable

El `user_input` de un canje es **texto arbitrario** escrito por el espectador.
Nunca pasarlo a un proceso ni construir rutas con él. Antes de usarlo (p. ej.
para descargar un clip con yt-dlp) hay que **validarlo como URL**: protocolo
`http`/`https`, dominio en **whitelist** y longitud máxima (AGENTS.md #2, #3, #9).
El prototipo `scripts/kick-rewards.ts` solo lo imprime (entre comillas) y no lo
ejecuta.

### 12.2 Tokens

Los tokens OAuth se guardan en `.kick-tokens.json` (raíz del repo), **ignorado
por git**. Nunca se imprimen en logs.

### 12.3 Prototipo

`scripts/kick-rewards.ts`: login OAuth + refresh, crear recompensa de prueba,
polling de canjes pendientes con username resuelto, y accept/reject. Sin base de
datos, dashboard ni overlay.