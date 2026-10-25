/**
 * Canal de control del launcher (Fase de distribución, Etapa 3A).
 *
 * Estos tests usan `listen` sustituido por un servidor en memoria, así que
 * ejercitan el protocolo y las reglas de seguridad sin abrir named pipes. El
 * flujo real (PowerShell ↔ Node por el pipe) se prueba en
 * `tests/e2e/launcher-control.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  CONTROL_FLAG,
  EXCHANGE_FLAG,
  installControlChannel,
  isControlId,
  isExchangeToken,
  readControlRequest,
  type ServerToLauncher,
} from "./control-channel.ts";

const TOKEN = "exchange-token-0123456789";
const CONTROL_ID = "launcher-abc";

/** Canal con un servidor falso: entrega los sockets al test. */
function createHarness(
  requestShutdown: (reason: string) => Promise<{ code: 0 | 1; message: string }> = async () => ({
    code: 0,
    message: "listo",
  }),
) {
  const sockets: FakeSocket[] = [];
  const messages: ServerToLauncher[] = [];
  let beforeExit: ((outcome: { code: 0 | 1; message: string }) => void) | null = null;
  // Cada socket reenvía lo escrito al colector compartido: se conecta ANTES de
  // entregarlo al canal, porque el servidor escribe `accepted` al conectar.
  const collect = (text: string): void => {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      messages.push(JSON.parse(line) as ServerToLauncher);
    }
  };
  const channel = installControlChannel({
    argv: [`${CONTROL_FLAG}${CONTROL_ID}`, `${EXCHANGE_FLAG}${TOKEN}`],
    listen: (_name, onSocket) => {
      const socket = new FakeSocket();
      socket.onWrite = collect;
      sockets.push(socket);
      onSocket(socket as never);
      return { close: () => undefined } as never;
    },
    requestShutdown,
    onBeforeExit: (listener) => {
      beforeExit = listener;
    },
    log: () => {},
  });
  return {
    channel,
    sockets,
    messages,
    collect,
    emitBeforeExit: (outcome: { code: 0 | 1; message: string }) => beforeExit?.(outcome),
    types: () => messages.map((message) => message.type),
  };
}

/** Socket mínimo: solo lo que usa el canal. */
class FakeSocket {
  destroyed = false;
  writable = true;
  onWrite: ((text: string) => void) | null = null;
  private readonly dataListeners: ((chunk: string) => void)[] = [];
  private readonly otherListeners = new Map<string, (() => void)[]>();

  setEncoding(): void {}

  on(event: string, listener: (chunk: string) => void): void {
    if (event === "data") {
      this.dataListeners.push(listener);
      return;
    }
    const list = this.otherListeners.get(event) ?? [];
    list.push(listener as () => void);
    this.otherListeners.set(event, list);
  }

  once(event: string, listener: () => void): void {
    this.on(event, listener as (chunk: string) => void);
  }

  write(text: string): boolean {
    this.onWrite?.(text);
    return true;
  }

  end(text: string): void {
    this.onWrite?.(text);
  }

  destroy(): void {
    this.destroyed = true;
    this.writable = false;
  }

  /** Simula un mensaje del launcher, con su salto de línea (NDJSON). */
  receive(message: unknown): void {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    // Las líneas ilegibles se mandan tal cual; las válidas se cierran con "\n".
    const payload = text.startsWith("{") || text.startsWith("[") ? `${text}\n` : text;
    for (const listener of this.dataListeners) listener(payload);
  }
}

describe("readControlRequest", () => {
  it("sin --Control no es una ejecución controlada", () => {
    expect(readControlRequest(["--port=8787"], 10)).toBeNull();
  });

  it("lee el id y el token, y deriva el nombre del pipe del id", () => {
    const request = readControlRequest(
      [`${CONTROL_FLAG}${CONTROL_ID}`, `${EXCHANGE_FLAG}${TOKEN}`, "--port=0"],
      42,
    );
    expect(request).toMatchObject({
      controlId: CONTROL_ID,
      exchange: TOKEN,
      pid: 42,
      pipeName: `\\\\?\\pipe\\viurewards-control-${CONTROL_ID}`,
    });
  });

  it("rechaza un identificador inválido", () => {
    const request = readControlRequest([`${CONTROL_FLAG}b@d id`, `${EXCHANGE_FLAG}${TOKEN}`]);
    expect(request).toHaveProperty("error");
  });

  it("rechaza un token demasiado corto", () => {
    expect(readControlRequest([`${CONTROL_FLAG}${CONTROL_ID}`, `${EXCHANGE_FLAG}corto`])).toHaveProperty(
      "error",
    );
  });

  it("rechaza un token con caracteres fuera de la URL-safe base64", () => {
    expect(
      readControlRequest([`${CONTROL_FLAG}${CONTROL_ID}`, `${EXCHANGE_FLAG}"token con espacios"`]),
    ).toHaveProperty("error");
  });

  it("el último valor de cada bandera gana", () => {
    const request = readControlRequest([
      `${CONTROL_FLAG}viejo`,
      `${CONTROL_FLAG}${CONTROL_ID}`,
      `${EXCHANGE_FLAG}viejo-token-0000000000`,
      `${EXCHANGE_FLAG}${TOKEN}`,
    ]);
    expect(request).toMatchObject({ controlId: CONTROL_ID, exchange: TOKEN });
  });

  it("valida los límites de id y token", () => {
    expect(isControlId("a".repeat(128))).toBe(true);
    expect(isControlId("a".repeat(129))).toBe(false);
    expect(isExchangeToken("a".repeat(16))).toBe(true);
    expect(isExchangeToken("a".repeat(15))).toBe(false);
    expect(isExchangeToken("a".repeat(257))).toBe(false);
  });
});

