/**
 * Tests de la decisión pura de cooldown (Parte B).
 *
 * `decide(recompensa, ahora, lastFiredAt)` no toca relojes ni base: solo compara.
 */

import { describe, expect, it } from "vitest";

import { decide, MemoryCooldownGate } from "./cooldown.ts";

describe("decide (cooldown puro)", () => {
  it("sin cooldown siempre dispara", () => {
    expect(decide({ cooldownSec: 0 }, 1_000, 999_000).fire).toBe(true);
    expect(decide({ cooldownSec: -5 }, 1_000, 999_000).fire).toBe(true);
  });

  it("sin último disparo dispara", () => {
    expect(decide({ cooldownSec: 30 }, 1_000, null).fire).toBe(true);
  });

  it("dentro del cooldown no dispara y calcula los segundos restantes", () => {
    // Disparó en t=0 con un cooldown de 30 s; a los 10 s faltan 20 s.
    const result = decide({ cooldownSec: 30 }, 10_000, 0);
    expect(result.fire).toBe(false);
    expect(result.remainingSec).toBe(20);
  });

  it("en el límite exacto ya dispara", () => {
    expect(decide({ cooldownSec: 30 }, 30_000, 0).fire).toBe(true);
    expect(decide({ cooldownSec: 30 }, 29_999, 0).fire).toBe(false);
  });

  it("un lastFiredAt en el futuro (cambio de hora) se considera vencido", () => {
    expect(decide({ cooldownSec: 30 }, 1_000, 500_000).fire).toBe(true);
  });
});

describe("MemoryCooldownGate", () => {
  it("claim decide y registra en el mismo tick", () => {
    const gate = new MemoryCooldownGate();
    expect(gate.claim("r1", 30, 1_000).fire).toBe(true);
    expect(gate.lastFiredAt("r1")).toBe(1_000);
    const blocked = gate.claim("r1", 30, 5_000);
    expect(blocked.fire).toBe(false);
    expect(blocked.remainingSec).toBe(26);
    // Sigue registrado el primer disparo, no el intento bloqueado.
    expect(gate.lastFiredAt("r1")).toBe(1_000);
  });

  it("claves distintas no se afectan", () => {
    const gate = new MemoryCooldownGate();
    gate.claim("a", 30, 1_000);
    expect(gate.claim("b", 30, 1_000).fire).toBe(true);
  });
});