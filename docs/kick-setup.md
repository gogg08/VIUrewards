# Guía: conectar Kick (Fase 4B)

Esta guía explica cómo vincular la cuenta de Kick y administrar recompensas de
canal desde **czero-rewards**, usando la **API oficial** de Kick.

Todo corre en la PC del streamer. El único tráfico de red de esta integración es
**saliente** hacia Kick (`https://id.kick.com` para OAuth y `https://api.kick.com`
para la API). **No hace falta URL pública, túnel ni webhooks** para las
recompensas y los canjes: la detección de canjes es por **polling REST**.

> Los datos verificados de la API están en `docs/kick-research.md` (Secciones 1 y
> 8). Todo lo no confirmado figura ahí como `TODO(verificar)`.

## Requisitos

- Una cuenta de Kick con **verificación en dos pasos (2FA) activada**. Sin 2FA, el
  panel de desarrollador no deja crear la app.
- La app levantada con `npm start` (por defecto en `http://127.0.0.1:8787/`).

## 1. Crear la app de desarrollador

1. Entrá a **`https://kick.com/settings/developer`**.
2. Creá una app. Kick pide, como mínimo:
   - **Nombre**.
   - **Redirect URL**.
3. En **Redirect URL** registrá exactamente:

   ```
   http://localhost:8787/callback
   ```

   - El host tiene que ser **`localhost`**, no `127.0.0.1`: la documentación de
     Kick menciona un bug conocido con `127.0.0.1` en el alta de apps.
     **[verificado]** (`docs/kick-research.md` §1.3)
   - La ruta tiene que ser exactamente **`/callback`**.
   - **Si cambiás el puerto** (o el host) en la Configuración del dashboard, tenés
     que **registrar de nuevo** la Redirect URL en la app de Kick con ese puerto.
     El dashboard arma el `redirect_uri` como
     `http://localhost:<puerto>/callback`.
4. Copiá el **Client ID** y el **Client Secret** que genera Kick.

## 2. Scopes

La app pide estos scopes al iniciar sesión:

```
user:read channel:rewards:read channel:rewards:write
```

- **`user:read`** — para leer el usuario autorizado (`GET /public/v1/users` sin
  `id` devuelve la cuenta vinculada) y mostrar "Conectado como <usuario>".
- **`channel:rewards:read`** — listar recompensas y leer canjes.
- **`channel:rewards:write`** — crear, editar y borrar recompensas; aceptar y
  rechazar canjes.

Los scopes se envían en la URL de autorización (`scope=...`). Si el panel de la
app de Kick pide habilitarlos por separado, seleccioná esos tres.

## 3. Cargar las credenciales en el dashboard

1. En el dashboard, entrá a la sección **Plataformas**.
2. Pegá el **Client ID** y el **Client Secret**.
3. Click en **Guardar credenciales**.

Notas:

- El **Client Secret es de solo escritura**: se guarda localmente (SQLite) y
  **nunca** se devuelve al navegador, ni se muestra, ni se loguea. Si lo querés
  cambiar, escribí uno nuevo y guardá.
- El **Client ID** no es secreto y puede reutilizarse desde el dashboard.

## 4. Vincular la cuenta

1. Click en **Vincular cuenta**. Se abre la página de autorización de Kick.
2. Autorizá la app. Kick te devuelve a `http://localhost:<puerto>/callback`.
3. El callback valida el vínculo **solo con `state` + PKCE** (no depende de la
   cookie de sesión) y **redirige al dashboard** sin parámetros sensibles.
4. Si todo sale bien, la Plataforma queda **Conectado** y muestra el nombre de la
   cuenta ("Conectado como <usuario>").

El inicio del vínculo genera `state` y `code_verifier` aleatorios, guardados en
memoria con **expiración corta** (10 minutos) y **de un solo uso**. Cualquier
`state` desconocido, vencido o reutilizado se rechaza.

Si ves **"Requiere volver a vincular"**: el `refresh_token` fue revocado o la
sesión venció. El polling se detiene (sin reintentos en bucle) y hay que repetir
este paso.

## 5. Probar la conexión

Click en **Probar conexión**. Llama al endpoint de usuario y a listar recompensas,
y muestra el resultado ("Conexión correcta como <usuario> · N recompensa(s)").

## 6. Crear una recompensa con su regla

En **Recompensas del canal** → **Nueva recompensa**:

