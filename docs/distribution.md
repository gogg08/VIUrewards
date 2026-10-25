# Distribución: paquete portable de Windows x64 (Etapa 2C)

Estado: **paquete de prueba**. Sirve para inspeccionar y probar la distribución,
pero todavía **no** es una instalación para usuarios finales: faltan el
instalador (`install.ps1`), el launcher con GUI, la bandeja del sistema, el
inicio con Windows y la publicación de releases.

## Estrategia C: los binarios externos se descargan al instalar

El ZIP de VIUrewards **solo contiene la aplicación**: código TypeScript, recursos
estáticos y `node_modules` de producción. **No incluye** `node.exe`,
`yt-dlp.exe`, `ffmpeg.exe` ni `ffprobe.exe`.

El instalador (Etapa 3) descarga cada herramienta **de la fuente de su
proveedor**, verifica el SHA-256 fijado en este repositorio y la instala en el
directorio de datos. Así VIUrewards no redistribuye ejecutables de terceros.

```
<VIUREWARDS_DATA_DIR>/
  app.db  media/  .uploads/  logs/  .viurewards.lock
  runtime/node.exe                 lo controla el instalador/actualizador
  bin/yt-dlp.exe                   el dashboard es su actualizador principal
  bin/ffmpeg.exe  bin/ffprobe.exe
  bin/ffmpeg-LICENSE.txt           aviso de licencia del proveedor
  bin/ffmpeg-PROCEDENCIA.txt       versión, commit y configuración de la compilación
```

Todo se verifica en `tests/dist/` (`npm run test:dist`) y en el build
(`npm run package:portable -- --smoke`).

---

## 1. Versiones fijadas

El **único** lugar donde se fijan las versiones, URLs y hashes es
`scripts/dist/config.ts` (`MANAGED_TOOLS`). Ni el script de empaquetado ni el
workflow de GitHub Actions consultan `latest`.

| Herramienta | Versión | Descarga (fija) | SHA-256 fijado | Instala en | Política |
| --- | --- | --- | --- | --- | --- |
| **Node.js** | 24.22.1 | `nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip` | `d2046d28…b95fa5` (`SHASUMS256.txt`) | `<datos>/runtime/node.exe` + `LICENSE` | `match-manifest` |
| **yt-dlp** | 2026.10.21 | `github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/yt-dlp.exe` | `33121d19…d9f555` (`SHA2-256SUMS`) | `<datos>/bin/yt-dlp.exe` | `if-missing` |
| **FFmpeg / ffprobe** | 9.0.2 essentials (gyan.dev) | `gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip` | `60f46726…047ba` (`.sha256` del proveedor) | `<datos>/bin/ffmpeg.exe`, `bin/ffprobe.exe` | `if-missing` |

Estas tres filas se copian al `manifest.json` del paquete (`managedTools`), que
es el contrato que consume el instalador. `contractVersion` permite que un
instalador futuro rechace un manifiesto con otro formato en vez de interpretarlo
a ciegas.

### Políticas de instalación

- **`match-manifest`** (Node): el runtime es de la aplicación; si el instalado no
  coincide con la versión del manifiesto, se reemplaza.
- **`if-missing`** (yt-dlp, FFmpeg): **nunca** se sobrescribe un archivo que ya
  existe. Es lo que impide que una actualización de VIUrewards pise el yt-dlp que
  el usuario actualizó desde el dashboard (Ajustes → Biblioteca y descargas).

`updatedBy` deja explícito quién actualiza después: `installer` (Node, FFmpeg) o
`dashboard` (yt-dlp).

### Qué significa cada hash (y qué NO significa)

- Los **hashes fijados** en `config.ts` se copiaron de la publicación de cada
  proveedor y no se recalculan en cada build. Si el archivo descargado no
  coincide, la descarga se **descarta**: no hay "última versión disponible".
- **No son firmas digitales.** Detectan corrupción y cambios de archivo respecto
  de lo que este repositorio fijó; no prueban autoría ni autenticidad por sí
  mismos. Además, para Node y FFmpeg el hash se sirve desde el **mismo origen**
  que el binario (nodejs.org publica `SHASUMS256.txt.sig`, una firma GPG que
  todavía **no** se verifica), así que un compromiso de ese origen afectaría a
  ambos archivos. Ver §4.
- El **SHA-256 del ZIP** (`VIUrewards-<versión>-portable-win-x64.zip.sha256`)
  sirve para detectar corrupción de la descarga o del copiado. Tampoco es una
  firma.
- Hoy **no hay firma de código** (no se pagan certificados de firma), así que el
  usuario confía en el canal de distribución (GitHub) y en los checksums.

### Por qué FFmpeg sigue siendo un build de gyan.dev

Se mantiene **exactamente la compilación que ya se probó** con VIUrewards
(`libx264` + `aac` + `loudnorm` + `scale`, que es lo que usa `src/media/args.ts`).
No se cambia de proveedor ni de configuración de códecs.

**gyan.dev es un proveedor externo**, un sitio de terceros que la página de
descargas de FFmpeg.org **enlaza**. **No es el repositorio upstream de FFmpeg.**
El paquete `ffmpeg-9.0.2-essentials_build.zip` incluye su `LICENSE` (GPLv3, por
`libx264`) y un `README.txt` con el commit de FFmpeg y la línea `configuration:`
de la compilación: el instalador los guarda junto a los binarios.

---

## 2. Estructura del paquete

```
VIUrewards-<versión>-portable-win-x64/
  VIUrewards.cmd            punto de entrada: doble clic (abre el launcher)
  app/                      código de la app (una versión)
    src/                    TypeScript que el runtime ejecuta directo
    web/ overlay/           recursos estáticos (resueltos con import.meta.url)
    scripts/start.ts        punto de entrada real
    scripts/dist/           smoke.mjs, shutdown-harness.mjs, launcher-harness.ps1,
                            launcher-gui.ps1, install-tools.ps1, config.ts,
                            fs-utils.ts
    package.json            + package-lock.json
    node_modules/           SOLO dependencias de producción (podadas)
  licenses/                 licencias de las dependencias npm redistribuidas
  manifest.json             versión, commit, plataforma, runtime esperado,
                            managedTools (URL + SHA-256) y hashes por archivo
  SHA256SUMS.txt            hashes de los archivos del paquete
  README-DISTRIBUCION.md    instrucciones de prueba manual
```

