import { describe, expect, it } from "vitest";

import { isUsableDownload, nodeSupportsEjs } from "./index.ts";

describe("nodeSupportsEjs", () => {
  it("acepta Node 22 o superior", () => {
    expect(nodeSupportsEjs("22.0.0")).toBe(true);
    expect(nodeSupportsEjs("22.23.2")).toBe(true);
    expect(nodeSupportsEjs("23.1.0")).toBe(true);
  });

  it("rechaza versiones anteriores a 22", () => {
    expect(nodeSupportsEjs("20.11.0")).toBe(false);
    expect(nodeSupportsEjs("18.20.0")).toBe(false);
  });
});

describe("isUsableDownload", () => {
  it("rechaza páginas mhtml/html", () => {
    expect(isUsableDownload("/media/abc.src.mhtml", null)).toBe(false);
    expect(isUsableDownload("/media/abc.src.html", null)).toBe(false);
    expect(isUsableDownload("/media/abc.src.htm", null)).toBe(false);
  });

  it("rechaza formatos sin pistas de video ni audio", () => {
    // Storyboard de YouTube: acodec y vcodec son "none".
    expect(isUsableDownload("/media/abc.src.mhtml", { vcodec: "none", acodec: "none" })).toBe(false);
  });

  it("acepta descargas con video y/o audio", () => {
    expect(isUsableDownload("/media/abc.src.mp4", { vcodec: "avc1", acodec: "mp4a" })).toBe(true);
    expect(isUsableDownload("/media/abc.src.mp4", { vcodec: "avc1", acodec: "none" })).toBe(true);
    expect(isUsableDownload("/media/abc.src.m4a", { vcodec: "none", acodec: "mp4a" })).toBe(true);
  });

  it("acepta cuando no hay metadatos que juzgar", () => {
    expect(isUsableDownload("/media/abc.src.webm", null)).toBe(true);
    expect(isUsableDownload("/media/abc.src.webm", {})).toBe(true);
  });
});