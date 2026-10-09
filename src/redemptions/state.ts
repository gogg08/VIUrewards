/**
 * Ciclo de vida de un canje de recompensa (Fase 4B).
 *
 * Modelado explícito, como pide AGENTS.md: cada estado es visible en el
 * dashboard y solo se permiten las transiciones definidas acá.
 *
 *   received ──► accepted            (alerta encolada, o clip listo)
 *      │   ├──► awaiting_moderation  (URL esperando aprobación)
 *      │   ├──► rejected            (rechazado en la plataforma)
 *      │   ├──► ignored             (canje viejo o en espera manual)
 *      │   ├──► failed              (la descarga o la resolución fallaron)
 *      │   └──► skipped             (sin regla, cooldown o sin permiso)
 *   awaiting_moderation ──► accepted | rejected | failed | skipped
 *   ignored ──► received (reprocesar) | rejected
 *
 * `accepted`, `rejected`, `failed` y `skipped` son terminales, salvo que el
 * canje siga pendiente en Kick (ver `leave_pending`).
 */

export const REDEMPTION_STATUSES = [
  "received",
  "accepted",
  "awaiting_moderation",
  "rejected",
  "ignored",
  "failed",
  "skipped",
] as const;

export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

export const REDEMPTION_TRANSITIONS: Record<RedemptionStatus, readonly RedemptionStatus[]> = {
  received: ["accepted", "awaiting_moderation", "rejected", "ignored", "failed", "skipped"],
  awaiting_moderation: ["accepted", "rejected", "failed", "skipped"],
  ignored: ["received", "rejected"],
  accepted: [],
  rejected: [],
  failed: [],
  skipped: [],
};

export function isRedemptionStatus(value: unknown): value is RedemptionStatus {
  return typeof value === "string" && (REDEMPTION_STATUSES as readonly string[]).includes(value);
}

export function canTransitionRedemption(from: RedemptionStatus, to: RedemptionStatus): boolean {
  return REDEMPTION_TRANSITIONS[from].includes(to);
}

/** Etiqueta en español para la UI. */
export function redemptionStatusLabel(status: RedemptionStatus): string {
  switch (status) {
    case "received":
      return "Recibido";
    case "accepted":
      return "Aceptado";
    case "awaiting_moderation":
      return "Esperando moderación";
    case "rejected":
      return "Rechazado";
    case "ignored":
      return "Omitido (pendiente)";
    case "failed":
      return "Fallido";
    case "skipped":
      return "Omitido";
  }
}