**No hay** `runtime/`, `bin/` ni `seed-tools/`, y ningún `.exe` de terceros.
`scripts/package.ts` lo verifica antes de comprimir
(`FORBIDDEN_EXECUTABLES` en `assertNoForbiddenExecutables`, más
`findForbiddenPaths` para datos, secretos y cerrojos), y `tests/dist` y el smoke
lo vuelven a verificar sobre el ZIP extraído.

Tampoco se copian tests, fixtures, `play-test.ts`, `data/`, `media/`,
`.uploads/`, `logs/`, `.env`, credenciales, cerrojos ni `.git`.

### 2.1 Por qué los recursos estáticos siguen funcionando

`web/` y `overlay/` se resuelven con `import.meta.url` **dentro** de `app/`, así
que la relación de rutas se conserva aunque el paquete se mueva. El directorio de
datos **nunca** los afecta.

### 2.2 Poda de `node_modules`

Después de `npm ci --omit=dev --ignore-scripts`, el build elimina las rutas de
`NODE_MODULES_PRUNE` (lista **explícita**, sin globs, en `config.ts`):

- **`better-sqlite3`**: los 7 prebuilds de otras plataformas (se conserva
  `prebuilds/win32-x64.node`), `deps/`, `src/` y `build/` (solo se usan para
  compilar el módulo; el binario precompilado ya contiene SQLite 3.53.4).
- **Dependencias**: carpetas `test/`, `docs/`, `examples/` y `benchmark(s)/` que
  `require()` nunca carga.

No se podan `glob/dist/esm`, `ajv/dist` ni los `.d.ts` a propósito: son rutas que
los `exports` de un paquete pueden cargar y una poda equivocada rompería el
runtime. Si una entrada no existe (por un cambio de versión), no se borra nada
más. Si la poda rompiera el runtime, **el build y `test:dist` fallan**, porque la
verificación de `better-sqlite3` se hace **después** de podar.

### 2.3 Aplicación, datos y herramientas

Tres directorios distintos, según `src/server/paths.ts`:

| Concepto | Dónde vive | Quién lo reemplaza |
| --- | --- | --- |
| **Aplicación** | la carpeta extraída del ZIP (`app/`) | una actualización de VIUrewards |
| **Datos** | `VIUREWARDS_DATA_DIR` (`app.db`, `media/`, `.uploads/`, `logs/`, `.viurewards.lock`) | nadie: persisten |
| **Runtime** | `<datos>/runtime/node.exe` | el instalador (`match-manifest`) |
| **Herramientas administradas** | `<datos>/bin/` | yt-dlp: el botón del dashboard |

Sin `VIUREWARDS_DATA_DIR`, el modo histórico escribe todo bajo el directorio de
trabajo, que en un paquete sería una carpeta de una versión reemplazable: el
launcher de la Etapa 3 **definirá** la variable.

`resolveRuntimePaths` busca el runtime de Node en `<datos>/runtime/` y después en
`<datos>/bin/` (ubicación anterior), y `VIUREWARDS_NODE_RUNTIME` tiene prioridad
sobre ambas. El runtime se usa como `--js-runtimes node:<ruta>` de yt-dlp; ver
`docs/managed-tools.md`.

---

## 3. Checksum del ZIP

```powershell
Get-FileHash .\VIUrewards-0.0.0-portable-win-x64.zip -Algorithm SHA256
```

El `Hash` debe coincidir con el contenido del `.sha256` que acompaña al ZIP. Eso
detecta corrupción; no es una firma (§1). El mismo `SHA256SUMS.txt` dentro del
paquete permite verificar cada archivo extraído.

---

## 4. Licencias y redistribución

### Lo que sí viaja en el paquete

- **Dependencias npm** (`fastify`, `ws`, `better-sqlite3`, …):
  `licenses/<paquete>.txt`, con la licencia declarada en su `package.json` y su
  archivo de licencia.
- **SQLite**: `licenses/SQLITE.txt` (dominio público, con el texto de atribución
  del header de SQLite 3.53.4 que embebe `better-sqlite3`).

### Lo que NO viaja y por qué

Node.js, yt-dlp y FFmpeg **los descarga el instalador** desde su proveedor y los
deja en el directorio de datos con sus avisos (`MANAGED_TOOLS[].notices`). El
paquete ya no redistribuye esos ejecutables.

**Esto reduce el alcance, pero no elimina todas las obligaciones legales.** Lo que
hay que tener presente antes de publicar:

1. **FFmpeg es GPLv3.** El binario de gyan.dev es una compilación **estática** con
   `libx264` y bibliotecas externas incluidas. Quien **redistribuya** ese binario
   (por ejemplo, si en el futuro se sirviera una copia propia, o si el instalador
   lo dejara dentro de un paquete que la gente descarga de nuestro canal) asume
   las obligaciones de la GPLv3: ofrecer el *Corresponding Source* completo de esa
   compilación exacta, incluidos los scripts de control de compilación e
   instalación y las bibliotecas externas. **Descargarlo directamente del
   proveedor no cambia el hecho de que el usuario final recibe un binario GPLv3**;
   sí cambia quién hace la distribución. La procedencia y el texto de la licencia
   quedan junto a los binarios.
2. **El hash fijado no es una firma.** Ver §1.
3. **La licencia de VIUrewards no está declarada.** El repositorio no tiene
   archivo `LICENSE` y esa decisión es del autor del proyecto: **no se inventa una**
   ni se crea el archivo desde el código. Sin ella, el paquete no puede presentarse
   como listo para publicarse.

