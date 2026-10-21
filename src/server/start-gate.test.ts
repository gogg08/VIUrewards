import { describe, expect, it } from "vitest";

import { StartGate } from "./start-gate.ts";

function makeGate(options: { active?: boolean; intervalMs?: number; now?: () => number } = {}) {
  const clock = { value: 10_000 };
  let active = options.active ?? true;
  let interval = options.intervalMs ?? 5_000;
  const gate = new StartGate({
    now: options.now ?? (() => clock.value),
    active: () => active,
    intervalMs: () => interval,
  });
  return {
    gate,
    clock,
    setActive(next: boolean) {
      active = next;
    },
    setInterval(next: number) {
      interval = next;
    },
  };
}

describe("StartGate - intervalo mínimo global (Modo Chill)", () => {
  it("sin ningún fin registrado no agrega espera", () => {
    const { gate } = makeGate();
    expect(gate.remainingMs()).toBe(0);
  });

  it("con el modo inactivo nunca agrega espera, aunque haya un fin reciente", () => {
    const { gate, clock, setActive } = makeGate({ active: false });
    gate.markEnd();
    expect(gate.remainingMs()).toBe(0);
    setActive(true);
    clock.value += 1_000;
    expect(gate.remainingMs()).toBe(4_000);
  });

  it("con intervalo 0 tampoco agrega espera", () => {
    const { gate, setInterval } = makeGate({ intervalMs: 0 });
    gate.markEnd();
    expect(gate.remainingMs()).toBe(0);
    setInterval(5_000);
    expect(gate.remainingMs()).toBe(5_000);
  });

  it("la espera cuenta desde el FIN: devuelve el tiempo restante y no suma una vez cumplido", () => {
    const { gate, clock } = makeGate({ intervalMs: 5_000 });
    gate.markEnd();
    expect(gate.remainingMs()).toBe(5_000);
    clock.value += 2_000;
    expect(gate.remainingMs()).toBe(3_000);
    clock.value += 3_000;
    expect(gate.remainingMs()).toBe(0);
    clock.value += 60_000;
    expect(gate.remainingMs()).toBe(0);
  });

  it("una alerta que todavía suena no agrega espera: solo cuenta al terminar", () => {
    const { gate, clock } = makeGate({ intervalMs: 5_000 });
    gate.markStart();
    clock.value += 2_000;
    expect(gate.remainingMs()).toBe(0);
    clock.value += 8_000; // terminó
    gate.markEnd();
    expect(gate.remainingMs()).toBe(5_000);
    clock.value += 5_000;
    expect(gate.remainingMs()).toBe(0);
  });

  it("markEnd acepta un instante explícito y nunca devuelve negativos", () => {
    const { gate, clock } = makeGate({ intervalMs: 5_000 });
    gate.markEnd(9_000);
    clock.value = 20_000;
    expect(gate.remainingMs()).toBe(0);
    clock.value = 9_500;
    expect(gate.remainingMs()).toBe(4_500);
  });

  it("un fin nuevo reinicia la cuenta (cada alerta que termina abre su espera)", () => {
    const { gate, clock } = makeGate({ intervalMs: 5_000 });
    gate.markEnd();
    clock.value += 4_000;
    expect(gate.remainingMs()).toBe(1_000);
    gate.markEnd();
    clock.value += 1_000;
    expect(gate.remainingMs()).toBe(4_000);
  });

  it("en 'Superponer' la espera también cuenta desde el inicio si algo sigue sonando", () => {
    // Empezó una alerta y después terminó OTRA: la que sigue sonando es la que
    // importa, así que la espera corre desde su inicio.
    const { gate, clock } = makeGate({ intervalMs: 5_000 });
    gate.markStart();
    clock.value += 1_000;
    gate.markEnd();
    clock.value += 1_000;
    expect(gate.remainingMs()).toBe(4_000);
    clock.value += 4_000;
    expect(gate.remainingMs()).toBe(0);
  });

  it("al terminar la alerta en curso, la espera vuelve a abrirse desde ese fin", () => {
    const { gate, clock } = makeGate({ intervalMs: 5_000 });
    gate.markStart();
    gate.markEnd(clock.value);
    clock.value += 4_000;
    expect(gate.remainingMs()).toBe(1_000);
    // La misma alerta terminó 4 s después de empezar: vuelve a haber espera.
    gate.markEnd();
    expect(gate.remainingMs()).toBe(5_000);
    clock.value += 5_000;
    expect(gate.remainingMs()).toBe(0);
  });

  it("un intervalo negativo se trata como 0", () => {
    const { gate } = makeGate({ intervalMs: -1_000 });
    gate.markEnd();
    expect(gate.remainingMs()).toBe(0);
  });
});
