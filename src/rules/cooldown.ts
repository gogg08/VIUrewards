/**
 * Cooldown de una recompensa (rework del sistema de cooldown, Parte B).
 *
 * Solo existe un cooldown GLOBAL por recompensa. La decisión es una función pura
 * (`decide`) que no depende del reloj ni de la base: recibe el `lastFiredAt`
 * persistido y el momento actual. La persistencia y la atomicidad (decisión +
 * registro en el mismo tick, sin `await` en el medio) viven en el despachador
 * de recompensas del servidor.
 *
 * El cooldown cuenta desde el momento en que la alerta se dispara, con un único
 * reloj local. NO se usa el `redeemed_at` de la plataforma.
 */

export interface CooldownDecision {
  /** ¿Puede dispararse ahora? */
  fire: boolean;
  /** Segundos que faltan si no puede (0 si puede). */
  remainingSec: number;
  /** `lastFiredAt` vigente (el que se leyó), para logs. */
  lastFiredAt: number | null;
}

/**
 * Decisión pura del cooldown. `cooldownSec <= 0` no bloquea nunca. Un
 * `lastFiredAt` en el futuro respecto de `now` (cambio de hora del sistema) se
 * considera vencido: no se bloquea por un reloj que se movió hacia atrás.
 */
export function decide(
  reward: { cooldownSec: number },
  nowMs: number,
  lastFiredAtMs: number | null,
): CooldownDecision {
  const cooldownSec = Number.isFinite(reward.cooldownSec) ? reward.cooldownSec : 0;
  if (cooldownSec <= 0) return { fire: true, remainingSec: 0, lastFiredAt: lastFiredAtMs };
  if (lastFiredAtMs === null) return { fire: true, remainingSec: 0, lastFiredAt: null };
  if (lastFiredAtMs > nowMs) return { fire: true, remainingSec: 0, lastFiredAt: lastFiredAtMs };

  const remainingMs = cooldownSec * 1000 - (nowMs - lastFiredAtMs);
  if (remainingMs > 0) {
    return { fire: false, remainingSec: Math.ceil(remainingMs / 1000), lastFiredAt: lastFiredAtMs };
  }
  return { fire: true, remainingSec: 0, lastFiredAt: lastFiredAtMs };
}

/**
 * Comprobación + registro atómicos. `claim` decide y, si dispara, registra el
 * momento en el mismo tick (sin `await`), de modo que dos canjes del mismo ciclo
 * no pasen los dos la comprobación.
 */
export interface CooldownGate {
  claim(key: string, cooldownSec: number, nowMs: number): CooldownDecision;
  /** Último disparo registrado para una clave (para tests y diagnóstico). */
  lastFiredAt(key: string): number | null;
}

/** Implementación en memoria (tests). El servidor usa una respaldada en la base. */
export class MemoryCooldownGate implements CooldownGate {
  private readonly firedAt = new Map<string, number>();

  claim(key: string, cooldownSec: number, nowMs: number): CooldownDecision {
    const last = this.firedAt.get(key) ?? null;
    const decision = decide({ cooldownSec }, nowMs, last);
    if (decision.fire) this.firedAt.set(key, nowMs);
    return decision;
  }

  lastFiredAt(key: string): number | null {
    return this.firedAt.get(key) ?? null;
  }
}