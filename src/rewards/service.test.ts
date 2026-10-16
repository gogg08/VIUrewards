/**
 * Tests del `RewardService` (rediseño, Etapa 4A) con una integración falsa.
 *
 * No se toca ninguna red ni se conoce ninguna plataforma concreta: solo la
 * interfaz `PlatformIntegration`. Cubren la vista unificada (cada estado), cada
 * operación con su manejo de fallos, el flujo de canjes pendientes y la regla
 * interna 1:1.
 */

import { describe, expect, it, vi } from "vitest";

import { openMemoryDatabase, upsertClip, upsertReward, type RewardRecord, type SqliteDatabase } from "../db/index.ts";
import type { EventSource } from "../events/index.ts";
import type {
  AccountLinkState,
  PlatformAccount,
  PlatformIntegration,
  PlatformOperationResult,
  RedemptionRejectFailure,
  RewardInput,
  RewardView,
} from "../platforms/integration.ts";
import { RewardService } from "./service.ts";

const PLATFORM = "fake";

function view(overrides: Partial<RewardView> & { id: string }): RewardView {
  return {
    title: "Alerta",
    cost: 100,
    description: "",
    color: "#00e701",
    enabled: true,
    paused: false,
    userInputRequired: false,
    skipRequestQueue: false,
    managed: true,
    ...overrides,
  };
}

interface FakeControls {
  integration: PlatformIntegration;
  remote: Map<string, RewardView>;
  pending: Map<string, string[]>;
  setState(state: AccountLinkState): void;
  failList(message: string): void;
  failCreate(message: string): void;
  failUpdate(message: string): void;
  failDelete(message: string): void;
  failPending(message: string): void;
  setRejectFailures(failures: RedemptionRejectFailure[]): void;
  addPending(rewardId: string, id: string): void;
  deleted: string[];
  rejected: string[][];
  lastCreateInput: RewardInput | null;
}

