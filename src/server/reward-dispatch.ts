/**
 * Despachador de recompensas (Parte B).
 *
 * Es la capa donde el canje se cruza con la **recompensa local** (por id remoto +
 * plataforma) y se decide:
 *  - modo `queue`: se aplica el cooldown GLOBAL de la recompensa (decisión +
 *    registro atómicos, sin `await` en el medio) y, si dispara, va al motor de
 *    reglas (que encola el `PlayClip` y acepta el canje).
 *  - modo `overlap`: no hay cooldown ni cola; se manda un `playAudio` a los
 *    overlays conectados. Si no hay ninguno o la recompensa no tiene clip, el
 *    canje queda omitido con el motivo correspondiente.
 *
 * El motor de reglas NO conoce recompensas: solo recibe los eventos que este
 * despachador le deja pasar. Este módulo vive en `src/server` porque conecta el
 * modelo local con la cola, la configuración y el WebSocket del overlay.
 */

import {
  findRewardByRemoteId,
  getClip,
  setRewardLastFired,
  type RewardRecord,
  type SqliteDatabase,
} from "../db/index.ts";
import { payloadRewardId, type NormalizedEvent, type ResolveOutcome } from "../events/index.ts";
import { decide, type CooldownDecision, type RuleEngine, type EngineResult } from "../rules/index.ts";
import type { AudioPlayback } from "./protocol.ts";

export interface RewardDispatcherOptions {
  db: SqliteDatabase;
  engine: RuleEngine;
  now: () => number;
  /** Envía un audio superpuesto; devuelve a cuántos overlays llegó (0 = ninguno). */
  broadcastAudio: (audio: AudioPlayback) => number;
  resolveEvent: (event: NormalizedEvent, outcome: ResolveOutcome) => Promise<void>;
  /** URL de un clip servido por /media con la clave del overlay. */
  mediaUrl: (clipId: string) => string;
  globalVolume: () => number;
  defaultMaxDuration: () => number;
  maxVoices: () => number;
  logger?: (message: string) => void;
}

const MODE_LABEL: Record<RewardRecord["repetition"], string> = {
  queue: "esperar turno",
  overlap: "superpuesto",
};

/** Motivo de omisión cuando el clip de la recompensa no se puede reproducir. */
function missingClipReason(clip: ReturnType<typeof getClip>): string {
  if (!clip) return "la recompensa no tiene clip";
  return "falta el archivo del clip";
}

export class RewardDispatcher {
  private readonly db: SqliteDatabase;
  private readonly engine: RuleEngine;
  private readonly now: () => number;
  private readonly broadcastAudio: RewardDispatcherOptions["broadcastAudio"];
  private readonly resolveEvent: RewardDispatcherOptions["resolveEvent"];
  private readonly mediaUrl: RewardDispatcherOptions["mediaUrl"];
  private readonly globalVolume: () => number;
  private readonly defaultMaxDuration: () => number;
  private readonly maxVoices: () => number;
  private readonly logger?: (message: string) => void;

  constructor(options: RewardDispatcherOptions) {
    this.db = options.db;
    this.engine = options.engine;
    this.now = options.now;
    this.broadcastAudio = options.broadcastAudio;
    this.resolveEvent = options.resolveEvent;
    this.mediaUrl = options.mediaUrl;
    this.globalVolume = options.globalVolume;
    this.defaultMaxDuration = options.defaultMaxDuration;
    this.maxVoices = options.maxVoices;
    this.logger = options.logger;
  }

  /** Procesa un evento y devuelve el resultado (igual que el motor de reglas). */
  async process(event: NormalizedEvent): Promise<EngineResult> {
    const base: Omit<EngineResult, "outcome"> = {
      eventId: event.id,
      platform: event.platform,
      type: event.type,
    };

    if (event.type === "reward_redeemed") {
      const remoteId = payloadRewardId(event.payload);
      const reward = remoteId ? findRewardByRemoteId(this.db, event.platform, remoteId) : null;
      if (reward) {
        if (reward.repetition === "overlap") return this.overlap(event, reward, base);
        return this.queue(event, reward, base);
      }
    }

    // Sin recompensa local (o evento que no es un canje): al motor tal cual.
    this.engine.forget(event.id);
    return this.engine.handle(event);
  }

