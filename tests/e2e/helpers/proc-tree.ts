/**
 * Limpieza de los procesos que crean los tests e2e.
 *
 * El problema real (medido en Windows, no supuesto): `child.kill("SIGKILL")`
 * termina **solo el proceso directo**. Un descendiente que el hijo lanzó sigue
 * vivo (probado: el nieto sobrevivió al kill del padre) y solo moría de rebote
 * cuando el padre salía por su propio camino de cierre. Si el test falla a
 * mitad de camino, ese descendiente queda huérfano.
 *
 * Cómo se resuelve, sin dependencias y sin tocar procesos ajenos:
 *
 * 1. **Espía** (`spyOnChildProcess`): registra TODO proceso lanzado en este
 *    proceso de test, incluidas las importaciones ESM con nombre de
 *    `child_process` (el `spawn` de `src/media/run-process.ts`, el de ffprobe).
 *    Se hace con un **Proxy sobre el módulo** + `syncBuiltinESMExports()`;
 *    asignar `cp.spawn = fn` NO alcanza (verificado).
 * 2. **Lista blanca**: los pids que existían antes de empezar (los padres del
 *    test y los shells del sistema) son ajenos. Todo lo demás que aparezca en
 *    este proceso lo creó el test.
 * 3. **Solo descendencia propia** (`ownTreePids`): desde el proceso de test se
 *    baja por `ParentProcessId`; desde cada hijo visto por el espía se sube a
 *    sus ancestros. Se une y se descarta la línea de padres del test. Nunca se
 *    busca un proceso por puerto ni por nombre.
 * 4. **Validación antes de señalizar** (`killOwnTree`): el pid tiene que seguir
 *    vivo y —cuando se conoce la línea de comandos esperada— seguir siendo el
 *    mismo proceso (un pid reciclado se deja intacto). Cada pid se espera con
 *    `waitGone`; si no muere se escala al `killProcessTree` del **supervisor de
 *    producción** (Windows: `taskkill /PID <pid> /T /F` sin shell; Unix: el
 *    grupo) solo para ese pid. Lo que sobreviva se devuelve y el test **falla**.
 *
 * Unix: no se usa `kill(-pid)` sobre un grupo supuesto, porque los hijos del
 * arnés no se lanzan `detached`. El recorrido por parentesco cubre el caso y
 * es seguro en ambas plataformas.
 */

import cp from "node:child_process";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { killProcessTree } from "../../../src/media/run-process.ts";

export const IS_WINDOWS = process.platform === "win32";

/** Espera máxima, por proceso, antes de escalar al kill del árbol. */
export const KILL_WAIT_MS = 5_000;
/** Espera máxima después de escalar. */
export const FORCE_WAIT_MS = 10_000;

let spawnedPids: number[] = [];
let originalSpawn: typeof cp.spawn | null = null;
let baseline = new Set<number>();

export interface SpawnSpy {
  /** Pids que se lanzaron en este proceso desde que se instaló el espía. */
  spawned(): number[];
  restore(): void;
}

/**
 * Registra los pids de todo proceso lanzado en este proceso de test.
 *
 * Idempotente: instalarlo dos veces no duplica el registro.
 */
export function spyOnChildProcess(): SpawnSpy {
  if (originalSpawn === null) {
    const original = cp.spawn;
    originalSpawn = original;
    const patched = ((...args: Parameters<typeof original>) => {
      const child = original(...args);
      if (typeof child.pid === "number") spawnedPids.push(child.pid);
      return child;
    }) as typeof original;
    // Las importaciones `import { spawn } from "node:child_process"` leen el
    // getter del módulo: se reemplaza el descriptor y se re-vinculan los
    // exports de los builtins (probado: sin esto el espía no ve nada).
    Object.defineProperty(cp, "spawn", {
      configurable: true,
      enumerable: true,
      get: () => patched,
    });
    syncBuiltinESMExports();
  }
  return {
    spawned: () => [...spawnedPids],
    restore: () => {
      restoreSpawn();
    },
  };
}