function fakeIntegration(): FakeControls {
  const remote = new Map<string, RewardView>();
  const pending = new Map<string, string[]>();
  const deleted: string[] = [];
  const rejected: string[][] = [];
  let state: AccountLinkState = "connected";
  let listError: string | null = null;
  let createError: string | null = null;
  let updateError: string | null = null;
  let deleteError: string | null = null;
  let pendingError: string | null = null;
  let rejectFailures: RedemptionRejectFailure[] = [];
  let nextId = 1;
  const controls: Partial<FakeControls> = {};
  const last = { createInput: null as RewardInput | null };

  const fail = <T,>(message: string | null): PlatformOperationResult<T> | null =>
    message ? { ok: false, reason: "HTTP_500", message } : null;

  const source: EventSource = {
    id: "fake-source",
    platform: PLATFORM,
    capabilities: { types: [], resolve: false },
    start: () => {},
    stop: () => {},
    onEvent: () => () => {},
  };

  const status = (): PlatformAccount => ({
    id: PLATFORM,
    platform: PLATFORM,
    name: "Fake",
    state,
    accountId: state === "connected" ? "u-1" : null,
    accountName: state === "connected" ? "streamer" : null,
    capabilities: source.capabilities,
    hasCredentials: true,
    clientId: "cid",
    lastError: null,
  });

  const integration: PlatformIntegration = {
    id: PLATFORM,
    platform: PLATFORM,
    name: "Fake",
    source,
    status,
    async setCredentials() {
      return { ok: true, value: status() };
    },
    async clearCredentials() {},
    async beginLink() {
      return { ok: true, value: { authorizeUrl: "https://auth.test", expiresAt: 0 } };
    },
    async completeLink() {
      return { ok: true };
    },
    async unlink() {},
    async test() {
      return { ok: true, message: "ok" };
    },
    diagnostics() {
      return {
        enabled: false,
        intervalMs: 5000,
        lastCheckAt: null,
        lastResult: null,
        lastError: null,
        latencyLastMs: null,
        latencyMinMs: null,
        latencyTypicalMs: null,
        latencyMaxMs: null,
        rateLimit429Count: 0,
        lastRateLimitHeaders: {},
      };
    },
    async listRewards() {
      const failure = fail<RewardView[]>(listError);
      if (failure) return failure;
      return { ok: true, value: [...remote.values()] };
    },
    async createReward(input) {
      last.createInput = input;
      const failure = fail<RewardView>(createError);
      if (failure) return failure;
      const id = `rw-${nextId++}`;
      const created = view({
        id,
        title: input.title,
        cost: input.cost,
        description: input.description ?? "",
        color: input.color ?? "#00e701",
        enabled: input.enabled ?? true,
        userInputRequired: input.userInputRequired ?? false,
      });
      remote.set(id, created);
      return { ok: true, value: created };
    },
    async updateReward(id, input) {
      const failure = fail<RewardView>(updateError);
      if (failure) return failure;
      const current = remote.get(id);
      if (!current) return { ok: false, reason: "HTTP_404", message: "No existe." };
      const updated = { ...current, ...input, id } as RewardView;
      remote.set(id, updated);
      return { ok: true, value: updated };
    },
    async deleteReward(id) {
      const failure = fail<{ id: string }>(deleteError);
      if (failure) return failure;
      deleted.push(id);
      remote.delete(id);
      return { ok: true, value: { id } };
    },
    async listPendingRedemptions(rewardId) {
      const failure = fail<string[]>(pendingError);
      if (failure) return failure;
      return { ok: true, value: [...(pending.get(rewardId) ?? [])] };
    },
    async rejectRedemptions(ids) {
      rejected.push([...ids]);
      // Los que fallan se dejan pendientes; el resto se saca.
      const badIds = new Set(rejectFailures.map((failure) => failure.id));
      for (const [rewardId, list] of pending) {
        pending.set(rewardId, list.filter((id) => badIds.has(id) || !ids.includes(id)));
      }
      const failures = rejectFailures.filter((failure) => ids.includes(failure.id));
      rejectFailures = [];
      return { ok: true, value: failures };
    },
    async start() {},
    async stop() {},
  };

  controls.integration = integration;
  controls.remote = remote;
  controls.pending = pending;
  controls.deleted = deleted;
  controls.rejected = rejected;
  controls.setState = (next) => {
    state = next;
  };
  controls.failList = (message) => {
    listError = message;
  };
  controls.failCreate = (message) => {
    createError = message;
  };
  controls.failUpdate = (message) => {
    updateError = message;
  };
  controls.failDelete = (message) => {
    deleteError = message;
  };
  controls.failPending = (message) => {
    pendingError = message;
  };
  controls.setRejectFailures = (failures) => {
    rejectFailures = failures;
  };
  controls.addPending = (rewardId, id) => {
    pending.set(rewardId, [...(pending.get(rewardId) ?? []), id]);
  };
  Object.defineProperty(controls, "lastCreateInput", { get: () => last.createInput });

  return controls as FakeControls;
}

function setup(clip = true): { db: SqliteDatabase; fake: FakeControls; service: RewardService } {
  const db = openMemoryDatabase();
  if (clip) {
    upsertClip(db, {
      id: "clip-1",
      sourceUrl: "https://youtube.com/watch?v=x",
      title: "Mi clip",
      durationSec: 10,
      sizeBytes: 1,
      file: "clip-1.mp4",
      createdAt: new Date().toISOString(),
      trimStart: null,
      trimEnd: null,
      hasVideo: true,
      missing: false,
    });
  }
  const fake = fakeIntegration();
  const service = new RewardService({ db, integration: fake.integration });
  return { db, fake, service };
}

async function createReward(service: RewardService): Promise<string> {
  const result = await service.create({ title: "Alerta", cost: 100, clipId: "clip-1" });
  if (!result.ok) throw new Error(`no se creó: ${result.message}`);
  return result.value.localId as string;
}

