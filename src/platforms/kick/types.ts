/**
 * Tipos de la API de Kick (Fase 4B).
 *
 * Todo lo específico de Kick vive en esta carpeta. Estos tipos describen lo que
 * devuelve la API oficial según docs/kick-research.md (Secciones 1 y 8). Lo que
 * no está verificado queda marcado con `TODO(verificar)`.
 */

/** Envoltura estándar de la API: `{ data, message? }`. */
export interface ApiEnvelope<T> {
  data: T;
  message?: string;
}

/** Respuesta del endpoint de tokens (`/oauth/token`). */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export interface KickUser {
  user_id: number;
  name: string;
}

export interface ChannelReward {
  id: string;
  title: string;
  cost: number;
  description: string;
  background_color: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_user_input_required: boolean;
  should_redemptions_skip_request_queue: boolean;
}

/** Cuerpo para crear/editar una recompensa (`POST`/`PATCH`). */
export interface ChannelRewardInput {
  title: string;
  cost: number;
  description?: string;
  background_color?: string;
  is_enabled?: boolean;
  is_user_input_required?: boolean;
  should_redemptions_skip_request_queue?: boolean;
}

/** Canje tal como lo devuelve el REST: `redeemer` solo trae `user_id`. */
export interface ChannelRewardRedemption {
  id: string;
  redeemed_at: string;
  status: "pending" | "accepted" | "rejected";
  user_input: string;
  redeemer: { user_id: number };
}

export interface RedemptionGroup {
  reward: { id: string; title: string };
  redemptions: ChannelRewardRedemption[];
}

export interface RedemptionsPage {
  data: RedemptionGroup[];
  pagination: { next_cursor: string };
}

/** Motivos de fallo al aceptar/rechazar (Kick solo devuelve los que fallaron). */
export type RedemptionFailureReason = "UNKNOWN" | "NOT_PENDING" | "NOT_FOUND" | "NOT_OWNED";

export interface RedemptionFailure {
  id: string;
  reason: RedemptionFailureReason;
}