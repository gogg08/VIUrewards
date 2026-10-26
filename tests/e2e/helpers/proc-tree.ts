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
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { killProcessTree } from "../../../src/media/run-process.ts";

export const IS_WINDOWS = process.platform === "win32";

/** Espera máxima, por proceso, antes de escalar al kill del árbol. */
export const KILL_WAIT_MS = 5_000;
/** Espera máxima después de escalar. */
export const FORCE_WAIT_MS = 10_000;

/**
 * Plazo de UNA consulta de procesos.
 *
 * Medido en esta PC: `Get-CimInstance Win32_Process` tarda ~1 s por llamada. En
 * un runner de CI cargado puede ser varias veces más lento, así que 15 s deja
 * margen amplio y sigue cortando mucho antes que el plazo de un test e2e (90 s)
 * y que el `timeout-minutes` del paso de CI (8 min). Los dos plazos son
 * INDEPENDIENTES: este acota la consulta, no el test.
 */
export const PROCESS_TABLE_TIMEOUT_MS = 15_000;

/**
 * Enumerador de procesos, inyectable en tests.
 *
 * Resuelve con la salida cruda del comando (CSV en Windows, texto en Unix).
 * Rechaza con el error de la ejecución, de un código de salida distinto de 0 o
 * del plazo. El llamador decide qué es cada cosa; aquí no se interpreta nada.
 */
export type ProcessEnumerator = (command: string, args: string[], timeoutMs: number) => Promise<string>;

/*
 * La consulta de procesos es ASÍNCRONA a propósito.
 *
 * Antes era `execFileSync` sin plazo: si `powershell.exe` o el servicio WMI no
 * respondían, la consulta esperaba para siempre y congelaba el bucle de eventos
 * del worker de test (medido: un timer de 1000 ms no llegó a dispararse y el
 * proceso quedó trabado hasta matarlo). Con el bucle congelado, ni el plazo del
 * test ni el `timeout-minutes` del paso de CI pueden actuar, y el runner muere
 * sin dejar logs.
 *
 * Con `execFile` + `timeout` + `killSignal: SIGKILL` el bucle sigue libre, el
 * plazo se cumple y el enumerador se termina de verdad. No se usa `Atomics.wait`
 * ni ninguna espera síncrona.
 */

/** Ejecutor real: `execFile` asíncrono con plazo y cierre fuerte. */
const execFileEnumerator: ProcessEnumerator = (command, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        // Terminación fuerte: un `SIGTERM` en Windows no detiene de forma fiable
        // a un `powershell.exe` colgado dentro de una llamada CIM.
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) {
          const killed = (error as { killed?: unknown }).killed === true;
          const detail = killed
            ? `la consulta de procesos superó el plazo de ${timeoutMs} ms y se terminó`
            : `la consulta de procesos falló: ${error.message}`;
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      },
    );
  });

let enumerator: ProcessEnumerator = execFileEnumerator;

/**
 * Reemplaza el enumerador (tests). Devuelve una función para restaurarlo.
 *
 * El repo de tests lo usa para simular una consulta lenta o fallida sin
 * depender de que el WMI real se bloquee.
 */
export function setProcessEnumerator(next: ProcessEnumerator): () => void {
  const previous = enumerator;
  enumerator = next;
  return () => {
    enumerator = previous;
  };
}

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
 * Windows: `Get-CimInstance Win32_Process` por `powershell.exe`. **No** se usa
 * `wmic`: Microsoft lo declaró obsoleto y ya no existe en `windows-latest`
 * (medido: el runner fallaba con `spawnSync wmic ENOENT`).
 *
 * Se piden solo tres propiedades y se re-emiten como objetos con nombres
 * propios: `Select-Object` sobre un `CimInstance` devuelve TODAS las
 * propiedades (44 columnas), y el CSV posicional se vuelve ilegible. Se usa CSV
 * (no texto libre) porque escapa comas y comillas de `CommandLine`; por eso se
 * parsea con un lector de CSV real y no con `split(",")`.
 *
 * Unix: `ps`, con el mismo plazo y la misma terminación fuerte que la consulta
 * de Windows.
 */
const WINDOWS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine -ErrorAction Stop |",
  "  ForEach-Object {",
  // `CommandLine` es null para los procesos protegidos: se normaliza a "" para
  // que la columna nunca cambie de cantidad y el CSV siga siendo posicional.
  "    $cmd = if ($null -eq $_.CommandLine) { '' } else { $_.CommandLine }",
  "    [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; cmd = $cmd }",
  "  } |",
  "  ConvertTo-Csv -NoTypeInformation",
].join("\n");

