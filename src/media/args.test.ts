import { describe, expect, it } from "vitest";

import { buildAudioFfmpegArgs, buildFfmpegArgs, buildFfprobeArgs, buildYtdlpArgs } from "./args.ts";

const TEMPLATE = "/media/abc.%(ext)s";

describe("buildYtdlpArgs", () => {
  it("devuelve un array y nunca usa -g", () => {
    const args = buildYtdlpArgs("https://youtu.be/abc", TEMPLATE, {
      maxBytes: 10 * 1024 * 1024,
      maxDurationSec: 60,
    });
    expect(Array.isArray(args)).toBe(true);
    expect(args).not.toContain("-g");
    expect(args).toContain("--no-playlist");
  });

  it("pone la URL al final, precedida por --", () => {
    const url = "https://youtu.be/abc";
    const args = buildYtdlpArgs(url, TEMPLATE, { maxBytes: 1024, maxDurationSec: 60 });
    expect(args.at(-1)).toBe(url);
    expect(args.at(-2)).toBe("--");
    expect(args.indexOf("--")).toBe(args.length - 2);
  });

  it("nunca deja que la URL se interprete como opción", () => {
    const maliciosa = "--exec=touch /tmp/pwned";
    const args = buildYtdlpArgs(maliciosa, TEMPLATE, { maxBytes: 1024, maxDurationSec: 60 });
    // La URL es un único elemento de argv y yt-dlp la verá después de `--`.
    expect(args.at(-1)).toBe(maliciosa);
    expect(args.at(-2)).toBe("--");
  });

  it("aplica los límites de tamaño y duración", () => {
    const args = buildYtdlpArgs("https://youtu.be/abc", TEMPLATE, {
      maxBytes: 5 * 1024 * 1024,
      maxDurationSec: 90,
    });
    const sizeIndex = args.indexOf("--max-filesize");
    expect(args[sizeIndex + 1]).toBe(String(5 * 1024 * 1024));
    const filterIndex = args.indexOf("--match-filter");
    expect(args[filterIndex + 1]).toBe("duration <= 90");
  });

  it("no incluye opciones que ejecuten comandos", () => {
    const args = buildYtdlpArgs("https://youtu.be/abc", TEMPLATE, { maxBytes: 1024, maxDurationSec: 60 });
    expect(args).not.toContain("--exec");
    expect(args).not.toContain("--external-downloader");
  });

  it("agrega --js-runtimes solo cuando se pide un runtime", () => {
    const without = buildYtdlpArgs("https://youtu.be/abc", TEMPLATE, {
      maxBytes: 1024,
      maxDurationSec: 60,
    });
    expect(without).not.toContain("--js-runtimes");

    const withNode = buildYtdlpArgs("https://youtu.be/abc", TEMPLATE, {
      maxBytes: 1024,
      maxDurationSec: 60,
      jsRuntime: "node",
    });
    const index = withNode.indexOf("--js-runtimes");
    expect(index).toBeGreaterThan(-1);
    expect(withNode[index + 1]).toBe("node");
    // Las opciones van antes de `--`; la URL sigue al final.
    expect(withNode.indexOf("--")).toBeGreaterThan(index);
    expect(withNode.at(-1)).toBe("https://youtu.be/abc");
  });
});

describe("buildFfmpegArgs", () => {
  it("devuelve un array con H.264/AAC y faststart", () => {
    const args = buildFfmpegArgs("/media/abc.src.mp4", "/media/abc.mp4", { maxHeight: 1080 });
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args.join(" ")).not.toContain("shell");
  });

  it("coloca la entrada y la salida en el orden correcto", () => {
    const input = "/media/abc.src.webm";
    const output = "/media/abc.mp4";
    const args = buildFfmpegArgs(input, output, { maxHeight: 720 });
    expect(args.indexOf(input)).toBeGreaterThan(-1);
    expect(args.at(-1)).toBe(output);
  });

  it("aplica la resolución máxima configurable", () => {
    const args = buildFfmpegArgs("/a", "/b", { maxHeight: 720 });
    const scaleIndex = args.indexOf("-vf");
    expect(args[scaleIndex + 1]).toContain("720");
  });
});

describe("buildFfprobeArgs", () => {
  it("pide streams y formato en JSON, con la entrada al final", () => {
    const args = buildFfprobeArgs("/tmp/archivo.bin");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("-show_streams");
    expect(args).toContain("-show_format");
    expect(args.join(" ")).toContain("json");
    expect(args.at(-1)).toBe("/tmp/archivo.bin");
  });
});

describe("buildAudioFfmpegArgs", () => {
  it("convierte a AAC sin video y con faststart", () => {
    const args = buildAudioFfmpegArgs("/tmp/cancion.bin", "/media/abc.m4a");
    expect(args).toContain("-vn");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("/media/abc.m4a");
    expect(args.join(" ")).not.toContain("libx264");
  });
});