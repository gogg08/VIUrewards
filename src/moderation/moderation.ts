/**
 * Cola de moderación de URLs propuestas por el público (Fase 4A).
 *
 * Nada de lo que escribe el público llega directo a un proceso: el texto se usa
 * para extraer una URL candidata, se valida (https, whitelist, largo) y, si pasa,
 * queda como propuesta PENDIENTE. Aprobar dispara la descarga existente; rechazar
 * la descarta. Los límites y la deduplicación evitan abuso.
 *
 * El `userInput` de un canje es input NO confiable (AGENTS.md): se trata como tal.
 */

import { randomUUID } from "node:crypto";

import {
  countPendingProposals,
  findPendingProposalByUrl,
  getProposal,
  insertProposal,
  listProposals,
  updateProposalStatus,
  type ProposalRecord,
} from "../db/proposals.ts";
import type { SqliteDatabase } from "../db/database.ts";
import { DEFAULT_ALLOWED_DOMAINS, DEFAULT_MAX_URL_LENGTH, validateUrl } from "../media/validate-url.ts";
import { canTransition, type ProposalStatus } from "./state.ts";

export interface ModerationLimits {
  maxPendingGlobal: number;
  maxPendingPerUser: number;
}

export type ValidationResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export type ResolveFn = (outcome: "accept" | "reject") => Promise<void>;

export interface ModerationSubmitInput {
  platform: string;
  userId: string;
  userName: string;
  eventId: string;
  /** Texto libre del usuario (canje o argumentos de comando). NO confiable. */
  userInput: string;
  autoApprove: boolean;
  /** Si el evento de origen soporta `resolve`, se llama al aprobar/rechazar. */
  resolve?: ResolveFn;
}

/** Interfaz mínima que usa el motor de reglas (no conoce la implementación). */
export interface ModerationSink {
  submit(input: ModerationSubmitInput): ModerationSubmitResult;
}

export type ModerationRejectReason =
  | "SIN_URL"
  | "URL_INVALID"
  | "DOMAIN_NOT_ALLOWED"
  | "TOO_LONG"
  | "DUPLICADA"
  | "LIMITE_GLOBAL"
  | "LIMITE_USUARIO";

export type ModerationSubmitResult =
  | { status: "pending"; proposal: ProposalRecord }
  | { status: "rejected"; proposal: ProposalRecord; reason: ModerationRejectReason };

export interface ModerationActionResult {
  ok: boolean;
  reason?: string;
  message?: string;
  proposal?: ProposalRecord;
}

export interface ModerationOptions {
  db: SqliteDatabase;
  limits: () => ModerationLimits;
  /** Arranca la descarga de una propuesta aprobada. */
  startDownload: (proposal: ProposalRecord) => void;
  /** Se llama cuando la descarga terminó bien (para encolar el clip). */
  onReady?: (proposal: ProposalRecord, clipId: string) => void;
  /** Se llama cuando la descarga falla (para decidir el canje de origen). */
  onFailed?: (proposal: ProposalRecord) => void;
  /** Valida y normaliza una URL. Por defecto usa la whitelist del módulo de media. */
  validate?: (raw: string) => ValidationResult;
  now?: () => number;
  maxUrlLength?: number;
}

const MAX_STORED_TEXT = 2048;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

/**
 * Extrae la primera URL del texto del usuario. Si no hay, y el texto entero
 * parece una URL (empieza con http), se usa eso. Devuelve `null` si no hay nada.
 */
export function extractUrlCandidate(text: string, maxUrlLength = DEFAULT_MAX_URL_LENGTH): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const match = trimmed.match(URL_PATTERN);
  const candidate = match ? match[0] : /^https?:/i.test(trimmed) ? trimmed : null;
  if (!candidate) return null;
  return candidate.slice(0, maxUrlLength);
}

function defaultValidate(raw: string): ValidationResult {
  const result = validateUrl(raw, { allowedDomains: DEFAULT_ALLOWED_DOMAINS });
  return result.ok ? { ok: true, url: result.url } : { ok: false, reason: result.reason };
}