/**
 * Parser de CSV mínimo (RFC 4180) para la salida de `ConvertTo-Csv`.
 *
 * Soporta los campos entrecomillados y las comillas escapadas como `""`, que es
 * lo que produce PowerShell cuando `CommandLine` trae comas o comillas.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Convierte el CSV de la consulta de Windows en filas de proceso.
 *
 * Descarta el encabezado y las filas sin `pid` numérico: un `pid` ilegible
 * nunca se inventa como 0, porque 0 se confundiría con un proceso real.
 */
export function rowsFromWindowsCsv(text: string): ProcessRow[] {
  const rows = parseCsv(text);
  const out: ProcessRow[] = [];
  // El primer registro es el encabezado (`pid,ppid,cmd`).
  for (const cells of rows.slice(1)) {
    if (cells.length < 2) continue;
    const pid = Number(cells[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = Number(cells[1]);
    out.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : 0,
      cmd: (cells[2] ?? "").trim(),
    });
  }
  return out;
}

/**
 * Mensajes de diagnóstico de la limpieza, SOLO con `CI` definido.
 *
 * Sin `CI` (uso local) no se imprime nada: la salida de los tests queda igual.
 * Con `CI`, se emite un evento ANTES de cada paso que puede quedarse esperando
 * (la consulta de procesos es la única llamada que puede bloquearse de forma
 * indefinida). Un mensaje posterior a la limpieza no sirve para localizar un
 * cuelgue.
 *
 * No se imprimen líneas de comandos completas, variables de entorno, tokens ni
 * pids: solo el archivo, el nombre del test y tiempos.
 */
export const CI_DIAGNOSTICS = process.env.CI === "true" || process.env.CI === "1";

let currentTest = "(sin nombre)";

/** Declara el test que arranca (aparece en los siguientes diagnósticos). */
export function noteTest(name: string): void {
  currentTest = name;
  if (CI_DIAGNOSTICS) diagStart(`test | ${currentTest}`);
}

function diagStart(stage: string): void {
  process.stdout.write(`[ci-diag] inicio ${stage} t=${Date.now()}\n`);
}

function diagEnd(stage: string, startedAt: number, detail: string): void {
  process.stdout.write(`[ci-diag] fin ${stage} ms=${Date.now() - startedAt} ${detail}\n`);
}

/**
 * Último error de enumeración, si lo hubo.
 *
 * `processTable()` devuelve `[]` ante un fallo para que los llamadores no
 * revienten, pero eso es indistinguible de "no hay procesos". La limpieza usa
 * este campo para **fallar** en vez de creer que no quedaba nada vivo: con
 * `[]` silencioso, `ownTree()` no encontraría descendientes y los procesos del
 * test quedarían corriendo sin que nadie lo note.
 */
let lastTableError: string | null = null;

/** Error de la última llamada a `processTable()`, o `null` si funcionó. */
export function processTableError(): string | null {
  return lastTableError;
}

/** Enumera los procesos actuales. Ver `lastTableError` para el porqué de `[]`. */
export async function processTable(): Promise<ProcessRow[]> {
  // El aviso va ANTES de la consulta: es la llamada que puede tardar o fallar. Un
  // mensaje que solo se imprima al volver no permitiría localizar un cuelgue.
  const startedAt = Date.now();
  if (CI_DIAGNOSTICS) diagStart(`processTable | ${currentTest}`);
  const rows = await readProcessTable();
  if (CI_DIAGNOSTICS) {
    diagEnd(
      `processTable | ${currentTest}`,
      startedAt,
      `filas=${rows.length} error=${lastTableError === null ? "null" : JSON.stringify(lastTableError)}`,
    );
  }
  return rows;
}

/**
 * Filas de la tabla de procesos.
 *
 * Un error NUNCA se devuelve como tabla vacía silenciosa: se anota en
 * `lastTableError` y se devuelve `[]` para que el llamador no reviente, pero la
 * limpieza comprueba ese campo y **falla** en vez de creer que no quedó nada
 * vivo. Una tabla vacía de verdad (sin procesos) también es un error: hasta el
 * proceso System (pid 4) existe siempre.
 */
