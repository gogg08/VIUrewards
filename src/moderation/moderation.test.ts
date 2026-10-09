/**
 * Tests de la cola de moderación (Fase 4A).
 *
 * Cubren validación y límites, deduplicación, el flujo aprobar/rechazar con la
 * llamada a `resolve`, secuencias de transiciones y que el input hostil nunca
 * llegue a un proceso (startDownload no se llama si la URL no es válida).
 */

import { describe, expect, it } from "vitest";

import { openMemoryDatabase, type SqliteDatabase } from "../db/database.ts";
import { ModerationService, extractUrlCandidate, type ModerationLimits } from "./index.ts";
import { canTransition } from "./state.ts";
import type { ProposalRecord } from "../db/proposals.ts";

interface Harness {
  db: SqliteDatabase;
  service: ModerationService;
  downloads: ProposalRecord[];
  ready: Array<{ proposalId: string; clipId: string }>;
}

function makeService(
  limits: Partial<ModerationLimits> = {},
  overrides: {
    validate?: (raw: string) => { ok: true; url: string } | { ok: false; reason: string };
  } = {},
): Harness {
  const db = openMemoryDatabase();
  const downloads: ProposalRecord[] = [];
  const ready: Array<{ proposalId: string; clipId: string }> = [];
  const service = new ModerationService({
    db,
    limits: () => ({
      maxPendingGlobal: limits.maxPendingGlobal ?? 25,
      maxPendingPerUser: limits.maxPendingPerUser ?? 3,
    }),
    startDownload: (proposal) => downloads.push(proposal),
    onReady: (proposal, clipId) => ready.push({ proposalId: proposal.id, clipId }),
    validate: overrides.validate,
  });
  return { db, service, downloads, ready };
}

const USER = { platform: "simulated", userId: "u1", userName: "Ana", eventId: "evt-1" };
const VALID_URL = "https://www.youtube.com/watch?v=abc12345678";

describe("extractUrlCandidate", () => {
  it("toma la primera URL del texto", () => {
    expect(extractUrlCandidate("!alerta https://youtu.be/abc mirá esto")).toBe("https://youtu.be/abc");
  });

  it("acepta el texto entero si es una URL", () => {
    expect(extractUrlCandidate("https://www.youtube.com/watch?v=xyz")).toBe("https://www.youtube.com/watch?v=xyz");
  });

  it("devuelve null si no hay URL", () => {
    expect(extractUrlCandidate("hola mundo")).toBeNull();
    expect(extractUrlCandidate("")).toBeNull();
    expect(extractUrlCandidate("   ")).toBeNull();
  });
});

describe("ModerationService.submit", () => {
  it("acepta una URL válida como pendiente", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: false });
    expect(result.status).toBe("pending");
    expect(result.proposal.status).toBe("pending");
    expect(result.proposal.url).toBe(VALID_URL);
    expect(h.downloads).toHaveLength(0);
  });

  it("rechaza texto sin URL", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: "no hay link", autoApprove: false });
    expect(result).toMatchObject({ status: "rejected", reason: "SIN_URL" });
  });

  it("rechaza http, dominios no permitidos y URLs inválidas sin tocar la descarga", () => {
    const h = makeService();
    for (const input of [
      "http://www.youtube.com/watch?v=abc",
      "https://ejemplo-raro.com/video",
      "https://www.youtube.com.evil.com/watch?v=abc",
    ]) {
      const result = h.service.submit({ ...USER, userInput: input, autoApprove: false });
      expect(result.status).toBe("rejected");
    }
    expect(h.downloads).toHaveLength(0);
  });

  it("deduplica la misma URL pendiente", () => {
    const h = makeService();
    h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: false });
    const second = h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: false });
    expect(second).toMatchObject({ status: "rejected", reason: "DUPLICADA" });
  });

  it("aplica el límite global de pendientes", () => {
    const h = makeService({ maxPendingGlobal: 1, maxPendingPerUser: 99 });
    h.service.submit({ ...USER, userInput: "https://www.youtube.com/watch?v=aaaaaaaaaa", autoApprove: false });
    const second = h.service.submit({ ...USER, userInput: "https://www.youtube.com/watch?v=bbbbbbbbbb", autoApprove: false });
    expect(second).toMatchObject({ status: "rejected", reason: "LIMITE_GLOBAL" });
  });

  it("aplica el límite por usuario", () => {
    const h = makeService({ maxPendingGlobal: 99, maxPendingPerUser: 1 });
    h.service.submit({ ...USER, userInput: "https://www.youtube.com/watch?v=aaaaaaaaaa", autoApprove: false });
    const second = h.service.submit({ ...USER, userInput: "https://www.youtube.com/watch?v=bbbbbbbbbb", autoApprove: false });
    expect(second).toMatchObject({ status: "rejected", reason: "LIMITE_USUARIO" });
  });

  it("la aprobación automática sigue pasando por validación", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: "not a url", autoApprove: true });
    expect(result.status).toBe("rejected");
    expect(h.downloads).toHaveLength(0);
  });

  it("la aprobación automática válida arranca la descarga", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: true });
    expect(result.status).toBe("pending");
    expect(result.proposal.status).toBe("downloading");
    expect(h.downloads).toHaveLength(1);
  });
});