export class ModerationService implements ModerationSink {
  private readonly db: SqliteDatabase;
  private readonly limits: () => ModerationLimits;
  private readonly startDownload: (proposal: ProposalRecord) => void;
  private readonly onReady?: (proposal: ProposalRecord, clipId: string) => void;
  private readonly onFailed?: (proposal: ProposalRecord) => void;
  private readonly validate: (raw: string) => ValidationResult;
  private readonly now: () => number;
  private readonly maxUrlLength: number;
  /** Callbacks de `resolve` por propuesta (en memoria; se pierden al reiniciar). */
  private readonly resolvers = new Map<string, ResolveFn>();

  constructor(options: ModerationOptions) {
    this.db = options.db;
    this.limits = options.limits;
    this.startDownload = options.startDownload;
    this.onReady = options.onReady;
    this.onFailed = options.onFailed;
    this.validate = options.validate ?? defaultValidate;
    this.now = options.now ?? (() => Date.now());
    this.maxUrlLength = options.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  }

  private record(
    input: ModerationSubmitInput,
    url: string,
    status: ProposalStatus,
    reason: string | null,
  ): ProposalRecord {
    const at = new Date(this.now()).toISOString();
    const proposal: ProposalRecord = {
      id: randomUUID(),
      platform: input.platform,
      userId: input.userId,
      userName: input.userName,
      url: url.slice(0, MAX_STORED_TEXT),
      eventId: input.eventId,
      status,
      reason,
      clipId: null,
      createdAt: at,
      updatedAt: at,
    };
    insertProposal(this.db, proposal);
    return proposal;
  }

  submit(input: ModerationSubmitInput): ModerationSubmitResult {
    const candidate = extractUrlCandidate(input.userInput ?? "", this.maxUrlLength);
    if (!candidate) {
      const proposal = this.record(input, (input.userInput ?? "").slice(0, MAX_STORED_TEXT), "rejected", "SIN_URL");
      this.rejectOrigin(input.resolve);
      return { status: "rejected", proposal, reason: "SIN_URL" };
    }

    const validation = this.validate(candidate);
    if (!validation.ok) {
      const reason = validation.reason as ModerationRejectReason;
      const proposal = this.record(input, candidate, "rejected", reason);
      this.rejectOrigin(input.resolve);
      return { status: "rejected", proposal, reason };
    }

    const normalized = validation.url;

    // Deduplicación: ya hay una propuesta pendiente con la misma URL.
    if (findPendingProposalByUrl(this.db, normalized)) {
      const proposal = this.record(input, normalized, "rejected", "DUPLICADA");
      this.rejectOrigin(input.resolve);
      return { status: "rejected", proposal, reason: "DUPLICADA" };
    }

    // Límites de abuso (global y por usuario).
    const limits = this.limits();
    if (countPendingProposals(this.db) >= limits.maxPendingGlobal) {
      const proposal = this.record(input, normalized, "rejected", "LIMITE_GLOBAL");
      this.rejectOrigin(input.resolve);
      return { status: "rejected", proposal, reason: "LIMITE_GLOBAL" };
    }
    if (countPendingProposals(this.db, input.userId) >= limits.maxPendingPerUser) {
      const proposal = this.record(input, normalized, "rejected", "LIMITE_USUARIO");
      this.rejectOrigin(input.resolve);
      return { status: "rejected", proposal, reason: "LIMITE_USUARIO" };
    }

    const proposal = this.record(input, normalized, "pending", null);
    if (input.resolve) this.resolvers.set(proposal.id, input.resolve);

    if (input.autoApprove) {
      const approved = this.approve(proposal.id);
      if (approved.ok && approved.proposal) return { status: "pending", proposal: approved.proposal };
    }
    return { status: "pending", proposal };
  }

  list(status?: string, limit = 200): ProposalRecord[] {
    return listProposals(this.db, { status, limit });
  }

  get(id: string): ProposalRecord | null {
    return getProposal(this.db, id);
  }

