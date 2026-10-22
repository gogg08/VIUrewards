import { describe, expect, it } from "vitest";

import { createShutdownController } from "./shutdown.ts";

/**
 * Controlador del cierre: idempotencia, segunda señal, plazo duro y orden de
 * los recursos. Todo se inyecta (salida, timers, stop, base), así que no se
 * envían señales reales ni se toca ninguna base.
 */

interface Harness {
  controller: ReturnType<typeof createShutdownController>;
  order: string[];
  exits: number[];
  logs: string[];
  fireTimer: () => void;
  timerActive: () => boolean;
}

function harness(overrides: Partial<Parameters<typeof createShutdownController>[0]> = {}): Harness {
  const order: string[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  let timerFn: (() => void) | null = null;
  const controller = createShutdownController({
    stop: async () => {
      order.push("stop");
    },
    closeDb: () => order.push("db"),
    closeLog: () => order.push("log"),
    killProcesses: () => order.push("kill"),
    exit: (code) => {
      exits.push(code);
      order.push(`exit:${code}`);
    },
    log: (message) => logs.push(message),
    setTimer: (fn) => {
      timerFn = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      timerFn = null;
    },
    ...overrides,
  });
  return {
    controller,
    order,
    exits,
    logs,
    fireTimer: () => timerFn?.(),
    timerActive: () => timerFn !== null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("cierre ordenado: controlador", () => {
  it("la primera señal cierra en orden, cierra la base antes del log y sale con 0", async () => {
    const h = harness();
    await h.controller.shutdown("SIGINT");
    expect(h.order).toEqual(["stop", "db", "log", "exit:0"]);
    expect(h.exits).toEqual([0]);
    expect(h.timerActive()).toBe(false);
  });

  it("es idempotente: dos llamadas no ejecutan dos cierres", async () => {
    const h = harness();
    const first = h.controller.shutdown("SIGINT");
    const second = h.controller.shutdown("SIGINT");
    await Promise.all([first, second]);
    expect(h.order.filter((entry) => entry === "stop")).toHaveLength(1);
    expect(h.order.filter((entry) => entry === "db")).toHaveLength(1);
    // La segunda señal fuerza la salida (código 1), no repite el cierre.
    expect(h.exits).toEqual([1]);
    expect(h.logs.some((line) => /Segunda interrupción/.test(line))).toBe(true);
  });

  it("la segunda señal fuerza la salida matando procesos sin esperar al stop", async () => {
    let release: () => void = () => {};
    const h = harness({
      stop: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      runningProcesses: () => 2,
    });
    void h.controller.shutdown("SIGINT");
    await flush();
    try {
      void h.controller.shutdown("SIGINT");
    } finally {
      // El stop simulado nunca termina: se libera para que la promesa del cierre
      // no quede pendiente dentro del test.
      release();
    }
    // Salió pese a que el stop seguía pendiente.
    expect(h.exits).toEqual([1]);
    expect(h.order).toContain("kill");
    expect(h.logs.some((line) => /2 proceso\(s\) externos/.test(line))).toBe(true);
    await flush();
    expect(h.exits).toEqual([1]);
  });

  it("el plazo duro corta un cierre bloqueado con código 1", async () => {
    const h = harness({
      stop: () => new Promise<void>(() => {}),
      timeoutMs: 5000,
    });
    void h.controller.shutdown("SIGTERM");
    await flush();
    h.fireTimer();
    expect(h.exits).toEqual([1]);
    expect(h.logs.some((line) => /Cierre forzado/.test(line))).toBe(true);
  });

  it("un error del stop no impide cerrar la base ni salir con 0", async () => {
    const h = harness({
      stop: async () => {
        throw new Error("boom");
      },
    });
    await h.controller.shutdown("SIGINT");
    expect(h.order).toEqual(["db", "log", "exit:0"]);
  });

  it("un error al cerrar la base no impide salir", async () => {
    const h = harness({
      closeDb: () => {
        throw new Error("db");
      },
    });
    await h.controller.shutdown("SIGINT");
    expect(h.exits).toEqual([0]);
  });

  it("reporta isClosing mientras dura el cierre", async () => {
    let release: () => void = () => {};
    const h = harness({
      stop: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    expect(h.controller.isClosing()).toBe(false);
    void h.controller.shutdown("SIGINT");
    expect(h.controller.isClosing()).toBe(true);
    release();
    await flush();
  });
});
