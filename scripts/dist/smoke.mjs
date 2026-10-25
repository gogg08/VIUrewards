#!/usr/bin/env node
/**
 * Smoke test del PAQUETE (Fase de distribución, Etapa 2C, Parte G).
 *
 * No usa ni mira el repositorio: se ejecuta con el **runtime fijado, externo al
 * paquete** (el ZIP no redistribuye `node.exe`; lo instala el instalador desde
 * nodejs.org) y solo escribe en directorios temporales.
 *
 * Qué verifica (y qué NO):
 *
 *  1. El runtime que lo ejecuta coincide con la versión y el ABI del manifiesto.
 *  2. `better-sqlite3` se carga desde ese runtime: crea base, tabla, fila,
 *     consulta, cierra y REABRE.
 *  3. El servidor del paquete arranca de verdad (`scripts/start.ts`) con un
 *     `VIUREWARDS_DATA_DIR` temporal (ruta con espacios) y un puerto libre.
 *  4. El dashboard, el login, los recursos estáticos, `/guia` y las reglas de
 *     acceso (`/api/*` → 401, overlay sin clave → 403) responden.
 *  5. La base, `media/`, `.uploads/` y `logs/` se crean en el directorio de
 *     datos y NO dentro del paquete.
 *  6. El **cierre ordenado** se ejerce con el arnés IPC (`shutdown-harness.mjs`),
 *     que corre la MISMA secuencia y el MISMO controlador que producción, y con
 *     él se comprueba: proceso terminado, código 0, base reabrible, cerrojo
 *     liberado y sin procesos vivos de la prueba.
 *  7. El **canal de control del launcher** (Etapa 3A) funciona sobre el paquete
 *     extraído: `scripts/start.ts` arranca con `--Control=<id> --Exchange=<token>`
 *     y un cliente local conectado al named pipe recibe `accepted`/`started`,
 *     pide `shutdown` y recibe `closing`/`finished`; el proceso termina con 0, el
 *     cerrojo se libera y la base se reabre. La orden sin el token se ignora.
 *     El cliente se conecta igual que el launcher de PowerShell: por el nombre
 *     exacto del pipe (en Node, `\\?\\pipe\\<id>`).
 *  8. El paquete no contiene datos de usuario, secretos ni cerrojos, y tampoco
 *     ejecutables de terceros (que se descargan al instalar).
 *
 *  NO se usa `SIGINT`/`SIGTERM`/`SIGBREAK` como prueba de cierre: en Windows,
 *  desde un proceso sin consola interactiva, esas llamadas NO llegan a los
 *  handlers de Node (ver `docs/distribution.md`). El Ctrl+C real queda como
 *  **prueba manual** documentada.
 *
 * Sobre el cerrojo (Parte 2 del pedido): si un servidor muere a la fuerza deja
 * `.viurewards.lock`. Esto se comprueba de forma explícita: un cerrojo con el
 * PID de un proceso ya terminado se puede recuperar, y un cerrojo de un proceso
 * vivo NO se toca. Nunca se borra un cerrojo "porque falló un intento".
 *
 * Uso:
 *   <runtime>/node.exe <paquete>/app/scripts/dist/smoke.mjs <paquete> [--port=N]
 *
 * Códigos de salida: 0 si todo pasa, 1 si algo falla, 2 si alguna comprobación
 * quedó OMITIDA (una omisión nunca cuenta como éxito).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const IPC_TOKEN_ENV = "VIUREWARDS_TEST_IPC_TOKEN";
const CHECKS = [];
let skipped = 0;

function ok(name, detail = "") {
  CHECKS.push({ name, status: "ok", detail });
  console.log(`  OK    ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
  CHECKS.push({ name, status: "failed", detail });
  console.error(`  FALLA ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, detail) {
  skipped += 1;
  CHECKS.push({ name, status: "skipped", detail });
  console.warn(`  OMITIDA ${name}${detail ? ` — ${detail}` : ""}`);
}

function check(name, condition, detail = "") {
  if (condition) ok(name, detail);
  else fail(name, detail);
  return Boolean(condition);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function fetchStatus(url) {
  return fetch(url, { redirect: "manual" }).then(
    (response) => ({ status: response.status, headers: response.headers }),
    () => ({ status: 0, headers: new Headers() }),
  );
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, text: await response.text() };
}

function waitExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode, timedOut: false });
      return;
    }
    const timer = setTimeout(() => resolveExit({ code: null, signal: null, timedOut: true }), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal, timedOut: false });
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function readLock(lockPath) {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    return typeof raw?.pid === "number" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Cliente del canal de control del launcher, en Node (para el smoke).
 *
 * Se conecta al nombre EXACTO del pipe, igual que el launcher de PowerShell
 * (`\\.\pipe\<nombre>`). Node interpreta ese prefijo como RUTA al conectarse,
 * así que del lado del cliente va `\\?\pipe\<nombre>` (ver
 * `src/server/control-channel.ts`). Los mensajes son NDJSON del servidor.
 */