  private queue(
    event: NormalizedEvent,
    reward: RewardRecord,
    base: Omit<EngineResult, "outcome">,
  ): Promise<EngineResult> {
    const now = this.now();
    const decision = decide(reward, now, reward.lastFiredAt);
    if (!decision.fire) {
      this.logDecision(reward, decision, now, `omitido (cooldown, faltan ${decision.remainingSec} s)`);
      return Promise.resolve({
        ...base,
        outcome: "skipped",
        ruleId: reward.ruleId ?? undefined,
        reason: `cooldown, faltan ${decision.remainingSec} s`,
      });
    }
    // El clip de la recompensa debe existir y no estar marcado como ausente: si no,
    // el overlay pediría un archivo inexistente. Se omite con un motivo claro. El
    // cooldown se evalúa antes (es la decisión documentada del modo cola).
    const clip = reward.clipId ? getClip(this.db, reward.clipId) : null;
    if (!clip || clip.missing) {
      const reason = missingClipReason(clip);
      this.logger?.(`rewards: ${reward.id} modo=esperar turno → omitido (${reason})`);
      return Promise.resolve({ ...base, outcome: "skipped", ruleId: reward.ruleId ?? undefined, reason });
    }
    // Decisión + registro en el mismo tick (sin `await`): dos canjes del mismo
    // ciclo no pueden pasar los dos la comprobación.
    setRewardLastFired(this.db, reward.id, now);
    this.logDecision(reward, decision, now, "disparó");
    this.engine.forget(event.id);
    return this.engine.handle(event);
  }

  private async overlap(
    event: NormalizedEvent,
    reward: RewardRecord,
    base: Omit<EngineResult, "outcome">,
  ): Promise<EngineResult> {
    const clip = reward.clipId ? getClip(this.db, reward.clipId) : null;
    // El modo overlap siempre usa playAudio (no depende de que el clip sea "solo
    // audio"): la recompensa suena superpuesta.
    if (!clip || clip.missing) {
      const reason = missingClipReason(clip);
      this.logger?.(`rewards: ${reward.id} modo=superpuesto → omitido (${reason})`);
      return { ...base, outcome: "skipped", ruleId: reward.ruleId ?? undefined, reason };
    }

    const audio: AudioPlayback = {
      id: event.id,
      url: this.mediaUrl(clip.id),
      volume: reward.volume * (this.globalVolume() / 100),
      trimStart: clip.trimStart ?? 0,
      trimEnd: clip.trimEnd,
      maxDurationSec: reward.maxDurationSec ?? this.defaultMaxDuration(),
      maxVoices: this.maxVoices(),
    };
    const sent = this.broadcastAudio(audio);
    if (sent === 0) {
      this.logger?.(`rewards: ${reward.id} modo=superpuesto → omitido (sin overlay conectado)`);
      return { ...base, outcome: "skipped", ruleId: reward.ruleId ?? undefined, reason: "sin overlay conectado" };
    }

    await this.resolveEvent(event, "accept");
    this.logger?.(`rewards: ${reward.id} modo=superpuesto → disparó (${sent} overlay(s))`);
    return { ...base, outcome: "fired", ruleId: reward.ruleId ?? undefined };
  }

  private logDecision(
    reward: RewardRecord,
    decision: CooldownDecision,
    now: number,
    result: string,
  ): void {
    this.logger?.(
      `rewards: recompensa=${reward.id} modo=${MODE_LABEL[reward.repetition]} ` +
        `último=${decision.lastFiredAt ?? "-"} ahora=${now} cooldown=${reward.cooldownSec}s → ${result}`,
    );
  }
}