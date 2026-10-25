/**
 * Verificación GPG del runtime de Node.js fijado (mantenimiento de releases).
 *
 * **No** forma parte del instalador ni del launcher: el usuario final solo
 * verifica SHA-256 y nunca necesita GPG. Este script es para quien prepara un
 * release de VIUrewards y quiere comprobar que el hash fijado en
 * `scripts/dist/config.ts` proviene de un manifiesto **firmado** por un
 * responsable de releases de Node.js, y no solo del mismo servidor que sirve el
 * binario.
 *
 * Cadena que comprueba, en este orden:
 *
 *   1. descarga `SHASUMS256.txt` y su firma `SHASUMS256.txt.sig` de la versión
 *      EXACTA fijada (`NODE_VERSION`), sin `latest`;
 *   2. verifica la firma con el keyring oficial de `nodejs/release-keys`;
 *   3. comprueba que la clave firmante está en `NODE_RELEASE_KEYS.fingerprints`
 *      (la lista de firmantes activos que publica Node.js);
 *   4. comprueba que `NODE_ASSET.sha256` de `config.ts` aparece en el manifiesto
 *      **firmado**;
 *   5. si el ZIP está en la caché local, comprueba que su SHA-256 real coincide.
 *
 * Falla con código 1 ante cualquier discrepancia. No modifica `config.ts`.
 *
 * Uso:
 *
 *   node scripts/dist/verify-node-release.ts
 *   node scripts/dist/verify-node-release.ts --keys-dir <ruta al clon de release-keys>
 *
 * Requisitos: `gpg` en el PATH y `git` para clonar las claves (o `--keys-dir`).
 * Si no hay `gpg`, sale con un mensaje que explica el procedimiento manual
 * (`docs/node-release-verification.md`) y código 2.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_ASSET, NODE_RELEASE_KEYS, NODE_VERSION } from "./config.ts";
import { runProcess } from "../../src/media/run-process.ts";

const BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;

/** Tope para las descargas y el clonado de claves. */
const DOWNLOAD_TIMEOUT_MS = 180_000;
/** Tope para un comando de comprobación (`gpg --version`, `gpg --verify`). */
const QUICK_TIMEOUT_MS = 60_000;

/** Código de salida: la herramienta necesaria no está disponible. */
export const EXIT_MISSING_TOOL = 2;
/** Código de salida: la verificación falló. */
export const EXIT_FAILED = 1;

export interface VerifyOptions {
  /** Ejecutor inyectable (tests). */
  run?: typeof runProcess;
  /** Directorio con el clon de `nodejs/release-keys` (evita clonar). */
  keysDir?: string;
  /** Directorio de trabajo para las descargas (por defecto, temporal). */
  workDir?: string;
  /** Archivo local a comprobar además del hash fijado (el ZIP de la caché). */
  localFile?: string;
  log?: (message: string) => void;
}

export type VerifyResult =
  | { ok: true; signer: string; fingerprint: string }
  | { ok: false; reason: string; detail: string };

