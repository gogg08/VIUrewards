/**
 * Canal de control del LAUNCHER (Fase de distribución, Etapa 3A).
 *
 * El launcher futuro es un script de PowerShell que arranca el servidor con el
 * `node.exe` del directorio de datos y necesita: saber cuándo está listo, pedirle
 * un cierre ORDENADO, esperar la terminación y distinguir «datos en uso».
 *
 * ## Por qué un named pipe con token y no el IPC de Node
 *
 * En Windows una señal no sirve para el cierre ordenado (`child.kill("SIGINT")`
 * mata sin correr handlers; `SIGBREAK` se traduce a `SIGKILL`). Se evaluó el
 * canal IPC nativo de Node (`process.send`, `spawn(..., "ipc")`), pero desde
 * **PowerShell 5.1** no es utilizable:
 *
 *  - `Start-Process` filtra las variables `NODE_CHANNEL_*` del entorno del hijo,
 *    así que `NODE_CHANNEL_FD` nunca llega (verificado en este repositorio).
 *  - Heredar un handle a un hijo lanzado desde PowerShell requiere replicar el
 *    *sentinel* del último error (`GetStdHandle(-1)` → 6 + lectura de
 *    `Marshal.GetLastWin32Error()`), que este entorno no reproduce de forma
 *    fiable; además `System.IO.Pipes` de .NET Framework crea los pipes con un
 *    nombre interno distinto (`\\.\pipe\pipe\<n>`) y marcados como locales,
 *    invisibles para otros procesos (`EBUSY`/`ENOENT`).
 *
 * Un named pipe con **nombre y token** sí funciona en las dos direcciones desde
 * PowerShell 5.1: el servidor escucha con `net.createServer().listen(nombre)` y
 * el launcher se conecta con `CreateFileW` al nombre exacto `\\.\pipe\<id>`
 * (verificado). El launcher conoce el nombre y el token porque **los genera él**
 * y los pasa en la línea de comandos.
 *
 * ## Seguridad
 *
 * - El canal **solo existe** con `--Control=<id>` y `--Exchange=<token>`: el uso
 *   normal (`npm start`, Ctrl+C, los tests, el arnés de distribución) no abre
 *   ningún pipe ni ninguna interfaz adicional.
 * - Todo mensaje entrante debe traer `exchange` **exactamente** igual al token.
 * - El token **nunca** se registra en los logs de la aplicación ni en los
 *   mensajes del servidor, y no se persiste en ningún archivo.
 * - Un mensaje ilegible o repetido no detiene el servidor ni lanza el cierre dos
 *   veces; la orden pasa por el MISMO `createShutdownController` de producción.
 * - No hay endpoint HTTP de apagado ni archivo de control persistente.
 *
 * Lo que este diseño **no** garantiza (medido, no supuesto):
 *
 * - El **nombre del pipe no aísla por usuario**. Se comprobó que otro proceso
 *   local que solo conoce el nombre (`\\.\pipe\viurewards-control-<id>`) puede
 *   conectarse, **leer** los mensajes del servidor y **escribir** en el canal.
 *   No se verificó la ACL que aplica Node al crear el pipe, así que no se afirma
 *   ni se niega que esté restringida al usuario creador.
 * - Por eso el control depende del **token**: sin el token correcto no se cierra
 *   nada (y el id aleatorio hace el nombre difícil de adivinar).
 * - El token viaja en los **argumentos del proceso** (`--Exchange=`), así que un
 *   proceso con acceso a la línea de comandos de esta sesión puede leerlo. El
 *   token **no** protege frente a procesos del mismo usuario que puedan leer esa
 *   información.
 * - Se acepta esta configuración para una **aplicación de escritorio de un solo
 *   usuario**: el peor caso de un vecino local es cerrar la propia instancia o
 *   ver su puerto/URLs locales, no escalar privilegios.
 *
 * ## Protocolo (NDJSON, una línea JSON por mensaje)
 *
 * Servidor → launcher:
 *
 * ```
 * {"type":"accepted","controlId":"<id>","pid":123}
 * {"type":"started","controlId":"<id>","pid":123,"port":8787,"url":"…","dashboardUrl":"…"}
 * {"type":"closing","controlId":"<id>","pid":123,"reason":"launcher"}
 * {"type":"finished","controlId":"<id>","pid":123,"code":0,"message":"…"}
 * ```
 *
 * Launcher → servidor:
 *
 * ```
 * {"type":"shutdown","exchange":"<token>"}
 * ```
 *
 * `finished` se envía **antes** de `exit()`, para que el launcher conozca el
 * resultado aunque la tubería se cierre en el acto.
 *
 * ## Nombre de la tubería
 *
 * El nombre viaja como `\\.\pipe\<id>`. Node lo acepta en `listen()`, pero
 * `net.connect("\\\\.\\pipe\\x")` de Node interpreta el prefijo como RUTA y crea
 * `\\.\pipe\x\pipe\<pid>`; por eso el launcher (PowerShell) usa `CreateFileW`
 * con el nombre de disco exacto y el servidor solo lo recibe en `listen()`.
 */