function connectControlPipe({ pipeName, timeoutMs = 30_000 }) {
  const lines = [];
  let pending = "";
  let waiters = [];
  let closed = false;
  const socket = connect(`\\\\?\\pipe\\${pipeName}`);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    pending += chunk;
    let cut = pending.indexOf("\n");
    while (cut >= 0) {
      const line = pending.slice(0, cut).trim();
      pending = pending.slice(cut + 1);
      if (line) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          // Una línea ilegible no es un mensaje del protocolo.
        }
      }
      cut = pending.indexOf("\n");
    }
    for (const resolveWaiter of waiters.splice(0)) resolveWaiter();
  });
  const waitFor = (predicate) =>
    new Promise((resolveWait) => {
      const check = () => {
        if (predicate(lines) || closed) resolveWait(predicate(lines));
      };
      const timer = setTimeout(() => resolveWait(false), timeoutMs);
      waiters.push(() => {
        clearTimeout(timer);
        resolveWait(predicate(lines));
      });
      check();
    });
  socket.on("close", () => {
    closed = true;
    for (const resolveWaiter of waiters.splice(0)) resolveWaiter();
  });
  socket.on("error", () => {
    closed = true;
    for (const resolveWaiter of waiters.splice(0)) resolveWaiter();
  });
  return {
    connected: new Promise((resolveConnected, reject) => {
      socket.once("connect", () => resolveConnected(true));
      socket.once("error", reject);
    }),
    send(message) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    waitFor,
    lines: () => [...lines],
    has: (type) => lines.some((line) => line.type === type),
    close() {
      socket.destroy();
    },
  };
}

/**
 * Arranca el arnés IPC del cierre ordenado.
 *
 * Es un proceso hijo con canal IPC, exactamente como en los tests de
 * distribución. El token se pasa por entorno y el arnés no arranca sin él.
 */
