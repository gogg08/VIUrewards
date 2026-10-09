/**
 * Motor de reglas evento -> acción (Fase 4A).
 */

export {
  hasPermission,
  matchesTrigger,
  normalizeCommand,
  ruleMatches,
} from "./matching.ts";

export { CooldownTracker, type CooldownResult } from "./cooldown.ts";

export { defaultActionResolver, SubmitUserUrl } from "./actions.ts";

export {
  MAX_COOLDOWN_SEC,
  MAX_MIN_AMOUNT,
  MAX_RULE_NAME_LENGTH,
  PERMISSIONS,
  RULE_ACTIONS,
  validateRuleInput,
  type RuleValidation,
} from "./validate.ts";

export {
  RuleEngine,
  type EngineLogEntry,
  type EngineOutcome,
  type EngineResult,
  type RuleEngineOptions,
} from "./engine.ts";

export type {
  ActionResolver,
  Permission,
  PlayClipActionConfig,
  Rule,
  RuleAction,
  RuleActionConfig,
  RuleActionContext,
  RuleConditions,
  RuleTrigger,
  SubmitUserUrlActionConfig,
} from "./types.ts";