/**
 * Acceso a la base local (Fase 3).
 */

export {
  migrate,
  openDatabase,
  openMemoryDatabase,
  SCHEMA_VERSION,
  type SqliteDatabase,
} from "./database.ts";

export {
  deleteSetting,
  getOrCreateSecret,
  getSetting,
  setSetting,
  SETTING_AUTH_PASSWORD,
  SETTING_OVERLAY_KEY,
} from "./settings.ts";

export {
  deleteClip,
  getClip,
  listClips,
  reconcileClips,
  renameClip,
  scanMediaDir,
  setClipMissing,
  setClipTrim,
  upsertClip,
  type ClipRecord,
  type MediaScan,
  type RebuiltClip,
  type ReconcileOptions,
  type ReconcileResult,
} from "./clips.ts";

export {
  deleteRule,
  getRuleRecord,
  listRules,
  toRule,
  upsertRule,
  type RuleRecord,
} from "./rules.ts";

export {
  deleteReward,
  findRewardByRemoteId,
  getReward,
  listRewardsForPlatform,
  listRewardsUsingClip,
  setRewardError,
  setRewardLastFired,
  upsertReward,
  type RewardRecord,
  type RewardRepetition,
} from "./rewards.ts";

export {
  addHistory,
  listHistory,
  pruneHistory,
  pruneHistoryByAge,
  type EventHistoryEntry,
  type EventHistoryRecord,
} from "./history.ts";


export {
  deletePlatformAccount,
  getPlatformAccount,
  upsertPlatformAccount,
  type PlatformAccountRecord,
  type PlatformAccountState,
  type PlatformCredentials,
  type PlatformTokens,
} from "./platform-accounts.ts";

export {
  forgetProcessedEvent,
  hasProcessedEvent,
  listManagedRewards,
  markEventProcessed,
  markRewardManaged,
  pruneProcessedEvents,
  unmarkRewardManaged,
} from "./processed-events.ts";

export {
  countRedemptions,
  getRedemption,
  insertRedemption,
  listRedemptions,
  updateRedemptionStatus,
  type RedemptionRecord,
} from "./redemptions.ts";