/**
 * Máquina de estados de los canjes (rediseño, Parte 1).
 *
 * Se prueba el estado nuevo `waiting` (en espera por cooldown) y sus
 * transiciones: se entra desde `received`, y de ahí se puede disparar
 * (`accepted`), omitir (`skipped`/`ignored`/`rejected`) o fallar (`failed`).
 * Una transición ilegal se rechaza sin romper nada.
 */

import { describe, expect, it } from "vitest";

import {
  REDEMPTION_STATUSES,
  canTransitionRedemption,
  isRedemptionStatus,
  redemptionStatusLabel,
  type RedemptionStatus,
} from "./state.ts";

describe("estado de canje 'waiting' (en espera por cooldown)", () => {
  it("es un estado conocido y tiene su etiqueta en español", () => {
    expect(REDEMPTION_STATUSES).toContain("waiting");
    expect(isRedemptionStatus("waiting")).toBe(true);
    expect(redemptionStatusLabel("waiting")).toBe("En espera por cooldown");
  });

  it("se entra desde 'received' (el canje llegó dentro del cooldown)", () => {
    expect(canTransitionRedemption("received", "waiting")).toBe(true);
  });

  it("al sonar el clip pasa a 'accepted'", () => {
    expect(canTransitionRedemption("waiting", "accepted")).toBe(true);
  });

  it("se puede omitir (por tope, espera máxima o descarte) sin aceptar", () => {
    expect(canTransitionRedemption("waiting", "skipped")).toBe(true);
    expect(canTransitionRedemption("waiting", "ignored")).toBe(true);
    expect(canTransitionRedemption("waiting", "rejected")).toBe(true);
    expect(canTransitionRedemption("waiting", "failed")).toBe(true);
  });

  it("no vuelve a 'received' ni a 'waiting' (no se re-espera sin reprocesar)", () => {
    expect(canTransitionRedemption("waiting", "received")).toBe(false);
    expect(canTransitionRedemption("waiting", "waiting")).toBe(false);
  });

  it("no se puede entrar a 'waiting' desde un estado final", () => {
    for (const terminal of ["accepted", "rejected", "failed", "skipped"] as RedemptionStatus[]) {
      expect(canTransitionRedemption(terminal, "waiting")).toBe(false);
    }
  });
});
