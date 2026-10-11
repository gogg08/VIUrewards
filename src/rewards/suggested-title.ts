/**
 * Título sugerido para una alerta (rediseño, Etapa 4A).
 *
 * Función pura: a partir del nombre de un clip propone un nombre de recompensa
 * limpio, sin emojis ni hashtags, con los espacios colapsados, recortado a 50
 * caracteres sin partir un carácter Unicode. Si no queda nada, devuelve "Alerta".
 */

/** Rango amplio de emojis, pictogramas y modificadores, más selectores/ZWJ. */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Hashtags (`#palabra`): se eliminan por completo. */
const HASHTAG = /#\S*/gu;

export const SUGGESTED_TITLE_MAX = 50;
export const SUGGESTED_TITLE_FALLBACK = "Alerta";

export function suggestedTitle(name: string): string {
  const source = typeof name === "string" ? name : "";
  const cleaned = source
    .replace(EMOJI, " ")
    .replace(HASHTAG, " ")
    .replace(/\s+/g, " ")
    .trim();

  // `[...text]` separa por puntos de código: no parte pares subrogados.
  const clipped = [...cleaned].slice(0, SUGGESTED_TITLE_MAX).join("");
  return clipped.length > 0 ? clipped : SUGGESTED_TITLE_FALLBACK;
}