/**
 * Ciclo de vida de canjes de recompensa (Fase 4B).
 */

export {
  canTransitionRedemption,
  isRedemptionStatus,
  REDEMPTION_STATUSES,
  REDEMPTION_TRANSITIONS,
  redemptionStatusLabel,
  type RedemptionStatus,
} from "./state.ts";

export {
  RedemptionCoordinator,
  type OldAction,
  type OnSkipPolicy,
  type ProcessOutcome,
  type ReceiveResult,
  type RedemptionCoordinatorOptions,
  type RedemptionPolicy,
} from "./coordinator.ts";
