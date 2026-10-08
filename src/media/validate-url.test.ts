import { describe, expect, it } from "vitest";

import { validateUrl, DEFAULT_MAX_URL_LENGTH } from "./validate-url.ts";

describe("validateUrl - casos válidos", () => {
  it("acepta https de los dominios de la whitelist", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.tiktok.com/@user/video/123",
      "https://clips.twitch.tv/SomeClip",
      "https://kick.com/somechannel",
    ]) {
      expect(validateUrl(url).ok).toBe(true);
    }
  });

  it("acepta subdominios del dominio permitido", () => {
    const result = validateUrl("https://m.youtube.com/watch?v=1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.host).toBe("m.youtube.com");
  });

  it("normaliza host, puerto por defecto y fragmento", () => {
    const result = validateUrl("https://WWW.YouTube.com:443/watch?v=1#frag");
    expect(result).toEqual({ ok: true, url: "https://www.youtube.com/watch?v=1", host: "www.youtube.com" });
  });

  it("recorta espacios alrededor de la URL", () => {
    const result = validateUrl("  https://youtu.be/abc  ");
    expect(result.ok).toBe(true);
  });
});

describe("validateUrl - dominios no permitidos", () => {
  it("rechaza dominios fuera de la whitelist", () => {
    for (const url of [
      "https://vimeo.com/123",
      "https://example.com/video",
      "https://www.twitch.tv/videos/1",
    ]) {
      expect(validateUrl(url)).toEqual({ ok: false, reason: "DOMAIN_NOT_ALLOWED" });
    }
  });

  it("no permite el bypass por sufijo de dominio", () => {
    for (const url of [
      "https://evil-youtube.com/watch",
      "https://youtube.com.evil.com/watch",
      "https://notyoutube.com/watch",
    ]) {
      expect(validateUrl(url)).toEqual({ ok: false, reason: "DOMAIN_NOT_ALLOWED" });
    }
  });
});

describe("validateUrl - entradas inválidas", () => {
  it("rechaza protocolos que no sean https", () => {
    for (const url of ["http://www.youtube.com/watch?v=1", "ftp://youtube.com/x"]) {
      expect(validateUrl(url)).toEqual({ ok: false, reason: "URL_INVALID" });
    }
  });

  it("rechaza URLs con credenciales embebidas", () => {
    expect(validateUrl("https://user:pass@youtube.com/watch")).toEqual({
      ok: false,
      reason: "URL_INVALID",
    });
  });

  it("rechaza inputs vacíos o solo espacios", () => {
    expect(validateUrl("")).toEqual({ ok: false, reason: "URL_INVALID" });
    expect(validateUrl("   ")).toEqual({ ok: false, reason: "URL_INVALID" });
  });

  it("rechaza intentos de inyección de opciones", () => {
    for (const input of ["--exec", "-g", "--", "-https://youtube.com", "--no-playlist"]) {
      expect(validateUrl(input)).toEqual({ ok: false, reason: "URL_INVALID" });
    }
  });

  it("rechaza URLs demasiado largas", () => {
    const huge = `https://youtube.com/${"a".repeat(DEFAULT_MAX_URL_LENGTH)}`;
    expect(huge.length).toBeGreaterThan(DEFAULT_MAX_URL_LENGTH);
    expect(validateUrl(huge)).toEqual({ ok: false, reason: "TOO_LONG" });
  });

  it("respeta un límite de longitud configurable", () => {
    const url = "https://youtu.be/abc";
    expect(validateUrl(url, { maxUrlLength: 5 })).toEqual({ ok: false, reason: "TOO_LONG" });
  });
});