### VIUrewards y los programas externos

VIUrewards invoca la app como procesos **separados** (`spawn`, argumentos en
array, `shell: false`) y se comunica por línea de comandos y archivos: los hechos
técnicos son los de programas independientes que cooperan. La orientación general
de la FSF sobre agregación e "obra combinada" no es un dictamen jurídico, y
**este documento no declara** que la agregación sea legalmente definitiva:
**requiere asesoramiento legal** antes de una publicación que conceda permisos de
reutilización del código.

> **Bloqueante antes de publicar:** la licencia de VIUrewards no está decidida y
> las obligaciones de redistribución de FFmpeg deben aclararse para el canal de
> distribución que se elija. El paquete actual es de **prueba**.

---

## 5. Cierre ordenado en el paquete

### Limitación real de Windows

En Windows, un proceso de Node **sin consola interactiva** no puede entregar
`SIGINT`, `SIGTERM` ni `SIGBREAK` a otro proceso. Se verificó en este repositorio:

- `child.kill("SIGTERM")` y `child.kill("SIGINT")` terminan el hijo **sin que
  corran sus handlers** (siempre `signal`, nunca `code: 0`).
- `child.kill("SIGBREAK")` se traduce a `SIGKILL`.
- `AttachConsole(pid)` desde una sesión no interactiva devuelve
  `ERROR_ACCESS_DENIED`.
- `taskkill` sin `/F` falla («solo se puede terminar de forma forzada»).

Consecuencia: **la automatización no puede probar el cierre por señales del
sistema operativo.** `AppServer.stop()` y `jobs.stop()` **no** tienen ningún
defecto: se comprobó que terminan en milisegundos con datos temporales.

### Cómo se prueba el cierre en la automatización

El paquete incluye `app/scripts/dist/shutdown-harness.mjs`, un **arnés IPC** que:

1. corre la **misma** secuencia que `scripts/start.ts` (`resolveRuntimePaths` →
   `prepareDataDir` → `acquireSharedResourcesLock` → `openDatabase` → limpieza →
   `reconcileClips` → `createServer` → `start`);
2. instala los **mismos** handlers de `SIGINT`/`SIGTERM`/`SIGBREAK`;
3. usa el **mismo** `createShutdownController` de `src/server/shutdown.ts`
   (`server.stop()` → `closeDb` → `closeLog`);
4. recibe `{shutdown:true}` por IPC y llama a `controller.shutdown("ipc")`, que
   es exactamente el camino de una señal.

No hay una implementación de apagado alternativa para tests. La única
diferencia con producción es el canal de control.

**El canal está cerrado en el uso normal:** el arnés exige simultáneamente un
canal IPC (`process.send`) y la variable `VIUREWARDS_TEST_IPC_TOKEN` con el token
del test. Sin ellas se niega a arrancar (código 1) sin abrir SQLite. No agrega
ninguna ruta HTTP ni ningún archivo que el usuario pueda disparar.

### Qué verifica el smoke del paquete

`app/scripts/dist/smoke.mjs`, ejecutado con el **runtime fijado** (externo al
paquete):

1. la versión y el **ABI** del runtime coinciden con el manifiesto;
2. el paquete **no** incluye `runtime/node.exe`;
3. `better-sqlite3` crea, escribe con WAL, lee, cierra y **reabre**;
4. el servidor del paquete arranca de verdad (`scripts/start.ts`);
5. `/` → 302 a `/login`, `/login`, `/web/*`, `/guia` → 200; `/overlay` sin
   clave → 403; `/api/state` y `/media/*` sin sesión → 401;
6. la base, `media/`, `.uploads/` y `logs/` se crean en el directorio de datos y
   **no** dentro del paquete;
7. el **cierre ordenado** por el arnés: proceso terminado, **código 0**, mensaje
   «VIUrewards se cerró correctamente.», base reabrible con el esquema aplicado
   (`user_version` > 0) y cerrojo liberado;
8. cerrojo tras un cierre forzado: queda con el pid de un proceso muerto y una
   instancia nueva puede retomarlo;
9. el paquete no trae secretos, cerrojos, `seed-tools/`, `runtime/` ni
   ejecutables de terceros.

Sale con **0** si todo pasa, **1** si algo falla y **2** si alguna comprobación
quedó **omitida** (una omisión nunca cuenta como éxito, y el build falla).

### Ctrl+C real: prueba MANUAL

En una consola interactiva, Ctrl+C **sí** llega a los handlers (probado a mano
con `npm start` en desarrollo). Falta repetirlo con el paquete distribuido:

```powershell
$env:VIUREWARDS_DATA_DIR = "C:\VIUrewards-datos"
$env:VIUREWARDS_NODE_RUNTIME = "C:\ruta\al\node.exe"
C:\ruta\al\node.exe .\app\scripts\start.ts
# ... abrir el dashboard, bajar una descarga si se quiere ...
# Ctrl+C  → debe imprimir "VIUrewards se cerró correctamente." y volver al prompt
```

Estado: **pendiente** con el paquete. No se afirma que esté verificado.

### Cerrojo si el proceso muere a la fuerza

`.viurewards.lock` puede quedar tras una salida forzada. La recuperación sigue
confiando en el mecanismo de `src/db/instance-lock.ts`: si el pid del cerrojo ya
no existe (`ESRCH`) o el archivo es ilegible y tiene más de 7 días, se libera; si
el pid **existe**, se respeta. Nunca se borra un cerrojo "porque falló un
intento". El launcher futuro, si reinicia enseguida, tiene que esperar la
terminación del proceso anterior y tratar el código de salida `3` como «datos en
uso».

### 5.1 Canal de control del launcher (Etapa 3A)