/** Vuelve `spawn` a la normalidad y olvida los pids registrados. */
export function restoreSpawn(): void {
  if (originalSpawn !== null) {
    Object.defineProperty(cp, "spawn", {
      configurable: true,
      enumerable: true,
      value: originalSpawn,
      writable: true,
    });
    originalSpawn = null;
    syncBuiltinESMExports();
  }
  spawnedPids = [];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: existe pero es de otro usuario; se cuenta como vivo (conservador).
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

/** Espera a que el pid desaparezca. Devuelve `true` si se fue. */
export async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  cmd: string;
}

/**
 * Tabla de procesos (solo lectura).
 *
 * Windows: `wmic`. Unix: `ps`. `execFileSync` espera a que el proceso termine,
 * así que no deja procesos que limpiar.
 */
export function processTable(): ProcessRow[] {
  try {
    if (IS_WINDOWS) {
      const out = execFileSync(
        "wmic",
        ["process", "get", "ProcessId,ParentProcessId,CommandLine", "/format:list"],
        { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      );
      const rows: ProcessRow[] = [];
      for (const block of out.split(/\r?\n\r?\n/)) {
        const pid = /ProcessId=(\d+)/.exec(block)?.[1];
        if (!pid) continue;
        rows.push({
          pid: Number(pid),
          ppid: Number(/ParentProcessId=(\d+)/.exec(block)?.[1] ?? 0),
          cmd: (/CommandLine=(.*)/.exec(block)?.[1] ?? "").trim(),
        });
      }
      return rows;
    }
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const rows: ProcessRow[] = [];
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3].trim() });
    }
    return rows;
  } catch {
    return [];
  }
}

/** Cadena de padres del proceso actual (incluido el propio proceso). */
export function parentChain(table: ProcessRow[] = processTable()): number[] {
  const chain: number[] = [process.pid];
  let cursor = process.pid;
  for (let depth = 0; depth < 8; depth++) {
    const parent = table.find((row) => row.pid === cursor)?.ppid;
    if (parent === undefined || parent === 0 || chain.includes(parent)) break;
    chain.push(parent);
    cursor = parent;
  }
  return chain;
}

/**
 * Fija qué procesos ya existían (lista blanca): la línea de padres del test y
 * los shells del sistema (`cmd.exe`, que es lo que lanza `wmic`). Se llama al
 * empezar el archivo de test.
 */
export function captureBaseline(extra: number[] = []): void {
  baseline = new Set(parentChain());
  for (const pid of extra) baseline.add(pid);
  for (const row of processTable()) {
    if (/(^|[\\/])cmd\.exe$/i.test(row.cmd)) baseline.add(row.pid);
  }
}

/** Cuántos procesos existen (para el diagnóstico de los tests). */
export function baselineSize(): number {
  return baseline.size;
}

