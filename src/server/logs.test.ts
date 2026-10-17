/**
 * Tests del log del servidor y del visor/resumen de soporte (Etapa 5, Parte C).
 *
 * Usan archivos temporales; nunca tocan logs ni datos reales.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSupportSummary,
  createFileLogger,
  lineMatchesLevel,
  readLogTail,
  readLogsForViewer,
  redactSecrets,
} from "./logs.ts";

const temps: string[] = [];

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "viu-logs-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createFileLogger", () => {
  it("escribe líneas con fecha, nivel y mensaje", () => {
    const path = join(makeTemp(), "server.log");
    const logger = createFileLogger({ path, now: () => new Date("2024-01-01T00:00:00.000Z") });
    logger.info("hola");
    logger.warn("ojo");
    logger.error("boom");
    logger.close();
    const content = readFileSync(path, "utf8");
    expect(content).toContain("2024-01-01T00:00:00.000Z [info] hola");
    expect(content).toContain("[warn] ojo");
    expect(content).toContain("[error] boom");
  });

  it("rota el archivo cuando supera el tamaño máximo", () => {
    const dir = makeTemp();
    const path = join(dir, "server.log");
    writeFileSync(path, "vieja línea\n");
    const logger = createFileLogger({ path, maxBytes: 1, now: () => new Date("2024-01-01T00:00:00.000Z") });
    logger.info("nueva");
    logger.close();
    // Rotó: existe el archivo `.1` con lo viejo y el archivo nuevo con lo nuevo.
    expect(readFileSync(path, "utf8")).toContain("nueva");
    expect(readFileSync(`${path}.1`, "utf8")).toContain("vieja línea");
  });

  it("un path inválido no lanza y el logger queda inerte", () => {
    const dir = makeTemp();
    // Un directorio no se puede abrir como archivo de log.
    const logger = createFileLogger({ path: dir });
    expect(() => logger.info("nada")).not.toThrow();
    logger.close();
  });
});

describe("readLogTail", () => {
  it("devuelve las últimas N líneas", () => {
    const path = join(makeTemp(), "server.log");
    const logger = createFileLogger({ path, now: () => new Date("2024-01-01T00:00:00.000Z") });
    for (let i = 1; i <= 10; i += 1) logger.info(`línea ${i}`);
    logger.close();
    const tail = readLogTail(path, { limit: 3 });
    expect(tail).toHaveLength(3);
    expect(tail[2]).toContain("línea 10");
    expect(tail[0]).toContain("línea 8");
  });

  it("filtra por nivel", () => {
    const path = join(makeTemp(), "server.log");
    const logger = createFileLogger({ path, now: () => new Date("2024-01-01T00:00:00.000Z") });
    logger.info("info-1");
    logger.error("error-1");
    logger.info("info-2");
    logger.close();
    const errors = readLogTail(path, { level: "error" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error-1");
  });

  it("lee solo el final: descarta la parte cortada en medio de una línea", () => {
    const path = join(makeTemp(), "server.log");
    const logger = createFileLogger({ path, now: () => new Date("2024-01-01T00:00:00.000Z") });
    for (let i = 1; i <= 200; i += 1) logger.info(`mensaje número ${i} con relleno`);
    logger.close();
    // Leemos un límite de bytes pequeño: no debe devolver una línea parcial al inicio.
    const tail = readLogTail(path, { limit: 100, maxBytes: 200 });
    expect(tail.length).toBeGreaterThan(0);
    for (const line of tail) expect(line.startsWith("20")).toBe(true);
    expect(tail[tail.length - 1]).toContain("200");
  });

  it("un archivo inexistente devuelve lista vacía", () => {
    expect(readLogTail(join(makeTemp(), "nope.log"))).toEqual([]);
  });

  it("lineMatchesLevel reconoce el nivel en el formato", () => {
    expect(lineMatchesLevel("2024 [warn] ojo", "warn")).toBe(true);
    expect(lineMatchesLevel("2024 [info] hola", "warn")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("redacta valores secretos conocidos", () => {
    const line = "usando clave ABCDEF123456 y token SECRETOKEY";
    const out = redactSecrets(line, { secrets: ["ABCDEF123456", "SECRETOKEY"] });
    expect(out).not.toContain("ABCDEF123456");
    expect(out).not.toContain("SECRETOKEY");
    expect(out).toContain("***");
  });

  it("redacta patrones clave=valor y token=valor", () => {
    const out = redactSecrets("GET /overlay?key=SUPERSECRETO123&token=OTROMAS456 ok");
    expect(out).not.toContain("SUPERSECRETO123");
    expect(out).not.toContain("OTROMAS456");
    expect(out).toContain("key=***");
  });

  it("ignora valores cortos (evita redactar ruido) y no toca texto normal", () => {
    const out = redactSecrets("puerto=8787 ok", { secrets: ["ab"] });
    expect(out).toContain("puerto=8787");
    expect(out).toContain("ok");
  });

  it("el orden no deja fragmentos cuando un secreto contiene a otro", () => {
    const out = redactSecrets("valor abcdefghi fin", { secrets: ["abc", "abcdefghi"] });
    expect(out).not.toContain("abcdefghi");
    expect(out).not.toContain("defghi");
  });
});

describe("readLogsForViewer", () => {
  it("redacta las líneas antes de devolverlas", () => {
    const path = join(makeTemp(), "server.log");
    writeFileSync(path, "2024 [info] usando key=FILTRADO123456\n");
    const result = readLogsForViewer(path, { limit: 10 }, ["FILTRADO123456"]);
    expect(result.available).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).not.toContain("FILTRADO123456");
    expect(result.lines[0]).toContain("***");
  });
});

describe("buildSupportSummary", () => {
  it("incluye los datos útiles y nunca un secreto", () => {
    const summary = buildSupportSummary(
      {
        appVersion: "1.2.3",
        overlayVersion: "abc123",
        tools: { ytDlp: "2024.08.06", ffmpeg: "ffmpeg version 6.1", ffprobe: null },
        platform: "Kick (conectada)",
        os: "Windows 11",
        port: 8787,
        overlayConnected: true,
        overlayClients: 1,
        recentErrors: ["2024 [error] falló con key=SECRETACO456789"],
      },
      ["SECRETACO456789"],
    );
    expect(summary).toContain("VIUrewards 1.2.3");
    expect(summary).toContain("Windows 11");
    expect(summary).toContain("yt-dlp: 2024.08.06");
    expect(summary).toContain("ffprobe: no detectada");
    expect(summary).toContain("Puerto: 8787");
    expect(summary).not.toContain("SECRETACO456789");
    expect(summary).toContain("***");
  });

  it("sin errores recientes lo dice explícitamente", () => {
    const summary = buildSupportSummary(
      {
        appVersion: "1.0.0",
        overlayVersion: "x",
        tools: { ytDlp: null, ffmpeg: null, ffprobe: null },
        platform: "Kick (sin conectar)",
        os: "linux",
        port: 8787,
        overlayConnected: false,
        overlayClients: 0,
        recentErrors: [],
      },
      [],
    );
    expect(summary).toContain("(sin errores recientes)");
  });
});