El launcher de PowerShell necesita saber cuándo el servidor está listo, pedirle
un cierre **ordenado** y esperar la terminación. En Windows no hay señal que
sirva (`child.kill("SIGINT"|"SIGTERM")` mata sin correr los handlers;
`SIGBREAK` se traduce a `SIGKILL`), así que el canal es un **named pipe local**
con nombre aleatorio y token.

```
launcher                              servidor (scripts/start.ts)
   │  --Control=<id> --Exchange=<token>   │
   │ ────────────────────────────────────►│  abre \\.\pipe\viurewards-control-<id>
   │◄── {"type":"accepted","pid":…} ─────│
   │◄── {"type":"started","port":…} ─────│  (también a una conexión tardía)
   │──── {"type":"shutdown",
   │        "exchange":"<token>"} ───────►│  → controller.shutdown("launcher")
   │◄── {"type":"closing","reason":…} ───│
   │◄── {"type":"finished","code":0} ────│  (justo ANTES de salir)
```

Mensajes en **NDJSON** (una línea JSON por mensaje, `\n` al final).

Reglas de seguridad:

- El canal **solo existe** con `--Control` y `--Exchange` válidos; sin ellos no
  se abre ningún pipe. `npm start`, Ctrl+C y el arnés de distribución no cambian.
- Toda orden debe traer `exchange` **exactamente** igual al token (16-256
  caracteres URL-safe). Una orden sin el token se ignora y el servidor sigue.
- El token **nunca** se registra en el log ni viaja en los mensajes del servidor,
  y no se persiste en ningún archivo.
- Una orden repetida (o una segunda conexión) **no** fuerza la salida: solo una
  segunda **señal** de consola fuerza.
- El cierre pasa por el MISMO `createShutdownController` de producción.
- No hay endpoint HTTP de apagado ni archivo de control persistente.

Lo que este diseño **no** garantiza (comprobado en este repositorio):

- El **nombre del pipe no aísla por usuario**. Se comprobó que otro proceso local
  que solo conoce `\\.\pipe\viurewards-control-<id>` puede conectarse, leer los
  mensajes del servidor (`accepted`, `started`, …) y escribir en el canal. No se
  verificó la ACL que aplica Node al crear el pipe, así que no se afirma que
  esté restringida al usuario creador.
- El control depende del **token**: sin él no se cierra nada. El id es aleatorio,
  lo que hace el nombre difícil de adivinar.
- El token viaja en los **argumentos del proceso** (`--Exchange=`): un proceso
  con acceso a la línea de comandos de esta sesión puede leerlo. El token **no**
  protege frente a procesos del mismo usuario con esa visibilidad.
- Se **acepta** esta configuración para una aplicación de escritorio de un solo
  usuario. El peor caso de un vecino local es cerrar la propia instancia o ver
  su puerto y sus URLs locales (siempre `127.0.0.1`), no escalar privilegios.

Detalle de implementación que importa: el proceso sale con `process.exit`, que
**corta el I/O pendiente**, y `closeDb` corre después de `server.stop()`. Por eso
el aviso `finished` no se envía al resolver `requestShutdown` (nunca llegaría):
se emite desde `onBeforeExit`, que el controlador invoca justo antes de salir y
**espera** a que el mensaje entre en el pipe.

Códigos de salida que el launcher debe distinguir:

| Código | Significado | Qué hace el launcher |
|---|---|---|
| `0` | cierre ordenado | nada más; los recursos se liberaron |
| `1` | salida forzada o error de arranque | informar, ofrecer reintentar |
| `2` | `VIUREWARDS_DATA_DIR` inválida | mostrar el mensaje y pedir la ruta |
| `3` | **datos en uso**: ya hay otra instancia | **no matar ni detener**; ofrecer abrir el dashboard existente |

El launcher de prueba (`scripts/dist/launcher-harness.ps1`) implementa este flujo
completo desde PowerShell 5.1 y lo ejercitan los e2e
(`tests/e2e/launcher-control.test.ts`). La misma capacidad se comprueba sobre el
**paquete extraído** en `scripts/dist/smoke.mjs` (con un cliente de pipe en Node,
que es lo que permite el arranque por `--Control` sin PowerShell): `accepted`,
`started`, la orden sin token ignorada, `closing`, `finished`, código 0, cerrojo
liberado y base reabrible. No es la GUI: la interfaz llega en una etapa
posterior.

---

## 6. Cómo construir y probar

### Localmente

```powershell
# El build EXIGE el Node fijado (el runtime que la instalación va a usar).
build\tools\node-v24.22.1-win-x64\node.exe scripts\package.ts --smoke
# o con el script de npm si el Node activo es 24.22.1:
npm run package:portable -- --smoke
```

Opciones: `--keep-staging` (no borra el staging), `--no-zip`, `--smoke` (corre el
smoke sobre el ZIP extraído y falla el build si hay fallas u omisiones),
`--out=<dir>`.

El build **no descarga nada**: no hay `--skip-download` ni caché de artefactos
porque el ZIP no incluye binarios externos.

Artefactos: `build/dist/VIUrewards-<versión>-portable-win-x64.zip` y su
`.sha256`. Nunca dentro del directorio del paquete.

### Runtime para el smoke y para `test:dist`

El paquete no trae `node.exe`, así que tanto el smoke como `test:dist` usan el
runtime **fijado**:

1. `VIUREWARDS_TEST_NODE_EXE` (ruta explícita; se comprueba la versión);
2. la caché `build/downloads/node-v24.22.1-win-x64.zip` (se verifica el SHA-256);
3. si no está, se **descarga** de la URL versionada de `config.ts`, se verifica
   contra el hash fijado y queda en la caché. Las ejecuciones siguientes la
   reutilizan.

Si la descarga falla o el hash no coincide, **el test falla** con el motivo: no
se omite por falta de red. El workflow define `VIUREWARDS_TEST_NODE_EXE` con el
Node del runner (que ya es la versión fijada), así que en CI no hay red extra.

### En GitHub Actions

`.github/workflows/package-windows.yml`, solo `workflow_dispatch`:

