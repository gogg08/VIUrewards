import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProcessSupervisor, killProcessTree } from "./run-process.ts";

const node = process.execPath;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "viu-proc-"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pids hijos directos de `parent`, sin `wmic`.
 *
 * `wmic` está obsoleto y ya no existe en `windows-latest` (medido: el runner
 * fallaba con `spawnSync wmic ENOENT`). Se usa `Get-CimInstance Win32_Process`,
 * que está en cualquier Windows con PowerShell 5.1.
 *
 * Devuelve `null` si la consulta falló: distinguir "no hay hijos" de "no se
 * pudo preguntar" importa, porque el test afirma que el nieto EXISTE.
 */
function childPids(parent: number): number[] | null {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // La canalización va al final de la línea anterior: PowerShell no acepta
    // empezar una línea con `|` ("elementos de canalización vacíos").
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parent}' -Property ProcessId -ErrorAction Stop |`,
    "  ForEach-Object { $_.ProcessId }",
  ].join("\n");
  try {
    const listing = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    // Una línea por pid; se descarta cualquier cosa que no sea un entero.
    return listing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
  } catch {
    return null;
  }
}

describe("supervisor de procesos: cancelación real", () => {
  it("cancela una ejecución viva y resuelve como cancelada (no como éxito)", async () => {
    const supervisor = createProcessSupervisor();
    const controller = new AbortController();
    const started = Date.now();
    const pending = supervisor.run(node, ["-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await sleep(200);
    expect(supervisor.running()).toHaveLength(1);
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(supervisor.running()).toHaveLength(0);
  });

  it("cancelAll espera a que el proceso muera", async () => {
    const supervisor = createProcessSupervisor();
    const pending = supervisor.run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 60_000 });
    await sleep(200);
    const pid = supervisor.running()[0]?.pid;
    expect(pid).toBeDefined();
    // cancelAll es asíncrona: al resolver, el proceso YA murió.
    const cancelled = await supervisor.cancelAll();
    expect(cancelled).toBe(1);
    // Sin esperar nada más: el supervisor ya no tiene el proceso vivo.
    expect(supervisor.running()).toHaveLength(0);
    expect(alive(pid as number)).toBe(false);
    const result = await pending;
    expect(result.cancelled).toBe(true);
  });

  it("una señal ya abortada no lanza ningún proceso", async () => {
    const supervisor = createProcessSupervisor();
    const controller = new AbortController();
    controller.abort();
    const result = await supervisor.run(node, ["-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 1000,
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(supervisor.running()).toHaveLength(0);
  });

  it("el timeout sigue funcionando", async () => {
    const supervisor = createProcessSupervisor();
    const result = await supervisor.run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBeFalsy();
  });

  it("termina también a los descendientes (árbol)", async () => {
    if (process.platform !== "win32") return; // la verificación usa la tabla de procesos de Windows
    const dir = tmp();
    const log = join(dir, "nieto.log");
    const script = join(dir, "abuelo.cjs");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      script,
      `const { spawn } = require("node:child_process");
       spawn(process.execPath, ["-e", ${JSON.stringify(
         `setTimeout(() => require("node:fs").appendFileSync(${JSON.stringify(log)}, "nieto vivo\\n"), 5000)`,
       )}], { stdio: "ignore" });
       setTimeout(() => {}, 60000);`,
    );
    const supervisor = createProcessSupervisor();
    const pending = supervisor.run(node, [script], { timeoutMs: 60_000 });
    await sleep(700);
    const root = supervisor.running()[0]?.pid as number;
    expect(alive(root)).toBe(true);
    // El nieto existe mientras el abuelo corre: se busca por parentesco.
    const children = childPids(root);
    expect(children, "la enumeración de procesos descendientes falló").not.toBeNull();
    expect((children as number[]).length, "el abuelo no tenía ningún hijo").toBeGreaterThan(0);
    const grandchildPid = (children as number[])[0];
    expect(Number.isInteger(grandchildPid)).toBe(true);
    // El nieto está vivo ANTES de cancelar (si no, la prueba no verifica nada).
    expect(alive(grandchildPid)).toBe(true);
    expect(await supervisor.cancelAll()).toBe(1);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    await sleep(6000);
    expect(existsSync(log)).toBe(false);
    expect(alive(grandchildPid)).toBe(false);
    expect(alive(root)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("killProcessTree no falla con un pid inexistente", async () => {
    await expect(killProcessTree(999_999, process.platform)).resolves.toBeUndefined();
  });
});
