/**
 * Moderación de URLs propuestas por el público (Fase 4A).
 */

export {
  canTransition,
  isActiveStatus,
  isPendingStatus,
  isProposalStatus,
  proposalStatusLabel,
  PROPOSAL_STATUSES,
  PROPOSAL_TRANSITIONS,
  type ProposalStatus,
} from "./state.ts";

export {
  extractUrlCandidate,
  ModerationService,
  type ModerationActionResult,
  type ModerationLimits,
  type ModerationOptions,
  type ModerationRejectReason,
  type ModerationSink,
  type ModerationSubmitInput,
  type ModerationSubmitResult,
  type ResolveFn,
  type ValidationResult,
} from "./moderation.ts";