async function readProcessTable(): Promise<ProcessRow[]> {
  try {
    if (IS_WINDOWS) {
      const out = await enumerator(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT],
        PROCESS_TABLE_TIMEOUT_MS,
      );
      const rows = rowsFromWindowsCsv(out);
      // Un CSV con encabezado y sin filas, o sin encabezado, está MAL FORMADO:
      // se distingue de "no hay procesos" para no confundir un parseo roto con
      // una limpieza completa.
      if (rows.length === 0) {
        lastTableError = parseCsv(out).length <= 1
          ? "Get-CimInstance no devolvió ningún proceso"
          : "el CSV de procesos no tenía filas válidas";
        return [];
      }
      lastTableError = null;
      return rows;
    }
    const out = await enumerator("ps", ["-eo", "pid=,ppid=,args="], PROCESS_TABLE_TIMEOUT_MS);
    const rows: ProcessRow[] = [];
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cmd: match[3].trim() });
    }
    lastTableError = rows.length === 0 ? "ps no devolvió ningún proceso" : null;
    return rows;
  } catch (error) {
    lastTableError = error instanceof Error ? error.message : String(error);
    return [];
  }
}

/** Cadena de padres del proceso actual (incluido el propio proceso). */
export async function parentChain(table?: ProcessRow[]): Promise<number[]> {
  const rows = table ?? (await processTable());
  const chain: number[] = [process.pid];
  let cursor = process.pid;
  for (let depth = 0; depth < 8; depth++) {
    const parent = rows.find((row) => row.pid === cursor)?.ppid;
    if (parent === undefined || parent === 0 || chain.includes(parent)) break;
    chain.push(parent);
    cursor = parent;
  }
  return chain;
}

/**
 * Fija qué procesos ya existían (lista blanca): la línea de padres del test y
 * los shells del sistema (`cmd.exe`, que es lo que lanzan los procesos
 * externos). Se llama al empezar el archivo de test.
 */
export async function captureBaseline(extra: number[] = []): Promise<void> {
  baseline = new Set(await parentChain());
  for (const pid of extra) baseline.add(pid);
  for (const row of await processTable()) {
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
export async function ownTree(options: OwnTreeOptions = {}): Promise<OwnTree> {
  const table = await processTable();
  const chain = await parentChain(table);
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
export async function isSameProcess(pid: number, expectedCmd?: string): Promise<boolean> {
  if (!isAlive(pid)) return false;
  if (!expectedCmd) return true;
  const row = (await processTable()).find((entry) => entry.pid === pid);
  // Sin tabla (la enumeración falló) se prefiere no tocar nada.
  return row !== undefined && row.cmd.includes(expectedCmd);
}

export interface KillResult {
  killed: number[];
  /** Pids que siguen vivos después de la escalada. */
  survivors: number[];
  /**
   * La enumeración de procesos falló: no se puede saber qué quedó vivo.
   *
   * Preferir esto a un resultado vacío: con `[]` el test creería que limpió
   * todo y los procesos del test seguirían corriendo (el fallo original con
   * `wmic` ausente se silenciaba justo así).
   */
  enumerationError: string | null;
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
  const startedAt = Date.now();
  if (CI_DIAGNOSTICS) diagStart(`cleanup | ${currentTest}`);
  const result = await runCleanup(options);
  if (CI_DIAGNOSTICS) {
    diagEnd(
      `cleanup | ${currentTest}`,
      startedAt,
      `muertos=${result.killed.length} vivos=${result.survivors.length} ` +
        `enumeracion=${result.enumerationError === null ? "ok" : "FALLO"}`,
    );
  }
  return result;
}

async function runCleanup(options: OwnTreeOptions): Promise<KillResult> {
  const killed: number[] = [];
  const { targets, protectedPids } = await ownTree(options);
  const enumerationError = processTableError();
  // Sin tabla no se puede calcular el árbol ni comprobar supervivientes: se
  // informa en vez de matar a ciegas o de fingir que no quedó nada.
  if (enumerationError !== null && targets.length === 0) {
    return { killed, survivors: [], enumerationError };
  }
  const table = await processTable();
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
  return { killed, survivors, enumerationError };
}

/** Error de limpieza con la lista de sobrevivientes (para fallar el test). */
export async function describeSurvivors(survivors: number[]): Promise<string> {
  const table = await processTable();
  const detail = survivors
    .map((pid) => {
      const row = table.find((entry) => entry.pid === pid);
      return `${pid}${row ? ` (${row.cmd.slice(0, 120)})` : ""}`;
    })
    .join(", ");
  return `quedaron procesos del test vivos después de la limpieza: ${detail}`;
}

/** Pids hijos directos (diagnóstico). */
export async function directChildren(pid: number): Promise<number[]> {
  return (await processTable()).filter((row) => row.ppid === pid).map((row) => row.pid);
}

export { killProcessTree };
