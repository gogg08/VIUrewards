/**
 * Configuración del paquete (Etapa 2C): reglas que el build debe sostener.
 *
 * Son pruebas **estáticas** de `scripts/dist/config.ts` y de las funciones
 * puras de `scripts/dist/fs-utils.ts`: no construyen el paquete, no descargan
 * nada y no tocan ningún directorio del usuario. Lo que sí se ejecuta de verdad
 * (extraer el ZIP, correr el smoke) vive en `tests/dist/package.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  FORBIDDEN_EXECUTABLES,
  FORBIDDEN_PATH_SEGMENTS,
  FORBIDDEN_TOP_LEVEL,
  MANAGED_TOOLS,
  NODE_ABI,
  NODE_ASSET,
  NODE_MODULES_PRUNE,
  NODE_VERSION,
  PACKAGE_CONTRACT_VERSION,
  managedTool,
} from "../../scripts/dist/config.ts";
import { expectedInstallerText, INSTALLER_FILE } from "../../scripts/dist/build-installer.ts";
import { findForbiddenPaths } from "../../scripts/dist/fs-utils.ts";

describe("herramientas administradas", () => {
  it("tres herramientas, cada una con URL versionada y SHA-256", () => {
    expect(MANAGED_TOOLS.map((tool) => tool.id)).toEqual(["node", "yt-dlp", "ffmpeg"]);
    for (const tool of MANAGED_TOOLS) {
      expect(tool.asset.url).toMatch(/^https:\/\//);
      expect(tool.asset.url).not.toMatch(/latest/i);
      expect(tool.asset.url).toContain(tool.version);
      expect(tool.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tool.asset.checksumSource).toMatch(/^https:\/\//);
      expect(tool.install.length).toBeGreaterThan(0);
    }
  });

  it("ningún hash se repite (dos artefactos iguales serían un error de config)", () => {
    const hashes = MANAGED_TOOLS.map((tool) => tool.asset.sha256);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("yt-dlp nunca se sobrescribe: el dashboard es su actualizador", () => {
    const ytdlp = managedTool("yt-dlp");
    expect(ytdlp.policy).toBe("if-missing");
    expect(ytdlp.updatedBy).toBe("dashboard");
  });

  it("Node es del instalador y se alinea con el manifiesto", () => {
    const node = managedTool("node");
    expect(node.policy).toBe("match-manifest");
    expect(node.updatedBy).toBe("installer");
    expect(node.version).toBe(NODE_VERSION);
    expect(node.install).toEqual([{ from: `node-v${NODE_VERSION}-win-x64/node.exe`, to: "runtime/node.exe" }]);
    // El runtime vive en `runtime/`, separado de las herramientas (`bin/`).
    expect(node.install[0]!.to.startsWith("runtime/")).toBe(true);
  });

  it("FFmpeg es un proveedor externo, con avisos junto a los binarios", () => {
    const ffmpeg = managedTool("ffmpeg");
    expect(ffmpeg.asset.url).toContain("gyan.dev");
    // Los binarios van a `bin/` del directorio de datos, nunca a `app/`.
    expect(ffmpeg.install.map((item) => item.to)).toEqual(["bin/ffmpeg.exe", "bin/ffprobe.exe"]);
    expect(ffmpeg.notices.map((item) => item.to)).toEqual([
      "bin/ffmpeg-LICENSE.txt",
      "bin/ffmpeg-PROCEDENCIA.txt",
    ]);
    expect(ffmpeg.policy).toBe("if-missing");
  });

  it("ninguna herramienta instala dentro de app/ ni sale del directorio de datos", () => {
    for (const tool of MANAGED_TOOLS) {
      for (const target of [...tool.install, ...tool.notices]) {
        expect(target.to.startsWith("app/")).toBe(false);
        expect(target.to).not.toMatch(/^[\\/]/);
        expect(target.to).not.toContain("..");
      }
    }
  });

  it("una herramienta desconocida falla con un error claro", () => {
    expect(() => managedTool("ffprobe" as never)).toThrow(/desconocida/);
  });

  it("el contrato del manifiesto y el ABI están declarados", () => {
    expect(PACKAGE_CONTRACT_VERSION).toBeGreaterThan(0);
    expect(NODE_ABI).toMatch(/^\d+$/);
    expect(NODE_ASSET.file).toBe(`node-v${NODE_VERSION}-win-x64.zip`);
    expect(NODE_ASSET.url).toBe(`https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ASSET.file}`);
  });
});

describe("exclusiones del paquete", () => {
  it("los ejecutables externos están prohibidos por nombre", () => {
    expect([...FORBIDDEN_EXECUTABLES].sort()).toEqual(["ffmpeg.exe", "ffprobe.exe", "node.exe", "yt-dlp.exe"]);
  });

  it("el contenido de un paquete correcto no dispara violaciones", () => {
    expect(
      findForbiddenPaths(
        ["app/scripts/start.ts", "licenses/better-sqlite3.txt", "manifest.json", "SHA256SUMS.txt"],
        FORBIDDEN_PATH_SEGMENTS,
        FORBIDDEN_TOP_LEVEL,
      ),
    ).toEqual([]);
  });

  it("detecta secretos y ejecutables en la raíz si se colaran", () => {
    const violations = findForbiddenPaths(
      ["app/.env", "app/scripts/.viurewards.lock", "runtime/node.exe", "bin/ffmpeg.exe", "seed-tools/bin/yt-dlp.exe"],
      FORBIDDEN_PATH_SEGMENTS,
      FORBIDDEN_TOP_LEVEL,
    );
    expect(violations.sort()).toEqual([
      "app/.env",
      "app/scripts/.viurewards.lock",
      "bin/ffmpeg.exe",
      "runtime/node.exe",
      "seed-tools/bin/yt-dlp.exe",
    ]);
  });

  it("también detecta el prefijo de `.env` con sufijo", () => {
    expect(
      findForbiddenPaths(["app/.env.local"], FORBIDDEN_PATH_SEGMENTS, FORBIDDEN_TOP_LEVEL),
    ).toEqual(["app/.env.local"]);
  });
});

describe("poda de node_modules", () => {
  it("se eliminan los prebuilds de otras plataformas pero NUNCA el de Windows x64", () => {
    const prebuilds = NODE_MODULES_PRUNE.filter((entry) => entry.startsWith("better-sqlite3/prebuilds/"));
    expect(prebuilds.length).toBeGreaterThan(0);
    expect(prebuilds.every((entry) => !entry.endsWith("win32-x64.node"))).toBe(true);
  });

  it("solo se podan binarios nativos de OTRAS plataformas, nunca código JS", () => {
    for (const entry of NODE_MODULES_PRUNE) {
      expect(entry).not.toMatch(/\.(js|mjs|cjs|json)$/);
    }
    // Los `.node` podados son exclusivamente prebuilds de otras plataformas.
    for (const entry of NODE_MODULES_PRUNE.filter((candidate) => candidate.endsWith(".node"))) {
      expect(entry.startsWith("better-sqlite3/prebuilds/")).toBe(true);
      expect(entry).not.toContain("win32-x64");
    }
    // Rutas donde vive código que los `exports` de un paquete pueden cargar.
    for (const risky of ["glob/dist/esm", "ajv/dist", "fastify/lib"]) {
      expect(NODE_MODULES_PRUNE).not.toContain(risky);
    }
  });

  it("no hay entradas repetidas ni rutas absolutas", () => {
    expect(new Set(NODE_MODULES_PRUNE).size).toBe(NODE_MODULES_PRUNE.length);
    for (const entry of NODE_MODULES_PRUNE) {
      expect(entry).not.toMatch(/^([A-Za-z]:|[\\/])/);
      expect(entry).not.toContain("..");
      expect(entry).not.toContain("node_modules/");
    }
  });
});

/**
 * Los `.mjs` de `scripts/dist/` se copian al paquete tal cual y los ejecuta
 * Node sin transpilar. Ninguna otra suite los carga (el único que los corre es
 * el smoke del paquete), así que una sintaxis de TypeScript se descubría recién
 * al empaquetar. Esta comprobación es estática y barata: `node --check`.
 */
