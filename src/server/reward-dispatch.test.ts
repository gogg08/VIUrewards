/**
 * Tests del despachador de recompensas (Parte B): cooldown global atómico,
 * orden/atomicidad de un mismo ciclo y modo superpuesto.
 */

import { describe, expect, it } from "vitest";

import {
  getReward,
  openMemoryDatabase,
  setClipMissing,
  setRewardLastFired,
  upsertClip,
  upsertReward,
  type RewardRecord,
  type SqliteDatabase,
} from "../db/index.ts";
import { createEvent, type NormalizedEvent, type ResolveOutcome } from "../events/index.ts";
import { AlertQueue } from "../queue/index.ts";
import { RuleEngine } from "../rules/index.ts";
import type { AudioPlayback } from "./protocol.ts";
import { RewardDispatcher, type WaitPolicy } from "./reward-dispatch.ts";

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
    missing: false,
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
  /** Simula que el clip de la recompensa terminó de reproducirse (sella el cooldown). */
  finish: (rewardId: string) => void;
  setWaitPolicy: (policy: WaitPolicy) => void;
  /** Simula que la recompensa tiene/ya no tiene un clip en curso. */
  setBusy: (busy: boolean) => void;
}

function makeHarness(
  options: { waitPolicy?: WaitPolicy; startGate?: { remainingMs(): number; markStart(): void; markEnd(): void } } = {},
): Harness {
  const db = openMemoryDatabase();
  const queue = new AlertQueue();
  const audios: AudioPlayback[] = [];
  const resolutions: Array<{ id: string; outcome: ResolveOutcome }> = [];
  const clock = { value: 1_000 };
  let audioRecipients = 1;
  let waitPolicy: WaitPolicy = options.waitPolicy ?? "skip";
  let rewardBusy = false;
  // Cola de espera mínima en memoria (un solo nivel), para probar el despacho.
  const waiting: Array<{ rewardId: string; event: NormalizedEvent }> = [];
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
    waitPolicy: () => waitPolicy,
    startGate: options.startGate,
    isRewardBusy: () => rewardBusy,
    markPlay: () => {
      // No hace falta el id acá: el harness dispara el siguiente a mano.
    },
    admitWait: (reward, event) => {
      if (waiting.some((item) => item.event.id === event.id)) return { admitted: false, reason: "duplicate" };
      if (waiting.filter((item) => item.rewardId === reward.id).length >= 20) {
        return { admitted: false, reason: "full" };
      }
      waiting.push({ rewardId: reward.id, event });
      return { admitted: true };
    },
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
    setWaitPolicy: (policy) => {
      waitPolicy = policy;
    },
    setBusy: (busy) => {
      rewardBusy = busy;
    },
    finish: (rewardId) => {
      setRewardLastFired(db, rewardId, clock.value);
      // Dispara el siguiente en espera, si hay.
      const index = waiting.findIndex((item) => item.rewardId === rewardId);
      if (index >= 0) {
        const [next] = waiting.splice(index, 1);
        const reward = getReward(db, rewardId);
        if (reward) void dispatcher.dispatchWaiting(reward, next.event);
      }
    },
  };
}