- **Título** (≤50), **Costo** (puntos, ≥1), **Descripción** (≤200), **Color**,
  **Habilitada** y **Pide texto al espectador**.
- **Acción al canjear** (la regla asociada):
  - **Modo A — "Reproducir un clip fijo"**: elegís un clip de la biblioteca,
    volumen, duración máxima y cooldown. Crea una acción `PlayClip`.
  - **Modo B — "URL del espectador (moderación)"**: el texto del canje es una URL
    que entra a la **cola de moderación**. Crea una acción `SubmitUserUrl` y
    **exige** que la recompensa pida texto.

La regla usa un trigger `reward_redeemed` con el **id de la recompensa**. La API
de Kick **no** tiene campos de video/volumen/duración: esos son locales
(`docs/kick-research.md` §8.1). **Borrar una recompensa no borra el clip.**

Límites de la API: **máximo 50 recompensas** por canal, y **solo la app que creó
una recompensa puede editarla o borrarla**. En la tabla, las recompensas de otras
apps se marcan como **"De otra app"** y sus botones quedan deshabilitados.

## 7. Canjes

La detección es por **polling** a
`GET /public/v1/channels/rewards/redemptions?status=pending`, con paginación por
`cursor`. Cada canje se convierte en un evento normalizado y pasa por el motor de
reglas.

Ciclo de vida de un canje:

- **Regla `PlayClip`**: el clip se **encola** y el canje se **acepta al encolar**
  (decisión documentada; ver `docs/dashboard.md`).
- **Regla `SubmitUserUrl`**: el canje queda **pendiente en Kick** mientras la URL
  espera moderación. **Aprobar** la propuesta descarga el clip y **acepta** el
  canje; **rechazar** (o una URL inválida, o una descarga fallida) sigue la
  política configurada.
- **Canje omitido** (cooldown, permisos o sin regla): según **"Al omitir un
  canje"** en Configuración:
  - **Dejarlo pendiente** (por defecto).
  - **Rechazarlo** (el espectador recupera sus puntos **si Kick lo permite** —
    `TODO(verificar)`, ver `docs/kick-research.md` §8.2).
- **Canjes viejos al iniciar**: según **"Canjes con más de N minutos"** (por
  defecto 10) y **"Qué hacer con canjes viejos"** (ignorar / rechazar / procesar).
  Si se **ignoran**, aparecen en el dashboard con los botones **"Rechazar todos"**
  y **"Procesar ahora"**.

Aceptar/rechazar se hace en **lotes de máximo 25** (`{ ids: [...] }`). La API solo
devuelve los que **fallaron**, con `reason` ∈ `UNKNOWN | NOT_PENDING | NOT_FOUND |
NOT_OWNED`; esos motivos quedan en el historial.

`user_input` es **input no confiable**: se valida como URL (whitelist, https,
longitud) antes de encolar una descarga.

## 8. Diagnóstico y límites de tasa

El panel **Diagnóstico** muestra:

- Intervalo de polling actual, último chequeo y resultado.
- Latencias de detección (última / mínima / típica / máxima de las últimas N).
- Cantidad de respuestas **429** y los **headers de rate limit** observados en la
  última respuesta.

Los **rate limits reales de Kick no están documentados** (`TODO(verificar)`). El
adaptador respeta `Retry-After` y hace backoff exponencial con jitter ante `429` o
`5xx`, y nunca reintenta en bucle sin pausa. Ver `docs/kick-research.md` §11.4
para la plantilla de mediciones.

En el panel **no** se muestran tokens, secretos ni claves, y tampoco se loguean.

## Aislamiento (para desarrollo)

Todo lo específico de Kick vive en `src/platforms/kick/`. El único archivo
autorizado a importarlo es el registro `src/platforms/index.ts`. Un test estático
(`src/platforms/isolation.test.ts`) falla si algún archivo fuera de esa carpeta
importa de allí o usa nombres/tipos de la API de Kick.

## Pendiente de verificación

- Rate limits reales de los endpoints REST de rewards/redemptions.
- Si `reject` **reembolsa** los puntos al espectador.
- Si Kick **expira** canjes pendientes automáticamente.
- Código de error exacto cuando el refresh falla por token revocado.

Todo esto se mide con el panel de diagnóstico y se anota en
`docs/kick-research.md` §11.4.