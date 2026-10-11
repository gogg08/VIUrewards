/**
 * Módulo de recompensas (rediseño, Etapa 4A).
 */

export { RewardService, type PendingOptions, type RewardServiceOptions } from "./service.ts";
export { suggestedTitle, SUGGESTED_TITLE_FALLBACK, SUGGESTED_TITLE_MAX } from "./suggested-title.ts";
export {
  ANIMATION_NAMES,
  MAX_REWARD_COST,
  MAX_REWARD_DESCRIPTION,
  MAX_REWARD_TITLE,
  normalizeRewardInput,
  REWARD_COLOR_RE,
  type NormalizedRewardInput,
  type RewardValidation,
} from "./validate.ts";
export type {
  RewardCreateInput,
  RewardListItem,
  RewardOperationError,
  RewardOperationResult,
  RewardPendingResult,
  RewardState,
  RewardUpdateInput,
  RewardsSnapshot,
} from "./types.ts";