- runner `windows-latest`, permisos `contents: read`;
- Node del runner = `NODE_VERSION` de `config.ts` (lo lee del archivo);
- corre `typecheck`, `npm test`, `npm run test:e2e` (instala ffmpeg con
  Chocolatey; si falla, el paso falla) y `npm run test:dist` sobre el ZIP recién
  construido;
- construye con `--smoke`;
- sube el ZIP, el `.sha256` y el `manifest.json` extraído **del propio ZIP**;
- **No** crea tags, **no** publica releases y **no** escribe en el repositorio.

Retención: `retention_days` (1, 3 o 7 días; GitHub Free permite hasta 90). El
artefacto se sube sin recompresión (`compression-level: 0`) para no guardar una
segunda copia comprimida del ZIP.

### Tests del paquete

```powershell
npm run test:dist
```

`tests/dist/config.test.ts` valida la configuración (sin red ni build) y
`tests/dist/package.test.ts` extrae el ZIP a una ruta temporal **con espacios** y
ejecuta el paquete con el runtime fijado. Si no hay ZIP, el grupo se **omite** con
el motivo a la vista (no pasa por verde).

`tests/dist/launcher.test.ts` (Etapa 3C) prueba el launcher del ZIP extraído:
`-SelfTest` (raíz de la app, datos fuera de la app, Windows Forms y que los
workers corran en un runspace), validación de rutas (relativa, raíz de unidad,
cualquier profundidad dentro de la app, hermano con prefijo compartido,
precedencia `-DataDir` > `VIUREWARDS_DATA_DIR` > `%LOCALAPPDATA%`), el ciclo de
vida real (`started` → cierre por el canal → código 0 → proceso terminado →
cerrojo liberado → SQLite reabrible), arranque/parada repetidos sin duplicar
procesos, datos en uso (**código 3**, cerrojo ajeno intacto), fallos de
runtime/instalador y el acceso directo de inicio (idempotente, en una carpeta
temporal). **No** descarga herramientas: siembra el runtime fijado y no ejecuta
`yt-dlp -U`.

---

## 7. Tamaño real

Build de la Etapa 2C (commit `f7050b5` + cambios de esta etapa):

| Componente | Tamaño |
| --- | --- |
| **ZIP completo** | **5.6 MB** (5 827 919 bytes, build de la Etapa 3C con el launcher corregido) |
| Contenido del paquete (sin comprimir) | 15.5 MB, 2021 archivos |
| `app/` (código + estáticos + `node_modules` podados) | ~15 MB |
| `licenses/` | ~0.4 MB (312 archivos) |
| `node_modules` podado | −28.6 MB (33 rutas) |

Comparación con la Etapa 2 clásica (que sí redistribuía todo): **141.0 MB** y
352.0 MB sin comprimir, con `runtime/` 89.7 MB y `seed-tools/bin/` 217.9 MB.
El ZIP cambia con cada build (el manifiesto guarda `builtAt` y el commit), así
que el hash se informa en el reporte de cada build, no acá.

---

## 8. Instalador de herramientas (`install-tools.ps1`, Etapa 3B)

Prepara una instalación por usuario **sin requerir administrador**: descarga
Node.js, yt-dlp y FFmpeg/ffprobe desde el proveedor de cada uno, verifica el
SHA-256 fijado y los deja en el directorio de datos.

```
powershell -NoProfile -ExecutionPolicy Bypass -File install-tools.ps1 `
  -DataDir "C:\VIUrewards-datos"
