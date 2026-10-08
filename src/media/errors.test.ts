import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { processVideo } from "./index.ts";
import type { FindBinaryOptions } from "./binaries.ts";
import type { RunProcess } from "./run-process.ts";

const SECRET_STDERR = "RAW_STDERR_SHOULD_NOT_LEAK_12345";

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "media-test-"));
  dirs.push(dir);
  return dir;
}

// Binarios "falsos" que existen siempre, sin tocar el PATH real.
const fakeBinaries: FindBinaryOptions = {
  pathEnv: "",
  extraDirs: ["/fake/bin"],
  platform: "linux",
  exists: () => true,
};

function failingRun(stderr: string): RunProcess {
  return async () => ({ code: 1, stdout: "", stderr, timedOut: false });
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("mensajes de error para el usuario", () => {
  it("no incluye el stderr crudo y lo guarda en un log en disco", async () => {
    const mediaDir = makeTempDir();
    const logsDir = makeTempDir();

    const result = await processVideo("https://youtu.be/abc", {
      mediaDir,
      logsDir,
      binarySearch: fakeBinaries,
      run: failingRun(`ERROR: algo salió mal\n${SECRET_STDERR}\nmas texto`),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // El mensaje es corto, en español y sin la salida cruda del proceso.
    expect(result.reason).toBe("DOWNLOAD_FAILED");
    expect(result.message).not.toContain(SECRET_STDERR);
    expect(result.message).not.toContain("ERROR: algo salió mal");
    expect(result.message.length).toBeLessThan(200);

    // El stderr crudo sí queda en el log.
    const logs = readdirSync(logsDir).filter((name) => name.endsWith(".log"));
    expect(logs).toHaveLength(1);
    const logBody = readFileSync(join(logsDir, logs[0]), "utf8");
    expect(logBody).toContain(SECRET_STDERR);
  });

  it("clasifica TOO_LONG con un mensaje que nombra el límite, sin stderr", async () => {
    const mediaDir = makeTempDir();
    const logsDir = makeTempDir();

    const result = await processVideo("https://youtu.be/abc", {
      mediaDir,
      logsDir,
      maxDurationSec: 90,
      binarySearch: fakeBinaries,
      run: failingRun("ERROR: This video does not pass filter duration <= 90"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("TOO_LONG");
    expect(result.message).toBe("El video dura más de 90 s (límite configurado).");
    expect(result.message).not.toContain("does not pass filter");
  });
});