import { createServer, type Server, type Socket } from "node:net";

/** Marca el arranque controlado por el launcher. */
export const CONTROL_FLAG = "--Control=";

/** Token del intercambio (lo genera el launcher, por proceso). */
export const EXCHANGE_FLAG = "--Exchange=";

/**
 * Tope para que `finished` salga por el pipe antes de `exit()`. No cambia el
 * cierre: el servidor, la base y el cerrojo ya se cerraron.
 */
const FINAL_MARGIN_MS = 250;

/** Mensajes que el servidor envía al launcher. */
export type ServerToLauncher =
  | { type: "accepted"; controlId: string; pid: number }
  | {
      type: "started";
      controlId: string;
      pid: number;
      port: number;
      url: string;
      dashboardUrl: string;
    }
  | { type: "closing"; controlId: string; pid: number; reason: string }
  | { type: "finished"; controlId: string; pid: number; code: 0 | 1; message: string };

/** Mensajes que el launcher envía al servidor. */
export type LauncherToServer = { type: "shutdown"; exchange: string };

export interface ControlRequest {
  /** Identificador corto del launcher (viaja en todos los mensajes). */
  controlId: string;
  /** Token que debe traer cada orden de cierre. */
  exchange: string;
  /** Nombre del pipe tal como lo recibe `net.Server.listen`. */
  pipeName: string;
  pid: number;
}

/** Valor de `--X=valor` (el último gana), o `undefined`. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  let value: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith(flag)) value = arg.slice(flag.length);
  }
  return value;
}

/** Identificador: letras, números, `-` y `_`, de 1 a 128 caracteres. */
export function isControlId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * Token: 16 a 256 caracteres de la URL-safe base64 (`New-Guid`,
 * `crypto.randomUUID`). Exigir un mínimo evita que un token trivial proteja la
 * orden de cierre.
 */
export function isExchangeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,256}$/.test(value);
}

/**
 * Lee la petición de control de la línea de comandos.
 *
 * Devuelve `null` cuando esta ejecución NO es controlada por el launcher. Si hay
 * `--Control` pero el identificador o el token no sirven, devuelve `{ error }`:
 * el arranque tiene que fallar en vez de ignorar en silencio una petición mal
 * armada (el launcher creería que controla un servidor que no lo escucha).
 */
export function readControlRequest(
  argv: readonly string[],
  pid: number = process.pid,
): ControlRequest | { error: string } | null {
  const rawId = flagValue(argv, CONTROL_FLAG);
  if (rawId === undefined) return null;
  const controlId = rawId.trim();
  if (!isControlId(controlId)) {
    return { error: `${CONTROL_FLAG} tiene un identificador inválido.` };
  }
  const exchange = (flagValue(argv, EXCHANGE_FLAG) ?? "").trim();
  if (!isExchangeToken(exchange)) {
    return {
      error: `El arranque controlado por el launcher necesita un token válido en ${EXCHANGE_FLAG}.`,
    };
  }
  // En Node, `listen()` dota de un nombre propio a cada forma:
  //   `nombre`            → EACCES (verificado)
  //   `\\.\pipe\nombre`    → lo crea como *localfile*, inaccesible desde otro proceso
  //   `\\?\pipe\nombre`    → nombre exacto, accesible desde PowerShell (verificado)
  // El launcher abre `\\.\pipe\viurewards-control-<id>`, que es el MISMO pipe.
  return { controlId, exchange, pipeName: `\\\\?\\pipe\\viurewards-control-${controlId}`, pid };
}