describe("installControlChannel", () => {
  it("sin --Control no instala canal", () => {
    expect(
      installControlChannel({ argv: [], requestShutdown: async () => ({ code: 0, message: "" }) }),
    ).toBeNull();
  });

  it("con una petición inválida lanza (no ignora la orden en silencio)", () => {
    expect(() =>
      installControlChannel({ argv: [`${CONTROL_FLAG}${CONTROL_ID}`], requestShutdown: async () => ({ code: 0, message: "" }) }),
    ).toThrow(/Exchange/);
  });

  it("informa accepted al conectar y started a las conexiones nuevas", () => {
    const connections: ((socket: FakeSocket) => void)[] = [];
    const errors: string[] = [];
    const channel = installControlChannel({
      argv: [`${CONTROL_FLAG}${CONTROL_ID}`, `${EXCHANGE_FLAG}${TOKEN}`],
      listen: (_name, onSocket) => {
        connections.push(onSocket as unknown as (socket: FakeSocket) => void);
        return { close: () => undefined } as never;
      },
      requestShutdown: async () => ({ code: 0, message: "" }),
      log: (message) => errors.push(message),
    });

    // El estado `started` ocurre ANTES de que el launcher se conecte.
    channel?.started({ port: 8787, url: "u", dashboardUrl: "d" });

    const late = new FakeSocket();
    const lines: ServerToLauncher[] = [];
    late.onWrite = (text) => {
      for (const line of text.split("\n")) if (line.trim()) lines.push(JSON.parse(line));
    };
    connections[0](late);

    // La conexión tardía recibe `accepted` Y el `started` ya informado.
    expect(lines.map((line) => line.type)).toEqual(["accepted", "started"]);
    expect(lines[1]).toMatchObject({ port: 8787, dashboardUrl: "d" });
    expect(errors.filter((message) => message.includes("no se pudo"))).toEqual([]);
  });

  it("una orden SIN token no inicia el cierre", () => {
    let calls = 0;
    const harness = createHarness(async () => {
      calls += 1;
      return { code: 0, message: "ok" };
    });
    harness.sockets[0].receive({ type: "shutdown", exchange: "token-incorrecto-000000" });
    harness.sockets[0].receive({ type: "shutdown" });
    expect(calls).toBe(0);
    expect(harness.channel?.isRequested()).toBe(false);
  });

  it("un mensaje ilegible no inicia el cierre", () => {
    let calls = 0;
    const harness = createHarness(async () => {
      calls += 1;
      return { code: 0, message: "ok" };
    });
    harness.sockets[0].receive("{no es json");
    harness.sockets[0].receive("[]");
    expect(calls).toBe(0);
  });

  it("una orden con el token inicia UN cierre y avisa closing", async () => {
    let calls = 0;
    const harness = createHarness(async () => {
      calls += 1;
      return { code: 0, message: "ok" };
    });
    harness.sockets[0].receive({ type: "shutdown", exchange: TOKEN });
    harness.sockets[0].receive({ type: "shutdown", exchange: TOKEN });
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(harness.channel?.isRequested()).toBe(true);
    expect(harness.types()).toContain("closing");
  });

  it("finished sale desde onBeforeExit, no al resolver requestShutdown", async () => {
    const harness = createHarness(async () => ({ code: 0, message: "listo" }));
    harness.sockets[0].receive({ type: "shutdown", exchange: TOKEN });
    await Promise.resolve();
    expect(harness.types()).not.toContain("finished");

    harness.emitBeforeExit({ code: 0, message: "listo" });
    expect(harness.messages.at(-1)).toMatchObject({ type: "finished", code: 0, message: "listo" });
  });

  it("un fallo de requestShutdown informa finished con código 1", async () => {
    const harness = createHarness(async () => {
      throw new Error("no se pudo cerrar");
    });
    harness.sockets[0].receive({ type: "shutdown", exchange: TOKEN });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.messages.at(-1)).toMatchObject({ type: "finished", code: 1 });
  });

  it("el token nunca aparece en los mensajes del servidor", () => {
    const harness = createHarness();
    harness.channel?.started({ port: 1, url: "u", dashboardUrl: "d" });
    harness.emitBeforeExit({ code: 0, message: "ok" });
    expect(JSON.stringify(harness.messages)).not.toContain(TOKEN);
  });

  it("el envío final escribe finished en el canal y no ensucia stderr", async () => {
    // Regresión: `sendFinal` escribía una línea de diagnóstico `[dbg]` a
    // `process.stderr` en TODOS los cierres. El aviso tiene que seguir saliendo
    // por el socket, y nada más.
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrText = "";
    const spy = ((chunk: unknown, ...rest: unknown[]) => {
      stderrText += String(chunk);
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const harness = createHarness();
    // Hay que pedir el cierre primero: `onBeforeExit` se registra en
    // `startShutdown`, no al instalar el canal.
    harness.sockets[0].receive({ type: "shutdown", exchange: TOKEN });
    await Promise.resolve();
    expect(harness.channel?.isRequested()).toBe(true);
    const before = harness.messages.length;
    process.stderr.write = spy;
    try {
      // `sendFinal` espera un margen acotado antes de resolver.
      await harness.emitBeforeExit({ code: 0, message: "listo" });
    } finally {
      process.stderr.write = originalWrite;
    }
    const during = harness.messages.slice(before);
    expect(during.some((message) => message.type === "finished" && message.code === 0)).toBe(true);
    expect(stderrText).not.toContain("[dbg]");
  });
});