describe("modo cola: cooldown global", () => {
  it("dispara, encola y acepta el canje", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 0 }));
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result).toMatchObject({ outcome: "fired", ruleId: "rule-1" });
    expect(h.queue.getState().current?.clipId).toBe("clip-1");
    expect(h.resolutions).toEqual([{ id: "c1", outcome: "accept" }]);
  });

  it("bloquea el segundo canje del mismo ciclo y lo omite con el motivo exacto", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    // El primer canje encola y «termina» (sella el cooldown al terminar el clip).
    const first = await h.dispatcher.process(rewardEvent("c1"));
    expect(first.outcome).toBe("fired");
    h.finish("local-1");
    // El segundo llega dentro del cooldown y se omite con el motivo de siempre.
    const second = await h.dispatcher.process(rewardEvent("c2"));
    expect(second).toMatchObject({ outcome: "skipped", reason: "cooldown, faltan 30 s" });
    expect(h.resolutions).toEqual([{ id: "c1", outcome: "accept" }]);
  });

  it("con cooldown 0 no bloquea", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
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
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    await h.dispatcher.process(rewardEvent("c1"));
    h.finish("local-1");
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

describe("clip con archivo ausente (missing)", () => {
  it("en modo cola se omite con motivo 'falta el archivo del clip' y no encola", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    setClipMissing(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "queue" }));

    const result = await h.dispatcher.process(rewardEvent("c1"));

    expect(result).toMatchObject({ outcome: "skipped", reason: "falta el archivo del clip" });
    // Nunca se encola algo que pediría un archivo inexistente al overlay.
    expect(h.queue.getState().current).toBeNull();
    expect(h.resolutions).toEqual([]);
  });

  it("en modo superpuesto se omite con el mismo motivo y no manda audio", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    setClipMissing(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));

    const result = await h.dispatcher.process(rewardEvent("c1"));

    expect(result).toMatchObject({ outcome: "skipped", reason: "falta el archivo del clip" });
    expect(h.audios).toEqual([]);
  });

  it("una recompensa sin clip se omite con un motivo distinto y claro", async () => {
    const h = makeHarness();
    upsertReward(h.db, reward({ repetition: "queue", clipId: null }));

    const result = await h.dispatcher.process(rewardEvent("c1"));

    expect(result).toMatchObject({ outcome: "skipped", reason: "la recompensa no tiene clip" });
    expect(h.queue.getState().current).toBeNull();
  });

  it("si el archivo reaparece (missing en falso), vuelve a disparar", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    setClipMissing(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "queue" }));
    expect((await h.dispatcher.process(rewardEvent("c1"))).outcome).toBe("skipped");

    setClipMissing(h.db, "clip-1", false);
    expect((await h.dispatcher.process(rewardEvent("c2"))).outcome).toBe("fired");
  });

  it("un clip ausente NUNCA consume el cooldown (con cooldown configurado)", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    setClipMissing(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "queue", cooldownSec: 30 }));

    // Dos canjes seguidos con el archivo ausente: los dos se omiten por el clip
    // (no por cooldown) y NINGUNO registra last_fired_at.
    const first = await h.dispatcher.process(rewardEvent("c1"));
    const second = await h.dispatcher.process(rewardEvent("c2"));
    expect(first).toMatchObject({ outcome: "skipped", reason: "falta el archivo del clip" });
    expect(second).toMatchObject({ outcome: "skipped", reason: "falta el archivo del clip" });

    // El cooldown no quedó registrado: al reaparecer, el siguiente canje dispara
    // enseguida (si se hubiera consumido, daría "cooldown, faltan N s").
    setClipMissing(h.db, "clip-1", false);
    const third = await h.dispatcher.process(rewardEvent("c3"));
    expect(third.outcome).toBe("fired");
    expect(h.queue.getState().current?.clipId).toBe("clip-1");
  });

  it("el cooldown sigue bloqueando el segundo canje cuando el clip SÍ existe", async () => {
    // Control: la omisión por clip ausente no rompe el cooldown normal.
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "queue", cooldownSec: 30 }));
    expect((await h.dispatcher.process(rewardEvent("c1"))).outcome).toBe("fired");
    h.finish("local-1");
    expect(await h.dispatcher.process(rewardEvent("c2"))).toMatchObject({
      outcome: "skipped",
      reason: "cooldown, faltan 30 s",
    });
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