export interface ControlChannelOptions {
  argv?: readonly string[];
  pid?: number;
  /** Sustituye el listener del pipe (tests). */
  listen?: (pipeName: string, onSocket: (socket: Socket) => void) => Server;
  /**
   * Pide el cierre ordenado. Debe llamar al MISMO controlador de producción
   * (`createShutdownController().shutdown`). Devuelve el resultado final.
   */
  requestShutdown: (reason: string) => Promise<{ code: 0 | 1; message: string }>;
  /**
   * Registra un aviso para ANTES de que el proceso salga (el controlador cierra
   * el log y llama a `exit()` dentro de su propia promesa, así que un `await`
   * después de `requestShutdown` no alcanza).
   */
  onBeforeExit?: (listener: (outcome: { code: 0 | 1; message: string }) => void) => void;
  log?: (message: string) => void;
}

export interface ControlChannel {
  controlId: string;
  /** Informa que el servidor quedó escuchando. */
  started(info: { port: number; url: string; dashboardUrl: string }): void;
  /** ¿El launcher ya pidió el cierre por este canal? */
  isRequested(): boolean;
  /** Cierra el canal (no toca el resto de la vida del proceso). */
  close(): Promise<void>;
}

/**
 * Instala el canal de control.
 *
 * Devuelve `null` si esta ejecución no es controlada por el launcher. Lanza si
 * la petición existe pero es inválida: en ese caso el launcher no podría manejar
 * al servidor y es mejor no arrancarlo a medias.
 */
