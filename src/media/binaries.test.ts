/**
 * Búsqueda de binarios con el directorio administrado (Fase de distribución,
 * Etapa 1).
 *
 * El punto delicado: `detectBinaries` derivaba `bin/` del directorio de trabajo.
 * En distribución el directorio de herramientas administradas vive en el
 * directorio de datos (`<VIUREWARDS_DATA_DIR>/bin`), así que debe poder pasarse
 * ya resuelto y tener prioridad. Sin `binDir` se conserva el comportamiento
 * histórico.
 *
 * Todo con directorios temporales y `exists` inyectado o archivos vacíos: nunca
 * se ejecuta ningún binario.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { binaryCandidates, detectBinaries, findBinary } from "./binaries.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix = "viu-bin-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Coloca los tres binarios (vacíos) en `dir`. */
function plantTools(dir: string, platform: NodeJS.Platform, ext = ".exe"): void {
  mkdirSync(dir, { recursive: true });
  const suffix = platform === "win32" ? ext : "";
  for (const name of ["yt-dlp", "ffmpeg", "ffprobe"]) writeFileSync(join(dir, `${name}${suffix}`), "");
}

describe("findBinary", () => {
  it("el binDir administrado tiene prioridad sobre el PATH", () => {
    const managed = makeDir();
    const onPath = makeDir();
    plantTools(managed, "win32");
    plantTools(onPath, "win32");

    const found = findBinary("yt-dlp", {
      binDir: managed,
      pathEnv: onPath,
      platform: "win32",
    });
    expect(found).toBe(join(managed, "yt-dlp.exe"));
  });

  it("si el binDir no tiene la herramienta, sigue con el PATH", () => {
    const managed = makeDir();
    const onPath = makeDir();
    plantTools(onPath, "win32");

    const found = findBinary("yt-dlp", { binDir: managed, pathEnv: onPath, platform: "win32" });
    expect(found).toBe(join(onPath, "yt-dlp.exe"));
  });

  it("respeta el orden: binDir, extraDirs y después el PATH", () => {
    const managed = makeDir();
    const extra = makeDir();
    const onPath = makeDir();
    plantTools(extra, "win32");
    plantTools(onPath, "win32");

    // Sin binDir: primero extraDirs.
    expect(findBinary("ffmpeg", { extraDirs: [extra], pathEnv: onPath, platform: "win32" })).toBe(
      join(extra, "ffmpeg.exe"),
    );
    // Con binDir y la herramienta presente: gana binDir.
    plantTools(managed, "win32");
    expect(
      findBinary("ffmpeg", { binDir: managed, extraDirs: [extra], pathEnv: onPath, platform: "win32" }),
    ).toBe(join(managed, "ffmpeg.exe"));
  });

  it("en Windows no acepta .cmd ni .bat (no se lanzan sin shell)", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "yt-dlp.cmd"), "");
    const found = findBinary("yt-dlp", { extraDirs: [dir], pathEnv: "", platform: "win32" });
    expect(found).toBeNull();
  });

  it("las rutas con espacios se devuelven tal cual (spawn las recibe en un array)", () => {
    const base = makeDir();
    const managed = join(base, "Mis Herramientas");
    plantTools(managed, "win32");
    const found = findBinary("ffmpeg", { binDir: managed, pathEnv: "", platform: "win32" });
    expect(found).toBe(join(managed, "ffmpeg.exe"));
    expect(found).toContain("Mis Herramientas");
  });

  it("en Unix busca el nombre sin extensión", () => {
    expect(binaryCandidates("yt-dlp", "linux")).toEqual(["yt-dlp"]);
    const dir = makeDir();
    plantTools(dir, "linux");
    expect(findBinary("yt-dlp", { extraDirs: [dir], pathEnv: "", platform: "linux" })).toBe(
      join(dir, "yt-dlp"),
    );
  });
});

describe("detectBinaries", () => {
  it("usa el binDir administrado que se le pasa", () => {
    const managed = makeDir();
    plantTools(managed, "win32");
    const detection = detectBinaries({ binDir: managed, pathEnv: "", platform: "win32" });
    expect(detection.ok).toBe(true);
    if (!detection.ok) return;
    expect(detection.binaries.ytDlp).toBe(join(managed, "yt-dlp.exe"));
    expect(detection.binaries.ffmpeg).toBe(join(managed, "ffmpeg.exe"));
    expect(detection.binaries.ffprobe).toBe(join(managed, "ffprobe.exe"));
  });

  it("sin binDir conserva el histórico `bin/` relativo", () => {
    // Se hace evidente con `exists` inyectado: se observa qué candidato consulta.
    const probed: string[] = [];
    detectBinaries({
      pathEnv: "",
      platform: "win32",
      exists: (path) => {
        probed.push(path);
        return false;
      },
    });
    // El primer candidato buscado es `bin/yt-dlp.exe` (relativo, como antes).
    expect(probed[0]).toBe(join("bin", "yt-dlp.exe"));
  });

  it("sin binDir explícito sigue mirando `bin/` (aunque se pasen extraDirs)", () => {
    const extra = makeDir();
    const probed: string[] = [];
    detectBinaries({
      extraDirs: [extra],
      pathEnv: "",
      platform: "win32",
      exists: (path) => {
        probed.push(path);
        return false;
      },
    });
    expect(probed).toContain(join(extra, "yt-dlp.exe"));
    // El histórico `bin/` se sigue consultando (y gana al resto) para no cambiar
    // el comportamiento de desarrollo cuando no se configura un directorio.
    expect(probed).toContain(join("bin", "yt-dlp.exe"));
    expect(probed.indexOf(join("bin", "yt-dlp.exe"))).toBeLessThan(
      probed.indexOf(join(extra, "yt-dlp.exe")),
    );
  });

  it("informa en español qué falta y dónde ponerlo", () => {
    const detection = detectBinaries({ binDir: makeDir(), pathEnv: "", platform: "win32" });
    expect(detection.ok).toBe(false);
    if (detection.ok) return;
    expect(detection.missing).toEqual(["yt-dlp", "ffmpeg", "ffprobe"]);
    expect(detection.message).toContain("Faltan binarios externos");
    expect(detection.message).toContain("carpeta bin/");
  });

  it("basta con que falte uno para no dar la detección por buena", () => {
    const managed = makeDir();
    plantTools(managed, "win32");
    rmSync(join(managed, "ffprobe.exe"));
    const detection = detectBinaries({ binDir: managed, pathEnv: "", platform: "win32" });
    expect(detection.ok).toBe(false);
    if (detection.ok) return;
    expect(detection.missing).toEqual(["ffprobe"]);
  });
});
