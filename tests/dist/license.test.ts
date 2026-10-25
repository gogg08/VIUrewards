/**
 * Licencia propia, avisos de terceros y verificación GPG del release de Node
 * (Etapa 3D).
 *
 * Todo lo de acá es **estático o simulado**: no descarga nada, no invoca `gpg`
 * de verdad y no toca el ZIP. La verificación real contra el keyring oficial es
 * un paso de mantenimiento manual (`docs/node-release-verification.md`).
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FFMPEG_ASSET,
  FFMPEG_VERSION,
  MANAGED_TOOLS,
  NODE_ASSET,
  NODE_RELEASE_KEYS,
  PROJECT_LICENSE,
  managedTool,
} from "../../scripts/dist/config.ts";
import type { ProcessResult, RunProcess } from "../../src/media/run-process.ts";
import { verifyNodeRelease } from "../../scripts/dist/verify-node-release.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// -----------------------------------------------------------------------------
// Licencia propia
// -----------------------------------------------------------------------------

describe("licencia de VIUrewards (0BSD)", () => {
  const licensePath = join(REPO_ROOT, PROJECT_LICENSE.file);
  const text = readFileSync(licensePath, "utf8");

  it("existe en la raíz del repositorio y declara SPDX 0BSD", () => {
    expect(existsSync(licensePath)).toBe(true);
    expect(PROJECT_LICENSE.spdx).toBe("0BSD");
    expect(text).toContain("SPDX-License-Identifier: 0BSD");
  });

  it("contiene el texto oficial de la BSD Zero Clause License", () => {
    // Fragmentos exactos e insustituibles del texto de 0BSD.
    expect(text).toContain("BSD Zero Clause License");
    expect(text).toContain("Permission to use, copy, modify, and/or distribute this software for any");
    expect(text).toContain("THE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES");
    expect(text).toContain("PERFORMANCE OF THIS SOFTWARE.");
    expect(text).toContain("WHATSOEVER RESULTING FROM");
  });

  it("no exige publicar los derivados como código abierto (es 0BSD, no GPL)", () => {
    // 0BSD no contiene la cláusula de código fuente de la GPL v3.
    expect(text).not.toMatch(/GNU GENERAL PUBLIC LICENSE/i);
    expect(text).not.toMatch(/must cause it to be licensed/i);
  });

  it("aclara que cubre SOLO el código propio y no sustituye licencias de terceros", () => {
    expect(PROJECT_LICENSE.coversProjectCodeOnly).toBe(true);
    // Los cuatro grupos de terceros que el paquete usa o descarga.
    for (const thirdParty of ["npm", "SQLite", "Node.js", "yt-dlp", "FFmpeg"]) {
      expect(text).toContain(thirdParty);
    }
    expect(text).toMatch(/does NOT cover|does NOT replace/);
  });

  it("no inventa un titular corporativo: usa la forma neutra de contribuyentes", () => {
    expect(text).toContain("Copyright (c) 2026 The VIUrewards contributors");
  });
});

// -----------------------------------------------------------------------------
// Avisos de terceros
// -----------------------------------------------------------------------------

describe("avisos de terceros", () => {
  it("cada herramienta administrada declara proveedor, página y licencia", () => {
    for (const tool of MANAGED_TOOLS) {
      expect(tool.provenance.vendor.length).toBeGreaterThan(0);
      expect(tool.provenance.vendorPage).toMatch(/^https:\/\//);
      expect(tool.provenance.license.length).toBeGreaterThan(0);
      expect(tool.provenance.verified.length).toBeGreaterThan(0);
    }
  });

  it("el proveedor de FFmpeg NO se presenta como el upstream de FFmpeg", () => {
    const { provenance } = managedTool("ffmpeg");
    expect(provenance.vendor).toContain("gyan.dev");
    expect(provenance.vendor).toMatch(/NO el upstream de FFmpeg/);
    expect(provenance.vendorPage).toContain("gyan.dev");
  });

  it("el aviso de FFmpeg coincide con el artefacto fijado en config.ts", () => {
    const ffmpeg = managedTool("ffmpeg");
    // Los datos que el aviso del paquete copia salen de acá: si se cambia el pin
    // sin tocar el aviso, esta comprobación lo detecta.
    expect(ffmpeg.version).toBe(FFMPEG_VERSION);
    expect(ffmpeg.asset.sha256).toBe(FFMPEG_ASSET.sha256);
    expect(ffmpeg.asset.url).toBe(FFMPEG_ASSET.url);
    expect(ffmpeg.asset.file).toBe("ffmpeg-9.0.2-essentials_build.zip");
    expect(ffmpeg.provenance.license).toContain("GPLv3");
  });

  it("la fuente del código de FFmpeg cita el commit leído del README del ZIP", () => {
    const { provenance } = managedTool("ffmpeg");
    // Verificado leyendo `README.txt` del ZIP fijado; no es un enlace inventado.
    expect(provenance.sourceCode).toBe("https://github.com/FFmpeg/FFmpeg/commit/946fcce07b");
  });

  it("no afirma que descargar FFmpeg elimine las obligaciones de la GPLv3", () => {
    const { licenseNote } = managedTool("ffmpeg");
    expect(licenseNote).toMatch(/NO es una firma digital/);
    expect(licenseNote).toMatch(/no elimina por sí solo las obligaciones/);
  });

  it("el hash fijado no se presenta como firma en ninguna herramienta", () => {
    for (const tool of MANAGED_TOOLS) {
      expect(tool.licenseNote).not.toMatch(/firma verificada|procedencia autenticada|hash certifica/i);
    }
  });

  it("Node cita su origen oficial y la firma GPG como paso de mantenimiento", () => {
    const { provenance } = managedTool("node");
    expect(provenance.vendor).toContain("Node.js");
    expect(provenance.vendorPage).toContain("nodejs.org/dist");
    expect(provenance.sourceCode).toContain("github.com/nodejs/node");
    expect(provenance.verified).toMatch(/SHASUMS256\.txt\.sig/);
  });

  it("yt-dlp conserva el dashboard como actualizador", () => {
    expect(managedTool("yt-dlp").updatedBy).toBe("dashboard");
  });
});

// -----------------------------------------------------------------------------
// Verificación GPG del release de Node (mantenimiento)
// -----------------------------------------------------------------------------

describe("verificación del release de Node", () => {
  /** Construye un `run` simulado con respuestas por comando. */
  function fakeRun(responses: {
    shasums: string;
    gpgStatus: string;
    gpgCode?: number;
    curlFile?: (target: string) => void;
  }): { run: RunProcess; calls: string[] } {
    const calls: string[] = [];
    const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    const run: RunProcess = async (command, args, options) => {
      calls.push([command, ...args].join(" "));
      if (command === "git" && args[0] === "--version") return ok("git version 2.45.0");
      if (command === "git" && args[0] === "clone") return ok();
      if (command === "gpg" && args[0] === "--version") return ok("gpg (GnuPG) 2.4.9");
      if (command === "gpg" && args.includes("--verify")) {
        return { code: responses.gpgCode ?? 0, stdout: responses.gpgStatus, stderr: "", timedOut: false };
      }
      if (command === "curl") {
        const target = args[args.indexOf("--output") + 1] ?? "";
        responses.curlFile?.(target);
        if (target.endsWith(".sig")) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(target, "firma-binaria");
        } else {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(target, responses.shasums);
        }
        void options;
        return ok();
      }
      return ok();
    };
    return { run, calls };
  }

  /** Argumentos comunes: keyring temporal ya "instalado". */
  async function withKeysDir<T>(body: (keysDir: string, workDir: string) => Promise<T>): Promise<T> {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "viu-node-verify-test-"));
    const keysDir = join(root, "release-keys");
    const workDir = join(root, "work");
    mkdirSync(join(keysDir, "gpg"), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    try {
      return await body(keysDir, workDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const AUTHORIZED = NODE_RELEASE_KEYS.fingerprints[0]!;
  const signedManifest = `${NODE_ASSET.sha256}  ${NODE_ASSET.file}\n`;

  it("acepta una firma buena de una clave autorizada con el hash fijado", async () => {
    await withKeysDir(async (keysDir, workDir) => {
      const { run } = fakeRun({
        shasums: signedManifest,
        gpgStatus: `[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG DEADBEEF Antoine du Hamel <a@b.c>\n[GNUPG:] VALIDSIG ${AUTHORIZED} 2026-10-01\n`,
      });
      const result = await verifyNodeRelease({ run, keysDir, workDir, log: () => {} });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.fingerprint).toBe(AUTHORIZED);
    });
  });

  it("rechaza una firma inválida (BADSIG) sin mirar el hash", async () => {
    await withKeysDir(async (keysDir, workDir) => {
      const { run } = fakeRun({
        shasums: signedManifest,
        gpgStatus: `[GNUPG:] BADSIG ${AUTHORIZED} Antoine du Hamel <a@b.c>\n`,
        gpgCode: 1,
      });
      const result = await verifyNodeRelease({ run, keysDir, workDir, log: () => {} });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("bad-signature");
    });
  });

  it("rechaza una firma buena de una clave NO autorizada", async () => {
    await withKeysDir(async (keysDir, workDir) => {
      const impostor = "0".repeat(40);
      const { run } = fakeRun({
        shasums: signedManifest,
        gpgStatus: `[GNUPG:] GOODSIG CAFE Otra Clave <x@y.z>\n[GNUPG:] VALIDSIG ${impostor} 2026-10-01\n`,
      });
      const result = await verifyNodeRelease({ run, keysDir, workDir, log: () => {} });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unauthorized-key");
    });
  });

  it("falla si el hash del manifiesto firmado no coincide con config.ts", async () => {
    await withKeysDir(async (keysDir, workDir) => {
      const otro = "a".repeat(64);
      const { run } = fakeRun({
        shasums: `${otro}  ${NODE_ASSET.file}\n`,
        gpgStatus: `[GNUPG:] GOODSIG DEADBEEF Antoine du Hamel <a@b.c>\n[GNUPG:] VALIDSIG ${AUTHORIZED} 2026-10-01\n`,
      });
      const result = await verifyNodeRelease({ run, keysDir, workDir, log: () => {} });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("hash-mismatch");
        // No se cambia el pin silenciosamente: el mensaje muestra ambos valores.
        expect(result.detail).toContain(NODE_ASSET.sha256);
        expect(result.detail).toContain(otro);
      }
    });
  });

  it("informa falta de `gpg` en vez de dar la verificación por buena", async () => {
    const run: RunProcess = async (command) => ({
      code: command === "gpg" ? 127 : 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    const result = await verifyNodeRelease({ run, keysDir: "/no/existe", log: () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("gpg-missing");
  });
});