/** Fila importada por la migración: datos provisorios y todavía sin sincronizar. */
function provisionalReward(): RewardRecord {
  return {
    id: "local-prov",
    platform: PLATFORM,
    remoteRewardId: "rw-prov",
    title: "Alerta",
    cost: 1,
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
    synced: false,
    ruleId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("RewardService: datos sin sincronizar (fila provisoria)", () => {
  it("rechaza editar una fila sin sincronizar y no envía nada a la plataforma", async () => {
    const { db, fake, service } = setup();
    upsertReward(db, provisionalReward());
    const spy = vi.spyOn(fake.integration, "updateReward");

    const result = await service.update("local-prov", { title: "Otro" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("debería fallar");
    expect(result.reason).toBe("NOT_SYNCED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("bloquea activar y desactivar una fila sin sincronizar", async () => {
    const { db, fake, service } = setup();
    upsertReward(db, provisionalReward());
    const spy = vi.spyOn(fake.integration, "updateReward");

    const on = await service.enable("local-prov");
    const off = await service.disable("local-prov", { confirm: true });

    expect(on.ok).toBe(false);
    expect(off.ok).toBe(false);
    if (!on.ok) expect(on.reason).toBe("NOT_SYNCED");
    expect(off.reason).toBe("NOT_SYNCED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("la vista marca synced=false, y al responder la plataforma la sincroniza", async () => {
    const { db, fake, service } = setup();
    upsertReward(db, provisionalReward());

    // Sin respuesta de la plataforma para esa recompensa, sigue sin sincronizar.
    const first = await service.list();
    const provisional = first.rewards.find((reward) => reward.localId === "local-prov");
    expect(provisional?.synced).toBe(false);

    // Cuando la plataforma responde, se sincroniza y ya se puede editar.
    fake.remote.set("rw-prov", view({ id: "rw-prov", title: "Real", cost: 42 }));
    const second = await service.list();
    const synced = second.rewards.find((reward) => reward.localId === "local-prov");
    expect(synced?.synced).toBe(true);
    expect(synced?.title).toBe("Real");

    const result = await service.update("local-prov", { title: "Editado" });
    expect(result.ok).toBe(true);
  });
});

describe("RewardService: vista unificada", () => {
  it("combina filas locales y remotas, y calcula cada estado", async () => {
    const { fake, service } = setup();
    // Local habilitada.
    await createReward(service);
    // Recompensa de otra app: existe en la plataforma, sin fila local.
    fake.remote.set("rw-ajena", view({ id: "rw-ajena", title: "De otro", managed: false }));

    const snapshot = await service.list();
    expect(snapshot.connected).toBe(true);
    const states = snapshot.rewards.map((reward) => [reward.title, reward.state]);
    expect(states).toContainEqual(["Alerta", "enabled"]);
    expect(states).toContainEqual(["De otro", "foreign"]);
  });

  it("marca 'missing' cuando la recompensa ya no está en la plataforma", async () => {
    const { fake, service } = setup();
    await createReward(service);
    for (const id of [...fake.remote.keys()]) fake.remote.delete(id);

    const snapshot = await service.list();
    expect(snapshot.rewards[0].state).toBe("missing");
  });

  it("devuelve las guardadas como 'offline' si la plataforma no responde", async () => {
    const { fake, service } = setup();
    await createReward(service);
    fake.failList("La plataforma no responde.");

    const snapshot = await service.list();
    expect(snapshot.offline).toBe(true);
    expect(snapshot.connected).toBe(false);
    expect(snapshot.rewards[0].state).toBe("offline");
    expect(snapshot.rewards[0].title).toBe("Alerta");
  });

  it("sin vínculo indica el estado explícitamente", async () => {
    const { fake, service } = setup();
    fake.setState("unlinked");
    fake.failList("La cuenta no está vinculada.");
    const snapshot = await service.list();
    expect(snapshot.platformState).toBe("unlinked");
    expect(snapshot.connected).toBe(false);
  });
});

describe("RewardService: crear", () => {
  it("crea en la plataforma y guarda fila local + regla 1:1, con texto del usuario apagado", async () => {
    const { db, fake, service } = setup();
    const result = await service.create({
      title: "Alerta",
      cost: 100,
      clipId: "clip-1",
      volume: 0.5,
      cooldownSec: 30,
    });
    expect(result.ok).toBe(true);
    // is_user_input_required se envía explícitamente en falso.
    expect(fake.lastCreateInput?.userInputRequired).toBe(false);

    const snap = await service.list();
    const listItem = snap.rewards.find((reward) => reward.title === "Alerta");
    expect(listItem?.clipId).toBe("clip-1");
    expect(listItem?.volume).toBe(0.5);
    expect(listItem?.state).toBe("enabled");

    const rules = db.prepare<{ trigger_json: string }>("SELECT trigger_json FROM rules").all();
    expect(rules).toHaveLength(1);
    expect(JSON.parse(rules[0].trigger_json)).toMatchObject({ type: "reward_redeemed", rewardId: "rw-1" });
  });

  it("valida título, costo, color y clip", async () => {
    const { service } = setup();
    expect((await service.create({ title: "", cost: 100, clipId: "clip-1" })).ok).toBe(false);
    expect((await service.create({ title: "x", cost: 0, clipId: "clip-1" })).ok).toBe(false);
    expect((await service.create({ title: "x", cost: 1, clipId: "clip-1", color: "rojo" })).ok).toBe(false);
    expect((await service.create({ title: "x", cost: 1, clipId: "no-existe" })).ok).toBe(false);
  });

  it("si la plataforma falla, no guarda nada", async () => {
    const { db, fake, service } = setup();
    fake.failCreate("Límite de 50 recompensas alcanzado.");
    const result = await service.create({ title: "Alerta", cost: 100, clipId: "clip-1" });
    expect(result.ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS c FROM rewards").get()).toMatchObject({ c: 0 });
  });

  it("si falla el guardado local, intenta borrar en la plataforma (compensación)", async () => {
    const { db, service } = setup();
    // Fila local previa que ocupa el id remoto `rw-1` → la inserción nueva viola
    // el índice único y dispara la compensación.
    db.prepare(
      `INSERT INTO rewards (id, platform, remote_reward_id, title, cost, color, description,
        volume, cooldown_sec, repetition, desired_enabled, managed, created_at, updated_at)
       VALUES ('pre', 'fake', 'rw-1', 'Pre', 1, '#00e701', '', 1, 0, 'queue', 1, 1, 'now', 'now')`,
    ).run();

    const result = await service.create({ title: "Alerta", cost: 100, clipId: "clip-1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("debía fallar");
    expect(result.reason).toBe("LOCAL_FAILED");
    // La fila previa sigue siendo la única; no quedó una segunda huérfana.
    expect(db.prepare("SELECT COUNT(*) AS c FROM rewards").get()).toMatchObject({ c: 1 });
  });
});

describe("RewardService: editar, activar, desactivar", () => {
  it("edita campos de la plataforma y opciones locales", async () => {
    const { service } = setup();
    const id = await createReward(service);
    const result = await service.update(id, { title: "Nueva", cost: 42, volume: 0.2 });
    expect(result.ok).toBe(true);
    const snapshot = await service.list();
    expect(snapshot.rewards[0]).toMatchObject({ title: "Nueva", cost: 42, volume: 0.2 });
  });

  it("si la plataforma falla al editar, no cambia lo local", async () => {
    const { fake, service } = setup();
    const id = await createReward(service);
    fake.failUpdate("permisos");
    const result = await service.update(id, { title: "Nueva" });
    expect(result.ok).toBe(false);
    const snapshot = await service.list();
    expect(snapshot.rewards[0].title).toBe("Alerta");
  });

  it("activa y desactiva una recompensa", async () => {
    const { fake, service } = setup();
    const id = await createReward(service);
    const off = await service.disable(id);
    expect(off.ok).toBe(true);
    expect(fake.remote.get("rw-1")?.enabled).toBe(false);
    const on = await service.enable(id);
    expect(on.ok).toBe(true);
    expect(fake.remote.get("rw-1")?.enabled).toBe(true);
  });

  it("desactivar pide confirmación y rechaza los pendientes en lotes", async () => {
    const { fake, service } = setup();
    const id = await createReward(service);
    fake.addPending("rw-1", "red-1");
    fake.addPending("rw-1", "red-2");

    const first = await service.disable(id);
    expect(first.needsConfirm).toBe(true);
    expect(first.pending).toBe(2);
    // Todavía no se deshabilitó.
    expect(fake.remote.get("rw-1")?.enabled).toBe(true);

    const second = await service.disable(id, { confirm: true });
    expect(second.ok).toBe(true);
    expect(fake.rejected[0]).toEqual(["red-1", "red-2"]);
    expect(fake.remote.get("rw-1")?.enabled).toBe(false);
  });

  it("un rechazo que falla de verdad NO deshabilita; con force sí", async () => {
    const { fake, service } = setup();
    const id = await createReward(service);
    fake.addPending("rw-1", "red-1");
    // NOT_PENDING es benigno; UNKNOWN no.
    fake.setRejectFailures([{ id: "red-1", reason: "UNKNOWN", benign: false }]);

    const failed = await service.disable(id, { confirm: true });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe("REJECT_FAILED");
    expect(failed.failed?.[0]).toMatchObject({ id: "red-1", reason: "UNKNOWN" });
    expect(fake.remote.get("rw-1")?.enabled).toBe(true);

    fake.addPending("rw-1", "red-1");
    fake.setRejectFailures([{ id: "red-1", reason: "UNKNOWN", benign: false }]);
    const forced = await service.disable(id, { confirm: true, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.warning).toBeTruthy();
    expect(fake.remote.get("rw-1")?.enabled).toBe(false);
  });

  it("los rechazos benignos (NOT_PENDING / NOT_FOUND) cuentan como resueltos", async () => {
    const { fake, service } = setup();
    const id = await createReward(service);
    fake.addPending("rw-1", "red-1");
    fake.setRejectFailures([{ id: "red-1", reason: "NOT_PENDING", benign: true }]);
    const result = await service.disable(id, { confirm: true });
    expect(result.ok).toBe(true);
    expect(fake.remote.get("rw-1")?.enabled).toBe(false);
  });
});

describe("RewardService: borrar, recrear, quitar", () => {
  it("borra en la plataforma y localmente, sin tocar el clip", async () => {
    const { db, fake, service } = setup();
    const id = await createReward(service);
    const result = await service.remove(id);
    expect(result.ok).toBe(true);
    expect(fake.deleted).toEqual(["rw-1"]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM rewards").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM rules").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM clips").get()).toMatchObject({ c: 1 });
  });

  it("recrea una recompensa que falta, con nuevo id y vínculo de la regla", async () => {
    const { db, fake, service } = setup();
    const id = await createReward(service);
    fake.remote.delete("rw-1"); // simula que la borraron en Kick

    const recreated = await service.recreate(id);
    expect(recreated.ok).toBe(true);
    const newRemoteId = recreated.ok ? recreated.value.remoteId : "";
    expect(newRemoteId).not.toBe("rw-1");
    const rule = db.prepare<{ trigger_json: string }>("SELECT trigger_json FROM rules").all()[0];
    expect(JSON.parse(rule.trigger_json).rewardId).toBe(newRemoteId);
  });

  it("quitar de la app borra la fila local y la regla sin tocar la plataforma", async () => {
    const { db, fake, service } = setup();
    const id = await createReward(service);
    const result = await service.detach(id);
    expect(result.ok).toBe(true);
    expect(fake.deleted).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM rewards").get()).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM rules").get()).toMatchObject({ c: 0 });
  });

  it("cuenta los canjes pendientes de una recompensa", async () => {
    const { fake, service } = setup();
    const id = await createReward(service);
    fake.addPending("rw-1", "red-1");
    fake.addPending("rw-1", "red-2");
    const result = await service.pendingCount(id);
    expect(result).toMatchObject({ ok: true, value: 2 });
  });
});