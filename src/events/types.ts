/**
 * Eventos normalizados y la interfaz `EventSource` (Fase 4A).
 *
 * Un evento normalizado es la única forma en que el motor de reglas ve lo que
 * pasa en una plataforma. Ningún código fuera del adaptador correspondiente
 * puede conocer nombres o tipos específicos de una plataforma (ver AGENTS.md).
 *
 * `payload` es un objeto libre, pero con helpers para leer los campos que usa el
 * motor (comando, recompensa, texto del usuario, monto). El `userInput` de un
 * canje es input NO confiable: se valida antes de usarse.
 */

export const EVENT_TYPES = [
  "chat_command",
  "reward_redeemed",
  "sub",
  "gift",
  "follow",
  "manual",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface EventUser {
  id: string;
  name: string;
  /** Roles conocidos: "broadcaster", "moderator", "subscriber", "vip", etc. */
  roles: string[];
}

export interface ChatCommandPayload {
  command: string;
  args: string[];
}

export interface RewardRedeemedPayload {
  rewardId: string;
  rewardTitle: string;
  /** Texto libre que escribió el espectador al canjear. NO confiable. */
  userInput: string;
}

/** Payload de un evento: los campos conocidos o un objeto libre. */
export type EventPayload =
  | ChatCommandPayload
  | RewardRedeemedPayload
  | Record<string, unknown>;

export interface NormalizedEvent {
  id: string;
  platform: string;
  type: EventType;
  user: EventUser;
  payload: EventPayload;
  timestamp: number;
}

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

function asRecord(payload: EventPayload): Record<string, unknown> {
  return payload as Record<string, unknown>;
}

/** Nombre del comando (sin el `!`), o `null` si el evento no es un comando. */
export function payloadCommand(payload: EventPayload): string | null {
  const value = asRecord(payload).command;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function payloadArgs(payload: EventPayload): string[] {
  const value = asRecord(payload).args;
  if (!Array.isArray(value)) return [];
  return value.filter((arg): arg is string => typeof arg === "string");
}

export function payloadRewardId(payload: EventPayload): string | null {
  const value = asRecord(payload).rewardId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Texto libre del espectador (canje o similar). Input no confiable. */
export function payloadUserInput(payload: EventPayload): string {
  const value = asRecord(payload).userInput;
  return typeof value === "string" ? value : "";
}

/** Monto asociado a un evento (gift subs, bits, etc.). */
export function payloadAmount(payload: EventPayload): number | null {
  const value = asRecord(payload).amount;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface CreateEventInput {
  type: EventType;
  platform?: string;
  /** Si no se pasa, se genera uno aleatorio. */
  id?: string;
  user?: Partial<EventUser>;
  payload?: EventPayload;
  timestamp?: number;
}

const SYSTEM_USER: EventUser = { id: "system", name: "system", roles: [] };

/** Construye un evento normalizado, completando lo que falte. */
export function createEvent(input: CreateEventInput): NormalizedEvent {
  const user: EventUser = {
    id: input.user?.id ?? SYSTEM_USER.id,
    name: input.user?.name ?? SYSTEM_USER.name,
    roles: input.user?.roles ?? [...SYSTEM_USER.roles],
  };
  return {
    id: input.id ?? randomId(),
    platform: input.platform ?? "local",
    type: input.type,
    user,
    payload: input.payload ?? {},
    timestamp: input.timestamp ?? Date.now(),
  };
}

function randomId(): string {
  // Id local, sin depender de la plataforma. `crypto.randomUUID` es global en Node.
  return globalThis.crypto.randomUUID();
}

/**
 * Capacidades declaradas por una fuente de eventos. El dashboard usa esto para
 * ocultar los triggers que la plataforma no soporta.
 */
export interface EventSourceCapabilities {
  /** Tipos de evento que la fuente puede emitir. */
  types: EventType[];
  /** ¿Soporta marcar un canje pendiente como aceptado o rechazado? */
  resolve: boolean;
}

export type EventHandler = (event: NormalizedEvent) => void | Promise<void>;

export type ResolveOutcome = "accept" | "reject";

/**
 * Fuente de eventos normalizados. Las plataformas reales la implementan en su
 * propio adaptador; acá viven las implementaciones locales (manual y simulada).
 */
export interface EventSource {
  readonly id: string;
  readonly platform: string;
  readonly capabilities: EventSourceCapabilities;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  onEvent(handler: EventHandler): () => void;
  /**
   * Para plataformas donde un canje queda pendiente hasta marcarlo como
   * cumplido o rechazado. Opcional: solo si `capabilities.resolve` es `true`.
   */
  resolve?(eventId: string, outcome: ResolveOutcome): Promise<void>;
}
