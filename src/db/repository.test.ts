/**
 * Persistencia de reglas e historial de eventos (Fase 4A).
 */

import { describe, expect, it } from "vitest";

import {
  addHistory,
  deleteRule,
  getRuleRecord,
  listHistory,
  listRules,
  openMemoryDatabase,
  pruneHistory,
  SCHEMA_VERSION,
  toRule,
  upsertRule,
  type RuleRecord,
} from "./index.ts";

function sampleRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: "r1",
    name: "Alerta",
    enabled: true,
    trigger: { type: "chat_command", command: "alerta" },
    conditions: { permission: "everyone" },
    action: { kind: "play_clip", clipId: "clip-1" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("migración Fase 4A", () => {
  it("crea rules y event_history", () => {
    const db = openMemoryDatabase();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(() => db.prepare("SELECT * FROM rules").all()).not.toThrow();
    expect(() => db.prepare("SELECT * FROM event_history").all()).not.toThrow();
  });

  it("elimina la tabla proposals (el público ya no envía links)", () => {
    const db = openMemoryDatabase();
    expect(() => db.prepare("SELECT * FROM proposals").all()).toThrow();
  });
});

describe("rules", () => {
  it("inserta, lista, lee, actualiza y borra", () => {
    const db = openMemoryDatabase();
    upsertRule(db, sampleRule());
    expect(listRules(db)).toHaveLength(1);
    expect(getRuleRecord(db, "r1")?.name).toBe("Alerta");

    upsertRule(db, sampleRule({ name: "Otra", enabled: false }));
    expect(getRuleRecord(db, "r1")?.name).toBe("Otra");
    expect(getRuleRecord(db, "r1")?.enabled).toBe(false);

    expect(toRule(getRuleRecord(db, "r1") as RuleRecord)).toMatchObject({ id: "r1", enabled: false });
    expect(deleteRule(db, "r1")).toBe(true);
    expect(deleteRule(db, "r1")).toBe(false);
  });

  it("sobrevive al ciclo JSON de trigger/condiciones/acción", () => {
    const db = openMemoryDatabase();
    upsertRule(db, sampleRule());
    const rule = toRule(getRuleRecord(db, "r1") as RuleRecord);
    expect(rule.trigger).toEqual({ type: "chat_command", command: "alerta" });
    expect(rule.conditions.permission).toBe("everyone");
    expect(rule.action).toEqual({ kind: "play_clip", clipId: "clip-1" });
  });
});

describe("event_history", () => {
  function entry(eventId: string, outcome: string) {
    return {
      eventId,
      platform: "simulated",
      type: "chat_command",
      userId: "u1",
      userName: "Ana",
      payloadJson: "{}",
      eventTs: 1,
      ruleId: null,
      outcome,
      reason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("agrega y lista más recientes primero", () => {
    const db = openMemoryDatabase();
    addHistory(db, entry("e1", "fired"), 500);
    addHistory(db, entry("e2", "no_match"), 500);
    const list = listHistory(db);
    expect(list).toHaveLength(2);
    expect(list[0].eventId).toBe("e2");
  });

  it("recorta el historial por cantidad", () => {
    const db = openMemoryDatabase();
    for (let i = 0; i < 10; i++) addHistory(db, entry(`e${i}`, "fired"), 5);
    expect(listHistory(db)).toHaveLength(5);
    expect(pruneHistory(db, 2)).toBe(3);
    expect(listHistory(db)).toHaveLength(2);
  });
});