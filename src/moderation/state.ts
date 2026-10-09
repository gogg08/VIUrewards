/**
 * Estados y transiciones de una propuesta de URL del público (Fase 4A).
 *
 * Modelado explícito, como pide AGENTS.md: cada estado es visible en la UI y
 * solo se permiten transiciones definidas. Ningún estado queda invisible.
 *
 *   pending ──► approved ──► downloading ──► ready
 *      │                          │
 *      └──► rejected              └──► failed
 */

export const PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "downloading",
  "ready",
  "failed",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Transiciones permitidas desde cada estado. */
export const PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["downloading", "failed"],
  downloading: ["ready", "failed"],
  ready: [],
  rejected: [],
  failed: [],
};

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

/** Estados considerados "pendientes" para los límites y la UI. */
export function isPendingStatus(status: ProposalStatus): boolean {
  return status === "pending";
}

export function isActiveStatus(status: ProposalStatus): boolean {
  return status === "pending" || status === "approved" || status === "downloading";
}

/** Etiqueta en español para la UI. */
export function proposalStatusLabel(status: ProposalStatus): string {
  switch (status) {
    case "pending":
      return "Pendiente";
    case "approved":
      return "Aprobada";
    case "rejected":
      return "Rechazada";
    case "downloading":
      return "Descargando";
    case "ready":
      return "Lista";
    case "failed":
      return "Fallida";
  }
}