describe("espera por cooldown (poner en cola)", () => {
  it("con la política 'queue' el canje dentro del cooldown queda en espera, no se omite", async () => {
    const h = makeHarness({ waitPolicy: "queue" });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    expect((await h.dispatcher.process(rewardEvent("c1"))).outcome).toBe("fired");
    h.finish("local-1");
    const second = await h.dispatcher.process(rewardEvent("c2"));
    expect(second).toMatchObject({ outcome: "waiting" });
  });

  it("al terminar el primero se dispara el siguiente en espera (uno por uno)", async () => {
    const h = makeHarness({ waitPolicy: "queue" });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    await h.dispatcher.process(rewardEvent("c1"));
    h.finish("local-1");
    await h.dispatcher.process(rewardEvent("c2"));
    // El fin del primer clip no dispara el c2 todavía: hay que cumplir el cooldown.
    expect(h.resolutions).toEqual([{ id: "c1", outcome: "accept" }]);
    // Al cumplirse el cooldown (30 s) y terminar de nuevo, se dispara c2.
    h.clock.value += 30_000;
    h.finish("local-1");
    expect(h.resolutions).toEqual([
      { id: "c1", outcome: "accept" },
      { id: "c2", outcome: "accept" },
    ]);
  });

  it("con la política 'skip' el canje dentro del cooldown se omite (como antes)", async () => {
    const h = makeHarness({ waitPolicy: "skip" });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    await h.dispatcher.process(rewardEvent("c1"));
    h.finish("local-1");
    const second = await h.dispatcher.process(rewardEvent("c2"));
    expect(second).toMatchObject({ outcome: "skipped", reason: "cooldown, faltan 30 s" });
  });

  it("el canje en espera NO se acepta hasta que dispara", async () => {
    const h = makeHarness({ waitPolicy: "queue" });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    await h.dispatcher.process(rewardEvent("c1"));
    h.finish("local-1");
    await h.dispatcher.process(rewardEvent("c2"));
    // Ni c2 ni c1 vuelven a aceptarse hasta que c2 dispare.
    expect(h.resolutions).toEqual([{ id: "c1", outcome: "accept" }]);
  });

  it("un clip ausente nunca entra a la espera (se omite por el clip)", async () => {
    const h = makeHarness({ waitPolicy: "queue" });
    addClip(h.db, "clip-1", true);
    setClipMissing(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result).toMatchObject({ outcome: "skipped", reason: "falta el archivo del clip" });
  });

  it("dispatchWaiting omite si el clip desapareció mientras esperaba", async () => {
    const h = makeHarness({ waitPolicy: "queue" });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    await h.dispatcher.process(rewardEvent("c1"));
    h.finish("local-1");
    await h.dispatcher.process(rewardEvent("c2"));
    // El archivo se borra mientras el canje espera.
    setClipMissing(h.db, "clip-1", true);
    h.clock.value += 30_000;
    const rewardRecord = getReward(h.db, "local-1");
    const fired = await h.dispatcher.dispatchWaiting(rewardRecord!, rewardEvent("c2"));
    expect(fired).toMatchObject({ outcome: "skipped", reason: "falta el archivo del clip" });
  });

  it("con la recompensa ocupada (clip en curso) el canje entra a la espera aunque el cooldown figure vencido", async () => {
    const h = makeHarness({ waitPolicy: "queue" });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 0 })); // sin cooldown: sólo la ocupa el clip
    h.setBusy(true);
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result).toMatchObject({ outcome: "waiting" });
    // No se encoló nada: el canje quedó esperando.
    expect(h.queue.getState().size).toBe(0);
  });

  it("con la recompensa ocupada y política 'skip' el canje se omite con motivo de cooldown", async () => {
    const h = makeHarness({ waitPolicy: "skip" });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ cooldownSec: 30 }));
    h.setBusy(true);
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toBe("cooldown, faltan 30 s");
  });
});
// --- Compuerta de inicio global en el modo superpuesto (Modo Chill) -----------

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor: tiempo agotado"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("modo superpuesto: compuerta de inicio global", () => {
  it("sin compuerta envía enseguida (comportamiento de siempre)", async () => {
    const h = makeHarness();
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));
    const result = await h.dispatcher.process(rewardEvent("c1"));
    expect(result.outcome).toBe("fired");
    expect(h.audios).toHaveLength(1);
  });

  it("con la compuerta cerrada programa el envío, acepta el canje y no duplica la espera", async () => {
    let lastStart = 0;
    // En "Superponer" la compuerta limita el INICIO de las alertas; el fin de una
    // superpuesta (markEnd) no la cierra: eso resuelve la cola en "Esperar turno".
    const intervalMs = 150;
    const h = makeHarness({
      startGate: {
        remainingMs: () => (lastStart ? Math.max(0, intervalMs - (Date.now() - lastStart)) : 0),
        markStart: () => {
          lastStart = Date.now();
        },
        markEnd: () => {},
      },
    });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));

    const first = await h.dispatcher.process(rewardEvent("c1"));
    expect(first.outcome).toBe("fired");
    expect(h.audios).toHaveLength(1);

    // El segundo llega dentro del intervalo: se acepta y el envío queda programado.
    const requestedAt = Date.now();
    const second = await h.dispatcher.process(rewardEvent("c2"));
    expect(second.outcome).toBe("fired");
    expect(h.audios).toHaveLength(1);
    expect(h.resolutions).toEqual([
      { id: "c1", outcome: "accept" },
      { id: "c2", outcome: "accept" },
    ]);

    await waitFor(() => h.audios.length === 2);
    // Una sola espera: no se sumó el intervalo dos veces.
    expect(Date.now() - requestedAt).toBeGreaterThanOrEqual(intervalMs - 20);
  });

  it("si no hay overlay conectado no marca el inicio en la compuerta", async () => {
    let starts = 0;
    const h = makeHarness({
      startGate: { remainingMs: () => 0, markStart: () => (starts += 1), markEnd: () => {} },
    });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));
    h.setAudioRecipients(0);

    const result = await h.dispatcher.process(rewardEvent("c1"));

    expect(result).toMatchObject({ outcome: "skipped", reason: "sin overlay conectado" });
    expect(starts).toBe(0);
  });

  it("con la compuerta abierta (intervalo cumplido) envía sin espera", async () => {
    let starts = 0;
    const h = makeHarness({
      startGate: { remainingMs: () => 0, markStart: () => (starts += 1), markEnd: () => {} },
    });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));

    await h.dispatcher.process(rewardEvent("c1"));
    await h.dispatcher.process(rewardEvent("c2"));

    expect(h.audios).toHaveLength(2);
    expect(starts).toBe(2);
  });

  it("cancelDeferred() descarta el audio diferido: no suena después del cierre", async () => {
    let lastStart = 0;
    const h = makeHarness({
      startGate: {
        remainingMs: () => (lastStart ? Math.max(0, 120 - (Date.now() - lastStart)) : 0),
        markStart: () => {
          lastStart = Date.now();
        },
        markEnd: () => {},
      },
    });
    addClip(h.db, "clip-1", true);
    upsertReward(h.db, reward({ repetition: "overlap" }));

    await h.dispatcher.process(rewardEvent("c1"));
    const second = await h.dispatcher.process(rewardEvent("c2"));
    // El canje se aceptó igual, pero el envío quedó programado.
    expect(second.outcome).toBe("fired");
    expect(h.audios).toHaveLength(1);

    expect(h.dispatcher.cancelDeferred()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Sin cancelDeferred() el segundo audio habría sonado al vencer el intervalo.
    expect(h.audios).toHaveLength(1);
    // Idempotente: ya no queda nada que cancelar.
    expect(h.dispatcher.cancelDeferred()).toBe(0);
  });
});
