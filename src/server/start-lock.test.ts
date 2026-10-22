/**
 * Ciclo de vida del cerrojo compartido en el ARRANQUE real (`main()`).
 *
 * Se llama a `main()` en el proceso de test con `cwd` en una carpeta temporal
 * (nunca la raíz del repositorio): `scripts/start.ts` resuelve `data/`, `media/`,
 * `logs/` y `.uploads/` con `process.cwd()`.
 *
 *  1. La primera instancia arranca, deja su cerrojo en la raíz y sirve HTTP.
 *  2. `main()` otra vez sobre la MISMA raíz rechaza con `SharedDataInUseError`
 *     sin abrir una segunda base ni reconciliar la biblioteca, y el cerrojo de
 *     la primera queda intacto.
 *  3. El cierre ordenado (la misma ruta que instala `main()` en SIGINT) libera
 *     el cerrojo.
 *  4. Un fallo al arrancar DESPUÉS de tomar el cerrojo (puerto ocupado) lo
 *     libera igual.
 *  5. Por texto: la exclusividad se comprueba ANTES de abrir la base, y el
 *     `catch` de `openDatabase` libera el cerrojo propio.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../scripts/start.ts";
import { SHARED_RESOURCES_LOCK_FILE } from "../db/instance-lock.ts";
import { SharedDataInUseError } from "../db/instance-lock-error.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeInstallation(): string {
  const root = mkdtempSync(join(tmpdir(), "viu-start-lock-"));
  dirs.push(root);
  for (const dir of ["media", "logs", "data", ".uploads"]) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

/** Corre `fn` con `cwd` en `dir` (el arranque usa rutas relativas al cwd). */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

/** Silencia la salida de la consola (el arranque imprime mucho). */
async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Arranca `main()` con el puerto indicado y devuelve un `stop` que ejecuta el
 * MISMO manejador de SIGINT que instaló `main()` (el cierre ordenado real), con
 * `process.exit` interceptado para no matar el proceso de test.
 */
async function startMain(root: string, port: number): Promise<{ stop: () => Promise<void> }> {
  const previousPort = process.env.PORT;
  const listenersBefore = process.listeners("SIGINT");
  process.env.PORT = String(port);
  try {
    await silently(() => withCwd(root, () => main()));
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  const added = process.listeners("SIGINT").filter((listener) => !listenersBefore.includes(listener));
  const handler = added[0];
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (stopped) return stopped;
    stopped = (async () => {
      if (!handler) return;
      process.off("SIGINT", handler);
      const original = process.exit;
      let exitCode: number | null = null;
      process.exit = ((code?: number) => {
        exitCode = code ?? 0;
        return undefined as never;
      }) as typeof process.exit;
      try {
        (handler as () => void)();
        // El controlador resuelve su promesa y llama a `exit(0)`.
        const deadline = Date.now() + 20_000;
        while (exitCode === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        process.exit = original;
      }
    })();
    return stopped;
  };
  return { stop };
}

describe("main() y el cerrojo de recursos compartidos", () => {
  it(
    "la segunda instancia no arranca, no toca el cerrojo ajeno y el cierre lo libera",
    { timeout: 60_000 },
    async () => {
      const root = makeInstallation();
      const running = await startMain(root, await freePort());
      try {
        const lockPath = join(root, SHARED_RESOURCES_LOCK_FILE);
        expect(existsSync(lockPath)).toBe(true);
        const lockBefore = readFileSync(lockPath, "utf8");
        expect((JSON.parse(lockBefore) as { pid: number }).pid).toBe(process.pid);

        // Segunda instancia sobre la MISMA raíz.
        const error = await withCwd(root, async () => {
          try {
            await silently(() => main());
            return null;
          } catch (caught) {
            return caught;
          }
        });
        expect(error).toBeInstanceOf(SharedDataInUseError);
        expect((error as SharedDataInUseError).reason).toContain("Otra copia");
        // No tocó el cerrojo de la primera ni sirvió nada.
        expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
      } finally {
        await running.stop();
      }
      // El cierre ordenado libera el cerrojo.
      expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
    },
  );

  it(
    "un fallo al arrancar después de tomar el cerrojo lo libera (puerto ocupado)",
    { timeout: 60_000 },
    async () => {
      const root = makeInstallation();
      const port = await freePort();
      // Se ocupa el puerto antes de arrancar: `server.start()` falla, pero
      // después de que el cerrojo y la base ya estaban abiertos.
      const blocker = net.createServer();
      await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()));
      try {
        const previousPort = process.env.PORT;
        process.env.PORT = String(port);
        try {
          const error = await withCwd(root, async () => {
            try {
              await silently(() => main());
              return null;
            } catch (caught) {
              return caught;
            }
          });
          expect(error).not.toBeNull();
        } finally {
          if (previousPort === undefined) delete process.env.PORT;
          else process.env.PORT = previousPort;
        }
        // La instancia que no arrancó no deja el cerrojo tomado.
        expect(existsSync(join(root, SHARED_RESOURCES_LOCK_FILE))).toBe(false);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    },
  );
});

describe("el orden del arranque (texto de scripts/start.ts)", () => {
  const source = readFileSync(new URL("../../scripts/start.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function main("));

  it("comprueba la exclusividad ANTES de abrir la base, reconciliar y servir", () => {
    const lockAt = body.indexOf("acquireSharedResourcesLock(");
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(body.indexOf("openDatabase("));
    expect(lockAt).toBeLessThan(body.indexOf("await reconcileClips("));
    expect(lockAt).toBeLessThan(body.indexOf("await createServer("));
    // Quien no obtiene la exclusividad no sigue.
    const beforeDb = body.slice(lockAt, body.indexOf("openDatabase(", lockAt));
    expect(beforeDb).toContain("if (!sharedLock.acquired)");
    expect(beforeDb).toContain("throw new SharedDataInUseError(");
  });

  it("si la base no se abre, libera el cerrojo propio", () => {
    const lockAt = body.indexOf("acquireSharedResourcesLock(");
    const dbAt = body.indexOf("openDatabase(", lockAt);
    const catchAt = body.indexOf("} catch (error) {", dbAt);
    const releaseAt = body.indexOf("sharedLock.release();", catchAt);
    const nextRelevant = body.indexOf("acquireInstanceLock(", dbAt);
    expect(catchAt).toBeGreaterThan(dbAt);
    expect(releaseAt).toBeGreaterThan(catchAt);
    expect(releaseAt).toBeLessThan(nextRelevant);
  });
});
