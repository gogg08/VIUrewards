/**
 * Tests del modelo local de recompensas y su migración (rediseño, Etapa 4A).
 *
 * La migración v6 importa las recompensas ya gestionadas que tenían una regla
 * `reward_redeemed` por `rewardId`: la fila local se arma con los datos de esa
 * regla. Se probó partiendo de una base en `user_version = 5`.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate, openMemoryDatabase } from "./database.ts";
import {
  deleteReward,
  findRewardByRemoteId,
  getReward,
  listRewardsForPlatform,
  listRewardsUsingClip,
  setRewardError,
  setRewardLastFired,
  upsertReward,
  type RewardRecord,
} from "./rewards.ts";

function baseReward(overrides: Partial<RewardRecord> = {}): RewardRecord {
  return {
    id: "local-1",
    platform: "fake",
    remoteRewardId: "rw-1",
    title: "Alerta",
    cost: 100,
    color: "#00e701",
    description: "desc",
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

function v5Database(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE clips (
      id           TEXT PRIMARY KEY,
      source_url   TEXT NOT NULL,
      title        TEXT NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      file         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      trim_start   REAL,
      trim_end     REAL
    );
    CREATE TABLE platform_managed_rewards (
      platform   TEXT NOT NULL,
      reward_id  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (platform, reward_id)
    );
    CREATE TABLE rules (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      trigger_json    TEXT NOT NULL,
      conditions_json TEXT NOT NULL,
      action_json     TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);
  db.pragma("user_version = 5");
  return db;
}

function insertRule(
  db: Database.Database,
  id: string,
  rewardId: string,
  options: { name?: string; enabled?: number; cooldownSec?: number; clipId?: string } = {},
): void {
  db.prepare(
    `INSERT INTO rules (id, name, enabled, trigger_json, conditions_json, action_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'now', 'now')`,
  ).run(
    id,
    options.name ?? "Recompensa: Alerta",
    options.enabled ?? 1,
    JSON.stringify({ type: "reward_redeemed", rewardId }),
    JSON.stringify({ permission: "everyone", cooldownSec: options.cooldownSec ?? 12 }),
    JSON.stringify({ kind: "play_clip", clipId: options.clipId ?? "clip-9", volume: 0.5 }),
  );
}

describe("migración v6: importar recompensas gestionadas", () => {
  it("crea una fila local a partir de la regla por rewardId", () => {
    const db = v5Database();
    db.prepare("INSERT INTO platform_managed_rewards VALUES ('kick', 'rw-x', 'now')").run();
    insertRule(db, "rule-x", "rw-x");

    migrate(db);

    const rewards = listRewardsForPlatform(db as never, "kick");
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({
      platform: "kick",
      remoteRewardId: "rw-x",
      title: "Alerta",
      clipId: "clip-9",
      volume: 0.5,
      cooldownSec: 12,
      repetition: "queue",
      desiredEnabled: true,
      managed: true,
      synced: false,
      ruleId: "rule-x",
    });
  });

  it("respeta el estado deshabilitado de la regla y limpia el prefijo del nombre", () => {
    const db = v5Database();
    db.prepare("INSERT INTO platform_managed_rewards VALUES ('kick', 'rw-y', 'now')").run();
    insertRule(db, "rule-y", "rw-y", { name: "Recompensa: 🎉 Fiesta", enabled: 0 });

    migrate(db);

    const [reward] = listRewardsForPlatform(db as never, "kick");
    expect(reward.desiredEnabled).toBe(false);
    expect(reward.title).toBe("🎉 Fiesta".slice(0, 50));
  });

  it("no crea fila local si la recompensa gestionada no tiene regla", () => {
    const db = v5Database();
    db.prepare("INSERT INTO platform_managed_rewards VALUES ('kick', 'rw-z', 'now')").run();

    migrate(db);

    expect(listRewardsForPlatform(db as never, "kick")).toHaveLength(0);
  });
});

describe("tabla rewards: acceso básico", () => {
  it("inserta, lee, actualiza y borra una recompensa", () => {
    const db = openMemoryDatabase();
    const reward = baseReward();
    upsertReward(db, reward);

    expect(getReward(db, "local-1")).toMatchObject({ title: "Alerta", remoteRewardId: "rw-1" });
    expect(findRewardByRemoteId(db, "fake", "rw-1")?.id).toBe("local-1");

    upsertReward(db, { ...reward, title: "Otra", lastError: "problema" });
    expect(getReward(db, "local-1")).toMatchObject({ title: "Otra", lastError: "problema" });

    setRewardError(db, "local-1", null);
    expect(getReward(db, "local-1")?.lastError).toBeNull();

    expect(deleteReward(db, "local-1")).toBe(true);
    expect(getReward(db, "local-1")).toBeNull();
  });

  it("lista las recompensas que usan un clip", () => {
    const db = openMemoryDatabase();
    upsertReward(db, baseReward({ id: "a", clipId: "clip-1" }));
    upsertReward(db, baseReward({ id: "b", clipId: "clip-2", remoteRewardId: "rw-2" }));
    const using = listRewardsUsingClip(db, "clip-1");
    expect(using.map((reward) => reward.id)).toEqual(["a"]);
  });

  it("guarda el modo de repetición y el último disparo, sin pisarlo al reinsertar", () => {
    const db = openMemoryDatabase();
    upsertReward(db, baseReward({ id: "r1", repetition: "overlap", cooldownSec: 30 }));
    expect(getReward(db, "r1")).toMatchObject({ repetition: "overlap", cooldownSec: 30, lastFiredAt: null });

    setRewardLastFired(db, "r1", 12_345);
    expect(getReward(db, "r1")?.lastFiredAt).toBe(12_345);

    // Editar (reinsertar) la fila no debe perder el último disparo.
    upsertReward(db, baseReward({ id: "r1", repetition: "overlap", cooldownSec: 60 }));
    expect(getReward(db, "r1")?.cooldownSec).toBe(60);
    expect(getReward(db, "r1")?.lastFiredAt).toBe(12_345);
  });

  it("lista las recompensas que usan un clip", () => {
    const db = openMemoryDatabase();
    upsertReward(db, baseReward({ id: "q", clipId: "clip-1", repetition: "queue" }));
    upsertReward(db, baseReward({ id: "o", clipId: "clip-1", repetition: "overlap", remoteRewardId: "rw-o" }));
    upsertReward(db, baseReward({ id: "z", clipId: "clip-1", repetition: "overlap", remoteRewardId: "rw-z" }));
    expect(listRewardsUsingClip(db, "clip-1").map((reward) => reward.id)).toEqual(["o", "q", "z"]);
    expect(listRewardsUsingClip(db, "otro")).toEqual([]);
  });
});