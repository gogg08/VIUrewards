/**
 * Cooldowns global y por usuario (Fase 4A). Reloj inyectable para testear.
 */

import type { RuleConditions } from "./types.ts";

export interface CooldownResult {
  allowed: boolean;
  /** Segundos que faltan para poder disparar de nuevo (0 si está permitido). */
  remainingSec: number;
}

export class CooldownTracker {
  private readonly globalAt = new Map<string, number>();
  private readonly userAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private userKey(ruleId: string, userId: string): string {
    return `${ruleId}\u0000${userId}`;
  }

  /**
   * ¿Puede dispararse la regla para este usuario ahora? No marca el uso; para
   * eso llamar a `mark` cuando la acción se ejecutó.
   */
  check(ruleId: string, userId: string, conditions: RuleConditions): CooldownResult {
    const now = this.now();
    const times: number[] = [];

    if (conditions.cooldownSec > 0) {
      const at = this.globalAt.get(ruleId);
      if (at !== undefined) times.push(at + conditions.cooldownSec * 1000 - now);
    }
    if (conditions.userCooldownSec > 0) {
      const at = this.userAt.get(this.userKey(ruleId, userId));
      if (at !== undefined) times.push(at + conditions.userCooldownSec * 1000 - now);
    }

    const remainingMs = Math.max(0, ...times);
    if (remainingMs > 0) return { allowed: false, remainingSec: Math.ceil(remainingMs / 1000) };
    return { allowed: true, remainingSec: 0 };
  }

  /** Registra que la regla se disparó para este usuario. */
  mark(ruleId: string, userId: string, conditions: RuleConditions): void {
    const now = this.now();
    if (conditions.cooldownSec > 0) this.globalAt.set(ruleId, now);
    if (conditions.userCooldownSec > 0) this.userAt.set(this.userKey(ruleId, userId), now);
  }

  /** Limpia el estado de cooldowns (tests / reinicios). */
  reset(): void {
    this.globalAt.clear();
    this.userAt.clear();
  }

  /** Descarta las marcas de reglas que ya no existen. */
  prune(ruleIds: ReadonlySet<string>): void {
    for (const key of [...this.globalAt.keys()]) if (!ruleIds.has(key)) this.globalAt.delete(key);
    for (const key of [...this.userAt.keys()]) {
      const ruleId = key.split("\u0000")[0];
      if (!ruleIds.has(ruleId)) this.userAt.delete(key);
    }
  }
}