/**
 * Tests del despachador de recompensas (Parte B): cooldown global atómico,
 * orden/atomicidad de un mismo ciclo y modo superpuesto.
 */

import { describe, expect, it } from "vitest";

import {
  openMemoryDatabase,
  upsertClip,
  upsertReward,
  type RewardRecord,
  type SqliteDatabase,
} from "../db/index.ts";
import { createEvent, type NormalizedEvent, type ResolveOutcome } from "../events/index.ts";
import { AlertQueue } from "../queue/index.ts";
import { RuleEngine } from "../rules/index.ts";
import type { AudioPlayback } from "./protocol.ts";
import { RewardDispatcher } from "./reward-dispatch.ts";

const REWARD_REMOTE = "rw-1";

function addClip(db: SqliteDatabase, id: string, hasVideo = true): void {
  upsertClip(db, {
    id,
    sourceUrl: "https://www.youtube.com/watch?v=x",
    title: id,
    durationSec: 10,
    sizeBytes: 1,
    file: `${id}.mp4`,
    createdAt: new Date().toISOString(),
    trimStart: null,
    trimEnd: null,
    hasVideo,
  });
}

function reward(overrides: Partial<RewardRecord> = {}): RewardRecord {
  return {
    id: "local-1",
    platform: "kick",
    remoteRewardId: REWARD_REMOTE,
    title: "Alerta",
    cost: 100,
    color: "#00e701",
    description: "",
    clipId: "clip-1",
    volume: 1,
    maxDurationSec: null,
    cooldownSec: 0,
    repetition: "queue",
    audioOnly: false,
    lastFiredAt: null,
    position: null,
    enterAnimation: null,
    exitAnimation: null,
    desiredEnabled: true,
    managed: true,
    synced: true,
    ruleId: "rule-1",
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function rewardEvent(id: string): NormalizedEvent {
  return createEvent({
    id,
    platform: "kick",
    type: "reward_redeemed",
    user: { id: "u1", name: "Ana", roles: [] },
    payload: { rewardId: REWARD_REMOTE, rewardTitle: "Alerta", userInput: "" },
  });
}

interface Harness {
  db: SqliteDatabase;
  dispatcher: RewardDispatcher;
  queue: AlertQueue;
  audios: AudioPlayback[];
  resolutions: Array<{ id: string; outcome: ResolveOutcome }>;
  clock: { value: number };
  setAudioRecipients: (count: number) => void;
}

function makeHarness(): Harness {
  const db = openMemoryDatabase();
  const queue = new AlertQueue();
  const audios: AudioPlayback[] = [];
  const resolutions: Array<{ id: string; outcome: ResolveOutcome }> = [];
  const clock = { value: 1_000 };
  let audioRecipients = 1;
  const resolveEvent = async (event: NormalizedEvent, outcome: ResolveOutcome): Promise<void> => {
    resolutions.push({ id: event.id, outcome });
  };

  // El motor resuelve el canje cuando encola (PlayClip acepta al encolar), igual
  // que en producción: `new RuleEngine({ queue, resolveEvent })`.
  const engine = new RuleEngine({ queue, resolveEvent });
  engine.setRules([
    {
      id: "rule-1",
      name: "Recompensa: Alerta",
      enabled: true,
      trigger: { type: "reward_redeemed", rewardId: REWARD_REMOTE },
      conditions: { permission: "everyone" },
      action: { kind: "play_clip", clipId: "clip-1" },
    },
  ]);

  const dispatcher = new RewardDispatcher({
    db,
    engine,
    now: () => clock.value,
    broadcastAudio: (audio) => {
      audios.push(audio);
      return audioRecipients;
    },
    resolveEvent: async (event, outcome) => {
      resolutions.push({ id: event.id, outcome });
    },
    mediaUrl: (clipId) => `/media/${clipId}.mp4?key=k`,
    globalVolume: () => 100,
    defaultMaxDuration: () => 30,
    maxVoices: () => 8,
  });

  return {
    db,
    dispatcher,
    queue,
    audios,
    resolutions,
    clock,
    setAudioRecipients: (count) => {
      audioRecipients = count;
    },
  };
}

describe("modo cola: cooldown global", () => {
  it("dispara, encola y acepta el canje", async () => {
    const h = makeHarness();
    upsertReward(h.db, reward({ cooldownSec: 0 }));
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result).toMatchObject({ outcome: "fired", ruleId: "rule-1" });
    expect(h.queue.getState().current?.clipId).toBe("clip-1");
    expect(h.resolutions).toEqual([{ id: "c1", outcome: "accept" }]);
  });

  it("bloquea el segundo canje del mismo ciclo y lo omite con el motivo exacto", async () => {
    const h = makeHarness();
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    // Dos canjes en el mismo ciclo: se lanzan sin esperar el primero.
    const [first, second] = await Promise.all([
      h.dispatcher.process(rewardEvent("c1")),
      h.dispatcher.process(rewardEvent("c2")),
    ]);
    expect(first.outcome).toBe("fired");
    expect(second).toMatchObject({ outcome: "skipped", reason: "cooldown, faltan 30 s" });
    // Solo un ítem disparado: el cooldown quedó registrado en el primer ciclo.
    expect(h.resolutions).toEqual([{ id: "c1", outcome: "accept" }]);
  });

  it("con cooldown 0 no bloquea", async () => {
    const h = makeHarness();
    upsertReward(h.db, reward({ cooldownSec: 0 }));
    const [a, b] = await Promise.all([
      h.dispatcher.process(rewardEvent("c1")),
      h.dispatcher.process(rewardEvent("c2")),
    ]);
    expect(a.outcome).toBe("fired");
    expect(b.outcome).toBe("fired");
  });

  it("el cooldown persiste entre llamadas (sobrevive reinicios)", async () => {
    const h = makeHarness();
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    await h.dispatcher.process(rewardEvent("c1"));
    // Otro despachador, misma base: el last_fired_at se lee de la fila.
    const again = new RewardDispatcher({
      db: h.db,
      engine: new RuleEngine({ queue: h.queue }),
      now: () => h.clock.value,
      broadcastAudio: () => 1,
      resolveEvent: async () => {},
      mediaUrl: (clipId) => `/media/${clipId}.mp4`,
      globalVolume: () => 100,
      defaultMaxDuration: () => 30,
      maxVoices: () => 8,
    });
    const blocked = await again.process(rewardEvent("c2"));
    expect(blocked).toMatchObject({ outcome: "skipped", reason: "cooldown, faltan 30 s" });
  });

  it("sin recompensa local, el evento va al motor (no_match)", async () => {
    const h = makeHarness();
    const event = createEvent({
      id: "x1",
      platform: "kick",
      type: "reward_redeemed",
      payload: { rewardId: "otra", rewardTitle: "Otra", userInput: "" },
    });
    expect((await h.dispatcher.process(event)).outcome).toBe("no_match");
  });
});

describe("modo superpuesto", () => {
  it("manda el audio, no entra en la cola y acepta el canje", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap", volume: 0.5, maxDurationSec: 5 }));
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result.outcome).toBe("fired");
    expect(h.queue.getState().current).toBeNull();
    expect(h.audios).toHaveLength(1);
    expect(h.audios[0]).toMatchObject({
      id: "c1",
      url: "/media/clip-1.mp4?key=k",
      volume: 0.5,
      maxDurationSec: 5,
      maxVoices: 8,
    });
    expect(h.resolutions).toEqual([{ id: "c1", outcome: "accept" }]);
  });

  it("nunca lo bloquea un cooldown", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap", cooldownSec: 600 }));
    expect((await h.dispatcher.process(rewardEvent("c1"))).outcome).toBe("fired");
    expect((await h.dispatcher.process(rewardEvent("c2"))).outcome).toBe("fired");
    expect(h.audios).toHaveLength(2);
  });

  it("sin overlay conectado queda omitido con el motivo exacto", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));
    h.setAudioRecipients(0);
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result).toMatchObject({ outcome: "skipped", reason: "sin overlay conectado" });
    expect(h.resolutions).toEqual([]);
  });

  it("el modo overlap siempre usa playAudio, aunque el clip tenga imagen", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result.outcome).toBe("fired");
    expect(h.audios).toHaveLength(1);
    expect(h.queue.getState().current).toBeNull();
  });
});

describe("modo cola con solo audio", () => {
  it("encola el clip marcando audioOnly (el overlay oculta la imagen)", async () => {
    const db = openMemoryDatabase();
    const queue = new AlertQueue();
    const engine = new RuleEngine({ queue });
    engine.setRules([
      {
        id: "rule-1",
        name: "Recompensa: Alerta",
        enabled: true,
        trigger: { type: "reward_redeemed", rewardId: REWARD_REMOTE },
        conditions: { permission: "everyone" },
        action: { kind: "play_clip", clipId: "clip-1", audioOnly: true },
      },
    ]);
    const dispatcher = new RewardDispatcher({
      db,
      engine,
      now: () => 1_000,
      broadcastAudio: () => 1,
      resolveEvent: async () => {},
      mediaUrl: (clipId) => `/media/${clipId}.mp4`,
      globalVolume: () => 100,
      defaultMaxDuration: () => 30,
      maxVoices: () => 8,
    });
    addClip(db, "clip-1", true);
    upsertReward(db, reward({ repetition: "queue", audioOnly: true }));
    const result = await dispatcher.process(rewardEvent("c1"));
    expect(result.outcome).toBe("fired");
    expect(queue.getState().current?.params.audioOnly).toBe(true);
  });
});