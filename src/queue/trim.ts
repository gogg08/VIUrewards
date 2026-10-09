/**
 * Validación del recorte no destructivo de un clip (Fase 3, parte B).
 *
 * El recorte son dos segundos opcionales: `trimStart` (por defecto 0) y
 * `trimEnd` (por defecto `null` = hasta el final). Nunca modifica el archivo
 * mp4; solo indica al overlay dónde hacer seek y dónde cortar.
 *
 * Función pura y sin excepciones: devuelve un resultado tipado.
 */

export type TrimErrorCode = "INVALID_TRIM";

export type TrimValidation =
  | { ok: true; trimStart: number; trimEnd: number | null }
  | { ok: false; reason: TrimErrorCode; message: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalid(message: string): TrimValidation {
  return { ok: false, reason: "INVALID_TRIM", message };
}

/**
 * Valida un recorte. Si se pasa `durationSec` (> 0) además exige que caiga
 * dentro del clip: `0 <= inicio < fin <= duración`.
 *
 * Sin `durationSec` solo valida la estructura (para la cola, que no conoce la
 * duración del clip).
 */
export function validateTrim(
  trimStart: unknown,
  trimEnd: unknown,
  durationSec?: number,
): TrimValidation {
  const start = trimStart === undefined || trimStart === null ? 0 : trimStart;
  if (!isFiniteNumber(start) || start < 0) {
    return invalid("El inicio del recorte debe ser un número mayor o igual a 0.");
  }

  let end: number | null = null;
  if (trimEnd !== undefined && trimEnd !== null) {
    if (!isFiniteNumber(trimEnd)) return invalid("El fin del recorte debe ser un número.");
    end = trimEnd;
  }

  if (end !== null && end <= start) {
    return invalid("El fin del recorte debe ser mayor que el inicio.");
  }

  if (isFiniteNumber(durationSec) && durationSec > 0) {
    if (start >= durationSec) return invalid("El recorte empieza después del final del clip.");
    if (end !== null && end > durationSec) {
      return invalid("El recorte termina después del final del clip.");
    }
  }

  return { ok: true, trimStart: start, trimEnd: end };
}

/**
 * Duración efectiva de reproducción: el menor entre el tramo recortado y la
 * duración máxima configurada para la alerta.
 */
export function effectiveDurationSec(
  trimStart: number,
  trimEnd: number | null,
  maxDurationSec: number,
): number {
  const naturalEnd = trimEnd ?? Number.POSITIVE_INFINITY;
  const cap = trimStart + Math.max(1, maxDurationSec);
  return Math.max(0.1, Math.min(naturalEnd, cap) - trimStart);
}