describe("ModerationService.approve / reject", () => {
  it("aprobar arranca la descarga sin resolver; 'accept' llega al quedar lista", async () => {
    const h = makeService();
    let resolved: string | null = null;
    const result = h.service.submit({
      ...USER,
      userInput: VALID_URL,
      autoApprove: false,
      resolve: async (outcome) => {
        resolved = outcome;
      },
    });
    const approved = h.service.approve(result.proposal.id);
    await Promise.resolve();
    expect(approved.ok).toBe(true);
    expect(h.downloads).toHaveLength(1);
    expect(resolved).toBeNull();
    h.service.markDownloadResult(result.proposal.id, { ok: true, clipId: "clip-1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe("accept");
  });

  it("rechazar descarta y resuelve 'reject'", async () => {
    const h = makeService();
    let resolved: string | null = null;
    const result = h.service.submit({
      ...USER,
      userInput: VALID_URL,
      autoApprove: false,
      resolve: async (outcome) => {
        resolved = outcome;
      },
    });
    const rejected = h.service.reject(result.proposal.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected.ok).toBe(true);
    expect(rejected.proposal?.status).toBe("rejected");
    expect(resolved).toBe("reject");
    expect(h.downloads).toHaveLength(0);
  });

  it("no se puede aprobar dos veces ni rechazar después de aprobar", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: false });
    expect(h.service.approve(result.proposal.id).ok).toBe(true);
    expect(h.service.approve(result.proposal.id)).toMatchObject({ ok: false, reason: "INVALID_TRANSITION" });
    expect(h.service.reject(result.proposal.id)).toMatchObject({ ok: false, reason: "INVALID_TRANSITION" });
  });
});

describe("ModerationService.markDownloadResult", () => {
  it("marca lista y avisa onReady", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: false });
    h.service.approve(result.proposal.id);
    h.service.markDownloadResult(result.proposal.id, { ok: true, clipId: "clip-1" });
    expect(h.service.get(result.proposal.id)?.status).toBe("ready");
    expect(h.ready).toEqual([{ proposalId: result.proposal.id, clipId: "clip-1" }]);
  });

  it("marca fallida y guarda el motivo", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: false });
    h.service.approve(result.proposal.id);
    h.service.markDownloadResult(result.proposal.id, { ok: false, message: "no se pudo" });
    expect(h.service.get(result.proposal.id)).toMatchObject({ status: "failed", reason: "no se pudo" });
  });

  it("ignora un resultado tardío o duplicado (no rompe)", () => {
    const h = makeService();
    const result = h.service.submit({ ...USER, userInput: VALID_URL, autoApprove: false });
    h.service.approve(result.proposal.id);
    h.service.markDownloadResult(result.proposal.id, { ok: true, clipId: "clip-1" });
    const late = h.service.markDownloadResult(result.proposal.id, { ok: true, clipId: "clip-2" });
    expect(late.ok).toBe(false);
    expect(h.service.get(result.proposal.id)?.status).toBe("ready");
    expect(h.ready).toHaveLength(1);
  });
});

describe("input hostil del público", () => {
  it("el texto sin URL se rechaza y nunca dispara descarga", () => {
    const h = makeService();
    const hostile = [
      "--exec ffmpeg -i x",
      "!alerta --exec sh -c 'rm -rf /'",
      "x".repeat(5000),
      "javascript:alert(1)",
      "file:///etc/passwd",
      "!alerta",
    ];
    for (const userInput of hostile) {
      const result = h.service.submit({ ...USER, userInput, autoApprove: true });
      expect(result.status).toBe("rejected");
    }
    expect(h.downloads).toHaveLength(0);
  });

  it("solo URLs validadas llegan a la descarga, sin arrastrar texto hostil", () => {
    const h = makeService();
    const hostile = [
      "-o /etc/passwd https://www.youtube.com/watch?v=abc12345678",
      "https://www.youtube.com/watch?v=abc12345678\n--exec evil",
      "!alerta https://youtu.be/abc --exec sh",
    ];
    for (const userInput of hostile) {
      h.service.submit({ ...USER, userInput, autoApprove: true });
    }

    expect(h.downloads.length).toBeGreaterThan(0);
    for (const proposal of h.downloads) {
      // La URL que llega al proceso es exactamente una URL https validada.
      expect(proposal.url.startsWith("https://")).toBe(true);
      expect(proposal.url).toMatch(/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//);
      for (const token of ["--exec", "-o ", "file:", "javascript:", "\n", "rm -rf"]) {
        expect(proposal.url).not.toContain(token);
      }
    }
  });
});

describe("transiciones de estado de las propuestas", () => {
  it("solo permite las transiciones definidas", () => {
    expect(canTransition("pending", "approved")).toBe(true);
    expect(canTransition("pending", "rejected")).toBe(true);
    expect(canTransition("pending", "ready")).toBe(false);
    expect(canTransition("approved", "downloading")).toBe(true);
    expect(canTransition("downloading", "ready")).toBe(true);
    expect(canTransition("downloading", "failed")).toBe(true);
    expect(canTransition("ready", "failed")).toBe(false);
    expect(canTransition("rejected", "approved")).toBe(false);
    expect(canTransition("failed", "downloading")).toBe(false);
  });
});