  /** Aprueba una propuesta pendiente y arranca la descarga. */
  approve(id: string): ModerationActionResult {
    const proposal = getProposal(this.db, id);
    if (!proposal) return { ok: false, reason: "NOT_FOUND" };
    const from = proposal.status as ProposalStatus;
    if (!canTransition(from, "approved")) {
      return { ok: false, reason: "INVALID_TRANSITION", message: `No se puede aprobar una propuesta "${from}".` };
    }

    updateProposalStatus(this.db, id, "approved", {});
    // La descarga arranca ya; el estado pasa a "downloading".
    updateProposalStatus(this.db, id, "downloading", {});
    const updated = getProposal(this.db, id) as ProposalRecord;

    try {
      this.startDownload(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo iniciar la descarga.";
      this.failDownload(id, message);
      return { ok: false, reason: "DOWNLOAD_FAILED", message, proposal: getProposal(this.db, id) ?? undefined };
    }
    return { ok: true, proposal: getProposal(this.db, id) ?? undefined };
  }

  /** Rechaza una propuesta pendiente. */
  reject(id: string, reason = "RECHAZADA"): ModerationActionResult {
    const proposal = getProposal(this.db, id);
    if (!proposal) return { ok: false, reason: "NOT_FOUND" };
    const from = proposal.status as ProposalStatus;
    if (!canTransition(from, "rejected")) {
      return { ok: false, reason: "INVALID_TRANSITION", message: `No se puede rechazar una propuesta "${from}".` };
    }
    updateProposalStatus(this.db, id, "rejected", { reason });
    this.callResolve(id, "reject");
    return { ok: true, proposal: getProposal(this.db, id) ?? undefined };
  }

  /** Informa el resultado de la descarga de una propuesta aprobada. */
  markDownloadResult(id: string, result: { ok: boolean; clipId?: string; message?: string }): ModerationActionResult {
    const proposal = getProposal(this.db, id);
    if (!proposal) return { ok: false, reason: "NOT_FOUND" };
    const from = proposal.status as ProposalStatus;
    if (from !== "downloading" && from !== "approved") {
      // Resultado tardío o duplicado: se ignora sin romper nada.
      return { ok: false, reason: "INVALID_TRANSITION", proposal };
    }

    if (result.ok && result.clipId) {
      if (!canTransition(from, "ready")) return { ok: false, reason: "INVALID_TRANSITION", proposal };
      updateProposalStatus(this.db, id, "ready", { clipId: result.clipId, reason: null });
      const updated = getProposal(this.db, id) as ProposalRecord;
      this.callResolve(id, "accept");
      this.onReady?.(updated, result.clipId);
      return { ok: true, proposal: updated };
    }

    this.failDownload(id, result.message ?? "La descarga falló.");
    return { ok: true, proposal: getProposal(this.db, id) ?? undefined };
  }

  /** Marca la propuesta como fallida y avisa (el canje de origen queda según config). */
  private failDownload(id: string, message: string): void {
    const current = getProposal(this.db, id);
    if (!current || !canTransition(current.status as ProposalStatus, "failed")) return;
    updateProposalStatus(this.db, id, "failed", { reason: message });
    const failed = getProposal(this.db, id) as ProposalRecord;
    this.onFailed?.(failed);
  }

  private rejectOrigin(resolve: ResolveFn | undefined): void {
    if (!resolve) return;
    void resolve("reject").catch(() => {
      /* El fallo al resolver no debe romper la moderación. */
    });
  }

  /**
   * Resuelve el canje de origen de una propuesta ya terminada (p. ej. tras una
   * descarga fallida, según la configuración). No cambia el estado de la propuesta.
   */
  resolveProposal(id: string, outcome: "accept" | "reject"): void {
    this.callResolve(id, outcome);
  }

  private callResolve(id: string, outcome: "accept" | "reject"): void {
    const resolve = this.resolvers.get(id);
    if (!resolve) return;
    this.resolvers.delete(id);
    void resolve(outcome).catch(() => {
      /* El fallo al resolver no debe romper la moderación. */
    });
  }
}
