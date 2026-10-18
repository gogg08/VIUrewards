/**
 * Tests del ciclo de vida de canjes (Fase 4B).
 *
 * El coordinador se prueba en aislamiento (base en memoria, `process` y `resolve`
 * falsos) con modelos de secuencias: cada transición permitida y cada camino de
 * error. Nada queda invisible: se lee el estado desde la tabla `redemptions`.
 */

import { describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../db/index.ts";
import { createEvent, type NormalizedEvent } from "../events/index.ts";
import {
  RedemptionCoordinator,
  type OldAction,
  type OnSkipPolicy,
  type ProcessOutcome,
  type RedemptionPolicy,
} from "./index.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function rewardEvent(id: string, timestamp = NOW): NormalizedEvent {
  return createEvent({
    id,
    platform: "fake",
    type: "reward_redeemed",
    user: { id: "u-1", name: "viewer" },
    payload: { rewardId: "rw-1", rewardTitle: "Alerta", userInput: "https://youtu.be/x" },
    timestamp,
  });
}

interface HarnessOptions {
  process?: (event: NormalizedEvent) => Promise<ProcessOutcome>;
  policy?: Partial<RedemptionPolicy>;
  resolveFails?: boolean;
  now?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const db = openMemoryDatabase();
  const resolveCalls: Array<{ id: string; outcome: "accept" | "reject" }> = [];
  let processed = 0;
  const policy: RedemptionPolicy = {
    onSkip: (options.policy?.onSkip ?? "leave_pending") as OnSkipPolicy,
    oldMinutes: options.policy?.oldMinutes ?? 10,
    oldAction: (options.policy?.oldAction ?? "ignore") as OldAction,
  };
  const coordinator = new RedemptionCoordinator({
    db,
    policy: () => policy,
    resolve: async (event, outcome) => {
      resolveCalls.push({ id: event.id, outcome });
      if (options.resolveFails) throw new Error("la plataforma rechazó la operación");
    },
    process: async (event) => {
      processed += 1;
      return options.process ? options.process(event) : { outcome: "fired" };
    },
    now: () => options.now ?? NOW,
  });
  return {
    coordinator,
    db,
    resolveCalls,
    get processedCount() {
      return processed;
    },
  };
}

describe("RedemptionCoordinator: regla PlayClip (fired)", () => {
  it("acepta el canje al encolar la alerta, sin que el coordinador resuelva nada", async () => {
    const h = makeHarness();
    const result = await h.coordinator.receive(rewardEvent("r1"));
    expect(result.status).toBe("accepted");
    expect(h.coordinator.get("fake", "r1")?.status).toBe("accepted");
    // PlayClip resuelve el accept en el motor; el coordinador no llama a resolve.
    expect(h.resolveCalls).toHaveLength(0);
  });

  it("es idempotente: el mismo canje no se procesa dos veces", async () => {
    const h = makeHarness();
    await h.coordinator.receive(rewardEvent("r1"));
    const second = await h.coordinator.receive(rewardEvent("r1"));
    expect(second.status).toBe("accepted");
    expect(h.processedCount).toBe(1);
  });
});

describe("RedemptionCoordinator: canje omitido (sin regla / cooldown / sin permiso)", () => {
  it("con la política por defecto (leave_pending) queda en ignored", async () => {
    const h = makeHarness({ process: async () => ({ outcome: "skipped", reason: "cooldown" }) });
    const result = await h.coordinator.receive(rewardEvent("r1"));
    expect(result.status).toBe("ignored");
    expect(result.reason).toBe("cooldown");
    expect(h.resolveCalls).toHaveLength(0);
  });

  it("con la política reject rechaza el canje en la plataforma", async () => {
    const h = makeHarness({
      process: async () => ({ outcome: "skipped", reason: "cooldown" }),
      policy: { onSkip: "reject" },
    });
    const result = await h.coordinator.receive(rewardEvent("r1"));
    expect(result.status).toBe("rejected");
    expect(h.resolveCalls).toEqual([{ id: "r1", outcome: "reject" }]);
  });

  it("si la plataforma no acepta el rechazo, el canje queda en failed", async () => {
    const h = makeHarness({
      process: async () => ({ outcome: "skipped", reason: "sin permiso" }),
      policy: { onSkip: "reject" },
      resolveFails: true,
    });
    const result = await h.coordinator.receive(rewardEvent("r1"));
    expect(result.status).toBe("failed");
  });
});

