import { describe, expect, it } from "vitest";

import { parseOverlayMessage } from "./protocol.ts";
import { parseDiag, urlWithoutKey } from "./protocol-diag.ts";

describe("parseOverlayMessage", () => {
  it("acepta ready, ended, error y diag", () => {
    expect(parseOverlayMessage(JSON.stringify({ type: "ready" }))).toEqual({ type: "ready" });
    expect(parseOverlayMessage(JSON.stringify({ type: "ended", itemId: "a" }))).toMatchObject({
      type: "ended",
      itemId: "a",
    });
    expect(parseOverlayMessage(JSON.stringify({ type: "error", message: "x" }))).toMatchObject({
      type: "error",
      message: "x",
    });
  });

  it("descarta el diag con forma inválida", () => {
    // Sin `kind` ni `version`: no cumple el esquema, se descarta.
    expect(parseOverlayMessage(JSON.stringify({ type: "diag", diag: { foo: 1 } }))).toBeNull();
    expect(parseOverlayMessage(JSON.stringify({ type: "diag", diag: { kind: "x", version: "v" } }))).toBeNull();
  });

  it("acepta un diag de conexión válido", () => {
    const parsed = parseOverlayMessage(
      JSON.stringify({
        type: "diag",
        diag: { kind: "connection", version: "v1", userAgent: "ua", canPlay: { "audio/x-m4a": "maybe" } },
      }),
    );
    expect(parsed).toMatchObject({ type: "diag", diag: { kind: "connection", version: "v1" } });
  });

  it("descarta basura y JSON inválido", () => {
    expect(parseOverlayMessage("no es json")).toBeNull();
    expect(parseOverlayMessage(JSON.stringify({ type: "desconocido" }))).toBeNull();
  });
});

describe("parseDiag", () => {
  it("no acepta una forma sin kind ni version", () => {
    expect(parseDiag({})).toBeNull();
    expect(parseDiag(null)).toBeNull();
    expect(parseDiag({ kind: "playback" })).toBeNull();
  });

  it("conserva solo los eventos conocidos y numéricos", () => {
    const diag = parseDiag({
      kind: "playback",
      version: "v1",
      url: "/media/a.m4a",
      readyState: 4,
      networkState: 1,
      errorCode: null,
      errorMessage: null,
      events: { playing: 120, loadedmetadata: 15, inventado: 5, error: "x" },
    });
    expect(diag?.events).toEqual({ loadedmetadata: 15, playing: 120 });
    expect(diag?.readyState).toBe(4);
  });
});

describe("urlWithoutKey", () => {
  it("quita el parámetro key y cualquier query", () => {
    expect(urlWithoutKey("/media/abc.m4a?key=secreto")).toBe("/media/abc.m4a");
    expect(urlWithoutKey("/media/abc.mp4")).toBe("/media/abc.mp4");
    expect(urlWithoutKey("")).toBe("");
  });
});
