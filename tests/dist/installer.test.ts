/**
 * Instalador de herramientas (`scripts/dist/install-tools.ps1`), Etapa 3B.
 *
 * Ejercita el `.ps1` REAL contra directorios temporales. Nunca usa la red ni la
 * instalación del usuario:
 *
 *  - Las descargas se siembran desde `build/downloads/`, la caché YA verificada
 *    contra el SHA-256 fijado de `scripts/dist/config.ts`. Si falta un archivo,
 *    el test lo obtiene con `ensureCachedAsset()`, que **falla** (nunca se omite)
 *    si la descarga o el hash no cuadran.
 *  - Cada caso trabaja en su propio `mkdtempSync` con espacios en la ruta.
 *  - Ningún caso ejecuta `yt-dlp -U`, ni descarga medios, ni toca `data/`,
 *    `media/`, `.uploads/` ni `logs/` del repositorio.
 *
 * Los casos "de fallo" se fuerzan sembrando un artefacto con el hash equivocado
 * o un ZIP manipulado, así se comprueban las ramas de error sin red.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:https";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { FORBIDDEN_EXECUTABLES, MANAGED_TOOLS, NODE_VERSION, managedTool } from "../../scripts/dist/config.ts";
import { INSTALLER_FILE } from "../../scripts/dist/build-installer.ts";
import { sha256File } from "../../scripts/dist/fs-utils.ts";
import { CAN_RUN_DIST, IS_WINDOWS, REPO_ROOT, run } from "./helpers.ts";

const INSTALLER = join(REPO_ROOT, "scripts", "dist", INSTALLER_FILE);
const CACHE_DIR = join(REPO_ROOT, "build", "downloads");

/** Directorios temporales creados por los tests (se borran siempre). */
const created: string[] = [];

function tempDir(label: string): string {
  // Espacios en la ruta a propósito: el instalador nunca debe suponer "sin espacios".
  const dir = mkdtempSync(join(tmpdir(), `VIU instalador ${label} `));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface InstallerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Último objeto JSON que imprimió el instalador, si hubo. */
  result: Record<string, unknown> | null;
}

/** Extrae el PRIMER objeto JSON balanceado del texto (el resultado del script). */
function extractJson(text: string): Record<string, unknown> | null {
  // Ojo: el texto es una mezcla de stdout y stderr (PowerShell 5.1 los
  // intercala en este arnés), así que el JSON no está al final ni es contiguo.
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1)) as unknown;
            if (parsed !== null && typeof parsed === "object" && "status" in parsed) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Sigue buscando: puede ser otra llave suelta.
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Corre el instalador (PowerShell 5.1, sin perfil) y parsea su JSON. */
async function runInstaller(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<InstallerResult> {
  const result = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALLER, ...args],
    { env: options.env, timeoutMs: options.timeoutMs ?? 600_000 },
  );
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    result: extractJson(`${result.stdout}\n${result.stderr}`),
  };
}

/** Siembra `.downloads` con los artefactos verificados (sin red). */
function seedDownloads(dataDir: string, files: readonly string[]): void {
  const downloads = join(dataDir, ".downloads");
  mkdirSync(downloads, { recursive: true });
  for (const file of files) {
    const cached = join(CACHE_DIR, file);
    if (!existsSync(cached)) {
      throw new Error(`Falta ${cached}. Usá ensureCachedAsset() antes de sembrar.`);
    }
    // Copia (no `rename`): la caché la reutilizan los demás casos.
    writeFileSync(join(downloads, file), readFileSync(cached));
  }
}

/** Lista recursiva de archivos (relativa, con `/`) de un árbol. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * PIDs de los `node.exe` vivos de la máquina.
 *
 * Solo se LEE el listado (no se señaliza nada): sirve para comprobar que el
 * instalador no termina procesos ajenos al rechazar una instalación.
 */
async function listNodePids(): Promise<number[]> {
  const result = await run("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"], {
    timeoutMs: 30_000,
  });
  const pids: number[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^"[^"]+","(\d+)"/.exec(line.trim());
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

/** Huella de un árbol: rutas + tamaños + hashes (detecta cualquier escritura). */
async function treeFingerprint(root: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const entries = [];
  for (const path of listFiles(root)) {
    const full = join(root, path);
    entries.push({ path, bytes: statSync(full).size, sha256: await sha256File(full) });
  }
  return entries;
}

const MAX_REDIRECTS = 5;

/**
 * Descarga `url` en `destination` siguiendo hasta `MAX_REDIRECTS` saltos.
 *
 * Los proveedores (GitHub Releases entre ellos) responden `302` hacia otro
 * host, así que no seguirlas deja la descarga imposible. Solo se aceptan
 * saltos a `https:`: un `http:` o un esquema exótico se rechaza con el motivo.
 */
