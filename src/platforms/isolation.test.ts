/**
 * Test estático de aislamiento de plataformas (Fase 4B).
 *
 * AGENTS.md: "Ningún código fuera de /src/platforms/<nombre>/ puede importar
 * tipos o nombres específicos de una plataforma". El único archivo autorizado a
 * importar un adaptador concreto es el registro `src/platforms/index.ts`.
 *
 * Se recorre el fuente (sin ejecutarlo): se falla si algún archivo fuera de
 * `src/platforms/kick/` importa desde ahí o menciona identificadores propios de
 * la API de Kick. Se excluyen los `*.test.ts` para que este mismo test no se
 * detecte a sí mismo (sus patrones viven en el código del test).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Carpetas que no se revisan (dependencias, artefactos, la propia plataforma). */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "media", "docs", "scripts"]);

/** Único archivo autorizado a importar del adaptador concreto. */
const REGISTRY = join("src", "platforms", "index.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function isExempt(relPath: string): boolean {
  const normalized = relPath.split("\\").join("/");
  return (
    normalized.startsWith("src/platforms/kick/") ||
    normalized === "src/platforms/index.ts" ||
    normalized.endsWith(".test.ts")
  );
}

// Imports hacia el adaptador de Kick concreto.
const KICK_IMPORT = /from\s+["'][^"']*(?:\/|^)kick(?:\/|["'])/;

// Identificadores propios de la API/implementación de Kick.
// No se incluye "kick.com" (es un dominio de la whitelist de media, agnóstico)
// ni columnas genéricas del esquema (`user_input`, `redeemer`), que la app usa
// para cualquier plataforma.
const KICK_IDENTIFIERS = [
  /\bKickApi\b/,
  /\bKickApiError\b/,
  /\bKickOAuth\b/,
  /\bKickEventSource\b/,
  /\bKickIntegration\b/,
  /\bcreateKickIntegration\b/,
  /\bKICK_[A-Z0-9_]+\b/,
  /\bChannelReward\b/,
  /\bChannelRewardInput\b/,
  /\bRedemptionFailure\b/,
  /\bRedemptionsPage\b/,
  /\/public\/v1\/channels\/rewards/,
];

describe("aislamiento de plataformas en el fuente", () => {
  it("ningún archivo fuera del adaptador importa de src/platforms/kick/", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (isExempt(rel)) continue;
      if (KICK_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("ningún archivo fuera del adaptador usa identificadores de la API de Kick", () => {
    const offenders: Array<{ file: string; match: string }> = [];
    // Se revisa el código fuente (src) y las páginas del dashboard/overlay.
    const files = [
      ...walk(join(ROOT, "src")),
      ...walk(join(ROOT, "web")).filter((f) => /\.(js|html|css)$/.test(f)),
      ...walk(join(ROOT, "overlay")).filter((f) => /\.(js|html|css)$/.test(f)),
    ];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (isExempt(rel)) continue;
      const source = readFileSync(file, "utf8");
      for (const pattern of KICK_IDENTIFIERS) {
        const match = source.match(pattern);
        if (match) offenders.push({ file: rel, match: match[0] });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("el registro es el único archivo que importa del adaptador", () => {
    const registry = readFileSync(join(ROOT, REGISTRY), "utf8");
    expect(KICK_IMPORT.test(registry)).toBe(true);
  });
});