/**
 * Tabla `rules`: reglas evento -> acción (Fase 4A).
 *
 * Trigger, condiciones y acción se guardan como JSON para no atar el esquema a
 * la forma exacta de cada tipo. La validación de esa forma vive en src/rules.
 */

import type { SqliteDatabase } from "./database.ts";
import type { Rule, RuleActionConfig, RuleConditions, RuleTrigger } from "../rules/types.ts";

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  trigger_json: string;
  conditions_json: string;
  action_json: string;
  created_at: string;
  updated_at: string;
}

export interface RuleRecord {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleConditions;
  action: RuleActionConfig;
  createdAt: string;
  updatedAt: string;
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: RuleRow): RuleRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    trigger: parse<RuleTrigger>(row.trigger_json, { type: "manual" }),
    conditions: parse<RuleConditions>(row.conditions_json, {
      permission: "everyone",
      cooldownSec: 0,
      userCooldownSec: 0,
    }),
    action: parse<RuleActionConfig>(row.action_json, { kind: "play_clip", clipId: "" }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRules(db: SqliteDatabase): RuleRecord[] {
  const rows = db
    .prepare<RuleRow>("SELECT * FROM rules ORDER BY created_at ASC, id ASC")
    .all();
  return rows.map(toRecord);
}

export function getRuleRecord(db: SqliteDatabase, id: string): RuleRecord | null {
  const row = db.prepare<RuleRow>("SELECT * FROM rules WHERE id = ?").get(id);
  return row ? toRecord(row) : null;
}

export function upsertRule(db: SqliteDatabase, rule: RuleRecord): void {
  db.prepare(
    `INSERT INTO rules
       (id, name, enabled, trigger_json, conditions_json, action_json, created_at, updated_at)
     VALUES
       (@id, @name, @enabled, @triggerJson, @conditionsJson, @actionJson, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       enabled = excluded.enabled,
       trigger_json = excluded.trigger_json,
       conditions_json = excluded.conditions_json,
       action_json = excluded.action_json,
       updated_at = excluded.updated_at`,
  ).run({
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled ? 1 : 0,
    triggerJson: JSON.stringify(rule.trigger),
    conditionsJson: JSON.stringify(rule.conditions),
    actionJson: JSON.stringify(rule.action),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  });
}

export function deleteRule(db: SqliteDatabase, id: string): boolean {
  const result = db.prepare("DELETE FROM rules WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Convierte un registro de base a la `Rule` que consume el motor. */
export function toRule(record: RuleRecord): Rule {
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    trigger: record.trigger,
    conditions: record.conditions,
    action: record.action,
  };
}
