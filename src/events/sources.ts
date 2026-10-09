/**
 * Fuentes de eventos locales (Fase 4A): manual y simulada.
 *
 * Ninguna habla con una plataforma. Sirven para probar el motor de reglas sin
 * integrar nada: `ManualEventSource` dispara un evento "manual" (botón del
 * dashboard) y `SimulatedEventSource` permite disparar cualquier tipo de evento.
 */

import {
  createEvent,
  type CreateEventInput,
  type EventHandler,
  type EventSource,
  type EventSourceCapabilities,
  type EventType,
  type NormalizedEvent,
  type ResolveOutcome,
} from "./types.ts";

export interface EmitterEventSourceConfig {
  id: string;
  platform: string;
  capabilities: EventSourceCapabilities;
}

/** Base con manejo de suscriptores; no es una fuente real por sí sola. */
export class EmitterEventSource implements EventSource {
  readonly id: string;
  readonly platform: string;
  readonly capabilities: EventSourceCapabilities;
  private readonly handlers = new Set<EventHandler>();

  constructor(config: EmitterEventSourceConfig) {
    this.id = config.id;
    this.platform = config.platform;
    this.capabilities = config.capabilities;
  }

  start(): void {
    /* Sin conexión externa: no hay nada que iniciar. */
  }

  stop(): void {
    /* Sin conexión externa: no hay nada que detener. */
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Notifica a todos los suscriptores. */
  protected emit(event: NormalizedEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }
}

/** Evento "manual": lo dispara el usuario desde el dashboard. */
export class ManualEventSource extends EmitterEventSource {
  constructor() {
    super({
      id: "manual",
      platform: "manual",
      capabilities: { types: ["manual"], resolve: false },
    });
  }

  trigger(input: { user?: CreateEventInput["user"]; payload?: CreateEventInput["payload"] } = {}): NormalizedEvent {
    const event = createEvent({
      type: "manual",
      platform: this.platform,
      user: input.user,
      payload: input.payload,
    });
    this.emit(event);
    return event;
  }
}

export interface SimulatedEventSourceOptions {
  /** Se llama cuando el motor resuelve un evento (accept/reject). */
  onResolve?: (eventId: string, outcome: ResolveOutcome) => void;
}

export interface SimulatedTriggerInput extends Omit<CreateEventInput, "platform"> {
  platform?: string;
}

/**
 * Limita cuántos eventos simulados se recuerdan para saber quién resolvió qué.
 */
const MAX_RESOLUTIONS = 100;

/**
 * Fuente simulada: puede emitir cualquier tipo de evento y resolver canjes, para
 * probar el flujo completo sin ninguna plataforma conectada.
 */
export class SimulatedEventSource extends EmitterEventSource {
  private readonly onResolve?: (eventId: string, outcome: ResolveOutcome) => void;
  private readonly resolutions: Array<{ eventId: string; outcome: ResolveOutcome }> = [];

  constructor(options: SimulatedEventSourceOptions = {}) {
    super({
      id: "simulated",
      platform: "simulated",
      capabilities: {
        types: ["chat_command", "reward_redeemed", "sub", "gift", "follow", "manual"],
        resolve: true,
      },
    });
    this.onResolve = options.onResolve;
  }

  /** Emite un evento del tipo pedido. */
  trigger(input: SimulatedTriggerInput): NormalizedEvent {
    const event = createEvent({ ...input, platform: input.platform ?? this.platform });
    this.emit(event);
    return event;
  }

  /** Resoluciones registradas (para tests y para mostrarlas en el dashboard). */
  getResolutions(): ReadonlyArray<{ eventId: string; outcome: ResolveOutcome }> {
    return this.resolutions;
  }

  async resolve(eventId: string, outcome: ResolveOutcome): Promise<void> {
    this.resolutions.push({ eventId, outcome });
    if (this.resolutions.length > MAX_RESOLUTIONS) this.resolutions.shift();
    this.onResolve?.(eventId, outcome);
  }
}

/** Todos los tipos, para validar entradas sin depender de una fuente. */
export function sourceTypes(source: EventSource): EventType[] {
  return source.capabilities.types;
}
