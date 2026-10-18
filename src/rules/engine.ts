/**
 * Motor de reglas (Fase 4A; rework de cooldown en la Parte B).
 *
 * Recibe eventos normalizados y decide qué regla dispara y qué acción ejecuta.
 * No conoce plataformas ni acciones concretas: las acciones se construyen con la
 * fábrica inyectada. La idempotencia por `event.id` es necesaria porque los
 * canjes llegan por polling y un mismo evento puede repetirse.
 *
 * El cooldown ya NO vive acá: es un atributo de la recompensa, aplicado por el
 * despachador de recompensas del servidor (que además decide queue vs overlap).
 *
 * Aislamiento de errores: si una regla falla, se registra y el motor sigue.
 */

import type { EventType, NormalizedEvent } from "../events/index.ts";
import type { EnqueueSink } from "../queue/index.ts";
import { defaultActionResolver } from "./actions.ts";
import { hasPermission, matchesTrigger } from "./matching.ts";
import type { ActionResolver, Rule, RuleActionContext, RuleActionOutcome } from "./types.ts";

export type EngineOutcome = "fired" | "skipped" | "error" | "no_match" | "duplicate" | "waiting";

export interface EngineResult {
  eventId: string;
  platform: string;
  type: EventType;
  outcome: EngineOutcome;
  /** Regla que disparó, o que se evaluó y no disparó. */
  ruleId?: string;
  /** Motivo cuando no disparó: "sin permiso", "cooldown, faltan N s", etc. */
  reason?: string;
}

export interface EngineLogEntry {
  kind: "fired" | "skipped" | "error" | "no_match" | "duplicate";
  eventId: string;
  ruleId?: string;
  detail?: string;
}

export interface RuleEngineOptions {
  queue: EnqueueSink;
  /** Máximo de ids de eventos recordados para idempotencia. */
  maxRecentEventIds?: number;
  /** Resuelve el evento de origen (accept/reject) si la plataforma lo soporta. */
  resolveEvent?: (event: NormalizedEvent, outcome: "accept" | "reject") => Promise<void>;
  /** Fábrica de acciones; por defecto arma `PlayClip`. */
  resolveAction?: ActionResolver;
  logger?: (entry: EngineLogEntry) => void;
}

const DEFAULT_MAX_RECENT = 500;

export class RuleEngine {
  private rules: Rule[] = [];
  private readonly queue: EnqueueSink;
  private readonly resolveAction: ActionResolver;
  private readonly resolveEvent?: (event: NormalizedEvent, outcome: "accept" | "reject") => Promise<void>;
  private readonly logger?: (entry: EngineLogEntry) => void;
  private readonly maxRecent: number;
  /** Buffer circular de ids recientes, para idempotencia. */
  private readonly recent: string[] = [];
  private readonly recentSet = new Set<string>();

  constructor(options: RuleEngineOptions) {
    this.queue = options.queue;
    this.resolveAction = options.resolveAction ?? defaultActionResolver;
    this.resolveEvent = options.resolveEvent;
    this.logger = options.logger;
    this.maxRecent = Math.max(1, options.maxRecentEventIds ?? DEFAULT_MAX_RECENT);
  }

  /** Reemplaza el conjunto de reglas; se evalúan en el orden dado. */
  setRules(rules: Rule[]): void {
    this.rules = [...rules];
  }

  getRules(): Rule[] {
    return [...this.rules];
  }

  /** Olvida un id ya visto para que un nuevo `handle` lo procese otra vez (p. ej. canje omitido y reprocesado a mano). */
  forget(eventId: string): void {
    if (!this.recentSet.delete(eventId)) return;
    const index = this.recent.indexOf(eventId);
    if (index >= 0) this.recent.splice(index, 1);
  }

  /** Procesa un evento. Devuelve el resultado (y lo registra en el logger). */
  async handle(event: NormalizedEvent): Promise<EngineResult> {
    const base = { eventId: event.id, platform: event.platform, type: event.type };

    if (this.recentSet.has(event.id)) {
      const result: EngineResult = { ...base, outcome: "duplicate" };
      this.log({ kind: "duplicate", eventId: event.id });
      return result;
    }
    this.remember(event.id);

    let last: EngineResult | null = null;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!matchesTrigger(rule.trigger, event)) continue;

      if (!hasPermission(rule.conditions.permission, event.user)) {
        last = { ...base, outcome: "skipped", ruleId: rule.id, reason: "sin permiso" };
        this.log({ kind: "skipped", eventId: event.id, ruleId: rule.id, detail: "sin permiso" });
        continue;
      }

      const context: RuleActionContext = {
        event,
        queue: this.queue,
        resolveEvent: (outcome) => this.resolveEvent?.(event, outcome) ?? Promise.resolve(),
      };

      try {
        const outcome: void | RuleActionOutcome = await this.resolveAction(rule.action).execute(context);
        if (outcome && outcome.fired === false) {
          const reason = outcome.reason ?? "la acción no disparó";
          last = { ...base, outcome: "skipped", ruleId: rule.id, reason };
          this.log({ kind: "skipped", eventId: event.id, ruleId: rule.id, detail: reason });
          continue;
        }
        const result: EngineResult = { ...base, outcome: "fired", ruleId: rule.id };
        this.log({ kind: "fired", eventId: event.id, ruleId: rule.id });
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        last = { ...base, outcome: "error", ruleId: rule.id, reason: detail };
        this.log({ kind: "error", eventId: event.id, ruleId: rule.id, detail });
        continue;
      }
    }

    if (last) return last;
    const result: EngineResult = { ...base, outcome: "no_match" };
    this.log({ kind: "no_match", eventId: event.id });
    return result;
  }

  private remember(id: string): void {
    this.recent.push(id);
    this.recentSet.add(id);
    while (this.recent.length > this.maxRecent) {
      const oldest = this.recent.shift();
      if (oldest !== undefined) this.recentSet.delete(oldest);
    }
  }

  private log(entry: EngineLogEntry): void {
    this.logger?.(entry);
  }
}