# o, sin -DataDir, con VIUREWARDS_DATA_DIR ya definida
```

Compatible con **Windows PowerShell 5.1**. Vive en `app/scripts/dist/` dentro del
paquete (la instalación no existe todavía la primera vez, así que no puede
buscarlo fuera de la aplicación).

### 8.1 Qué instala y dónde

| Destino | Origen | Política |
| --- | --- | --- |
| `<datos>/runtime/node.exe` | ZIP oficial de Node.js | `match-manifest` |
| `<datos>/runtime/LICENSE` | aviso MIT del ZIP | aviso |
| `<datos>/bin/yt-dlp.exe` | release oficial de GitHub | `if-missing` |
| `<datos>/bin/ffmpeg.exe`, `bin/ffprobe.exe` | ZIP de gyan.dev | `if-missing` |
| `<datos>/bin/ffmpeg-LICENSE.txt` | texto GPLv3 del ZIP | aviso |
| `<datos>/bin/ffmpeg-PROCEDENCIA.txt` | README del ZIP (commit, bibliotecas) | aviso |

Nada se escribe dentro de `app/`. Los avisos de FFmpeg viajan **junto a los
binarios** (§4).

### 8.2 Políticas

- **`if-missing`** (yt-dlp, FFmpeg): si el destino ya existe **no se sobrescribe**.
  El usuario pudo haberlo actualizado — en yt-dlp, desde el botón del dashboard,
  que sigue siendo el mecanismo principal. Una actualización de VIUrewards no
  pisa esa versión. Una instalación **parcial** (algunos archivos sí, otros no)
  se rechaza en vez de completarse a ciegas.
- **`match-manifest`** (Node): se compara el SHA-256 del **archivo instalado**
  (`installedSha256` en `config.ts`), no el del ZIP. Si coincide, no se toca; si
  difiere, se exige `-ForceRuntime`. El hash del ZIP (`asset.sha256`) sirve para
  verificar la descarga, no para comparar `node.exe`.

### 8.3 Seguridad de la instalación

1. Cada artefacto se descarga a `<datos>/.downloads/<archivo>.part` y se
   **verifica antes de extraer**. Un hash incorrecto, una descarga truncada o un
   error de red descartan el archivo sin tocar la instalación existente.
2. Se extrae **solo lo declarado** en `install` y `notices`, nunca el ZIP
   completo (`ZipArchive.GetEntry`; en PowerShell 5.1 la extensión
   `ZipFileExtensions::OpenRead` no es accesible por nombre).
3. Toda ruta de destino se comprueba con `Assert-InsideDataDir` **antes** de
   escribir: nada puede quedar fuera del directorio de datos.
4. La escritura va a `<destino>.installing` y después `Move-Item` (atómico en el
   mismo volumen). Si algo falla, se borran los `.installing`: no quedan
   ejecutables a medio escribir. `.downloads` y `.trabajo` están en el mismo
   volumen que los destinos, así que nunca se cruza un disco.
5. Antes de crear `.downloads` se comprueba que **no haya una instancia usando
   los datos** (`.viurewards.lock` con un PID vivo → código **3**). Un cerrojo
   **huérfano** (PID inexistente) se informa y no bloquea.
6. Se rechazan rutas incoherentes **antes de escribir**: relativas, inexistentes
   como archivo, sin `-DataDir` ni variable y la raíz de una unidad (`C:\`) →
   código **2**.
7. Nunca se instala **dentro de la aplicación** → código **2**, a **cualquier
   profundidad**. La raíz protegida se deduce de `$PSScriptRoot`, el
   `scripts/dist` donde vive el propio script: en fuentes `<repo>/scripts/dist`
   → `<repo>`, y en el paquete `<paquete>/app/scripts/dist` → `<paquete>/app`
   (ambos tienen `package.json`; si no lo tuvieran, no se inventa una raíz). La
   comparación es explícita entre rutas **absolutas normalizadas**, con el
   separador obligatorio: la raíz exacta y cualquier subdirectorio se rechazan,
   y `C:\VIUrewards-data` **no** cuenta como subdirectorio de `C:\VIUrewards`.
   Así `-DataDir <app>\media` (o `<app>\data`, `<app>\logs`, `<app>\` con barra
   final, un equivalente con `..` y separadores mezclados, o una carpeta anidada
   cinco o más niveles dentro) se rechaza igual que `<app>`. No hay tope de
   profundidad, así que no depende de cuántos niveles tenga el destino.

> **Incidente corregido.** Una versión anterior solo comparaba el directorio de
> datos **exacto** con la raíz de la aplicación. Apuntar `-DataDir` a
> `<app>\media` o `<app>\data` instalaba `runtime/` y `bin/` dentro del código y
> devolvía **0**. `tests/dist/installer.test.ts` lo reproduce sobre una
> estructura temporal (nunca sobre el repositorio) y se verificó por mutación en
> ambos sentidos: sin el guard de ancestros el test falla.

> **Segundo defecto, corregido en la Etapa 3B.2.** El guard empezó a deducir la
> raíz por `$PSScriptRoot`, pero la variable local que la guardaba se llamaba
> `$applicationRoot`, y **PowerShell no distingue mayúsculas entre variables**:
> era la MISMA variable que el parámetro `$ApplicationRoot`. Inicializarla a
> `$null` borraba el parámetro, de modo que el guard solo podía rechazar la raíz
> deducida y seguía instalando dentro de una app temporal o anidada. La variable
> local pasó a llamarse `$guardRoot`, y `tests/dist/config.test.ts` tiene una
> comprobación estática que falla si vuelve el nombre en conflicto.

### 8.4 Códigos de salida

| Código | Significado |
| --- | --- |
| `0` | herramientas listas (instaladas ahora o ya válidas) |
| `1` | fallo (hash, red, herramienta en uso, instalación parcial) |
| `2` | configuración de rutas inválida; **no se escribió nada** (`data-dir-missing`, `data-dir-relative`, `data-dir-invalid`, `data-dir-is-drive-root`, `data-dir-not-a-directory`, `data-dir-is-application`) |
| `3` | otra instancia está usando esos datos; **no se escribió nada** |

The instalador imprime al final un JSON con `status`, `reason`, `message`,
`dataDir`, `contractVersion` y `tools` (por herramienta: id, versión, si quedó
instalada, si se reemplazó y los archivos).

### 8.4.1 Semántica de los fallos a mitad de instalación

Cada herramienta se instala **de forma independiente**. Si Node ya quedó
instalado y falla yt-dlp (hash incorrecto, red, `Move-Item` bloqueado):

- Node **queda instalado** (no se revierte: es un artefacto válido y verificado);
- la herramienta que falló **no deja ejecutables parciales**: se extrae y se
  copia a `<destino>.installing` y se borra en el `catch`;
- `.downloads`/`.trabajo` se limpian al salir (con `-KeepDownloads` se conservan
  las descargas ya verificadas para reintentar sin red);
- un reintento completa en la **misma** carpeta sin limpieza manual.

`-ForceRuntime` **no** saltea el cerrojo: con una instancia activa el instalador
sale con código **3** antes de descargar o reemplazar `node.exe`, el cerrojo
conserva sus bytes y no se termina ningún proceso.

### 8.5 Las versiones salen de `config.ts`

La tabla `$Tools` del `.ps1` es **generada** desde `scripts/dist/config.ts`
(`npm run build:installer`); su lógica no lee el `.ts` en tiempo de ejecución.
`tests/dist/config.test.ts` falla si el bloque generado quedó desfasado, así que
una versión no puede quedar distinta en los dos lugares. El `.ps1` se mantiene en
**ASCII puro y CRLF** (PowerShell 5.1 mal-decodifica UTF-8 sin BOM y rompe el
parseo con terminadores mezclados).

### 8.6 Qué verifica `tests/dist/installer.test.ts`

Ejecuta el `.ps1` **real** contra directorios temporales con espacios, sembrando
`build/downloads/` (la caché ya verificada; si falta algo se descarga una vez y
se comprueba el hash, y un fallo hace fallar la suite, nunca la omite):
instalación completa y hashes, `node.exe` que se ejecuta y reporta la versión
fijada, reinstalación idempotente (mismos bytes), conservación de yt-dlp y FFmpeg
del usuario, cerrojo en uso (código 3, cerrojo y árbol intactos), `-ForceRuntime`
rechazado mientras una instancia usa los datos (cerrojo y `node.exe` con los
mismos bytes, ningún proceso terminado), cerrojo huérfano, hash incorrecto, ZIP
con entradas que escapan, rutas inválidas (incluida la raíz de unidad y una
estructura de aplicación temporal, con sus subcarpetas y formas equivalentes),
fallo a mitad de instalación y reintento, fallo al mover el ejecutable (destino
bloqueado), `VIUREWARDS_DATA_DIR`, y que no se toca la base ni los medios de otro
directorio.

**No** descarga medios ni ejecuta `yt-dlp -U`.

---

## 8.7 Launcher con GUI (`launcher-gui.ps1`, Etapa 3C)

El launcher es una **ventana de Windows Forms** en Windows PowerShell 5.1
(`app/scripts/dist/launcher-gui.ps1`), sin dependencias externas ni ejecutables
compilados. El usuario hace doble clic en **`VIUrewards.cmd`**, en la raíz del
paquete:

```
VIUrewards-<versión>-portable-win-x64/
  VIUrewards.cmd     <- punto de entrada (doble clic)
  app/scripts/dist/launcher-gui.ps1
                     <- NO se copia a la raíz: deduce la raíz de la app desde
                        $PSScriptRoot (`<pkg>/app/scripts/dist` -> `<pkg>/app`),
                        igual que `install-tools.ps1` para su guard