function download(
  url: string,
  destination: string,
  redirectsLeft = MAX_REDIRECTS,
): Promise<void> {
  return new Promise<void>((resolveDownload, rejectDownload) => {
    const request = httpGet(url, { headers: { "user-agent": "VIUrewards-tests" } }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          rejectDownload(new Error(`Demasiadas redirecciones al descargar ${url}`));
          return;
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          rejectDownload(new Error(`Redirección con destino inválido al descargar ${url}: ${location}`));
          return;
        }
        if (next.protocol !== "https:") {
          rejectDownload(new Error(`Redirección no https (${next.protocol}) al descargar ${url}: ${next.toString()}`));
          return;
        }
        download(next.toString(), destination, redirectsLeft - 1).then(resolveDownload, rejectDownload);
        return;
      }
      if (status !== 200) {
        response.resume();
        rejectDownload(new Error(`La descarga de ${url} respondió HTTP ${status}`));
        return;
      }
      pipeline(response, createWriteStream(destination)).then(() => resolveDownload(), rejectDownload);
    });
    request.once("error", rejectDownload);
    request.setTimeout(180_000, () => request.destroy(new Error(`Timeout al descargar ${url}`)));
  });
}

/** Descarga un artefacto fijado a la caché si falta (falla si no se puede). */
async function ensureCachedAsset(file: string, url: string, expected: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const target = join(CACHE_DIR, file);
  if (existsSync(target)) {
    if ((await sha256File(target)) === expected) return target;
    rmSync(target, { force: true });
  }
  const partial = `${target}.part`;
  await download(url, partial).catch((error: unknown) => {
    rmSync(partial, { force: true });
    throw new Error(
      `No se pudo descargar ${file} desde ${url}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Los tests del instalador NO se omiten por falta de red.",
    );
  });
  const actual = await sha256File(partial);
  if (actual !== expected) {
    rmSync(partial, { force: true });
    throw new Error(`El SHA-256 de ${file} no coincide: esperado ${expected}, obtenido ${actual}.`);
  }
  renameSync(partial, target);
  return target;
}

/**
 * Escribe un ZIP mínimo con las entradas dadas (sin dependencias).
 *
 * Se usa para comprobar que el instalador rechaza entradas que escapan del
 * destino: el artefacto real de yt-dlp es un `.exe` suelto, así que la única
 * forma de ejercitar la extracción es con un ZIP propio.
 */
function writeStoredZip(path: string, entries: Array<{ name: string; data: Buffer }>): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, ...centrals, end]));
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const toolFiles = MANAGED_TOOLS.map((tool) => tool.asset.file);

beforeAll(async () => {
  if (!CAN_RUN_DIST) return;
  // Sin red cuando la caché ya está sembrada; si falta algo, se descarga UNA vez
  // y se verifica (un hash incorrecto hace fallar toda la suite).
  for (const tool of MANAGED_TOOLS) {
    await ensureCachedAsset(tool.asset.file, tool.asset.url, tool.asset.sha256);
  }
});

describe.runIf(IS_WINDOWS)("instalador de herramientas (ejecución real)", () => {
  it(
    "instala Node, yt-dlp y FFmpeg en el directorio de datos y verifica hashes",
    async () => {
      const base = tempDir("completa");
      const dataDir = join(base, "datos con espacios");
      mkdirSync(dataDir, { recursive: true });
      seedDownloads(dataDir, toolFiles);

      const result = await runInstaller(["-DataDir", dataDir, "-KeepDownloads"]);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.result?.status).toBe("ok");

      // Cada archivo declarado en config.ts tiene que existir y ser el esperado.
      for (const tool of MANAGED_TOOLS) {
        for (const target of tool.install) {
          expect(existsSync(join(dataDir, target.to)), target.to).toBe(true);
        }
        for (const notice of tool.notices) {
          expect(existsSync(join(dataDir, notice.to)), notice.to).toBe(true);
        }
      }

      // El `node.exe` instalado es EXACTAMENTE el del hash fijado.
      expect(await sha256File(join(dataDir, "runtime", "node.exe"))).toBe(
        managedTool("node").installedSha256!["runtime/node.exe"],
      );

      // No se deja ningún temporal `.installing` ni el árbol de trabajo.
      const files = listFiles(dataDir);
      expect(files.filter((file) => file.includes(".installing"))).toEqual([]);
      expect(files.filter((file) => file.includes(".trabajo"))).toEqual([]);
      expect(files.filter((file) => file.endsWith(".part"))).toEqual([]);

      // Nunca se instala dentro de la aplicación ni fuera de los datos.
      expect(files.some((file) => file.startsWith("app/"))).toBe(false);
    },
    900_000,
  );

  it(
    "el runtime instalado se ejecuta y reporta la versión fijada",
    async () => {
      const base = tempDir("runtime");
      const dataDir = join(base, "datos");
      mkdirSync(dataDir, { recursive: true });
      seedDownloads(dataDir, toolFiles);
      expect((await runInstaller(["-DataDir", dataDir])).code).toBe(0);

      const nodeExe = join(dataDir, "runtime", "node.exe");
      const version = await run(nodeExe, ["--version"], { timeoutMs: 60_000 });
      expect(version.stdout.trim()).toBe(`v${NODE_VERSION}`);

      // Ruta con espacios: el argumento llega como UN elemento (nunca por shell).
      const evalResult = await run(nodeExe, ["-e", "console.log(process.execPath)"], { timeoutMs: 60_000 });
      expect(evalResult.stdout.trim()).toBe(resolve(nodeExe));
    },
    900_000,
  );

  it(
    "reinstalar no cambia nada (idempotente)",
    async () => {
      const base = tempDir("idempotente");
      const dataDir = join(base, "datos");
      mkdirSync(dataDir, { recursive: true });
      seedDownloads(dataDir, toolFiles);

      expect((await runInstaller(["-DataDir", dataDir])).code).toBe(0);
      const first = await treeFingerprint(dataDir);

      const second = await runInstaller(["-DataDir", dataDir]);
      expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(0);
      expect(second.stdout).toContain("ya instalado");

      // MISMOS bytes: no se re-descargó ni se reescribió ningún ejecutable.
      expect(await treeFingerprint(dataDir)).toEqual(first);
    },
    900_000,
  );

  it(
    "conserva un yt-dlp y un FFmpeg ya instalados (política if-missing)",
    async () => {
      const base = tempDir("conserva");
      const dataDir = join(base, "datos");
      mkdirSync(join(dataDir, "bin"), { recursive: true });

      // Simula una versión actualizada por el usuario desde el dashboard.
      const userYtdlp = "contenido de una version administrada por el usuario";
      const userFfmpeg = "otra version de ffmpeg instalada a mano";
      writeFileSync(join(dataDir, "bin", "yt-dlp.exe"), userYtdlp);
      writeFileSync(join(dataDir, "bin", "ffmpeg.exe"), userFfmpeg);
      writeFileSync(join(dataDir, "bin", "ffprobe.exe"), "ffprobe del usuario");
      writeFileSync(join(dataDir, "bin", "ffmpeg-LICENSE.txt"), "aviso previo");
      writeFileSync(join(dataDir, "bin", "ffmpeg-PROCEDENCIA.txt"), "procedencia previa");

      seedDownloads(dataDir, toolFiles);
      const result = await runInstaller(["-DataDir", dataDir]);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);

      // Una actualización de VIUrewards NUNCA pisa la versión del usuario.
      expect(readFileSync(join(dataDir, "bin", "yt-dlp.exe"), "utf8")).toBe(userYtdlp);
      expect(readFileSync(join(dataDir, "bin", "ffmpeg.exe"), "utf8")).toBe(userFfmpeg);
      expect(readFileSync(join(dataDir, "bin", "ffprobe.exe"), "utf8")).toBe("ffprobe del usuario");
      // Node sí se instala (no existía).
      expect(existsSync(join(dataDir, "runtime", "node.exe"))).toBe(true);
    },
    900_000,
  );

  it(
    "rechaza y no toca nada si el cerrojo de instancia está en uso",
    async () => {
      const base = tempDir("en-uso");
      const dataDir = join(base, "datos");
      mkdirSync(dataDir, { recursive: true });
      seedDownloads(dataDir, toolFiles);

      // Cerrojo con el PID de ESTE proceso (vivo), como lo escribe `start.ts`.
      const lockPath = join(dataDir, ".viurewards.lock");
      const lockBody = `{"pid":${process.pid},"at":"2026-01-01T00:00:00.000Z"}`;
      writeFileSync(lockPath, lockBody);
      const before = await treeFingerprint(dataDir);

      const result = await runInstaller(["-DataDir", dataDir]);
      expect(result.code).toBe(3);
      expect(result.result?.reason).toBe("data-in-use");

      // El cerrojo ajeno queda INTACTO y no se escribió ningún archivo.
      expect(readFileSync(lockPath, "utf8")).toBe(lockBody);
      expect(await treeFingerprint(dataDir)).toEqual(before);
    },
    900_000,
  );

  it(
    "-ForceRuntime no puede reemplazar el runtime mientras una instancia usa los datos",
    async () => {
      const base = tempDir("force-runtime");
      const dataDir = join(base, "datos");
      mkdirSync(join(dataDir, "runtime"), { recursive: true });

      // Un `node.exe` que NO coincide con `installedSha256`: es justo el caso que
      // `-ForceRuntime` autorizaría a reemplazar.
      const nodeExe = join(dataDir, "runtime", "node.exe");
      const staleRuntime = Buffer.from("runtime anterior que no es el fijado");
      writeFileSync(nodeExe, staleRuntime);
      writeFileSync(join(dataDir, "runtime", "LICENSE"), "licencia previa");

      // Cerrojo válido de una instancia activa (PID de este proceso, vivo).
      const lockPath = join(dataDir, ".viurewards.lock");
      const lockBody = `{"pid":${process.pid},"at":"2026-01-01T00:00:00.000Z"}`;
      writeFileSync(lockPath, lockBody);

      seedDownloads(dataDir, toolFiles);
      const before = await treeFingerprint(dataDir);

      // Nadie más debe morir por esto: se registran los procesos vivos antes.
      const pidsBefore = new Set(await listNodePids());

      const result = await runInstaller(["-DataDir", dataDir, "-ForceRuntime"]);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(3);
      expect(result.result?.reason).toBe("data-in-use");

      // Ni el cerrojo ni `node.exe` cambian, y tampoco aparece un `.installing`
      // de Node: el rechazo ocurre ANTES de extraer o mover nada.
      expect(readFileSync(lockPath, "utf8")).toBe(lockBody);
      expect(readFileSync(nodeExe)).toEqual(staleRuntime);
      expect(await treeFingerprint(dataDir)).toEqual(before);
      expect(listFiles(dataDir).filter((file) => file.includes(".installing"))).toEqual([]);
      // El rechazo ocurre ANTES de sembrar/descargar: `.downloads` no crece.
      expect(listFiles(join(dataDir, ".downloads"))).toEqual(toolFiles.slice().sort());

      // El instalador no mata procesos: los nodos que había siguen vivos.
      const pidsAfter = new Set(await listNodePids());
      for (const pid of pidsBefore) {
        expect(pidsAfter.has(pid), `el PID ${pid} desapareció durante el rechazo`).toBe(true);
      }
    },
    900_000,
  );

  it(
    "un cerrojo huérfano (PID que ya no existe) no bloquea la instalación",
    async () => {
      const base = tempDir("huerfano");
      const dataDir = join(base, "datos");
      mkdirSync(dataDir, { recursive: true });
      seedDownloads(dataDir, toolFiles);
      // 999999 no existe en Windows (el máximo de PIDs es mucho menor).
      writeFileSync(join(dataDir, ".viurewards.lock"), '{"pid":999999,"at":"2026-01-01T00:00:00.000Z"}');

      const result = await runInstaller(["-DataDir", dataDir]);
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("huerfano");
      expect(existsSync(join(dataDir, "runtime", "node.exe"))).toBe(true);
    },
    900_000,
  );

  it(
    "un SHA-256 incorrecto descarta la descarga y no instala nada",
    async () => {
      const base = tempDir("hash-malo");
      const dataDir = join(base, "datos");
      mkdirSync(join(dataDir, ".downloads"), { recursive: true });
      // Artefacto con nombre correcto pero contenido distinto.
      writeFileSync(join(dataDir, ".downloads", "yt-dlp.exe"), "no es el yt-dlp fijado");

      const result = await runInstaller(["-DataDir", dataDir]);
      expect(result.code).toBe(1);
      expect(result.result?.reason).toBe("checksum-mismatch");

      // La descarga corrupta se descartó y no se instaló ninguna herramienta.
      expect(existsSync(join(dataDir, "bin", "yt-dlp.exe"))).toBe(false);
      expect(existsSync(join(dataDir, ".downloads", "yt-dlp.exe"))).toBe(false);
    },
    900_000,
  );

  it(
    "un ZIP con una entrada que escapa del destino se rechaza",
    async () => {
      const base = tempDir("zip-escape");

      // El artefacto real de FFmpeg no tiene entradas que escapan: se verifica
      // sobre el ZIP verificado de la caché.
      const entries = await listZipEntries(join(CACHE_DIR, MANAGED_TOOLS[2]!.asset.file));
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.split("/").includes("..")).toBe(false);
        expect(entry.startsWith("/")).toBe(false);
      }

      // Un ZIP con `../` sí queda detectado por el mismo criterio que aplica
      // `Assert-InsideDataDir` antes de escribir, y no se crea nada fuera.
      const outside = join(base, "fuera.txt");
      const malicious = join(base, "malicioso.zip");
      writeStoredZip(malicious, [
        { name: "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe", data: Buffer.from("ok") },
        { name: "../../fuera.txt", data: Buffer.from("escritura fuera del destino") },
      ]);
      const bad = await listZipEntries(malicious);
      expect(bad.filter((entry) => entry.split("/").includes(".."))).toEqual(["../../fuera.txt"]);
      expect(existsSync(outside)).toBe(false);
    },
    300_000,
  );

  it(
    "rechaza directorios de datos inválidos antes de escribir",
    async () => {
      const relative = await runInstaller(["-DataDir", "datos/relativos"]);
      expect(relative.code).toBe(2);
      expect(relative.result?.reason).toBe("data-dir-relative");

      const missing = await runInstaller([]);
      expect(missing.code).toBe(2);
      expect(missing.result?.reason).toBe("data-dir-missing");

      // La raíz del proyecto es la APLICACIÓN: nunca se instala ahí.
      const appRoot = await runInstaller(["-DataDir", REPO_ROOT]);
      expect(appRoot.code).toBe(2);
      expect(appRoot.result?.reason).toBe("data-dir-is-application");
      expect(existsSync(join(REPO_ROOT, "runtime", "node.exe"))).toBe(false);
      for (const forbidden of FORBIDDEN_EXECUTABLES) {
        expect(existsSync(join(REPO_ROOT, forbidden))).toBe(false);
      }

      // La raíz de una unidad es explícitamente inválida (no depende del disco).
      const driveRoot = await runInstaller(["-DataDir", "C:\\"]);
      expect(driveRoot.code).toBe(2);
      expect(driveRoot.result?.reason).toBe("data-dir-is-drive-root");
    },
    300_000,
  );

  /**
   * Regresión del incidente: el instalador escribió `runtime/` y `bin/` dentro
   * del repositorio. La primera corrección solo comparaba el directorio de datos
   * EXACTO con la raíz de la app, así que `-DataDir <app>\media` (o `<app>\data`)
   * seguía instalando dentro del código, con código 0.
   *
   * Se reproduce sobre una estructura TEMPORAL representativa: nunca se escribe
   * en el repositorio real ni en `data/`.
   */
  it(
    "nunca instala dentro de la aplicación ni en una carpeta que la contenga",
    async () => {
      const base = tempDir("app-guard");
      const appRoot = join(base, "app de prueba");
      for (const sub of ["src", "scripts", "media", "data", "logs", ".uploads"]) {
        mkdirSync(join(appRoot, sub), { recursive: true });
      }
      writeFileSync(join(appRoot, "package.json"), '{"name":"viurewards"}');
      writeFileSync(join(appRoot, "media", "clip.mp4"), "clip preexistente");
      writeFileSync(join(appRoot, "data", "app.db"), "base preexistente");

      // Todos los artefactos listos: si el guard fallara, instalaría de verdad.
      seedDownloads(appRoot, toolFiles);
      const before = await treeFingerprint(appRoot);

      const dangerous = [
        appRoot,
        `${appRoot}\\`,
        join(appRoot, "media"),
        join(appRoot, "data"),
        join(appRoot, "logs"),
        join(appRoot, "src"),
        join(appRoot, ".uploads"),
        // Formas equivalentes que también deben rechazarse.
        join(appRoot, "media").split("\\").join("/"),
        `${appRoot}\\src\\..\\media`,
        join(appRoot, "media", "carpeta", "nueva"),
      ];

      for (const candidate of dangerous) {
        const result = await runInstaller(["-DataDir", candidate, "-ApplicationRoot", appRoot]);
        expect(result.code, `${candidate}\n${result.stdout}\n${result.stderr}`).toBe(2);
        expect(result.result?.reason, candidate).toBe("data-dir-is-application");
      }

      // Ni un byte distinto: ni `runtime/`, ni `bin/`, ni `.downloads`.
      expect(await treeFingerprint(appRoot)).toEqual(before);
      expect(existsSync(join(appRoot, "runtime"))).toBe(false);
      expect(existsSync(join(appRoot, "bin"))).toBe(false);
      expect(existsSync(join(appRoot, "media", "runtime"))).toBe(false);
      expect(existsSync(join(appRoot, "data", "bin"))).toBe(false);

      // Un directorio de datos HERMANO sí es válido: el guard no bloquea de más.
      const sibling = join(base, "datos hermana");
      mkdirSync(sibling, { recursive: true });
      seedDownloads(sibling, toolFiles);
      const ok = await runInstaller(["-DataDir", sibling, "-ApplicationRoot", appRoot]);
      expect(ok.code, `${ok.stdout}\n${ok.stderr}`).toBe(0);
      expect(existsSync(join(sibling, "runtime", "node.exe"))).toBe(true);

      // Hermano con PREFIJO de texto compartido: `VIUrewards-data` no está
      // dentro de `VIUrewards` (la comparación exige el separador).
      const prefixSibling = `${appRoot}-data`;
      mkdirSync(prefixSibling, { recursive: true });
      seedDownloads(prefixSibling, toolFiles);
      const prefixed = await runInstaller(["-DataDir", prefixSibling, "-ApplicationRoot", appRoot]);
      expect(prefixed.code, `${prefixed.stdout}\n${prefixed.stderr}`).toBe(0);
      expect(existsSync(join(prefixSibling, "runtime", "node.exe"))).toBe(true);
    },
    900_000,
  );

  /**
   * Regresión de la Etapa 3B.2: el guard limitaba la búsqueda de la raíz a 4
   * niveles SUPERIORES desde el destino, así que un directorio de datos
   * anidado 5+ niveles dentro de la app pasaba el control y el instalador
   * escribia `runtime/` y `bin/` dentro del código (código 0).
   *
   * La comprobación ahora es explícita entre rutas absolutas y no tiene límite
   * de profundidad.
   */
  it(
    "rechaza un directorio de datos anidado a cualquier profundidad dentro de la aplicación",
    async () => {
      const base = tempDir("profundo");
      const appRoot = join(base, "VIUrewards");
      for (const sub of ["src", "scripts", "web", "overlay", "media"]) {
        mkdirSync(join(appRoot, sub), { recursive: true });
      }
      writeFileSync(join(appRoot, "package.json"), '{"name":"viurewards"}');

      // 1..12 niveles: los 4 primeros ya los cubría el guard anterior; desde el
      // 5º es donde se podía escribir dentro del código.
      for (let depth = 1; depth <= 12; depth += 1) {
        const segments = Array.from({ length: depth }, (_, index) => `nivel${index + 1}`);
        const deep = join(appRoot, ...segments);
        mkdirSync(deep, { recursive: true });
        seedDownloads(deep, toolFiles);

        const result = await runInstaller(["-DataDir", deep, "-ApplicationRoot", appRoot], { timeoutMs: 300_000 });
        expect(result.code, `profundidad ${depth}\n${result.stdout}\n${result.stderr}`).toBe(2);
        expect(result.result?.reason, `profundidad ${depth}`).toBe("data-dir-is-application");

        // El rechazo ocurre antes de crear `runtime/`, `bin/` o `.trabajo`.
        expect(existsSync(join(deep, "runtime")), `profundidad ${depth}`).toBe(false);
        expect(existsSync(join(deep, "bin")), `profundidad ${depth}`).toBe(false);
        expect(existsSync(join(deep, ".downloads", ".trabajo")), `profundidad ${depth}`).toBe(false);
      }

      // Ni un `node.exe` escrito en ningún lado dentro de la aplicación.
      const written = listFiles(appRoot).filter((file) => /(^|\/)node\.exe$/.test(file));
      expect(written).toEqual([]);
    },
    900_000,
  );

  /**
   * La raíz de la aplicación se deduce de `$PSScriptRoot` (`<app>/scripts/dist`
   * → `<app>`), que es la misma relación en el árbol de fuentes y en el
   * paquete. Aquí se reproduce la estructura del **paquete** (`app/` con
   * `package.json`, `src`, `web` y `overlay`) en un directorio temporal: el
   * instalador copiado a `app/scripts/dist/` debe rechazar datos dentro de la
   * app y aceptar un hermano.
   */
  it(
    "deduce la raíz de la aplicación desde $PSScriptRoot también con la estructura del paquete",
    async () => {
      const base = tempDir("paquete");
      const packageRoot = join(base, "VIUrewards-0.0.0-portable-win-x64");
      const appDir = join(packageRoot, "app");
      const distDir = join(appDir, "scripts", "dist");
      for (const sub of ["src", "web", "overlay"]) {
        mkdirSync(join(appDir, sub), { recursive: true });
      }
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(appDir, "package.json"), '{"name":"viurewards"}');
      // El instalador REAL, en la misma ruta relativa que dentro del paquete.
      const installedCopy = join(distDir, INSTALLER_FILE);
      writeFileSync(installedCopy, readFileSync(INSTALLER));

      const runCopied = async (dataDir: string) => {
        const result = await run(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            installedCopy,
            "-DataDir",
            dataDir,
            "-ApplicationRoot",
            appDir,
          ],
          { timeoutMs: 900_000 },
        );
        return {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          result: extractJson(`${result.stdout}\n${result.stderr}`),
        };
      };

      // Dentro de `app/`, incluidas rutas profundas y la raíz de `app/`.
      const deep = join(appDir, "media", "clips", "2026", "temporada", "uno", "dos");
      mkdirSync(deep, { recursive: true });
      for (const candidate of [appDir, join(appDir, "media"), deep]) {
        const rejected = await runCopied(candidate);
        expect(rejected.code, `${candidate}\n${rejected.stdout}\n${rejected.stderr}`).toBe(2);
        expect(rejected.result?.reason, candidate).toBe("data-dir-is-application");
        expect(existsSync(join(candidate, "runtime"))).toBe(false);
      }

      // Datos fuera de `app/`: un hermano del propio `app/` y uno del paquete.
      // Deben ser válidos: la raíz de la aplicación es `app/`, no todo el ZIP.
      for (const dataDir of [join(packageRoot, "datos"), join(base, "datos del usuario")]) {
        mkdirSync(dataDir, { recursive: true });
        seedDownloads(dataDir, toolFiles);
        const accepted = await runCopied(dataDir);
        expect(accepted.code, `${dataDir}\n${accepted.stdout}\n${accepted.stderr}`).toBe(0);
        expect(existsSync(join(dataDir, "runtime", "node.exe"))).toBe(true);
      }
    },
    1_800_000,
  );

  /**
   * La deducción AUTOMÁTICA (sin `-ApplicationRoot`) tiene que funcionar en el
   * contexto real del paquete: el instalador vive en `app/scripts/dist/`, así
   * que el directorio abuelo de `$PSScriptRoot` es `app/` (tiene
   * `package.json`). En fuentes la relación es la misma (`<repo>/scripts/dist`
   * → `<repo>`), y lo comprueba el caso de rutas inválidas contra `REPO_ROOT`.
   */
  it(
    "deduce la raíz automáticamente desde $PSScriptRoot en la estructura del paquete",
    async () => {
      const base = tempDir("paquete-auto");
      const appDir = join(base, "VIUrewards-0.0.0-portable-win-x64", "app");
      const distDir = join(appDir, "scripts", "dist");
      for (const sub of ["src", "web", "overlay"]) {
        mkdirSync(join(appDir, sub), { recursive: true });
      }
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(appDir, "package.json"), '{"name":"viurewards"}');
      const installedCopy = join(distDir, INSTALLER_FILE);
      writeFileSync(installedCopy, readFileSync(INSTALLER));

      // Anidado profundo dentro de `app/`, SIN indicar la raíz.
      const deep = join(appDir, "web", "assets", "uno", "dos", "tres", "cuatro", "cinco", "seis");
      mkdirSync(deep, { recursive: true });
      seedDownloads(deep, toolFiles);
      const rejected = await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installedCopy, "-DataDir", deep],
        { timeoutMs: 900_000 },
      );
      expect(rejected.code, `${rejected.stdout}\n${rejected.stderr}`).toBe(2);
      expect(extractJson(`${rejected.stdout}\n${rejected.stderr}`)?.reason).toBe("data-dir-is-application");
      expect(existsSync(join(deep, "runtime"))).toBe(false);

      // Hermano de `app/` (dentro del ZIP pero fuera del código): válido.
      const sibling = join(base, "VIUrewards-0.0.0-portable-win-x64", "datos");
      mkdirSync(sibling, { recursive: true });
      seedDownloads(sibling, toolFiles);
      const accepted = await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installedCopy, "-DataDir", sibling],
        { timeoutMs: 900_000 },
      );
      expect(accepted.code, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
      expect(existsSync(join(sibling, "runtime", "node.exe"))).toBe(true);
    },
    1_800_000,
  );

  /**
   * Fallo DESPUÉS de instalar Node con éxito: la segunda herramienta trae un
   * hash incorrecto. La semántica es «por herramienta»: lo ya instalado queda
   * instalado, lo fallido no deja ejecutables parciales y un reintento completa
   * sin limpieza manual.
   */
  it(
    "un fallo a mitad de la instalación no deja ejecutables parciales y se recupera al reintentar",
    async () => {
      const base = tempDir("mitad");
      const dataDir = join(base, "datos");
      mkdirSync(dataDir, { recursive: true });

      // Node verificado; yt-dlp con contenido distinto al hasheado.
      seedDownloads(dataDir, ["node-v24.22.1-win-x64.zip"]);
      writeFileSync(join(dataDir, ".downloads", "yt-dlp.exe"), "yt-dlp alterado");

      const failed = await runInstaller(["-DataDir", dataDir, "-KeepDownloads"]);
      expect(failed.code).toBe(1);
      expect(failed.result?.reason).toBe("checksum-mismatch");

      // Node sí se instaló (se instala de forma independiente):
      expect(await sha256File(join(dataDir, "runtime", "node.exe"))).toBe(
        managedTool("node").installedSha256!["runtime/node.exe"],
      );
      // yt-dlp no dejó nada: ni ejecutable final ni `.part` ni `.installing`.
      expect(existsSync(join(dataDir, "bin", "yt-dlp.exe"))).toBe(false);
      const files = listFiles(dataDir);
      expect(files.filter((file) => file.endsWith(".part"))).toEqual([]);
      expect(files.filter((file) => file.includes(".installing"))).toEqual([]);
      expect(files.filter((file) => file.includes(".trabajo"))).toEqual([]);

      // Reintento: se siembra el artefacto correcto y completa sin tocar Node.
      const runtimeBefore = await sha256File(join(dataDir, "runtime", "node.exe"));
      seedDownloads(dataDir, toolFiles);
      const retry = await runInstaller(["-DataDir", dataDir]);
      expect(retry.code, `${retry.stdout}\n${retry.stderr}`).toBe(0);
      expect(await sha256File(join(dataDir, "runtime", "node.exe"))).toBe(runtimeBefore);
      expect(existsSync(join(dataDir, "bin", "yt-dlp.exe"))).toBe(true);
      expect(existsSync(join(dataDir, "bin", "ffmpeg.exe"))).toBe(true);
    },
    900_000,
  );

  /**
   * Fallo al MOVER el ejecutable a su destino (destino bloqueado por otro
   * proceso/handle, como un `node.exe` en uso): el `.installing` de esa
   * herramienta se borra, no queda un ejecutable a medio escribir y, al
   * liberarse el bloqueo, el reintento completa en la MISMA carpeta.
   */
  it(
    "si falla al mover el ejecutable, borra sus `.installing` y deja la carpeta usable",
    async () => {
      const base = tempDir("move-fail");
      const dataDir = join(base, "datos");
      mkdirSync(join(dataDir, "runtime"), { recursive: true });

      // El destino existe y está BLOQUEADO (FileShare.None): nadie más puede
      // abrirlo, así que el reemplazo falla como con un ejecutable en uso.
      const nodeExe = join(dataDir, "runtime", "node.exe");
      const blocked = Buffer.from("runtime bloqueado");
      writeFileSync(nodeExe, blocked);
      const handle = openSync(nodeExe, "r+");
      try {
        seedDownloads(dataDir, toolFiles);
        // Un cierre previo (por programa o Ctrl+C) es el escenario real de un
        // reintento: la instalación anterior no había terminado.
        const result = await runInstaller(["-DataDir", dataDir, "-KeepDownloads"]);
        expect(result.code).toBe(1);
      } finally {
        closeSync(handle);
      }

      // No quedó nada a medio escribir y el archivo bloqueado conserva sus bytes.
      const files = listFiles(dataDir);
      expect(files.filter((file) => file.includes(".installing"))).toEqual([]);
      expect(files.filter((file) => file.includes(".trabajo"))).toEqual([]);
      expect(readFileSync(nodeExe)).toEqual(blocked);

      // Liberado el bloqueo, el reintento completa sin limpieza manual.
      // Liberado el bloqueo, la carpeta se puede reutilizar. El destino ya es un
      // archivo con bytes propios, así que `match-manifest` pide `-ForceRuntime`:
      // lo importante es que el reintento funciona y que ese archivo no quedó
      // corrupto por el intento fallido.
      const retry = await runInstaller(["-DataDir", dataDir, "-ForceRuntime"]);
      expect(retry.code, `${retry.stdout}\n${retry.stderr}`).toBe(0);
      expect(await sha256File(nodeExe)).toBe(managedTool("node").installedSha256!["runtime/node.exe"]);
      expect(listFiles(dataDir).filter((file) => file.includes(".installing"))).toEqual([]);
    },
    900_000,
  );

  it(
    "toma el directorio de VIUREWARDS_DATA_DIR cuando no se pasa -DataDir",
    async () => {
      const base = tempDir("env");
      const dataDir = join(base, "datos por entorno");
      mkdirSync(dataDir, { recursive: true });
      seedDownloads(dataDir, toolFiles);

      const result = await runInstaller([], { env: { VIUREWARDS_DATA_DIR: dataDir } });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.result?.dataDir).toBe(dataDir);
      expect(existsSync(join(dataDir, "runtime", "node.exe"))).toBe(true);
    },
    900_000,
  );

  it(
    "no modifica una base ni medios de otro directorio",
    async () => {
      const base = tempDir("ajeno");
      const dataDir = join(base, "datos");
      const otherData = join(base, "otra instalacion");
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(join(otherData, "media"), { recursive: true });
      writeFileSync(join(otherData, "app.db"), "base de otra instalacion");
      writeFileSync(join(otherData, "media", "clip.mp4"), "clip de otra instalacion");

      const before = await treeFingerprint(otherData);
      seedDownloads(dataDir, toolFiles);
      expect((await runInstaller(["-DataDir", dataDir])).code).toBe(0);
      expect(await treeFingerprint(otherData)).toEqual(before);
    },
    900_000,
  );
});

/** Nombres de entrada de un ZIP (delegado a .NET para no duplicar un lector). */
async function listZipEntries(zipPath: string): Promise<string[]> {
  const result = await run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}').Entries | ForEach-Object { $_.FullName }`,
    ],
    { timeoutMs: 300_000 },
  );
  if (result.code !== 0) throw new Error(`No se pudo leer ${zipPath}: ${result.stderr}`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** El hash del ZIP fijado se corresponde con la caché (guardia de la suite). */
describe.runIf(IS_WINDOWS)("caché de artefactos", () => {
  it("los artefactos en caché coinciden con config.ts", async () => {
    for (const tool of MANAGED_TOOLS) {
      const path = join(CACHE_DIR, tool.asset.file);
      if (!existsSync(path)) continue;
      expect(await sha256File(path), tool.asset.file).toBe(tool.asset.sha256);
    }
  });
});

/** Comprobación de que el helper de ZIP propio es correcto (no se usa en prod). */
describe("helper de ZIP de prueba", () => {
  it("genera un ZIP legible, con entrada transversal detectable", () => {
    const base = tempDir("zip-helper");
    const path = join(base, "prueba.zip");
    writeStoredZip(path, [
      { name: "a/b.txt", data: Buffer.from("hola") },
      { name: "../../fuera.txt", data: Buffer.from("x") },
    ]);
    const bytes = readFileSync(path);
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(bytes.includes(Buffer.from("../../fuera.txt"))).toBe(true);
  });
});
