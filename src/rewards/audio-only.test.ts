/**
 * Tests de la regla "solo audio" por recompensa (rework, Sección 2).
 *
 * El modo overlap siempre es solo audio; un clip sin imagen también lo fuerza.
 * Si nada lo fuerza, vale lo que pidió el creador.
 */

import { describe, expect, it } from "vitest";

import { resolveAudioOnly } from "./audio-only.ts";

describe("resolveAudioOnly", () => {
  it("overlap fuerza solo audio aunque el creador no lo haya pedido", () => {
    expect(resolveAudioOnly({ repetition: "overlap", requested: false, clipHasVideo: true })).toEqual({
      value: true,
      forcedBy: "overlap",
    });
  });

  it("un clip sin imagen fuerza solo audio en modo esperar turno", () => {
    expect(resolveAudioOnly({ repetition: "queue", requested: false, clipHasVideo: false })).toEqual({
      value: true,
      forcedBy: "no-video",
    });
  });

  it("sin fuerzas vale la opción del creador", () => {
    expect(resolveAudioOnly({ repetition: "queue", requested: true, clipHasVideo: true })).toEqual({
      value: true,
      forcedBy: null,
    });
    expect(resolveAudioOnly({ repetition: "queue", requested: false, clipHasVideo: true })).toEqual({
      value: false,
      forcedBy: null,
    });
  });

  it("overlap tiene prioridad sobre el pedido del creador", () => {
    expect(resolveAudioOnly({ repetition: "overlap", requested: false, clipHasVideo: false }).forcedBy).toBe(
      "overlap",
    );
  });
});