```

El `.cmd` invoca `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` con la
ruta entrecomillada (`%~dp0`, admite espacios) y pasa `%*`, así que
`VIUrewards.cmd -DataDir "C:\datos"` funciona igual que el `.ps1`.

### Qué hace

1. Resuelve el directorio de datos **antes de nada** (ver precedencia abajo) y
   rechaza una ruta relativa, la raíz de una unidad o cualquier carpeta **dentro
de la aplicación** (a cualquier profundidad).
2. Comprueba `<datos>/runtime/node.exe` y `<datos>/bin/{yt-dlp,ffmpeg,ffprobe}.exe`.
   Si falta alguno, ejecuta `install-tools.ps1 -DataDir <datos>` y muestra el
   progreso en el registro; si la instalación falla, **no arranca** el servidor.
3. Arranca `scripts/start.ts` con el `node.exe` de `<datos>/runtime`, con el canal
   de control de §5.1 (`--Control`/`--Exchange` nuevos en cada arranque) y con
   `VIUREWARDS_DATA_DIR`/`VIUREWARDS_NODE_RUNTIME` apuntando a las rutas
   resueltas. **No** fija `--port` ni `PORT`: el puerto es el de Ajustes (8787 por
   defecto) y la URL real llega en el mensaje `started`.
4. **Detener servidor** pide el cierre por el canal (misma secuencia de
   producción que Ctrl+C) y espera `finished` y la terminación real del proceso.
   Si no responde en el plazo, termina **solo el árbol de su propio hijo**
   (`taskkill /PID <pid> /T /F`); nunca por nombre ni por PID buscado.
5. **Abrir dashboard** solo se habilita con la URL que informó el servidor.

### Estados

`Detenido`, `Preparando herramientas`, `Iniciando`, `En ejecución`,
`Deteniendo`, `Error`. Mientras hay una operación en curso los botones quedan
deshabilitados. Las operaciones largas corren en un **runspace aparte** y la GUI
las sondea con un `Timer` de 200 ms, así que la ventana nunca se bloquea.

### Bandeja y cierre de la ventana

Cerrar la ventana **no** tira el servidor: la oculta en la bandeja (icono con
menú Mostrar ventana / Abrir dashboard / Detener servidor / Salir). **Salir** pide
el cierre ordenado si hay servidor y recién después cierra la aplicación. El
servidor sigue siendo hijo de este launcher y conserva el token: no hay un
servidor autónomo que después nadie pueda detener.

#### Cómo se abre la ventana y se bombean los mensajes (defecto corregido)

La ventana se abre con **`$form.Show()` + `[Application]::Run($form)`**. No se usa
`ShowDialog()` ni `Application.Idle`, por dos defectos medidos con el ZIP real:

- Con `ShowDialog()`, enviar `WM_CLOSE` (la X) hacía que el **proceso saliera con
  código 0**. Reproducido dos veces, también con `-NoStart`. El servidor quedaba
  sin ventana ni bandeja, con el cerrojo tomado por un proceso que nadie
  controlaba y el launcher siguiente informaba «datos en uso». Un `Form` aislado
  con `$e.Cancel = $true` + `Hide()` sí se ocultaba: el problema era el modo de
  mostrar, no el handler.
- Con `NotifyIcon`, los clics **no llegaban** a sus handlers porque no había
  *message loop* de Windows Forms corriendo. Está verificado que `NotifyIcon` sí
  crea su ventana oculta y despacha `WM_APP+1024` a `MouseDoubleClick` etc., pero
  solo si hay un loop que bombee los mensajes.
- `Application.Idle` **no se dispara** en esta sesión (medido con `Shown`+`Idle`: la
  GUI retornaba de inmediato y el servidor nunca arrancaba). Por eso el arranque
  inicial cuelga de un `Timer` de un solo disparo que corre ya con el loop activo,
  y un `Timer` vacío de 250 ms mantiene el hilo despierto para que Windows siga
  repintando cuando no hay actividad.

El patrón nuevo se validó antes en un caso aislado: `Show()` + `Application.Run()`
bombea, la X **oculta** (`visible=False`), «Mostrar ventana» restaura y
`Application.ExitThread()` sale limpio.

#### Clics de la bandeja

El icono se hace **visible después** de `$form.Show()` y con el loop a punto de
arrancar; activarlo en el bloque de construcción hacía que se dibujara pero que
los clics no llegaran a nadie (medido).

| Gesto | Qué hace |
| --- | --- |
| Clic izquierdo | Restaura la ventana (`Add_MouseClick`, rama `Left`) |
| Doble clic | Restaura la ventana (`Add_DoubleClick`) |
| Clic derecho | Abre el `ContextMenuStrip` del icono **por el shell** |

El clic derecho **no** se atiende a mano. Abrir el menú también desde
`MouseClick` lo desplegaba y lo cerraba en el mismo clic, así que el menú no se
podía usar; el shell de Windows ya lo abre, y es el comportamiento esperado.

Esto lo fija `tests/dist/launcher.test.ts` («la ventana se abre con
Show()+Application.Run()…»), **verificado por mutación** sobre un ZIP alterado:
volver a `ShowDialog()`, activar `$notify.Visible` en el bloque de construcción o
re-añadir la rama del clic derecho hacen fallar el test.

#### Alcance de las variables de la ventana (defecto corregido)

El cuerpo de la GUI se invoca **con punto** (`. ${function:Show-ViuLauncher}`),
no como función. El cuerpo arma la ventana con variables **sin calificar**
(`$form`, `$notify`, `$menuExit`, …); como función, esas variables viven en el
alcance de la función, y los `scriptblock` de los eventos —que se ejecutan con
la ventana ya abierta— no las encuentran: con `Set-StrictMode -Version 2.0` la X
(`FormClosing`) y **Salir** (clic del menú) lanzaban `VariableIsUndefined` antes
de ocultar la ventana, así que el launcher **no desaparecía a la vista** aunque
el servidor seguía corriendo. Con punto el cuerpo corre en el alcance del script,
que sigue vivo mientras dura el message loop, y los eventos ven las variables.

Por eso `-SelfTest` se atiende **antes** de invocar el cuerpo: esa rama termina
en `return` y, con punto, un `return` sale del script sin ejecutar el `exit` de
abajo (medido: un caso inválido informaba `ok` con código 0). El código de salida
final es explícito (`exit 0`), no `$LASTEXITCODE`, que no existe en un script y
sin él `exit` tomaba el último código de un proceso externo (medido: 2).

Esto lo fija `tests/dist/launcher.test.ts` («atiende -SelfTest antes de invocar
el cuerpo…»): falla si vuelve la invocación como función o `exit $LASTEXITCODE`.
El efecto visual de la X y del icono de bandeja sigue siendo **prueba manual**
(ver el final de esta sección).

### Inicio con Windows

Acceso directo en la carpeta **Inicio del usuario actual** (sin administrador)
que relanza el mismo `.ps1` con `-AutoStart`: abre minimizado en la bandeja y
pide el arranque. Se activa y se desactiva de forma **idempotente** (activar dos
veces deja un solo `.lnk`; desactivar dos veces no falla).

### Directorio de datos (precedencia)

| Orden | Origen | Regla |
| --- | --- | --- |
| 1 | `-DataDir` | Ruta absoluta; manda sobre todo lo demás |
| 2 | `VIUREWARDS_DATA_DIR` | Ruta absoluta; mismo contrato que `src/server/paths.ts` |
| 3 | `%LOCALAPPDATA%\VIUrewards` | Directorio persistente por usuario |

Nunca se acepta una ruta dentro de la aplicación (`data-dir-is-application` en el
instalador y el mismo rechazo en el launcher). La base, `media/`, `.uploads/`,
`logs/`, `bin/` y `.viurewards.lock` viven en el directorio de datos.

### Datos en uso (código 3)

Si hay otra instancia usando los datos, el servidor sale con **código 3**. El
launcher lo informa como «Ya hay otra copia de VIUrewards usando estos datos.
Esta ventana NO la detiene»: no manda ninguna orden, no mata nada y no toca el
cerrojo ajeno (el instalador devuelve el mismo código en la misma situación).

### Limitación de la automatización de Windows

Los tests de distribución cubren la GUI de forma indirecta: `-SelfTest`
construye los controles reales y **ejecuta los workers en un runspace** (así se
detectó que un worker no puede llamar a helpers del launcher), el contrato de la
ventana y de la bandeja se fija con tests estáticos sobre el `.ps1` extraído del
ZIP, y el ciclo de vida se ejercita con las mismas funciones que usa la GUI.

Construir la ventana entera fuera de un escritorio interactivo **tampoco** es
fiable: en la sesión no interactiva de este entorno la ventana se puede enumerar
y se le puede enviar `WM_CLOSE` (así se midió que con `ShowDialog()` el proceso
salía con código 0), pero **los clics reales del shell sobre el icono de bandeja
no se pueden inyectar**. **Quedan como pruebas MANUALES**:

1. Abrir el launcher: aparece la ventana y, si no hay servidor, arranca solo.
2. Cerrar con **X**: la ventana se oculta y el icono queda en la bandeja.
3. **Clic izquierdo** y **doble clic** en el icono: la ventana vuelve.
4. **Clic derecho**: se abre el menú (Mostrar ventana / Abrir dashboard /
   Detener servidor / Salir).
5. **Salir**: detiene el servidor por el canal, espera la terminación y cierra.
6. Activar «Iniciar con Windows» y comprobar que el acceso directo arranca la
   aplicación minimizada en la bandeja tras reiniciar el equipo.

---

## 9. Lo que falta antes de distribuir

1. **Licencia del proyecto** (decisión del autor) y aclarar las obligaciones de
   redistribución de FFmpeg para el canal elegido (§4).
2. **Instalador gráfico y actualización automática de la aplicación.** El
   launcher con GUI, la bandeja y el inicio con Windows ya existen (§8.7); falta
   decidir y construir cómo se actualiza VIUrewards (el repositorio es privado por
   ahora, así que no hay actualizador y el launcher no muestra un botón falso).
3. **Prueba manual de Ctrl+C con el paquete** (§5) y, si se puede, una prueba en
   una máquina sin Node instalado.
4. Verificar la firma GPG de `SHASUMS256.txt` de Node (hoy no se verifica) y
   evaluar una firma para el propio ZIP.
5. Decidir si se firma el código (hoy no se paga certificado).