export function installControlChannel(options: ControlChannelOptions): ControlChannel | null {
  const argv = options.argv ?? process.argv.slice(1);
  const found = readControlRequest(argv, options.pid ?? process.pid);
  if (found === null) return null;
  if ("error" in found) throw new Error(found.error);
  const request: ControlRequest = found;

  const log = options.log ?? (() => {});
  const listeners = new Set<Socket>();
  let requested = false;
  let closed: Promise<void> | null = null;
  // Estado ya informado: se repite a cada conexión nueva (el launcher puede
  // conectarse después de que el servidor informó `accepted`/`started`).
  let startedInfo: { port: number; url: string; dashboardUrl: string } | null = null;
  let closingReason: string | null = null;
  // Última conexión conocida: se conserva aunque el socket se cierre al apagar el
  // servidor HTTP, porque `finished` se envía después de `server.stop()`.
  let lastSocket: Socket | null = null;
  log(`Control: escuchando en el canal del launcher.`);

  const send = (socket: Socket, message: ServerToLauncher): void => {
    try {
      if (socket.destroyed || !socket.writable) return;
      socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      // Un canal que se cerró no puede impedir el cierre del servidor.
    }
  };

  /**
   * Envío final antes de `exit()`. Se escribe la línea y se espera un instante
   * acotado: el dato viaja en la cola de E/S del socket y el proceso sale justo
   * despu\u00e9s (ver `onBeforeExit`), sin esperar a `finish` (en un pipe de Windows
   * puede no emitirse).
   */
  const sendFinal = (socket: Socket, message: ServerToLauncher): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (socket.destroyed || !socket.writable) {
        resolve();
        return;
      }
      try {
        socket.write(`${JSON.stringify(message)}\n`);
      } catch {
        // Un canal cerrado no puede impedir el cierre del servidor.
      }
      // Timer SIN `unref`: mantiene vivo el event loop el instante necesario para
      // que el dato salga del pipe antes de `exit()`.
      setTimeout(resolve, FINAL_MARGIN_MS);
    });
  };

  const broadcast = (message: ServerToLauncher): void => {
    for (const socket of listeners) send(socket, message);
  };

  const listen =
    options.listen ??
    ((pipeName: string, onSocket: (socket: Socket) => void): Server => {
      const server = createServer(onSocket);
      server.on("error", (error: Error) => {
        // El pipe no se pudo abrir (nombre tomado): se registra sin el token.
        log(`Control: no se pudo abrir el canal (${error.message}).`);
      });
      server.listen(pipeName);
      return server;
    });

  const server = listen(request.pipeName, (socket) => {
    log("Control: launcher conectado.");
    listeners.add(socket);
    lastSocket = socket;
    socket.setEncoding("utf8");
    socket.on("close", () => listeners.delete(socket));
    socket.on("error", () => listeners.delete(socket));
    send(socket, { type: "accepted", controlId: request.controlId, pid: request.pid });
    if (startedInfo) {
      send(socket, {
        type: "started",
        controlId: request.controlId,
        pid: request.pid,
        port: startedInfo.port,
        url: startedInfo.url,
        dashboardUrl: startedInfo.dashboardUrl,
      });
    }
    if (closingReason !== null) {
      send(socket, {
        type: "closing",
        controlId: request.controlId,
        pid: request.pid,
        reason: closingReason,
      });
    }

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
        index = buffer.indexOf("\n");
      }
      // Una línea sin salto no puede crecer sin límite.
      if (buffer.length > 8192) buffer = "";
    });

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      log(`Control: línea recibida (${trimmed.length} bytes).`);
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // Ilegible: no se hace nada ni se revela el token esperado.
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const data = message as { type?: unknown; exchange?: unknown };
      if (typeof data.exchange !== "string" || !isExchangeToken(data.exchange)) return;
      if (data.exchange !== request.exchange) {
        log("Control: se ignoró una orden con un token incorrecto.");
        return;
      }
      if (data.type !== "shutdown") return;
      startShutdown("launcher");
    };
  });

  function startShutdown(reason: string): void {
    // Una sola secuencia: una orden repetida (o una segunda conexión) no
    // vuelve a pedir el cierre ni fuerza la salida.
    if (requested) return;
    requested = true;
    closingReason = reason;
    broadcast({ type: "closing", controlId: request.controlId, pid: request.pid, reason });
    // El aviso `finished` se emite desde `onBeforeExit`, que el controlador
    // invoca justo antes de `exit()`: `requestShutdown` NO resuelve antes de
    // que el proceso salga (la salida ocurre dentro de su promesa).
    options.onBeforeExit?.((outcome) => {
      const targets = listeners.size > 0 ? [...listeners] : lastSocket ? [lastSocket] : [];
      const pending: Promise<void>[] = [];
      for (const socket of targets) {
        pending.push(
          sendFinal(socket, {
            type: "finished",
            controlId: request.controlId,
            pid: request.pid,
            code: outcome.code,
            message: outcome.message,
          }),
        );
      }
      // El canal deja de tener referencias vivas: sin esto el event loop queda
      // abierto (el pipe escucha) y el proceso no termina solo.
      return Promise.all(pending).then(() => {
        for (const socket of listeners) socket.destroy();
        listeners.clear();
        try {
          server.close(() => undefined);
        } catch {
          // Un servidor ya cerrado no impide nada.
        }
      });
    });
    void options.requestShutdown(reason).catch((error: unknown) => {
      log(`Control: el cierre falló: ${error instanceof Error ? error.message : String(error)}.`);
      broadcast({
        type: "finished",
        controlId: request.controlId,
        pid: request.pid,
        code: 1,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    controlId: request.controlId,
    started(info) {
      startedInfo = info;
      broadcast({
        type: "started",
        controlId: request.controlId,
        pid: request.pid,
        port: info.port,
        url: info.url,
        dashboardUrl: info.dashboardUrl,
      });
    },
    isRequested: () => requested,
    close() {
      if (closed) return closed;
      closed = new Promise<void>((resolve) => {
        for (const socket of listeners) socket.destroy();
        listeners.clear();
        server.close(() => resolve());
        // `close()` espera a las conexiones; ya se destruyeron, pero un pipe sin
        // nadie conectado puede no emitir `close`: no se cuelga el cierre.
        setTimeout(resolve, 250).unref?.();
      });
      return closed;
    },
  };
}
