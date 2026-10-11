/**
 * Tests del motor de reglas (Fase 4A): coincidencia de triggers, permisos,
 * cooldowns (global y por usuario), idempotencia por event.id, aislamiento de
 * errores entre reglas y ejecución de la acción play_clip.
 */

import { describe, expect, it } from "vitest";

import { createEvent, type NormalizedEvent } from "../events/index.ts";
import { AlertQueue } from "../queue/index.ts";
import { CooldownTracker } from "./cooldown.ts";
import { RuleEngine } from "./engine.ts";
import { hasPermission, matchesTrigger, normalizeCommand } from "./matching.ts";
import type { Rule, RuleActionConfig } from "./types.ts";

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
    conditions: { permission: "everyone", cooldownSec: 0, userCooldownSec: 0 },
    action: { kind: "play_clip", clipId: "clip-1" },
    ...overrides,
  };
}

interface EngineHarness {
  engine: RuleEngine;
  queue: AlertQueue;
  clock: { value: number };
}

function makeEngine(resolveAction?: (config: RuleActionConfig) => { kind: string; execute: () => void }): EngineHarness {
  const queue = new AlertQueue();
  const clock = { value: 1_000 };
  const engine = new RuleEngine({
    queue,
    now: () => clock.value,
    resolveAction,
  });
  return { engine, queue, clock };
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

describe("CooldownTracker", () => {
  it("bloquea el cooldown global y lo libera con el reloj", () => {
    const clock = { value: 0 };
    const tracker = new CooldownTracker(() => clock.value);
    const conditions = { permission: "everyone" as const, cooldownSec: 10, userCooldownSec: 0 };
    expect(tracker.check("r", "u", conditions).allowed).toBe(true);
    tracker.mark("r", "u", conditions);
    expect(tracker.check("r", "u", conditions)).toMatchObject({ allowed: false, remainingSec: 10 });
    clock.value = 10_000;
    expect(tracker.check("r", "u", conditions).allowed).toBe(true);
  });

  it("el cooldown por usuario no afecta a otro usuario", () => {
    const clock = { value: 0 };
    const tracker = new CooldownTracker(() => clock.value);
    const conditions = { permission: "everyone" as const, cooldownSec: 0, userCooldownSec: 10 };
    tracker.mark("r", "u1", conditions);
    expect(tracker.check("r", "u1", conditions).allowed).toBe(false);
    expect(tracker.check("r", "u2", conditions).allowed).toBe(true);
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
    h.engine.setRules([playRule({ conditions: { permission: "mods", cooldownSec: 0, userCooldownSec: 0 } })]);
    const result = await h.engine.handle(chatEvent("alerta"));
    expect(result).toMatchObject({ outcome: "skipped", reason: "sin permiso" });
    expect(h.queue.getState().current).toBeNull();
  });

  it("respeta el cooldown global", async () => {
    const h = makeEngine();
    h.engine.setRules([playRule({ conditions: { permission: "everyone", cooldownSec: 30, userCooldownSec: 0 } })]);
    await h.engine.handle(chatEvent("alerta"));
    const again = await h.engine.handle(chatEvent("alerta"));
    expect(again.outcome).toBe("skipped");
    expect(again.reason).toContain("cooldown");
  });

  it("es idempotente por event.id", async () => {
    const h = makeEngine();
    h.engine.setRules([playRule()]);
    const event = chatEvent("alerta");
    expect((await h.engine.handle(event)).outcome).toBe("fired");
    expect((await h.engine.handle(event)).outcome).toBe("duplicate");
    // Solo un ítem en la cola.
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
      return { kind: "play_clip", execute: () => h.queue.enqueue({ clipId: "clip-2" }) };
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