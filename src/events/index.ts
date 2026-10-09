/**
 * Eventos normalizados y fuentes de eventos (Fase 4A).
 */

export {
  createEvent,
  isEventType,
  payloadAmount,
  payloadArgs,
  payloadCommand,
  payloadRewardId,
  payloadUserInput,
  EVENT_TYPES,
  type ChatCommandPayload,
  type CreateEventInput,
  type EventHandler,
  type EventPayload,
  type EventSource,
  type EventSourceCapabilities,
  type EventType,
  type EventUser,
  type NormalizedEvent,
  type ResolveOutcome,
  type RewardRedeemedPayload,
} from "./types.ts";

export {
  EmitterEventSource,
  ManualEventSource,
  SimulatedEventSource,
  sourceTypes,
  type EmitterEventSourceConfig,
  type SimulatedEventSourceOptions,
  type SimulatedTriggerInput,
} from "./sources.ts";