describe("scripts .mjs del paquete", () => {
  const distScripts = join(import.meta.dirname, "..", "..", "scripts", "dist");
  for (const name of ["smoke.mjs", "shutdown-harness.mjs"]) {
    it(`${name} es JavaScript válido para Node`, () => {
      const result = spawnSync(process.execPath, ["--check", join(distScripts, name)], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
    });
  }
});

/**
 * Instalador de herramientas (`scripts/dist/install-tools.ps1`).
 *
 * Son comprobaciones **estáticas**: el archivo parsea en Windows PowerShell 5.1,
 * es ASCII puro (5.1 mal-decodifica UTF-8 sin BOM) y su tabla `$Tools` coincide
 * con `config.ts`. La ejecución real (descarga, hash, extracción, políticas) la
 * ejercita `tests/dist/installer.test.ts` con los archivos YA verificados de
 * `build/downloads/`.
 */
describe("instalador de herramientas", () => {
  const distDir = join(import.meta.dirname, "..", "..", "scripts", "dist");
  const installerPath = join(distDir, INSTALLER_FILE);
  const source = readFileSync(installerPath, "utf8");

  it("el bloque generado está al día con config.ts", () => {
    // Si no, alguien cambió una versión en `config.ts` sin regenerar el `.ps1`:
    // el instalador descargaría un artefacto y verificaría otro hash.
    expect(expectedInstallerText(source)).toBe(source);
  });

  it("no tiene caracteres fuera de ASCII (PowerShell 5.1 los mal-decodifica)", () => {
    const offending = [...source]
      .map((char, index) => ({ char, index }))
      .filter((entry) => entry.char.charCodeAt(0) > 127)
      .slice(0, 5)
      .map((entry) => `char ${entry.char.charCodeAt(0)} en el offset ${entry.index}`);
    expect(offending).toEqual([]);
  });

  it("no usa escapes `u{XXXX} (PowerShell 5.1 no los interpreta)", () => {
    expect(source).not.toMatch(/`u\{[0-9A-Fa-f]+\}/);
  });

  it("no llama a `ZipFileExtensions` (no es accesible por nombre en 5.1)", () => {
    expect(source).not.toContain("ZipFileExtensions]::");
  });

  it("usa CRLF en todo el archivo (terminadores mezclados rompen el parseo)", () => {
    const bareLf = (source.match(/(?<!\r)\n/g) ?? []).length;
    expect(bareLf).toBe(0);
  });

  it("parsea en Windows PowerShell 5.1 sin errores", () => {
    if (process.platform !== "win32") return;
    const script = [
      "$errors = $null; $tokens = $null;",
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${installerPath}', [ref]$tokens, [ref]$errors);`,
      'if ($errors.Count -eq 0) { Write-Output "ok" } else { $errors | ForEach-Object { Write-Output ($_.Extent.StartLineNumber.ToString() + ": " + $_.Message) }; exit 1 }',
    ].join(" ");
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.stdout.trim(), result.stderr).toBe("ok");
    expect(result.status).toBe(0);
  });

  it("el build:installer --check no detecta diferencias", () => {
    const result = spawnSync(process.execPath, [join(distDir, "build-installer.ts"), "--check"], {
      cwd: join(import.meta.dirname, "..", ".."),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("declara las tres herramientas con su política y sus destinos", () => {
    for (const tool of MANAGED_TOOLS) {
      expect(source).toContain(`id = '${tool.id}'`);
      expect(source).toContain(`sha256 = '${tool.asset.sha256}'`);
      expect(source).toContain(`policy = '${tool.policy}'`);
      for (const target of [...tool.install, ...tool.notices]) {
        expect(source).toContain(`to = '${target.to}'`);
      }
    }
  });

  it("protege contra escribir dentro de la aplicación, no solo en su raíz", () => {
    // El guard compara la raíz de la app contra el destino con una ruta
    // ABSOLUTA y sin límite de profundidad: `-DataDir <app>\media` se rechaza
    // igual que `<app>`.
    expect(source).toContain("data-dir-is-application");
    expect(source).toContain("Test-PathInside");
    // La raíz ya no se busca subiendo niveles (el tope era el defecto).
    expect(source).not.toContain("$ApplicationRootLookupDepth");
    expect(source).not.toMatch(/GetDirectoryName\(\$ancestor\)/);
    // Una raíz de unidad es inválida explícitamente (antes caía como «error").
    expect(source).toContain("data-dir-is-drive-root");
  });

  it("la raíz protegida se deduce de $PSScriptRoot y admite el override de tests", () => {
    // Fuentes: <repo>/scripts/dist -> <repo>. Paquete: <app>/scripts/dist -> <app>.
    expect(source).toContain("$PSScriptRoot");
    expect(source).toMatch(/\[string\]\$ApplicationRoot = ""/);
  });

  it("no usa una variable local que colisione con el parámetro $ApplicationRoot", () => {
    // PowerShell NO distingue mayúsculas entre variables: `$applicationRoot` y
    // el parámetro `$ApplicationRoot` son LA MISMA variable, así que
    // inicializarla a `$null` borraba el parámetro y el guard solo podía
    // rechazar la raíz deducida (regresión real: instalaba dentro de la app).
    const withoutComments = source
      .replace(/<#[\s\S]*?#>/g, "")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(withoutComments).not.toMatch(/\$applicationRoot\b/);
  });
});
