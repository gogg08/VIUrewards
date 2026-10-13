/**
 * Tests del motor de reglas (Fase 4A; Parte B). Coincidencia de triggers,
 * permisos, idempotencia por event.id, aislamiento de errores entre reglas y
 * ejecución de la acción play_clip.
 *
 * El cooldown YA NO vive en el motor: es un dato de la recompensa, aplicado por
 * el despachador (ver `src/server/reward-dispatch.test.ts`) y decidido por la
 * función pura `decide` (ver `cooldown.test.ts`).
 */

import { describe, expect, it } from "vitest";

import { createEvent, type NormalizedEvent } from "../events/index.ts";
import { AlertQueue } from "../queue/index.ts";
import { RuleEngine } from "./engine.ts";
import { hasPermission, matchesTrigger, normalizeCommand } from "./matching.ts";
import type { ActionResolver, Rule } from "./types.ts";

function chatEvent(command: string, args: string[] = [], roles: string[] = []): NormalizedEvent {
  return createEvent({
    type: "chat_command",
    platform: "simulated",
    id: `evt-${command}-${Math.random()}`,
    user: { id: "u1", name: "Ana", roles },
    payload: { command, args },
  });
}

function rewardEvent(rewardId: string, userInput = "", roles: string[] = []): NormalizedEvent {
  return createEvent({
    type: "reward_redeemed",
    platform: "simulated",
    id: `evt-r-${rewardId}-${Math.random()}`,
    user: { id: "u1", name: "Ana", roles },
    payload: { rewardId, rewardTitle: "Alerta", userInput },
  });
}

function playRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule-1",
    name: "Alerta",
    enabled: true,
    trigger: { type: "chat_command", command: "alerta" },
    conditions: { permission: "everyone" },
    action: { kind: "play_clip", clipId: "clip-1" },
    ...overrides,
  };
}

interface EngineHarness {
  engine: RuleEngine;
  queue: AlertQueue;
}

function makeEngine(resolveAction?: ActionResolver): EngineHarness {
  const queue = new AlertQueue();
  const engine = new RuleEngine({ queue, resolveAction });
  return { engine, queue };
}

describe("matching", () => {
  it("normaliza el nombre del comando (con o sin !)", () => {
    expect(normalizeCommand("!Alerta")).toBe("alerta");
    expect(normalizeCommand("alerta")).toBe("alerta");
  });

  it("coincide por tipo y comando", () => {
    expect(matchesTrigger({ type: "chat_command", command: "alerta" }, chatEvent("!alerta"))).toBe(true);
    expect(matchesTrigger({ type: "chat_command", command: "alerta" }, chatEvent("hola"))).toBe(false);
  });

  it("coincide por rewardId y monto mínimo", () => {
    expect(matchesTrigger({ type: "reward_redeemed", rewardId: "r1" }, rewardEvent("r1"))).toBe(true);
    expect(matchesTrigger({ type: "reward_redeemed", rewardId: "r2" }, rewardEvent("r1"))).toBe(false);

    const gift = createEvent({ type: "gift", payload: { amount: 5 } });
    expect(matchesTrigger({ type: "gift", minAmount: 5 }, gift)).toBe(true);
    expect(matchesTrigger({ type: "gift", minAmount: 10 }, gift)).toBe(false);
  });
});

describe("permisos", () => {
  it("everyone, subs y mods", () => {
    expect(hasPermission("everyone", { id: "u", name: "u", roles: [] })).toBe(true);
    expect(hasPermission("subs", { id: "u", name: "u", roles: [] })).toBe(false);
    expect(hasPermission("subs", { id: "u", name: "u", roles: ["subscriber"] })).toBe(true);
    expect(hasPermission("mods", { id: "u", name: "u", roles: ["subscriber"] })).toBe(false);
    expect(hasPermission("mods", { id: "u", name: "u", roles: ["moderator"] })).toBe(true);
    expect(hasPermission("mods", { id: "u", name: "u", roles: ["broadcaster"] })).toBe(true);
  });
});

describe("RuleEngine", () => {
  it("dispara la regla y encola el clip", async () => {
    const h = makeEngine();
    h.engine.setRules([playRule()]);
    const result = await h.engine.handle(chatEvent("alerta"));
    expect(result).toMatchObject({ outcome: "fired", ruleId: "rule-1" });
    expect(h.queue.getState().current?.clipId).toBe("clip-1");
  });

  it("no dispara si el permiso no alcanza", async () => {
    const h = makeEngine();
    h.engine.setRules([playRule({ conditions: { permission: "mods" } })]);
    const result = await h.engine.handle(chatEvent("alerta"));
    expect(result).toMatchObject({ outcome: "skipped", reason: "sin permiso" });
    expect(h.queue.getState().current).toBeNull();
  });

  it("trata como omitida una acción que devuelve fired: false", async () => {
    const h = makeEngine(() => ({
      kind: "play_clip",
      execute: () => ({ fired: false, reason: "sin overlay conectado" }),
    }));
    h.engine.setRules([playRule()]);
    const result = await h.engine.handle(chatEvent("alerta"));
    expect(result).toMatchObject({ outcome: "skipped", reason: "sin overlay conectado" });
    expect(h.queue.getState().current).toBeNull();
  });

  it("es idempotente por event.id", async () => {
    const h = makeEngine();
    h.engine.setRules([playRule()]);
    const event = chatEvent("alerta");
    expect((await h.engine.handle(event)).outcome).toBe("fired");
    expect((await h.engine.handle(event)).outcome).toBe("duplicate");
    expect(h.queue.getState().current?.clipId).toBe("clip-1");
    expect(h.queue.getState().size).toBe(0);
  });

  it("aísla el error de una regla y sigue con las demás", async () => {
    const h = makeEngine((config) => {
      if (config.kind === "play_clip" && config.clipId === "boom") {
        return {
          kind: "play_clip",
          execute: () => {
            throw new Error("boom");
          },
        };
      }
      return { kind: "play_clip", execute: () => { h.queue.enqueue({ clipId: "clip-2" }); } };
    });
    h.engine.setRules([
      playRule({ id: "r1", action: { kind: "play_clip", clipId: "boom" } }),
      playRule({ id: "r2", action: { kind: "play_clip", clipId: "clip-2" } }),
    ]);
    const result = await h.engine.handle(chatEvent("alerta"));
    expect(result).toMatchObject({ outcome: "fired", ruleId: "r2" });
    expect(h.queue.getState().current?.clipId).toBe("clip-2");
  });

  it("devuelve no_match cuando ninguna regla aplica", async () => {
    const h = makeEngine();
    h.engine.setRules([playRule()]);
    const result = await h.engine.handle(chatEvent("otro"));
    expect(result.outcome).toBe("no_match");
  });

  it("respeta una regla desactivada", async () => {
    const h = makeEngine();
    h.engine.setRules([playRule({ enabled: false })]);
    expect((await h.engine.handle(chatEvent("alerta"))).outcome).toBe("no_match");
  });
});