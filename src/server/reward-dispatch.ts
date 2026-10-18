/**
 * Despachador de recompensas (Parte B; espera por cooldown, Parte 1).
 *
 * Es la capa donde el canje se cruza con la **recompensa local** (por id remoto +
 * plataforma) y se decide:
 *  - modo `queue`: se aplica el cooldown GLOBAL de la recompensa. Si dispara, va
 *    al motor de reglas (que encola el `PlayClip` y acepta el canje). Si está en
 *    cooldown, según la política `onWait`:
 *      - `queue` (por defecto): el canje entra a la **espera por cooldown** de esa
 *        recompensa y suena más tarde, uno por uno.
 *      - `skip` (como antes): el canje se omite con el motivo de siempre.
 *  - modo `overlap`: no hay cooldown ni cola; se manda un `playAudio` a los
 *    overlays conectados.
 *
 * El cooldown cuenta desde que el clip **termina** de reproducirse: el despacho
 * ya NO sella `last_fired_at` al encolar; lo sella el servidor cuando la cola da
 * por terminado el ítem (ver `onItemFinished`).
 *
 * El motor de reglas NO conoce recompensas: solo recibe los eventos que este
 * despachador le deja pasar.
 */

import {
  findRewardByRemoteId,
  getClip,
  type RewardRecord,
  type SqliteDatabase,
} from "../db/index.ts";
import { payloadRewardId, type NormalizedEvent, type ResolveOutcome } from "../events/index.ts";
import { decide, type CooldownDecision, type RuleEngine, type EngineResult } from "../rules/index.ts";
import type { AudioPlayback } from "./protocol.ts";

/** Qué hacer cuando un canje llega dentro del cooldown (solo modo `queue`). */
export type WaitPolicy = "queue" | "skip";

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
  /** Política cuando un canje llega dentro del cooldown (por defecto `queue`). */
  waitPolicy?: () => WaitPolicy;
  /**
   * ¿La recompensa tiene una reproducción pendiente (encolada o sonando) que
   * todavía no terminó? Mientras sea `true`, el canje se trata como "en cooldown":
   * no se puede disparar otro hasta que el actual termine. Es lo que evita que
   * varios canjes se encolen pegados cuando llegan antes de que suene el primero
   * (el cooldown recién se sella al terminar de reproducirse).
   */
  isRewardBusy?: (rewardId: string) => boolean;
  /**
   * Admitir un canje en la espera por cooldown. Devuelve `admitted: false` con el
   * motivo (`full` o `duplicate`) si no se pudo. Si no se inyecta, no hay espera.
   */
  admitWait?: (reward: RewardRecord, event: NormalizedEvent) => { admitted: boolean; reason?: "full" | "duplicate" };
  /**
   * Se llama justo antes de que el motor encole el `PlayClip` del disparo, con la
   * recompensa en curso: el servidor lo usa para asociar el próximo ítem encolado
   * con su recompensa y poder sellar el fin de reproducción.
   */
  markPlay?: (reward: RewardRecord) => void;
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
  private readonly waitPolicy: () => WaitPolicy;
  private readonly isRewardBusy?: (rewardId: string) => boolean;
  private readonly admitWait?: RewardDispatcherOptions["admitWait"];
  private readonly markPlay?: RewardDispatcherOptions["markPlay"];
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
    this.waitPolicy = options.waitPolicy ?? (() => "queue");
    this.isRewardBusy = options.isRewardBusy;
    this.admitWait = options.admitWait;
    this.markPlay = options.markPlay;
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

  /**
   * Dispara un canje que ya estaba en la espera por cooldown (lo llama el
   * planificador al cumplirse el cooldown). Re-chequea el clip (pudo borrarse
   * mientras esperaba) y, si está, lo encola por el camino normal. NO comprueba
   * el cooldown: el planificador ya se encargó de que se haya cumplido.
   */
  async dispatchWaiting(reward: RewardRecord, event: NormalizedEvent): Promise<EngineResult> {
    const base: Omit<EngineResult, "outcome"> = {
      eventId: event.id,
      platform: event.platform,
      type: event.type,
    };
    const clip = reward.clipId ? getClip(this.db, reward.clipId) : null;
    if (!clip || clip.missing) {
      const reason = missingClipReason(clip);
      this.logger?.(`rewards: ${reward.id} espera → omitido (${reason})`);
      return { ...base, outcome: "skipped", ruleId: reward.ruleId ?? undefined, reason };
    }
    this.logger?.(`rewards: ${reward.id} espera → disparó`);
    this.markPlay?.(reward);
    this.engine.forget(event.id);
    return this.engine.handle(event);
  }

  private queue(
    event: NormalizedEvent,
    reward: RewardRecord,
    base: Omit<EngineResult, "outcome">,
  ): Promise<EngineResult> {
    const now = this.now();

    // El clip se chequea ANTES del cooldown: un clip ausente nunca consume el
    // cooldown ni entra a la espera (no sonó nada). Si el archivo reaparece, el
    // próximo canje dispara enseguida.
    const clip = reward.clipId ? getClip(this.db, reward.clipId) : null;
    if (!clip || clip.missing) {
      const reason = missingClipReason(clip);
      this.logger?.(`rewards: ${reward.id} modo=esperar turno → omitido (${reason})`);
      return Promise.resolve({ ...base, outcome: "skipped", ruleId: reward.ruleId ?? undefined, reason });
    }

    const decision = decide(reward, now, reward.lastFiredAt);
    // La recompensa está "ocupada": tiene un clip encolado o sonando que todavía
    // no terminó. Mientras el cooldown recién se sella AL TERMINAR de reproducir,
    // sin este chequeo varios canjes que llegan antes de que suene el primero
    // pasarían los dos la comprobación y se encolarían pegados (sin espacio de
    // cooldown entre clips). Se trata como "en cooldown": espera el turno.
    const busy = this.isRewardBusy?.(reward.id) === true;
    if (busy || !decision.fire) {
      const remainingSec = busy ? Math.max(decision.remainingSec, reward.cooldownSec) : decision.remainingSec;
      // En cooldown. Según la política: esperar (por defecto) u omitir (como antes).
      if (this.waitPolicy() === "queue" && this.admitWait) {
        const admitted = this.admitWait(reward, event);
        if (admitted.admitted) {
          this.logDecision(reward, decision, now, `en espera por cooldown (faltan ${remainingSec} s)`);
          return Promise.resolve({
            ...base,
            outcome: "waiting",
            ruleId: reward.ruleId ?? undefined,
            reason: `En espera por cooldown (${remainingSec} s)`,
          });
        }
        // No se pudo esperar (tope lleno o duplicado): se omite con el motivo.
        const reason = admitted.reason === "full" ? "cola de espera llena" : "ya está en espera";
        this.logDecision(reward, decision, now, `omitido (${reason})`);
        return Promise.resolve({ ...base, outcome: "skipped", ruleId: reward.ruleId ?? undefined, reason });
      }
      this.logDecision(reward, decision, now, `omitido (cooldown, faltan ${remainingSec} s)`);
      return Promise.resolve({
        ...base,
        outcome: "skipped",
        ruleId: reward.ruleId ?? undefined,
        reason: `cooldown, faltan ${remainingSec} s`,
      });
    }

    // Dispara: se encola. `last_fired_at` NO se sella acá: el cooldown cuenta
    // desde que el clip TERMINA de reproducirse (el servidor lo sella en
    // `onItemFinished`). Se olvida el id para que el motor vuelva a evaluarlo.
    this.logDecision(reward, decision, now, "disparó");
    this.markPlay?.(reward);
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