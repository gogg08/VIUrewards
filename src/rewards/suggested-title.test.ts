/**
 * Tests del título sugerido (rediseño, Etapa 4A).
 */

import { describe, expect, it } from "vitest";

import { SUGGESTED_TITLE_FALLBACK, SUGGESTED_TITLE_MAX, suggestedTitle } from "./suggested-title.ts";

describe("suggestedTitle", () => {
  it("quita emojis", () => {
    expect(suggestedTitle("🎮 Mejor jugada 🔥")).toBe("Mejor jugada");
  });

  it("quita hashtags", () => {
    expect(suggestedTitle("clip #viral #gaming")).toBe("clip");
  });

  it("colapsa espacios", () => {
    expect(suggestedTitle("  hola   mundo  ")).toBe("hola mundo");
  });

  it("recorta a 50 caracteres", () => {
    const result = suggestedTitle("a".repeat(80));
    expect(result.length).toBe(SUGGESTED_TITLE_MAX);
  });

  it("no parte un carácter Unicode al recortar", () => {
    // Carácter del plano suplementario que NO es emoji (U+2000B): ocupa dos
    // unidades UTF-16, así que un recorte por unidades lo partiría.
    const name = `${"a".repeat(SUGGESTED_TITLE_MAX - 1)}\u{2000B}`;
    const result = suggestedTitle(name);
    expect(result.endsWith("\u{2000B}")).toBe(true);
    expect(result).not.toMatch(/[\uD800-\uDBFF]$/); // sin subrogado suelto
  });

  it("usa un texto por defecto si queda vacío", () => {
    expect(suggestedTitle("")).toBe(SUGGESTED_TITLE_FALLBACK);
    expect(suggestedTitle("   ")).toBe(SUGGESTED_TITLE_FALLBACK);
    expect(suggestedTitle("🎉🔥")).toBe(SUGGESTED_TITLE_FALLBACK);
    expect(suggestedTitle("#solo #hashtags")).toBe(SUGGESTED_TITLE_FALLBACK);
  });
});