describe("RedemptionCoordinator: canjes viejos", () => {
  const old = () => rewardEvent("r1", NOW - 30 * MINUTE);

  it("con oldAction=ignore quedan en ignored y a la vista para decidir", async () => {
    const h = makeHarness({ policy: { oldAction: "ignore", oldMinutes: 10 } });
    const result = await h.coordinator.receive(old());
    expect(result.status).toBe("ignored");
    expect(h.coordinator.listIgnored("fake").map((row) => row.eventId)).toEqual(["r1"]);
  });

  it("con oldAction=reject los rechaza en la plataforma", async () => {
    const h = makeHarness({ policy: { oldAction: "reject" } });
    const result = await h.coordinator.receive(old());
    expect(result.status).toBe("rejected");
    expect(h.resolveCalls).toEqual([{ id: "r1", outcome: "reject" }]);
  });

  it("con oldAction=process los trata como nuevos", async () => {
    const h = makeHarness({ policy: { oldAction: "process" } });
    const result = await h.coordinator.receive(old());
    expect(result.status).toBe("accepted");
  });

  it("reprocesa un canje ignorado a pedido ('Procesar ahora')", async () => {
    const h = makeHarness({ policy: { oldAction: "ignore" } });
    await h.coordinator.receive(old());
    expect(h.coordinator.get("fake", "r1")?.status).toBe("ignored");
    const result = await h.coordinator.reprocess("fake", "r1");
    expect(result?.status).toBe("accepted");
  });

  it("rechaza todos los ignorados ('Rechazar todos')", async () => {
    const h = makeHarness({ policy: { oldAction: "ignore" } });
    await h.coordinator.receive(rewardEvent("a", NOW - 30 * MINUTE));
    await h.coordinator.receive(rewardEvent("b", NOW - 30 * MINUTE));
    const rejected = await h.coordinator.rejectAllIgnored("fake");
    expect(rejected).toBe(2);
    expect(h.coordinator.listIgnored("fake")).toHaveLength(0);
    expect(h.resolveCalls.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
});

describe("RedemptionCoordinator: canje en espera por cooldown", () => {
  it("queda en 'waiting' sin resolver en la plataforma hasta que suene", async () => {
    const h = makeHarness({
      process: async () => ({ outcome: "waiting", reason: "En espera por cooldown (12 s)" }),
    });
    const result = await h.coordinator.receive(rewardEvent("r1"));
    expect(result.status).toBe("waiting");
    expect(result.reason).toBe("En espera por cooldown (12 s)");
    expect(h.coordinator.get("fake", "r1")?.status).toBe("waiting");
    // No se resuelve en la plataforma: el canje queda pendiente.
    expect(h.resolveCalls).toHaveLength(0);
  });

  it("es idempotente: un canje en espera que reaparece por polling no se reprocesa", async () => {
    const h = makeHarness({ process: async () => ({ outcome: "waiting" }) });
    await h.coordinator.receive(rewardEvent("r1"));
    const again = await h.coordinator.receive(rewardEvent("r1"));
    expect(again.status).toBe("waiting");
    // Solo se procesó una vez (el estado 'waiting' no es 'ignored', no se reprocesa).
    expect(h.processedCount).toBe(1);
  });

  it("con onSkip='reject' el canje en espera igual NO se rechaza (no es un omitido)", async () => {
    const h = makeHarness({
      process: async () => ({ outcome: "waiting" }),
      policy: { onSkip: "reject" },
    });
    const result = await h.coordinator.receive(rewardEvent("r1"));
    expect(result.status).toBe("waiting");
    expect(h.resolveCalls).toHaveLength(0);
  });
});

describe("RedemptionCoordinator: aislamiento de errores", () => {
  it("si el procesamiento lanza, el canje queda en failed y no rompe el flujo", async () => {
    const h = makeHarness({
      process: async () => {
        throw new Error("explosión en el motor");
      },
    });
    const result = await h.coordinator.receive(rewardEvent("r1"));
    expect(result.status).toBe("failed");
  });
});