function startHarness({ nodeExe, harnessPath, dataDir, port, token }) {
  const child = spawn(nodeExe, [harnessPath, `--port=${port}`], {
    cwd: join(harnessPath, "..", "..", ".."),
    env: {
      ...process.env,
      VIUREWARDS_DATA_DIR: dataDir,
      VIUREWARDS_NODE_RUNTIME: nodeExe,
      PORT: String(port),
      [IPC_TOKEN_ENV]: token,
      // Sin credenciales reales ni conexión a Kick.
      KICK_CLIENT_ID: "",
      KICK_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  return { child, output: () => output };
}

/**
 * Canal de control del LAUNCHER sobre el paquete extraído.
 *
 * Arranca `app/scripts/start.ts` con `--Control=<id> --Exchange=<token>` (el modo
 * en el que el launcher controla al servidor), se conecta al named pipe como lo
 * haría PowerShell y recorre el protocolo completo:
 *
 *   accepted → started → (orden SIN token, ignorada) → orden CON token →
 *   closing → finished → el proceso termina con código 0.
 *
 * Después se comprueban el cerrojo liberado y la base reabrible. No se usa
 * ninguna señal: en Windows no llegan a los handlers de Node (ver
 * `docs/distribution.md`). El cierre corre por el MISMO controlador que
 * producción (`scripts/start.ts` no tiene un apagado aparte para el canal).
 */
async function runLauncherChannelCheck({ nodeExe, appDir, dataDir, lockPath }) {
  const startScript = join(appDir, "scripts", "start.ts");
  if (!check("app/scripts/start.ts incluido para el canal del launcher", existsSync(startScript), startScript)) {
    return;
  }

  const controlId = `smoke${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`;
  const exchange = `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const port = await freePort();
  const server = spawn(
    nodeExe,
    [startScript, `--Control=${controlId}`, `--Exchange=${exchange}`, `--port=${port}`],
    {
      cwd: appDir,
      env: {
        ...process.env,
        VIUREWARDS_DATA_DIR: dataDir,
        VIUREWARDS_NODE_RUNTIME: nodeExe,
        PORT: String(port),
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  server.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  server.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = waitExit(server, 30000);
  let pipe = null;

  try {
    // El canal tarda en abrirse (base, limpieza, reconciliación): se reintenta.
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) break;
      const candidate = connectControlPipe({ pipeName: `viurewards-control-${controlId}` });
      try {
        await candidate.connected;
        pipe = candidate;
        break;
      } catch {
        candidate.close();
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (
      !check(
        "El canal del launcher acepta la conexión del paquete extraído",
        pipe !== null,
        pipe ? `pipe viurewards-control-${controlId}` : output.slice(-1200),
      )
    ) {
      return;
    }

    const accepted = await pipe.waitFor((lines) => lines.some((line) => line.type === "accepted"));
    check("El canal informa `accepted` con el pid del servidor", accepted, JSON.stringify(pipe.lines()));
    const started = await pipe.waitFor((lines) => lines.some((line) => line.type === "started"));
    const startedMessage = pipe.lines().find((line) => line.type === "started");
    check(
      "El canal informa `started` con el puerto real",
      started && startedMessage?.port === port,
      JSON.stringify(startedMessage ?? {}),
    );

    // Orden SIN el token: el servidor NO debe cerrarse con ella.
    pipe.send({ type: "shutdown", exchange: "0".repeat(24) });
    await new Promise((r) => setTimeout(r, 1500));
    const stillServing = (await fetchStatus(`http://127.0.0.1:${port}/login`)).status === 200;
    check(
      "Una orden de cierre SIN el token no detiene el servidor",
      stillServing && !pipe.has("closing") && server.exitCode === null,
      stillServing ? "sigue sirviendo" : `exitCode=${server.exitCode}`,
    );

    // Orden CON el token: UNA sola secuencia de cierre.
    pipe.send({ type: "shutdown", exchange });
    const closing = await pipe.waitFor((lines) => lines.some((line) => line.type === "closing"));
    check("Una orden con el token informa `closing`", closing, JSON.stringify(pipe.lines()));
    const finished = await pipe.waitFor((lines) => lines.some((line) => line.type === "finished"));
    const finishedMessage = pipe.lines().find((line) => line.type === "finished");
    check(
      "El canal informa `finished` con código 0 antes de salir",
      finished && finishedMessage?.code === 0,
      JSON.stringify(finishedMessage ?? {}),
    );

    const exit = await exited;
    check(
      "El cierre por el canal termina el proceso",
      !exit.timedOut,
      `code=${exit.code} signal=${exit.signal} timedOut=${exit.timedOut}\n${output.slice(-800)}`,
    );
    check("El cierre por el canal sale con código 0", exit.code === 0, `code=${exit.code} signal=${exit.signal}`);

    check(
      "El cerrojo se liberó después del cierre por el canal",
      !existsSync(lockPath),
      existsSync(lockPath) ? `${lockPath} sigue existiendo (pid=${readLock(lockPath)?.pid ?? "?"})` : "",
    );

    const dbPath = join(dataDir, "app.db");
    let reopened = false;
    let reopenDetail = dbPath;
    if (existsSync(dbPath)) {
      try {
        const moduleUrl = pathToFileURL(join(appDir, "node_modules/better-sqlite3/lib/index.js")).href;
        const Opened = (await import(moduleUrl)).default;
        const again = new Opened(dbPath, { readonly: true });
        const tables = again.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
        again.close();
        reopened = tables > 0;
        reopenDetail = `${dbPath} (${tables} tablas)`;
      } catch (error) {
        reopenDetail = `${dbPath}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    check("La base se reabre después del cierre por el canal", reopened, reopenDetail);
  } finally {
    pipe?.close();
    if (server.exitCode === null && server.signalCode === null) {
      // Solo el árbol de ESTE hijo: no se busca nada por puerto ni por nombre.
      if (process.platform === "win32") {
        await new Promise((r) => {
          const killer = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("close", r);
          killer.once("error", r);
        });
      } else {
        server.kill("SIGKILL");
      }
      await waitExit(server, 10000);
    }
  }
}

async function main() {
  const packageRoot = resolve(process.argv[2] ?? ".");
  const args = process.argv.slice(3);
  const portFlag = args.find((arg) => arg.startsWith("--port="));
  const requestedPort = portFlag ? Number(portFlag.slice("--port=".length)) : 0;

  console.log(`Smoke del paquete: ${packageRoot}`);
  console.log(`Runtime: ${process.execPath} (${process.version})`);

  // ---------------------------------------------------------------------------
  // 1. Runtime fijado (externo al paquete: lo instala el instalador)
  // ---------------------------------------------------------------------------
  const manifestPath = join(packageRoot, "manifest.json");
  let manifest = null;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    check(
      "El runtime que corre el smoke coincide con la versión del manifiesto",
      manifest.node?.version === process.version,
      `${process.version} vs ${manifest.node?.version ?? "sin versión"}`,
    );
    check(
      "El runtime que corre el smoke coincide con el ABI del manifiesto",
      String(manifest.node?.abi ?? "") === process.versions.modules,
      `ABI ${process.versions.modules} vs ${manifest.node?.abi ?? "sin ABI"}`,
    );
  } else {
    fail("manifest.json presente", `no existe ${manifestPath}`);
  }

  // El runtime NO viaja en el paquete: es el propio `node.exe` con el que se
  // invoca este smoke, que el test/instalador ya verificó contra el manifiesto.
  const nodeExe = process.execPath;
  check("El paquete NO incluye runtime/node.exe", !existsSync(join(packageRoot, "runtime", "node.exe")));

  const appDir = join(packageRoot, "app");
  const dataRoot = mkdtempSync(join(tmpdir(), "VIU smoke datos con espacios-"));
  const dataDir = join(dataRoot, "datos del streamer");
  mkdirSync(dataDir, { recursive: true });
  console.log(`Datos temporales: ${dataDir}`);

  try {
    // -------------------------------------------------------------------------
    // 2. better-sqlite3 con el runtime fijado
    // -------------------------------------------------------------------------
    const Database = (await import(pathToFileURL(join(appDir, "node_modules/better-sqlite3/lib/index.js")).href))
      .default;
    const dbFile = join(dataDir, "smoke-sqlite.db");
    const db = new Database(dbFile);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE prueba (id INTEGER PRIMARY KEY, valor TEXT NOT NULL)");
    db.prepare("INSERT INTO prueba (valor) VALUES (?)").run("hola VIUrewards");
    const row = db.prepare("SELECT valor FROM prueba WHERE id = 1").get();
    db.close();
    check(
      "better-sqlite3 crea, escribe y lee con el runtime fijado",
      row?.valor === "hola VIUrewards",
      `valor leído: ${row?.valor ?? "nada"}`,
    );

    const reopened = new Database(dbFile, { readonly: true });
    const again = reopened.prepare("SELECT valor FROM prueba WHERE id = 1").get();
    reopened.close();
    check("La base SQLite se puede REABRIR", again?.valor === "hola VIUrewards", `valor leído: ${again?.valor ?? "nada"}`);
    rmSync(dbFile, { force: true });
    rmSync(`${dbFile}-wal`, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });

    // -------------------------------------------------------------------------
    // 3-4. Servidor real del paquete (scripts/start.ts, el punto de entrada)
    // -------------------------------------------------------------------------
    const port = requestedPort > 0 ? requestedPort : await freePort();
    const startScript = join(appDir, "scripts", "start.ts");
    check("app/scripts/start.ts incluido", existsSync(startScript), startScript);

    const server = spawn(nodeExe, [startScript], {
      cwd: appDir,
      env: {
        ...process.env,
        VIUREWARDS_DATA_DIR: dataDir,
        VIUREWARDS_NODE_RUNTIME: nodeExe,
        PORT: String(port),
        KICK_CLIENT_ID: "",
        KICK_CLIENT_SECRET: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    server.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    server.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });

    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) break;
      const probe = await fetchStatus(`${base}/login`);
      if (probe.status > 0) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    check("El servidor del paquete queda accesible", ready, ready ? base : output.slice(-1200));

    if (ready) {
      const dashboard = await fetchStatus(`${base}/`);
      check(
        "GET / sin sesión redirige a /login",
        dashboard.status === 302 && dashboard.headers.get("location") === "/login",
        `HTTP ${dashboard.status} -> ${dashboard.headers.get("location") ?? "sin location"}`,
      );
      const login = await fetchText(`${base}/login`);
      check(
        "GET /login responde la página de acceso",
        login.status === 200 && login.text.includes("VIUrewards"),
        `HTTP ${login.status}`,
      );
      const style = await fetchStatus(`${base}/web/style.css`);
      check("GET /web/style.css responde", style.status === 200, `HTTP ${style.status}`);
      const app = await fetchStatus(`${base}/web/app.js`);
      check("GET /web/app.js responde", app.status === 200, `HTTP ${app.status}`);
      const overlayNoKey = await fetchStatus(`${base}/overlay`);
      check("GET /overlay sin clave responde 403", overlayNoKey.status === 403, `HTTP ${overlayNoKey.status}`);
      const guide = await fetchStatus(`${base}/guia`);
      check("GET /guia responde", guide.status === 200, `HTTP ${guide.status}`);
      const state = await fetchStatus(`${base}/api/state`);
      check("GET /api/state sin sesión responde 401", state.status === 401, `HTTP ${state.status}`);
      const media = await fetchStatus(`${base}/media/no-existe.mp4`);
      check("GET /media sin sesión ni clave responde 401", media.status === 401, `HTTP ${media.status}`);

      check("El cerrojo de recursos compartidos está tomado", existsSync(join(dataDir, ".viurewards.lock")));
    } else {
      skip("Dashboard y recursos estáticos", "el servidor no quedó accesible");
    }

    // Este servidor se apaga sí o sí. NO se usa una señal como prueba de cierre
    // (en Windows no llega); para liberar los recursos de la prueba se termina
    // el árbol con la herramienta del sistema y se documenta como tal.
    if (server.exitCode === null && server.signalCode === null) {
      if (process.platform === "win32") {
        await new Promise((r) => {
          const killer = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("close", r);
          killer.once("error", r);
        });
      } else {
        server.kill("SIGKILL");
      }
      await waitExit(server, 10000);
    }
    check(
      "El servidor de prueba terminó antes de seguir",
      server.exitCode !== null || server.signalCode !== null,
      `exitCode=${server.exitCode} signal=${server.signalCode}`,
    );

    // -------------------------------------------------------------------------
    // 5. Datos en el directorio temporal, no en el paquete
    // -------------------------------------------------------------------------
    const inData = (name) => existsSync(join(dataDir, name));
    check("La base se creó en el directorio de datos", inData("app.db"), join(dataDir, "app.db"));
    check("media/ se creó en el directorio de datos", inData("media"), join(dataDir, "media"));
    check(".uploads/ se creó en el directorio de datos", inData(".uploads"), join(dataDir, ".uploads"));
    check("logs/ se creó en el directorio de datos", inData("logs"), join(dataDir, "logs"));
    check(
      "El paquete NO tiene datos de usuario en app/",
      !existsSync(join(appDir, "data")) &&
        !existsSync(join(appDir, "media")) &&
        !existsSync(join(appDir, ".uploads")) &&
        !existsSync(join(appDir, "logs")),
      appDir,
    );

    // -------------------------------------------------------------------------
    // 6. CERROJO: recuperación tras un cierre forzado, sin tocar uno válido
    // -------------------------------------------------------------------------
    // El servidor anterior murió a la fuerza: su cerrojo quedó con un pid que ya
    // no existe. Una instancia nueva debe poder tomarlo (comprobación de pid),
    // y NUNCA debe borrar el cerrojo de un proceso vivo.
    const lockPath = join(dataDir, ".viurewards.lock");
    const staleLock = readLock(lockPath);
    if (staleLock) {
      check(
        "El cerrojo quedó con el pid del proceso terminado",
        !isAlive(staleLock.pid),
        `pid=${staleLock.pid} vivo=${isAlive(staleLock.pid)}`,
      );
    } else {
      skip("El cerrojo quedó con el pid del proceso terminado", "no hay cerrojo legible");
    }

    // -------------------------------------------------------------------------
    // 7. Cierre ordenado con el ARNÉS IPC (misma secuencia que producción)
    // -------------------------------------------------------------------------
    const harnessPath = join(appDir, "scripts", "dist", "shutdown-harness.mjs");
    const harnessIncluded = existsSync(harnessPath);
    check("app/scripts/dist/shutdown-harness.mjs incluido", harnessIncluded, harnessPath);

    if (harnessIncluded) {
      const harnessPort = await freePort();
      const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const harness = startHarness({ nodeExe, harnessPath, dataDir, port: harnessPort, token });
      const exited = new Promise((r) => harness.child.once("exit", (code, signal) => r({ code, signal })));

      const readyMessage = await new Promise((resolveReady) => {
        const timer = setTimeout(() => resolveReady(null), 45000);
        harness.child.on("message", (message) => {
          if (message && message.ready === true) {
            clearTimeout(timer);
            resolveReady(message);
          }
        });
        void exited.then(() => {
          clearTimeout(timer);
          resolveReady(null);
        });
      });
      check(
        "El arnés IPC arranca el servidor del paquete",
        readyMessage !== null,
        readyMessage ? `puerto ${readyMessage.port}` : harness.output().slice(-1200),
      );

      if (readyMessage) {
        const hBase = `http://127.0.0.1:${readyMessage.port}`;
        const hLogin = await fetchStatus(`${hBase}/login`);
        check("El servidor del arnés responde el dashboard", hLogin.status === 200, `HTTP ${hLogin.status}`);
        check("El arnés tomó el cerrojo de recursos compartidos", existsSync(lockPath), lockPath);

        // La orden de cierre: el MISMO controlador que usan las señales.
        harness.child.send({ shutdown: true });
        const exit = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 25000))]);
        check(
          "El cierre ordenado termina el proceso",
          exit !== null,
          exit === null ? `no salió en 25 s:\n${harness.output().slice(-1200)}` : `code=${exit.code} signal=${exit.signal}`,
        );
        if (exit !== null) {
          check("El cierre ordenado sale con código 0", exit.code === 0, `code=${exit.code} signal=${exit.signal}`);
          check(
            "El cierre ordenado informa el resultado en español",
            harness.output().includes("VIUrewards se cerró correctamente."),
            harness.output().slice(-600),
          );
        } else {
          // No se puede dejar el proceso vivo: se limpia el árbol de ESTE hijo.
          await new Promise((r) => {
            const killer = spawn("taskkill", ["/PID", String(harness.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            killer.once("close", r);
            killer.once("error", r);
          });
        }

        check(
          "El cerrojo se liberó después del cierre ordenado",
          !existsSync(lockPath),
          existsSync(lockPath) ? `${lockPath} sigue existiendo (pid=${readLock(lockPath)?.pid ?? "?"})` : "",
        );
      }
    } else {
      skip("Cierre ordenado con el arnés IPC", "el paquete no incluye shutdown-harness.mjs");
    }

    // -------------------------------------------------------------------------
    // 7-bis. Canal de control del LAUNCHER (Etapa 3A) sobre el paquete
    // -------------------------------------------------------------------------
    // Lo que usará el launcher de PowerShell: `scripts/start.ts` con
    // `--Control=<id> --Exchange=<token>`. Se conecta un cliente local al pipe, se
    // comprueba que una orden SIN el token NO cierra, y que la orden CON el token
    // cierra ordenadamente (código 0), libera el cerrojo y deja la base reabrible.
    // NO prueba señales del sistema: el Ctrl+C real sigue siendo manual.
    await runLauncherChannelCheck({ nodeExe, appDir, dataDir, lockPath });

    // -------------------------------------------------------------------------
    // 8. Después del cierre: base reabrible y sin procesos vivos
    // -------------------------------------------------------------------------
    const dbPath = join(dataDir, "app.db");
    if (existsSync(dbPath)) {
      const again2 = new Database(dbPath, { readonly: true });
      const tables = again2.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
      const userVersion = again2.pragma("user_version", { simple: true });
      again2.close();
      check(
        "La base del directorio de datos se reabre con el esquema aplicado",
        Number(tables?.n) > 0 && Number(userVersion) > 0,
        `tablas=${tables?.n} user_version=${userVersion}`,
      );
    } else {
      fail("La base del directorio de datos se reabre", "app.db no existe");
    }

    check(
      "No quedan procesos de la prueba vivos",
      !isAlive(server.pid) && (readLock(lockPath) === null || !isAlive(readLock(lockPath).pid)),
      `servidor=${server.pid}`,
    );

    // -------------------------------------------------------------------------
    // 9. El paquete no trae secretos, estado ni ejecutables externos
    // -------------------------------------------------------------------------
    // En la estrategia C, `node.exe`, `yt-dlp.exe`, `ffmpeg.exe` y
    // `ffprobe.exe` los instala el instalador desde cada proveedor: si viajaran
    // en el ZIP se estarían redistribuyendo sin querer.
    const forbiddenExecutables = new Set(["node.exe", "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe"]);
    const forbidden = [];
    const executables = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (/^(\.env(\..*)?|\.kick-tokens\.json|\.kick-reward\.json|\.viurewards\.lock|instance\.lock)$/.test(entry.name)) {
          forbidden.push(full);
        }
        if (forbiddenExecutables.has(entry.name)) executables.push(full);
      }
    };
    walk(packageRoot);
    check("El paquete no trae secretos ni cerrojos", forbidden.length === 0, forbidden.join(", "));
    check("El paquete no trae ejecutables de terceros", executables.length === 0, executables.join(", "));
    check(
      "El paquete no trae seed-tools ni runtime/",
      !existsSync(join(packageRoot, "seed-tools")) && !existsSync(join(packageRoot, "runtime")),
      "las herramientas las instala el instalador en el directorio de datos",
    );
  } catch (error) {
    fail("Smoke del paquete", error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true });
  }

  const failed = CHECKS.filter((c) => c.status === "failed");
  console.log("");
  console.log(`Resultado: ${CHECKS.length - failed.length - skipped} OK, ${failed.length} fallas, ${skipped} omitidas.`);
  if (failed.length > 0) process.exit(1);
  if (skipped > 0) process.exit(2);
  process.exit(0);
}

void main();