/** Descarga un archivo a un destino local. */
async function download(run: typeof runProcess, url: string, target: string): Promise<void> {
  const result = await run("curl", ["--fail", "--silent", "--show-error", "--location", "--output", target, url], {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(`No se pudo descargar ${url}: ${result.stderr.trim() || `código ${result.code}`}`);
  }
}

/**
 * Verifica el release de Node fijado.
 *
 * Devuelve un resultado explícito (nunca lanza por una discrepancia): el
 * llamador decide el código de salida.
 */
export async function verifyNodeRelease(options: VerifyOptions = {}): Promise<VerifyResult> {
  const run = options.run ?? runProcess;
  const log = options.log ?? ((message: string) => console.log(message));

  // --- Herramientas -------------------------------------------------------
  const gpg = await run("gpg", ["--version"], { timeoutMs: QUICK_TIMEOUT_MS });
  if (gpg.code !== 0) {
    return {
      ok: false,
      reason: "gpg-missing",
      detail: "No hay `gpg` en el PATH. Seguí el procedimiento manual de docs/node-release-verification.md.",
    };
  }
  if (!options.keysDir) {
    const git = await run("git", ["--version"], { timeoutMs: QUICK_TIMEOUT_MS });
    if (git.code !== 0) {
      return {
        ok: false,
        reason: "git-missing",
        detail: "No hay `git` para clonar las claves. Pasá --keys-dir con un clon de nodejs/release-keys.",
      };
    }
  }

  // --- Claves -------------------------------------------------------------
  const ownWorkDir = options.workDir === undefined;
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), "viu-node-verify-"));
  try {
    let keysDir = options.keysDir;
    if (!keysDir) {
      keysDir = join(workDir, "release-keys");
      log(`Clonando las claves oficiales de ${NODE_RELEASE_KEYS.source}…`);
      // Contra la rama por defecto del repositorio de claves (es un repo de
      // datos, no de código que ejecutemos). Se registra el commit para que la
      // verificación sea reproducible.
      const clone = await run("git", ["clone", "--depth", "1", NODE_RELEASE_KEYS.keyringUrl, keysDir], {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      });
      if (clone.code !== 0) {
        return {
          ok: false,
          reason: "keys-unavailable",
          detail: `No se pudieron obtener las claves: ${clone.stderr.trim() || `código ${clone.code}`}`,
        };
      }
    }
    const keyring = join(keysDir, "gpg");
    if (!existsSync(keyring)) {
      return { ok: false, reason: "keys-unavailable", detail: `No existe el keyring ${keyring}.` };
    }

    // --- Descargas de la versión EXACTA -----------------------------------
    const shasums = join(workDir, "SHASUMS256.txt");
    const signature = join(workDir, "SHASUMS256.txt.sig");
    log(`Descargando ${BASE}/SHASUMS256.txt y su firma…`);
    await download(run, `${BASE}/SHASUMS256.txt`, shasums);
    await download(run, `${BASE}/SHASUMS256.txt.sig`, signature);

    // --- Firma ------------------------------------------------------------
    // `--status-fd 1`: la salida legible por máquina, para no depender del
    // texto traducido. `--no-default-keyring` + `--keyring`: solo las claves
    // oficiales, nunca el keyring del usuario.
    const verified = await run(
      "gpg",
      [
        "--batch",
        "--no-tty",
        "--status-fd",
        "1",
        "--no-default-keyring",
        "--keyring",
        "pubring.kbx",
        "--trust-model",
        "always",
        "--verify",
        signature,
        shasums,
      ],
      { timeoutMs: QUICK_TIMEOUT_MS, env: { GNUPGHOME: keyring } },
    );
    const status = verified.stdout;
    if (verified.code !== 0 || !/\[GNUPG:\] GOODSIG /.test(status)) {
      return {
        ok: false,
        reason: "bad-signature",
        detail: `La firma de SHASUMS256.txt no es válida.\n${status.trim()}\n${verified.stderr.trim()}`,
      };
    }
    const validAt = /\[GNUPG:\] VALIDSIG ([0-9A-F]{40})/.exec(status);
    const fingerprint = validAt?.[1];
    if (!fingerprint) {
      return { ok: false, reason: "no-fingerprint", detail: "gpg no informó la huella del firmante." };
    }
    const authorized = (NODE_RELEASE_KEYS.fingerprints as readonly string[]).includes(fingerprint);
    if (!authorized) {
      return {
        ok: false,
        reason: "unauthorized-key",
        detail:
          `La firma es buena pero la clave ${fingerprint} NO está en la lista de firmantes autorizados ` +
          `de ${NODE_RELEASE_KEYS.source}.`,
      };
    }
    const signer = /\[GNUPG:\] GOODSIG [0-9A-F]+ (.+)/.exec(status)?.[1]?.trim() ?? "(sin nombre)";
    log(`Firma buena de ${signer} (${fingerprint}), clave autorizada.`);

    // --- Hash fijado en el manifiesto firmado -----------------------------
    const manifest = readFileSync(shasums, "utf8");
    const line = manifest
      .split(/\r?\n/)
      .find((entry) => entry.trim().endsWith(`  ${NODE_ASSET.file}`) || entry.trim().endsWith(` *${NODE_ASSET.file}`));
    if (!line) {
      return {
        ok: false,
        reason: "hash-missing",
        detail: `El manifiesto firmado no menciona ${NODE_ASSET.file}.`,
      };
    }
    const signedHash = line.trim().split(/\s+/)[0]?.toLowerCase();
    if (signedHash !== NODE_ASSET.sha256) {
      return {
        ok: false,
        reason: "hash-mismatch",
        detail:
          `El hash firmado de ${NODE_ASSET.file} no coincide con config.ts.\n` +
          `  firmado:  ${signedHash}\n  fijado:   ${NODE_ASSET.sha256}\n` +
          "No se cambia el pin sin informar de la discrepancia.",
      };
    }
    log(`El hash fijado de ${NODE_ASSET.file} aparece en el manifiesto firmado.`);

    // --- Archivo local (si se pasó) ---------------------------------------
    if (options.localFile) {
      if (!existsSync(options.localFile)) {
        return { ok: false, reason: "local-missing", detail: `No existe ${options.localFile}.` };
      }
      const actual = createHash("sha256").update(readFileSync(options.localFile)).digest("hex");
      if (actual !== signedHash) {
        return {
          ok: false,
          reason: "local-mismatch",
          detail: `El SHA-256 real de ${options.localFile} no coincide.\n  real: ${actual}\n  firmado: ${signedHash}`,
        };
      }
      log(`El archivo local ${options.localFile} coincide con el hash firmado.`);
    }

    return { ok: true, signer, fingerprint };
  } finally {
    if (ownWorkDir) rmSync(workDir, { recursive: true, force: true });
  }
}

/** Punto de entrada: parsea los argumentos, verifica e informa el resultado. */
async function main(argv: string[]): Promise<void> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) args.set(name ?? "", inline);
    else args.set(name ?? "", argv[index + 1] ?? "");
  }
  const keysDir = args.get("keys-dir");
  const localFile = args.get("file");
  const result = await verifyNodeRelease({ keysDir, localFile });
  if (result.ok) {
    console.log(`\nNode ${NODE_VERSION}: firma y hash verificados (${result.signer}).`);
    return;
  }
  console.error(`\nVerificación fallida (${result.reason}):\n${result.detail}`);
  process.exitCode = result.reason === "gpg-missing" || result.reason === "git-missing" ? EXIT_MISSING_TOOL : EXIT_FAILED;
}

const isEntryPoint = process.argv[1] !== undefined && /verify-node-release\.[cm]?ts$/.test(process.argv[1]);
if (isEntryPoint) {
  await main(process.argv.slice(2));
}
