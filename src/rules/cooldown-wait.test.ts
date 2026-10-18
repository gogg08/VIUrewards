/**
 * Tests del planificador de espera por cooldown (`CooldownWaiter`): FIFO, topes,
 * espera máxima, descarte y ausencia de temporizadores colgados. Reloj y
 * temporizadores falsos (avanzar los timers avanza `Date.now()`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CooldownWaiter, type WaitEntry } from "./cooldown-wait.ts";

interface Harness {
  waiter: CooldownWaiter;
  fired: Array<{ rewardId: string; eventId: string }>;
  dropped: Array<{ rewardId: string; eventId: string; reason: string }>;
  lastFired: Map<string, number | null>;
  cooldowns: Map<string, number>;
  setBusy: (fn: () => boolean) => void;
}

function makeHarness(options: { busy?: () => boolean } = {}): Harness {
  const fired: Array<{ rewardId: string; eventId: string }> = [];
  const dropped: Array<{ rewardId: string; eventId: string; reason: string }> = [];
  const lastFired = new Map<string, number | null>();
  const cooldowns = new Map<string, number>();
  let busy = options.busy ?? (() => false);

  const waiter = new CooldownWaiter({
    now: () => Date.now(),
    maxWaiting: () => 20,
    maxWaitMs: () => 10 * 60_000,
    cooldownMs: (rewardId) => cooldowns.get(rewardId) ?? 0,
    lastFiredAt: (rewardId) => lastFired.get(rewardId) ?? null,
    isBusy: () => busy(),
    dispatch: (rewardId, entry) => {
      fired.push({ rewardId, eventId: entry.eventId });
    },
    onDrop: (rewardId, entry, reason) => {
      dropped.push({ rewardId, eventId: entry.eventId, reason });
    },
  });

  return {
    waiter,
    fired,
    dropped,
    lastFired,
    cooldowns,
    setBusy: (fn) => {
      busy = fn;
    },
  };
}

function entry(eventId: string): WaitEntry {
  return { eventId, enqueuedAtMs: Date.now(), payload: { id: eventId } };
}

describe("CooldownWaiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispara el primer canje cuando se cumple el cooldown desde el último disparo", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 10_000);
    h.lastFired.set("r1", 5_000); // el último disparo fue 5 s antes de "ahora"
    h.waiter.admit("r1", entry("c1"));

    // A los 4 s todavía no toca (faltaba 5 s).
    vi.advanceTimersByTime(4_000);
    expect(h.fired).toHaveLength(0);

    // Al cumplirse los 5 s restantes, dispara.
    vi.advanceTimersByTime(1_000);
    expect(h.fired).toEqual([{ rewardId: "r1", eventId: "c1" }]);
  });

  it("procesa los canjes en orden de llegada (FIFO)", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 1_000);
    h.lastFired.set("r1", Date.now() - 1_000); // el cooldown ya se cumplió
    h.waiter.admit("r1", entry("c1"));
    h.waiter.admit("r1", entry("c2"));
    h.waiter.admit("r1", entry("c3"));

    // Se dispara el primero; el servidor sella su fin y reprogcha al siguiente.
    vi.advanceTimersByTime(0);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1"]);
    h.lastFired.set("r1", Date.now());
    h.waiter.kick("r1"); // el servidor avisa el fin (onItemFinished)
    vi.advanceTimersByTime(1_000);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1", "c2"]);
  });

  it("NO dispara el siguiente mientras el clip anterior sigue sonando (respeta el cooldown)", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 5_000);
    // El primer canje ya cumplió su cooldown (venía de un disparo previo lejano).
    h.lastFired.set("r1", Date.now() - 5_000);
    h.waiter.admit("r1", entry("c1"));
    h.waiter.admit("r1", entry("c2"));

    // Dispara c1. El servidor TODAVÍA no selló un fin nuevo (el clip está
    // sonando): c2 NO debe dispararse pegado.
    vi.advanceTimersByTime(0);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1"]);

    // Pasa cualquier tiempo sin que se selle el fin: sigue sin salir c2.
    vi.advanceTimersByTime(30_000);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1"]);

    // Recién cuando el servidor sella el fin de c1 empieza a correr el cooldown.
    h.lastFired.set("r1", Date.now());
    h.waiter.kick("r1");
    vi.advanceTimersByTime(4_999);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1"]);
    vi.advanceTimersByTime(1);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1", "c2"]);
  });

  it("con la recompensa ocupada no dispara aunque el cooldown figure vencido", () => {
    const h = makeHarness({ busy: () => true });
    h.cooldowns.set("r1", 1_000);
    // `last_fired_at` viejo (vencido): sin el chequeo de ocupada, dispararía ya.
    h.lastFired.set("r1", Date.now() - 10_000);
    h.waiter.admit("r1", entry("c1"));

    vi.advanceTimersByTime(30_000);
    expect(h.fired).toHaveLength(0);

    // Al liberarse la recompensa (fin de reproducción) y sellar el cooldown,
    // recién ahí dispara.
    h.setBusy(() => false);
    h.lastFired.set("r1", Date.now());
    h.waiter.kick("r1");
    vi.advanceTimersByTime(1_000);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1"]);
  });

  it("rechaza un evento duplicado (idempotencia)", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 10_000);
    h.lastFired.set("r1", Date.now());
    expect(h.waiter.admit("r1", entry("c1")).admitted).toBe(true);
    expect(h.waiter.admit("r1", entry("c1"))).toEqual({ admitted: false, reason: "duplicate" });
  });

  it("rechaza cuando se supera el tope de cantidad", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 10_000);
    h.lastFired.set("r1", Date.now());
    // El harness fija maxWaiting en 20.
    for (let i = 0; i < 20; i += 1) {
      expect(h.waiter.admit("r1", entry(`c${i}`)).admitted).toBe(true);
    }
    expect(h.waiter.admit("r1", entry("c20"))).toEqual({ admitted: false, reason: "full" });
  });

  it("omite los canjes que esperaron más del máximo (por antigüedad)", () => {
    const h = makeHarness();
    // Cooldown largo: el disparo estaba programado a los 11 minutos, más allá de
    // la espera máxima (10 min), así que al llegar se omite por antigüedad.
    h.cooldowns.set("r1", 11 * 60_000);
    h.lastFired.set("r1", Date.now());
    h.waiter.admit("r1", entry("c1"));
    vi.advanceTimersByTime(11 * 60_000);
    expect(h.fired).toHaveLength(0);
    expect(h.dropped).toEqual([{ rewardId: "r1", eventId: "c1", reason: "expired" }]);
    expect(h.waiter.totalWaiting()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discard vacía la espera de una recompensa y no dispara nada", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 1_000);
    h.lastFired.set("r1", Date.now());
    h.waiter.admit("r1", entry("c1"));
    const discarded = h.waiter.discard("r1");
    expect(discarded.map((e) => e.eventId)).toEqual(["c1"]);
    vi.advanceTimersByTime(5_000);
    expect(h.fired).toHaveLength(0);
  });

  it("dos recompensas con esperas simultáneas no se interfieren", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 1_000);
    h.cooldowns.set("r2", 3_000);
    h.lastFired.set("r1", Date.now());
    h.lastFired.set("r2", Date.now());
    h.waiter.admit("r1", entry("a1"));
    h.waiter.admit("r2", entry("b1"));

    vi.advanceTimersByTime(1_000);
    expect(h.fired).toEqual([{ rewardId: "r1", eventId: "a1" }]);

    vi.advanceTimersByTime(2_000);
    expect(h.fired).toEqual([
      { rewardId: "r1", eventId: "a1" },
      { rewardId: "r2", eventId: "b1" },
    ]);
  });

  it("remainingSec refleja lo que falta para el próximo disparo", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 10_000);
    h.lastFired.set("r1", Date.now());
    expect(h.waiter.remainingSec("r1")).toBe(10);
    vi.advanceTimersByTime(4_000);
    expect(h.waiter.remainingSec("r1")).toBe(6);
    vi.advanceTimersByTime(6_000);
    expect(h.waiter.remainingSec("r1")).toBe(0);
  });

  it("no deja temporizadores colgados al vaciarse la espera", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 1_000);
    h.lastFired.set("r1", Date.now());
    h.waiter.admit("r1", entry("c1"));
    vi.advanceTimersByTime(1_000);
    expect(h.waiter.totalWaiting()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rewardIds lista solo las recompensas con canjes en espera", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 10_000);
    h.cooldowns.set("r2", 10_000);
    h.lastFired.set("r1", Date.now());
    h.lastFired.set("r2", Date.now());
    h.waiter.admit("r1", entry("c1"));
    h.waiter.admit("r2", entry("c2"));
    expect(h.waiter.rewardIds().sort()).toEqual(["r1", "r2"]);
    h.waiter.discard("r1");
    expect(h.waiter.rewardIds()).toEqual(["r2"]);
  });

  it("dispara de a UNO: nunca dos en el mismo instante (atomicidad)", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 1_000);
    h.lastFired.set("r1", Date.now() - 2_000); // ya cumplido
    h.waiter.admit("r1", entry("c1"));
    h.waiter.admit("r1", entry("c2"));

    // Al dispararse el primero, el siguiente NO se dispara en el mismo tick.
    vi.advanceTimersByTime(0);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1"]);
    // Solo cuando se sella el fin del primero (kick) se programa el siguiente.
    h.lastFired.set("r1", Date.now());
    h.waiter.kick("r1");
    vi.advanceTimersByTime(1_000);
    expect(h.fired.map((f) => f.eventId)).toEqual(["c1", "c2"]);
  });

  it("discardAll devuelve todas las esperas y las vacía", () => {
    const h = makeHarness();
    h.cooldowns.set("r1", 10_000);
    h.cooldowns.set("r2", 10_000);
    h.lastFired.set("r1", Date.now());
    h.lastFired.set("r2", Date.now());
    h.waiter.admit("r1", entry("c1"));
    h.waiter.admit("r2", entry("c2"));
    const all = h.waiter.discardAll();
    expect(all).toHaveLength(2);
    expect(h.waiter.totalWaiting()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
