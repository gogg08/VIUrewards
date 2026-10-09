/**
 * Tests de eventos normalizados y fuentes locales (Fase 4A).
 */

import { describe, expect, it } from "vitest";

import {
  createEvent,
  isEventType,
  ManualEventSource,
  payloadAmount,
  payloadArgs,
  payloadCommand,
  payloadRewardId,
  payloadUserInput,
  SimulatedEventSource,
  type NormalizedEvent,
} from "./index.ts";

describe("createEvent", () => {
  it("completa id, plataforma, usuario y timestamp", () => {
    const event = createEvent({ type: "manual" });
    expect(event.id).toBeTruthy();
    expect(event.platform).toBe("local");
    expect(event.user).toEqual({ id: "system", name: "system", roles: [] });
    expect(typeof event.timestamp).toBe("number");
  });

  it("respeta lo que se pasa", () => {
    const event = createEvent({
      type: "chat_command",
      platform: "simulated",
      id: "evt-1",
      user: { id: "u1", name: "Ana", roles: ["subscriber"] },
      payload: { command: "alerta", args: ["x"] },
      timestamp: 123,
    });
    expect(event).toMatchObject({ id: "evt-1", platform: "simulated", timestamp: 123 });
  });
});

describe("isEventType", () => {
  it("valida los tipos conocidos", () => {
    expect(isEventType("chat_command")).toBe(true);
    expect(isEventType("reward_redeemed")).toBe(true);
    expect(isEventType("nope")).toBe(false);
    expect(isEventType(42)).toBe(false);
  });
});

describe("helpers de payload", () => {
  it("leen los campos conocidos sin romper con payload libre", () => {
    const chat = createEvent({ type: "chat_command", payload: { command: "alerta", args: ["a", 2, "b"] } });
    expect(payloadCommand(chat.payload)).toBe("alerta");
    expect(payloadArgs(chat.payload)).toEqual(["a", "b"]);

    const reward = createEvent({
      type: "reward_redeemed",
      payload: { rewardId: "r1", rewardTitle: "T", userInput: "https://x" },
    });
    expect(payloadRewardId(reward.payload)).toBe("r1");
    expect(payloadUserInput(reward.payload)).toBe("https://x");

    const gift = createEvent({ type: "gift", payload: { amount: 10 } });
    expect(payloadAmount(gift.payload)).toBe(10);

    const empty = createEvent({ type: "follow" });
    expect(payloadCommand(empty.payload)).toBeNull();
    expect(payloadRewardId(empty.payload)).toBeNull();
    expect(payloadUserInput(empty.payload)).toBe("");
    expect(payloadAmount(empty.payload)).toBeNull();
  });
});

describe("ManualEventSource", () => {
  it("emite eventos manuales a los suscriptores", () => {
    const source = new ManualEventSource();
    const received: NormalizedEvent[] = [];
    const off = source.onEvent((event) => received.push(event));
    const event = source.trigger({ user: { id: "u1", name: "Ana" } });

    expect(event.type).toBe("manual");
    expect(event.platform).toBe("manual");
    expect(received).toHaveLength(1);

    off();
    source.trigger();
    expect(received).toHaveLength(1);
  });
});

describe("SimulatedEventSource", () => {
  it("puede emitir cualquier tipo y resolver canjes", async () => {
    const resolutions: Array<{ eventId: string; outcome: string }> = [];
    const source = new SimulatedEventSource({
      onResolve: (eventId, outcome) => resolutions.push({ eventId, outcome }),
    });

    expect(source.capabilities.types).toContain("reward_redeemed");
    expect(source.capabilities.resolve).toBe(true);

    const received: NormalizedEvent[] = [];
    source.onEvent((event) => received.push(event));

    const event = source.trigger({ type: "reward_redeemed", payload: { rewardId: "r1", rewardTitle: "T", userInput: "" } });
    expect(received).toHaveLength(1);
    expect(event.type).toBe("reward_redeemed");

    await source.resolve(event.id, "accept");
    expect(resolutions).toEqual([{ eventId: event.id, outcome: "accept" }]);
    expect(source.getResolutions()).toHaveLength(1);
  });
});