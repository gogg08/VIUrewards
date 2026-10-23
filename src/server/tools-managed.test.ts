/**
 * El actualizador de yt-dlp y el directorio administrado (Etapa 1).
 *
 * En distribución `yt-dlp` vive en `<VIUREWARDS_DATA_DIR>/bin` y el botón del
 * dashboard tiene que consultar y actualizar ESE ejecutable: una actualización
 * de VIUrewards reemplaza el código, no la herramienta gestionada. Se inyecta
 * `run`, así que nunca se ejecuta `yt-dlp -U` de verdad.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunProcess } from "../media/run-process.ts";
import { readToolVersions, updateYtdlp } from "./tools.ts";

const temps: string[] = [];

function makeTemp(prefix = "viu-managed-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Crea los tres binarios (vacíos) en `dir`. */
function plantTools(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ["yt-dlp", "ffmpeg", "ffprobe"]) writeFileSync(join(dir, `${name}.exe`), "");
}

/** Ejecutor falso que anota qué comando recibió y responde ok. */
function spyRun(version = "2026.08.19"): { run: RunProcess; commands: string[] } {
  const commands: string[] = [];
  const run: RunProcess = async (command) => {
    commands.push(command);
    return { code: 0, stdout: version, stderr: "", timedOut: false };
  };
  return { run, commands };
}

/** Búsqueda que solo mira el binario administrado, sin tocar el PATH real. */
function managedSearch(binDir: string) {
  return { binDir, pathEnv: "", platform: "win32" as const };
}

describe("actualizador de yt-dlp con el directorio administrado", () => {
  it("lee la versión del yt-dlp administrado", async () => {
    const managed = makeTemp();
    plantTools(managed);
    const { run, commands } = spyRun();

    const versions = await readToolVersions({ run, binarySearch: managedSearch(managed) });

    expect(versions.ytDlp).toBe("2026.08.19");
    expect(commands).toContain(join(managed, "yt-dlp.exe"));
  });

  it("`-U` se ejecuta sobre el ejecutable administrado, no sobre otro del PATH", async () => {
    const managed = makeTemp();
    const onPath = makeTemp("viu-path-");
    plantTools(managed);
    plantTools(onPath);
    const { run, commands } = spyRun();

    const result = await updateYtdlp({
      run,
      // Aunque el PATH tenga su propio yt-dlp, gana el administrado.
      binarySearch: { ...managedSearch(managed), pathEnv: onPath },
    });

    expect(result.ok).toBe(true);
    expect(commands).toEqual([join(managed, "yt-dlp.exe")]);
  });

  it("la actualización no reemplaza el binario por sí misma: solo invoca `-U`", async () => {
    // Contrato observable: `updateYtdlp` no escribe ni copia archivos; deja que el
    // propio yt-dlp se actualice (así un fallo de permisos no lo daña).
    const managed = makeTemp();
    plantTools(managed);
    writeFileSync(join(managed, "yt-dlp.exe"), "contenido-original");
    const { run, commands } = spyRun();

    await updateYtdlp({ run, binarySearch: managedSearch(managed) });

    // Un único proceso, con un único argumento: `-U`.
    expect(commands).toHaveLength(1);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(managed, "yt-dlp.exe"), "utf8")).toBe("contenido-original");
  });

  it("sin herramientas en el directorio administrado avisa y no ejecuta nada", async () => {
    const managed = makeTemp();
    const { run, commands } = spyRun();

    const result = await updateYtdlp({ run, binarySearch: managedSearch(managed) });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Faltan binarios externos");
    expect(commands).toEqual([]);
  });

  it("rutas con espacios llegan intactas como un solo argumento", async () => {
    const base = makeTemp();
    const managed = join(base, "Mis Herramientas");
    plantTools(managed);
    const seen: string[] = [];
    const run: RunProcess = async (command) => {
      seen.push(command);
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    };

    await updateYtdlp({ run, binarySearch: managedSearch(managed) });
    expect(seen[0]).toBe(join(managed, "yt-dlp.exe"));
    expect(seen[0]).toContain("Mis Herramientas");
  });
});