function descendantsOf(table: ProcessRow[], root: number): number[] {
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const row of table) {
      if (row.ppid === current && row.pid !== current && !found.includes(row.pid)) {
        found.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

function ancestorsOf(table: ProcessRow[], pid: number): number[] {
  const found: number[] = [];
  let cursor = table.find((row) => row.pid === pid)?.ppid;
  while (cursor !== undefined && cursor !== 0 && !found.includes(cursor)) {
    found.push(cursor);
    cursor = table.find((row) => row.pid === cursor)?.ppid;
  }
  return found;
}

export interface OwnTreeOptions {
  /** Pids raíz que el test conserva (p. ej. el `ChildProcess` del arnés). */
  roots?: number[];
  /** Pids conocidos de antemano como ajenos. */
  extra?: number[];
}

export interface OwnTree {
  /** Todo lo que el test creó (sin el proceso de test ni sus padres). */
  targets: number[];
  /** Procesos de la línea de padres: nunca se tocan. */
  protectedPids: number[];
}

/**
 * Calcula los procesos propios del test.
 *
 * `targets`: hijos directos y descendientes del proceso de test, más los pids
 * del espía con sus ancestros, menos la línea de padres. Los pids de la lista
 * blanca que no sean ancestros de un hijo propios se excluyen.
 */
export function ownTree(options: OwnTreeOptions = {}): OwnTree {
  const table = processTable();
  const chain = parentChain(table);
  const white = new Set([...baseline, ...chain, ...(options.extra ?? [])]);
  const roots = new Set((options.roots ?? []).filter((pid) => !chain.includes(pid) && pid !== process.pid));
  const targets = new Set<number>();

  // 1) Lo que el arnés pidió limpiar explícitamente.
  for (const pid of roots) targets.add(pid);

  // 2) Lo que el espía vio lanzar y no es de la lista blanca.
  for (const pid of spawnedPids) {
    if (!white.has(pid) && !chain.includes(pid)) targets.add(pid);
  }

  // 3) Descendencia del proceso de test (cubre nietos que el espía no vio).
  for (const pid of descendantsOf(table, process.pid)) {
    if (!white.has(pid)) targets.add(pid);
  }

  // 4) Descendencia y ancestros de cada candidato (el espía puede haber visto
  //    a un nieto; sus ancestros también son del test).
  for (const pid of [...targets]) {
    if (white.has(pid) && !roots.has(pid)) continue;
    for (const child of descendantsOf(table, pid)) {
      if (!white.has(child)) targets.add(child);
    }
    for (const ancestor of ancestorsOf(table, pid)) {
      if (!chain.includes(ancestor) && ancestor !== process.pid) targets.add(ancestor);
    }
  }

  for (const pid of chain) targets.delete(pid);
  targets.delete(process.pid);
  return { targets: [...targets], protectedPids: chain };
}

/**
 * Comprueba que el pid siga siendo el mismo proceso antes de señalizarlo.
 *
 * Con `expectedCmd`, el proceso actual debe contenerla: un pid reciclado
 * muestra otra línea de comandos y se deja intacto.
 */
export function isSameProcess(pid: number, expectedCmd?: string): boolean {
  if (!isAlive(pid)) return false;
  if (!expectedCmd) return true;
  const row = processTable().find((entry) => entry.pid === pid);
  // Sin tabla (wmic falló) se prefiere no tocar nada.
  return row !== undefined && row.cmd.includes(expectedCmd);
}

export interface KillResult {
  killed: number[];
  /** Pids que siguen vivos después de la escalada. */
  survivors: number[];
}

/**
 * Termina la descendencia del test y espera a que muera.
 *
 * - Solo pids de `ownTree`: nunca un proceso buscado por puerto o nombre.
 * - Valida que no sea el propio test ni un padre, y que el pid siga siendo el
 *   mismo proceso antes de señalizarlo.
 * - Hojas primero: si el padre muere antes, el hijo queda huérfano pero vivo.
 * - Escala al `killProcessTree` de producción solo para el pid concreto.
 * - Devuelve los que sobrevivieron para que el test falle con nombre y apellido.
 */
export async function killOwnTree(options: OwnTreeOptions = {}): Promise<KillResult> {
  const killed: number[] = [];
  const { targets, protectedPids } = ownTree(options);
  const table = processTable();
  const depthOf = (pid: number): number => ancestorsOf(table, pid).length;
  const ordered = targets
    .filter((pid) => pid !== process.pid && !protectedPids.includes(pid))
    .sort((a, b) => depthOf(b) - depthOf(a));

  for (const pid of ordered) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid);
      killed.push(pid);
    } catch {
      // Ya murió o no se puede señalizar: se decide por `isAlive` más abajo.
    }
  }

  const survivors: number[] = [];
  for (const pid of ordered) {
    if (await waitGone(pid, KILL_WAIT_MS)) continue;
    // No murió: se escala al mecanismo del supervisor SOLO para este pid.
    await killProcessTree(pid);
    if (await waitGone(pid, FORCE_WAIT_MS)) continue;
    survivors.push(pid);
  }
  return { killed, survivors };
}

/** Error de limpieza con la lista de sobrevivientes (para fallar el test). */
export function describeSurvivors(survivors: number[]): string {
  const table = processTable();
  const detail = survivors
    .map((pid) => {
      const row = table.find((entry) => entry.pid === pid);
      return `${pid}${row ? ` (${row.cmd.slice(0, 120)})` : ""}`;
    })
    .join(", ");
  return `quedaron procesos del test vivos después de la limpieza: ${detail}`;
}

/** Pids hijos directos (diagnóstico). */
export function directChildren(pid: number): number[] {
  return processTable()
    .filter((row) => row.ppid === pid)
    .map((row) => row.pid);
}

export { killProcessTree };
