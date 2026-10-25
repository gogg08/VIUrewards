/**
 * Generador del instalador de herramientas (`scripts/dist/install-tools.ps1`).
 *
 * PowerShell no puede importar `scripts/dist/config.ts`, así que las versiones,
 * URLs, hashes, rutas de instalación y políticas se copian como LITERALES en la
 * tabla `$Tools` del `.ps1`. Este script es el único que las escribe: la fuente
 * sigue siendo `config.ts`.
 *
 * Uso:
 *   npm run build:installer            # reescribe el .ps1
 *   npm run build:installer -- --check # solo verifica que esté al día (CI/tests)
 *
 * El archivo generado conserva el encabezado de ayuda y las funciones (que sí se
 * editan a mano); solo se reemplaza el bloque `# BEGIN GENERATED` …
 * `# END GENERATED`, así un cambio de versión no puede quedar a medias entre los
 * dos lugares.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MANAGED_TOOLS, PACKAGE_CONTRACT_VERSION, type ManagedTool } from "./config.ts";

export const INSTALLER_FILE = "install-tools.ps1";

const BEGIN_MARKER = "# BEGIN GENERATED (desde scripts/dist/config.ts; regenerar con npm run build:installer)";
const END_MARKER = "# END GENERATED";

/** Comillas simples de PowerShell: se duplican. */
function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function renderEntries(entries: ManagedTool["install"], indent: string): string[] {
  const lines = [`${indent}@(`];
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1;
    lines.push(
      `${indent}  [ordered]@{ from = ${psString(entry.from)}; to = ${psString(entry.to)} }${last ? "" : ""}`,
    );
  });
  lines.push(`${indent})`);
  return lines;
}

/**
 * Bloque `$Tools` equivalente a `MANAGED_TOOLS`, en el mismo orden.
 *
 * Se generan SOLO los datos del contrato: identificador, versión, archivo, URL,
 * hash, fuente del hash, política, rutas de instalación y avisos. La lógica del
 * instalador (descarga, verificación, extracción, políticas) es código, no se
 * genera.
 */
export function renderToolTable(tools: readonly ManagedTool[]): string {
  const lines: string[] = [`$script:ManifestContractVersion = ${PACKAGE_CONTRACT_VERSION}`, "", "$script:Tools = @("];
  tools.forEach((tool, toolIndex) => {
    lines.push("  [ordered]@{");
    lines.push(`    id = ${psString(tool.id)}`);
    lines.push(`    version = ${psString(tool.version)}`);
    lines.push(`    file = ${psString(tool.asset.file)}`);
    lines.push(`    url = ${psString(tool.asset.url)}`);
    lines.push(`    sha256 = ${psString(tool.asset.sha256)}`);
    lines.push(`    checksumSource = ${psString(tool.asset.checksumSource)}`);
    lines.push(`    policy = ${psString(tool.policy)}`);
    lines.push(...renderEntries(tool.install, "    ").map((line, index) => (index === 0 ? `    install = ${line.trimStart()}` : line)));
    lines.push(...renderEntries(tool.notices, "    ").map((line, index) => (index === 0 ? `    notices = ${line.trimStart()}` : line)));
    if (tool.installedSha256 && Object.keys(tool.installedSha256).length > 0) {
      lines.push("    installedSha256 = [ordered]@{");
      for (const [path, hash] of Object.entries(tool.installedSha256)) {
        lines.push(`      ${psString(path)} = ${psString(hash)}`);
      }
      lines.push("    }");
    }
    lines.push(`  }${toolIndex === tools.length - 1 ? "" : ""}`);
  });
  lines.push(")");
  return lines.join("\n");
}

/**
 * Terminadores de línea de Windows.
 *
 * El `.ps1` se escribe SIEMPRE con CRLF: Windows PowerShell 5.1 mezcla mal los
 * terminadores y un archivo con CRLF y LF entreverado deja de parsear. Como el
 * bloque generado viene de acá, también tiene que llevar CRLF.
 */
export const LINE_ENDING = "\r\n";

/** Normaliza cualquier texto a CRLF (idempotente). */
export function withCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, LINE_ENDING);
}

/** Sustituye el bloque generado. Devuelve el texto nuevo, todo en CRLF. */
export function applyGeneratedBlock(text: string, generated: string): string {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(
      `El instalador no tiene los marcadores del bloque generado (${BEGIN_MARKER} … ${END_MARKER}).`,
    );
  }
  const head = text.slice(0, begin + BEGIN_MARKER.length);
  const tail = text.slice(end);
  return withCrlf(`${head}\n${generated}\n${tail}`);
}

/** Texto esperado del instalador a partir de la plantilla actual. */
export function expectedInstallerText(template: string, tools: readonly ManagedTool[] = MANAGED_TOOLS): string {
  const begin = template.indexOf(BEGIN_MARKER);
  const end = template.indexOf(END_MARKER);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(
      `El instalador no tiene los marcadores del bloque generado (${BEGIN_MARKER} … ${END_MARKER}).`,
    );
  }
  // Se mira la PRIMERA línea del archivo: alcanza para saber si la plantilla
  // usa CRLF (lo normal en Windows) o LF (editor que los normalizó).
  const templateHasCrlf = template.includes("\r\n");
  const spliced = `${template.slice(0, begin + BEGIN_MARKER.length)}\n${renderToolTable(tools)}\n${template.slice(end)}`;
  return templateHasCrlf ? withCrlf(spliced) : spliced;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`;

if (isEntryPoint) {
  const distDir = fileURLToPath(new URL(".", import.meta.url));
  const path = join(distDir, INSTALLER_FILE);
  const current = readFileSync(path, "utf8");
  const expected = expectedInstallerText(current);
  const check = process.argv.slice(2).includes("--check");

  if (expected === current) {
    console.log(`${INSTALLER_FILE}: al día (${MANAGED_TOOLS.length} herramientas).`);
  } else if (check) {
    console.error(
      `${INSTALLER_FILE} no coincide con scripts/dist/config.ts.\n` +
        "Ejecutá `npm run build:installer` y revisá el diff.",
    );
    process.exitCode = 1;
  } else {
    writeFileSync(path, expected, "utf8");
    console.log(`${INSTALLER_FILE}: bloque generado actualizado (${MANAGED_TOOLS.length} herramientas).`);
  }
}
