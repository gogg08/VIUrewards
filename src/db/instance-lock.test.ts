/**
 * Exclusividad de instancia: pruebas REALES sobre archivos de cerrojo en una
 * carpeta temporal (nunca `data/instance.lock` del usuario).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireInstanceLock, acquireSharedResourcesLock, DEFAULT_LOCK_MAX_AGE_MS, INSTANCE_LOCK_FILE, SHARED_RESOURCES_LOCK_FILE } from "./instance-lock.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "instance-lock-"));
  dirs.push(dir);
  return join(dir, "app.db");
}

function lockPath(dbPath: string): string {
  return join(dbPath, "..", INSTANCE_LOCK_FILE);
}

/** Escribe un cerrojo a mano (simula una ejecución anterior). */
function writeLock(dbPath: string, contents: unknown): void {
  writeFileSync(lockPath(dbPath), typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

describe("exclusividad de instancia", () => {
  it("la primera instancia obtiene la exclusividad y crea el cerrojo", () => {
    const dbPath = tempDbPath();
    const lock = acquireInstanceLock(dbPath);
    try {
      expect(lock.acquired).toBe(true);
      expect(lock.message).toContain("exclusiva");
      expect(existsSync(lockPath(dbPath))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("una segunda instancia con el cerrojo de un proceso vivo NO obtiene la exclusividad", () => {
    const dbPath = tempDbPath();
    const first = acquireInstanceLock(dbPath);
    try {
      expect(first.acquired).toBe(true);
      const second = acquireInstanceLock(dbPath);
      expect(second.acquired).toBe(false);
      expect(second.message).toContain("Otra copia");
    } finally {
      first.release();
    }
  });

  it("al liberar el cerrojo, otra instancia pasa a poder tomarlo", () => {
    const dbPath = tempDbPath();
    const first = acquireInstanceLock(dbPath);
    expect(first.acquired).toBe(true);
    expect(acquireInstanceLock(dbPath).acquired).toBe(false);

    first.release();
    const retry = acquireInstanceLock(dbPath);
    try {
      expect(retry.acquired).toBe(true);
    } finally {
      retry.release();
    }
  });

  it("release es idempotente y borra el archivo una sola vez", () => {
    const dbPath = tempDbPath();
    const lock = acquireInstanceLock(dbPath);
    lock.release();
    lock.release();
    expect(existsSync(lockPath(dbPath))).toBe(false);
  });

  it("libera el cerrojo de una ejecución anterior cuyo proceso ya no existe", () => {
    const dbPath = tempDbPath();
    writeLock(dbPath, { pid: 424242, at: Date.now() });
    const lines: string[] = [];
    const lock = acquireInstanceLock(dbPath, { isAlive: () => false, log: (m) => lines.push(m) });
    try {
      expect(lock.acquired).toBe(true);
      expect(lines.join("\n")).toContain("pid 424242");
    } finally {
      lock.release();
    }
  });

  it("respeta el cerrojo de un proceso vivo aunque sea viejo (un pid puede reciclarse)", () => {
    const dbPath = tempDbPath();
    writeLock(dbPath, { pid: 424242, at: Date.now() - DEFAULT_LOCK_MAX_AGE_MS * 10 });
    const lock = acquireInstanceLock(dbPath, { isAlive: () => true });
    expect(lock.acquired).toBe(false);
  });

  it("un cerrojo ilegible reciente se respeta y uno viejo se libera", () => {
    const dbPath = tempDbPath();
    writeLock(dbPath, "no es json");
    // Reciente: no se puede asegurar que nadie lo esté usando.
    expect(acquireInstanceLock(dbPath, { isAlive: () => false }).acquired).toBe(false);

    // Viejo: un cerrojo que nunca se liberó no debe bloquear para siempre.
    const lock = acquireInstanceLock(dbPath, {
      isAlive: () => false,
      now: () => Date.now() + DEFAULT_LOCK_MAX_AGE_MS + 1,
    });
    try {
      expect(lock.acquired).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("un cerrojo de un proceso muerto se libera aunque esté recién escrito", () => {
    const dbPath = tempDbPath();
    writeLock(dbPath, { pid: 424242, at: Date.now() });
    const lock = acquireInstanceLock(dbPath, { isAlive: () => false });
    try {
      expect(lock.acquired).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("la ruta del cerrojo se puede cambiar (tests y modos avanzados)", () => {
    const dbPath = tempDbPath();
    const custom = join(dbPath, "..", "custom.lock");
    const lock = acquireInstanceLock(dbPath, { path: custom });
    try {
      expect(lock.acquired).toBe(true);
      expect(existsSync(custom)).toBe(true);
      expect(existsSync(join(dbPath, "..", INSTANCE_LOCK_FILE))).toBe(false);
    } finally {
      lock.release();
    }
  });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "shared-lock-"));
  dirs.push(dir);
  return dir;
}

describe("exclusividad de los recursos compartidos (media/, .uploads/, logs/)", () => {
  it("la primera instancia toma el cerrojo en la raíz compartida", () => {
    const root = tempRoot();
    const lock = acquireSharedResourcesLock(root);
    try {
      expect(lock.acquired).toBe(true);
      expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("dos copias con data/ distintas pero la misma media/ SÍ se ven entre sí", () => {
    // Cada copia tiene su base, pero comparten la carpeta de medios.
    const root = tempRoot();
    const first = acquireSharedResourcesLock(root);
    try {
      expect(first.acquired).toBe(true);
      const second = acquireSharedResourcesLock(root);
      expect(second.acquired).toBe(false);
      expect(second.message).toContain("Otra copia");
      // La segunda no borra el cerrojo de la primera al "liberar".
      second.release();
      expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(true);
    } finally {
      first.release();
    }
  });

  it("la ruta se normaliza: la misma raíz con otra forma cae en el mismo cerrojo", () => {
    const root = tempRoot();
    const first = acquireSharedResourcesLock(root);
    try {
      expect(first.acquired).toBe(true);
      expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(true);
      // `root`, `root/.` y `root/sub/..` son la MISMA raíz.
      const second = acquireSharedResourcesLock(join(root, "sub", ".."));
      expect(second.acquired).toBe(false);
      second.release();
      expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(true);
    } finally {
      first.release();
    }
  });

  it("el cerrojo queda en la raíz, nunca dentro de media/ (la recorre la reconciliación)", () => {
    const root = tempRoot();
    mkdirSync(join(root, "media"), { recursive: true });
    const lock = acquireSharedResourcesLock(root);
    try {
      expect(lock.acquired).toBe(true);
      expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(true);
      expect(existsSync(join(root, "media", SHARED_RESOURCES_LOCK_FILE))).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("al liberar el cerrojo compartido, otra copia puede tomarlo", () => {
    const root = tempRoot();
    const first = acquireSharedResourcesLock(root);
    expect(first.acquired).toBe(true);
    expect(acquireSharedResourcesLock(root).acquired).toBe(false);
    first.release();
    const retry = acquireSharedResourcesLock(root);
    try {
      expect(retry.acquired).toBe(true);
    } finally {
      retry.release();
    }
  });

  it("un cerrojo compartido de un proceso vivo se respeta aunque sea viejo", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, SHARED_RESOURCES_LOCK_FILE),
      JSON.stringify({ pid: 424242, at: Date.now() - DEFAULT_LOCK_MAX_AGE_MS * 10 }),
      "utf8",
    );
    const lock = acquireSharedResourcesLock(root, { isAlive: () => true });
    expect(lock.acquired).toBe(false);
    lock.release();
    expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(true);
  });

  it("un cerrojo compartido de una ejecución anterior (proceso muerto) se libera", () => {
    const root = tempRoot();
    writeFileSync(join(root, SHARED_RESOURCES_LOCK_FILE), JSON.stringify({ pid: 424242, at: Date.now() }), "utf8");
    const lines: string[] = [];
    const lock = acquireSharedResourcesLock(root, { isAlive: () => false, log: (m) => lines.push(m) });
    try {
      expect(lock.acquired).toBe(true);
      expect(lines.join("\n")).toContain("pid 424242");
    } finally {
      lock.release();
    }
  });
});
