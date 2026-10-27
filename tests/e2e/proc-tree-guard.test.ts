/**
 * Contratos PUROS de la guarda de procesos de los E2E.
 *
 * Estas pruebas **no** consultan el sistema operativo, **no** crean procesos y
 * **no** matan nada: usan tablas de procesos sintéticas y `ChildProcess`
 * falsos. Los casos que necesitan Windows real (enumeración CIM, procesos de
 * verdad) viven en `proc-table.test.ts` y se ejecutan solo en la suite e2e.
 *
 * El reloj es inyectable (`CleanupContext.monoNow`) y la carrera entre "llegó el
 * evento" y "venció el plazo" también (`CreationRace`): ningún caso depende del
 * orden real del event loop ni de un `sleep()`.
 */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  type CapturedEntry,
  type CleanupContext,
  type CreationRace,
  type ProcessRow,
  IS_WINDOWS,
  awaitCreation,
  cleanupCaptured,
  cleanupSucceeded,
  createCleanupContext,
  decideFromObservation,
  describeCleanup,
  indexProcessTable,
  onCaptured,
  processTable,
  processTableError,
  protectedChain,
  recordFirstCreationEvent,
  rootsFormChain,
  rowsFromWindowsCsv,
  setProcessEnumerator,
  terminateCaptured,
  transitiveDescendants,
  waitForAllCapturedExits,
} from "./helpers/proc-tree.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de test (sin E/S)
// ─────────────────────────────────────────────────────────────────────────────

/** Reloj monotónico controlado. */
function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    ctx: (overrides: Partial<CleanupContext> = {}): CleanupContext =>
      createCleanupContext({ monoNow: () => now, ...overrides }),
    set(ms: number): void {
      now = ms;
    },
    now: (): number => now,
  };
}

/**
 * `ChildProcess` mínimo: `EventEmitter` con `pid` y `kill()` controlables.
 *
 * `kill()` solo registra la llamada y devuelve lo pedido: **nunca** termina nada
 * y **nunca** emite `exit` por sí solo, para poder distinguir un intento de una
 * terminación confirmada.
 */
class FakeChild extends EventEmitter {
  pid: number | undefined;
  killReturn = true;
  killCalls: Array<string | number | undefined> = [];
  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }
  kill(signal?: string | number): boolean {
    this.killCalls.push(signal);
    return this.killReturn;
  }
  spawnEvent(): void {
    this.emit("spawn");
  }
  errorEvent(code: string): void {
    const error = new Error(`fallo ${code}`) as NodeJS.ErrnoException;
    error.code = code;
    this.emit("error", error);
  }
  exitEvent(code: number | null = 0): void {
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

/**
 * Entrada completa sobre un `FakeChild`, ya registrada y suscrita.
 *
 * `pid: null` significa "el hijo no expone un PID válido". `pid: undefined`
 * (o la omisión) usa el PID por defecto del doble.
 */
function entry(options: { pid?: number | null; ctx?: CleanupContext } = {}) {
  const ctx = options.ctx ?? fakeClock().ctx();
  const childPid = options.pid === null ? undefined : (options.pid ?? 4242);
  const child = new FakeChild(childPid);
  const captured = onCaptured(child as unknown as import("node:child_process").ChildProcess, ctx);
  return { child, entry: captured, ctx };
}

function row(pid: number, ppid: number, cmd = ""): ProcessRow {
  return { pid, ppid, cmd };
}

/**
 * Carrera determinista: el test decide el orden sin depender del event loop.
 *
 * `"settled"` espera al evento real; `"timer-wake"` resuelve ya, aunque el
 * evento exista. Es exactamente lo que necesita el caso "el timer gana la
 * carrera y el evento puntual ya estaba registrado".
 */
function stagedRace(order: Array<"settled" | "timer-wake">): CreationRace {
  let index = 0;
  return (settled: Promise<void>, _remainingMs: number) => {
    const step = order[Math.min(index, order.length - 1)];
    index += 1;
    if (step === "settled") return settled.then(() => "settled" as const);
    return Promise.resolve("timer-wake" as const);
  };
}

/** Espera un microtask (no un `sleep` real) para que corra una promesa ya resuelta. */
const tick = (): Promise<void> => Promise.resolve();

/**
 * Avanza el reloj hasta la fecha límite DESPUÉS de arrancar la espera.
 *
 * Necesario en los casos que esperan el timeout completo: el bucle de
 * `awaitCreation` rearma el temporizador mientras el reloj no alcance la fecha
 * límite, así que el test tiene que moverlo (determinista, sin `sleep`).
 */
async function advanceClockTo(
  clock: ReturnType<typeof fakeClock>,
  pending: Promise<unknown>,
  ms: number,
): Promise<void> {
  const done = {};
  void pending.then(() => done);
  clock.set(ms);
  await tick();
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadena de ancestros (protectedChain)
// ─────────────────────────────────────────────────────────────────────────────

describe("protectedChain", () => {
  it("una cadena normal llega a PID 0 sin marcarse como incompleta", () => {
    const table = [row(10, 8), row(8, 4), row(4, 0)];
    const chain = protectedChain(table, 10, new Map([[10, 300], [8, 200], [4, 100]]));
    expect(chain.pids).toEqual([10, 8, 4]);
    // Alcanzar una raíz legítima NO vuelve inválida la cadena.
    expect(chain.structurallyComplete).toBe(true);
    expect(chain.identityVerified).toBe(true);
    expect(chain.issues).toEqual([]);
  }, 10_000);

  it("un PID 0 sin fila propia es una raíz terminal válida", () => {
    // Importante: se reconoce el 0 ANTES de buscar su fila (que no existe).
    const table = [row(10, 5), row(5, 0)];
    const chain = protectedChain(table, 10, new Map([[10, 300], [5, 200]]));
    expect(chain.pids).toEqual([10, 5, 0]);
    expect(chain.structurallyComplete).toBe(true);
    expect(chain.issues).toEqual([]);
  });

  it("un PID 4 sin fila propia es una raíz terminal válida", () => {
    const table = [row(10, 4)];
    const chain = protectedChain(table, 10, new Map([[10, 300]]));
    expect(chain.pids).toEqual([10, 4]);
    expect(chain.structurallyComplete).toBe(true);
  });

  it("no corta a los 8 niveles: protege un ancestro lejano", () => {
    // Antes había un `for depth < 8`: con 12 niveles el ancestro 1024 quedaba
    // FUERA del conjunto protegido y podía ser candidato de limpieza.
    const table = [
      row(1048, 1046), row(1046, 1024), row(1024, 512), row(512, 4),
    ];
    const chain = protectedChain(table, 1048);
    expect(chain.pids).toContain(1024);
    expect(chain.pids).toContain(512);
    expect(chain.pids).toContain(4);
    expect(chain.structurallyComplete).toBe(true);
  });

  it("un padre ausente deja la cadena incompleta y lo protege igual", () => {
    const table = [row(10, 999)];
    const chain = protectedChain(table, 10, new Map([[10, 300]]));
    expect(chain.pids).toContain(999);
    expect(chain.structurallyComplete).toBe(false);
    expect(chain.issues).toEqual([{ kind: "parent-missing", pid: 10 }]);
  });

  it("un ciclo se detecta y no autoriza nada", () => {
    const table = [row(100, 200), row(200, 100)];
    const chain = protectedChain(table, 100);
    expect(chain.structurallyComplete).toBe(false);
    expect(chain.issues.some((issue) => issue.kind === "cycle")).toBe(true);
  });

  it("un padre más nuevo que el hijo deja la identidad SIN verificar", () => {
    const table = [row(10, 8), row(8, 4)];
    const chain = protectedChain(table, 10, new Map([[10, 100], [8, 200]]));
    expect(chain.structurallyComplete).toBe(true);
    expect(chain.identityVerified).toBe(false);
    expect(chain.issues).toContainEqual({ kind: "parent-newer-than-child", pid: 10, ppid: 8 });
  });

  it("una fecha desconocida no se declara verificada", () => {
    const table = [row(10, 8), row(8, 4)];
    const chain = protectedChain(table, 10, new Map([[10, 100], [8, null]]));
    expect(chain.identityVerified).toBe(false);
    // La fila sin fecha es la del padre (8); cada fila se valida por sí misma.
    expect(chain.issues).toContainEqual({ kind: "creation-unknown", pid: 8 });
  });

  it("la fila real con creación desconocida cuenta aunque su padre sea PID 0", () => {
    // Defecto corregido: antes se retornaba en la raíz sintética antes de mirar
    // los datos de la fila real, así que un `created: null` pasaba como ok.
    const table = [row(10, 0)];
    const chain = protectedChain(table, 10, new Map([[10, null]]));
    expect(chain.structurallyComplete).toBe(true);
    expect(chain.identityVerified).toBe(false);
  });

  it("el propio proceso de test siempre está protegido", () => {
    const chain = protectedChain([row(77, 0)], 77);
    expect(chain.pids).toContain(77);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Descendientes transitivos (solo observación)
// ─────────────────────────────────────────────────────────────────────────────

describe("transitiveDescendants", () => {
  it("devuelve los descendientes transitivos y excluye TODAS las raíces", () => {
    const table = [row(100, 0), row(200, 100), row(300, 200)];
    const result = transitiveDescendants(table, [100]);
    expect(result.descendants).toEqual([200, 300]);
    expect(result.issues).toEqual([]);
    expect(result.coverage).toBe("complete");
  });

  it("con dos raíces solapadas (100 → 200 → 300) el resultado es {300}", () => {
    // Semántica única acordada: excluye AMBAS raíces.
    const table = [row(100, 0), row(200, 100), row(300, 200)];
    const result = transitiveDescendants(table, [100, 200]);
    expect(result.descendants).toEqual([300]);
    // Las raíces están en cadena de ascendencia: no es una anomalía.
    expect(result.issues).toEqual([]);
    expect(result.coverage).toBe("complete");
  });

  it("una raíz ausente con hijos visibles se recorre igual y se informa", () => {
    // 42 no tiene fila, pero 410 sí y su ppid es 42.
    const table = [row(410, 42), row(420, 410)];
    const result = transitiveDescendants(table, [42]);
    expect(result.descendants).toEqual([410, 420]);
    expect(result.coverage).toBe("partial");
    expect(result.issues).toContainEqual({ kind: "root-missing", pid: 42 });
    expect(result.issues).toContainEqual({ kind: "parent-missing-relevant", ppid: 42 });
  });

  it("una raíz ausente SIN hijos solo informa root-missing", () => {
    // No existe ninguna fila con ppid = 42: no se inventa una relación.
    const table = [row(410, 1)];
    const result = transitiveDescendants(table, [42]);
    expect(result.descendants).toEqual([]);
    expect(result.issues).toEqual([{ kind: "root-missing", pid: 42 }]);
    expect(result.coverage).toBe("partial");
  });

  it("dos raíces no relacionadas que alcanzan el mismo PID producen multi-root", () => {
    // Fixture por PID duplicado: 300 aparece con ppid 100 y con ppid 400.
    const table = [
      row(100, 0),
      row(400, 0),
      row(300, 100),
      row(300, 400),
    ];
    const result = transitiveDescendants(table, [100, 400]);
    expect(result.coverage).toBe("partial");
    expect(result.issues).toContainEqual({ kind: "pid-duplicated", pid: 300 });
    expect(result.issues).toContainEqual({ kind: "multi-root", pid: 300, roots: [100, 400] });
  });

  it("un PID alcanzable desde raíces en cadena no es multi-root", () => {
    // 100 y 200 son comparables (100 es ancestro de 200).
    const table = [row(100, 0), row(200, 100), row(300, 200)];
    expect(rootsFormChain(table, [100, 200])).toBe(true);
    const result = transitiveDescendants(table, [100, 200]);
    expect(result.issues.some((issue) => issue.kind === "multi-root")).toBe(false);
  });

  it("con tres raíces donde dos están anidadas y la tercera no, la anomalía NO se oculta", () => {
    // 100 → 200; 400 no está relacionada con ninguna. 300 aparece con los tres
    // ppid (filas duplicadas de PID).
    const table = [
      row(100, 0),
      row(200, 100),
      row(400, 0),
      row(300, 100),
      row(300, 200),
      row(300, 400),
    ];
    const roots = [100, 200, 400];
    expect(rootsFormChain(table, roots)).toBe(false);
    const result = transitiveDescendants(table, roots);
    const multi = result.issues.find((issue) => issue.kind === "multi-root");
    expect(multi, "la anomalía de tres raíces quedó oculta").toBeDefined();
    expect(result.coverage).toBe("partial");
  });

  it("un ciclo padre→hijo se informa y afecta la cobertura", () => {
    // 500 aparece dos veces: como raíz (ppid 0) y como hijo de 510. 510 es hijo
    // de 500, así que 500 → 510 → 500 cierra un ciclo real.
    const table = [row(500, 0), row(510, 500), row(500, 510)];
    const result = transitiveDescendants(table, [500]);
    expect(result.issues).toContainEqual({ kind: "pid-duplicated", pid: 500 });
    expect(result.issues).toContainEqual({ kind: "cycle", pid: 500 });
    expect(result.coverage).toBe("partial");
    expect(result.descendants).toContain(510);
  });

  it("un auto-padre es un ciclo real de un nodo", () => {
    // 610 es hijo de 600 y, además, se declara padre de sí mismo.
    const table = [row(600, 0), row(610, 600), row(610, 610)];
    const result = transitiveDescendants(table, [600]);
    expect(result.issues).toContainEqual({ kind: "cycle", pid: 610 });
    expect(result.coverage).toBe("partial");
  });

  it("una raíz nunca aparece como descendiente aunque otra raíz la alcance", () => {
    const table = [row(100, 0), row(200, 100)];
    const result = transitiveDescendants(table, [100, 200]);
    expect(result.descendants).toEqual([]);
  });
});

describe("indexProcessTable", () => {
  it("un PID duplicado no se sobrescribe en silencio", () => {
    const indexed = indexProcessTable([row(1, 0, "primera"), row(1, 0, "segunda")]);
    expect(indexed.byPid.get(1)?.cmd).toBe("primera");
    expect(indexed.duplicatePids).toEqual([1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Captura de creación: regla temporal única
// ─────────────────────────────────────────────────────────────────────────────

describe("awaitCreation: regla temporal", () => {
  it("E1 un spawn puntual queda settled-in-time con el PID del hijo", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ pid: 4242, ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["settled"]));
    expect(captured.creationDeadlineMonoMs).toBe(1_000);

    clock.set(500);
    child.spawnEvent();
    await pending;

    expect(captured.creationWait).toBe("settled-in-time");
    expect(captured.creationState).toBe("spawned");
    expect(captured.pid).toBe(4242);
    expect(captured.lateCreationEventType).toBeNull();
  });

  it("E2 un error de creación es spawn-failed con pid null", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ pid: undefined, ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["settled"]));
    clock.set(200);
    child.errorEvent("ENOENT");
    await pending;

    expect(captured.creationState).toBe("spawn-failed");
    expect(captured.pid).toBeNull();
    expect(captured.creationErrorCode).toBe("ENOENT");
    expect(captured.creationWait).toBe("settled-in-time");
    expect(captured.lateCreationEventType).toBeNull();
  });

  it("E3 un spawn sin evento y sin plazo es timeout por ausencia", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { entry: captured } = entry({ ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    await tick();
    clock.set(1_100);
    await pending;

    expect(captured.creationWait).toBe("timed-out");
    expect(captured.firstEvent).toBeNull();
    expect(captured.lateCreationEventType).toBeNull();
  });

  it("E4 la frontera exacta (eventMonoMs === deadline) es TARDÍA", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["settled"]));
    clock.set(1_000);
    child.spawnEvent();
    await pending;

    expect(captured.creationWait).toBe("timed-out");
    expect(captured.lateCreationEventType).toBe("spawn");
    expect(captured.lateCreationEventAfterMs).toBe(0);
  });

  it("E5 timer-wake con un evento puntual YA registrado NO declara timeout", async () => {
    // El caso que antes dependía del orden de callbacks: el timer gana la
    // carrera aunque el evento llegó antes del deadline.
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    clock.set(900);
    child.spawnEvent();
    clock.set(1_100);
    await pending;

    expect(captured.creationDeadlineMonoMs).toBe(1_000);
    expect(captured.creationWait).toBe("settled-in-time");
    expect(captured.lateCreationEventType).toBeNull();
  });

  it("E6 timer-wake con el evento justo en la frontera SÍ declara timeout", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    clock.set(1_000);
    child.spawnEvent();
    clock.set(1_100);
    await pending;

    expect(captured.creationWait).toBe("timed-out");
    expect(captured.lateCreationEventType).toBe("spawn");
    expect(captured.lateCreationEventAfterMs).toBe(0);
  });

  it("E7 un temporizador prematuro rearma sin recursión y con la misma fecha límite", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ ctx });

    // Primer despertar prematuro (reloj aún en 200), luego llega el evento.
    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake", "settled"]));
    clock.set(200);
    await tick();
    clock.set(600);
    child.spawnEvent();
    await pending;

    expect(captured.creationDeadlineMonoMs).toBe(1_000);
    expect(captured.creationWait).toBe("settled-in-time");
  });

  it("E8 un spawn tardío no revierte el timeout y sería un superviviente", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ pid: 4243, ctx });
    const kill = () => child.killCalls.length;

    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    // El bucle rearma el temporizador mientras el reloj no alcance la fecha
    // límite: se avanza DESPUÉS de arrancar la espera.
    await tick();
    clock.set(1_100);
    const result = await pending;
    expect(result.creationWait).toBe("timed-out");

    clock.set(1_200);
    child.spawnEvent();

    expect(captured.creationWait).toBe("timed-out");
    expect(captured.creationState).toBe("spawned");
    expect(captured.pid).toBe(4243);
    expect(captured.lateCreationEventType).toBe("spawn");
    expect(captured.lateCreationEventAfterMs).toBe(200);
    // Nunca se intenta terminarlo por ser tardío.
    const signals = terminateCaptured(captured, ctx);
    expect(signals.kind).toBe("refused");
    expect(signals.refusal).toBe("creation-timeout");
    expect(kill()).toBe(0);
  });

  it("E9 un error tardío también queda visible con su código", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ pid: undefined, ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    await tick();
    clock.set(1_100);
    await pending;
    expect(captured.creationWait).toBe("timed-out");

    clock.set(1_200);
    child.errorEvent("EACCES");

    expect(captured.creationWait).toBe("timed-out");
    expect(captured.creationState).toBe("spawn-failed");
    expect(captured.lateCreationEventType).toBe("error");
    expect(captured.lateCreationEventAfterMs).toBe(200);
    expect(captured.creationErrorCode).toBe("EACCES");
  });

  it("E10 un error de runtime tras un spawn válido NO toca la creación", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["settled"]));
    clock.set(300);
    child.spawnEvent();
    await pending;
    expect(captured.creationWait).toBe("settled-in-time");

    clock.set(400);
    child.errorEvent("EPERM");

    expect(captured.creationState).toBe("spawned");
    expect(captured.creationWait).toBe("settled-in-time");
    expect(captured.lateCreationEventType).toBeNull();
    expect(captured.runtimeErrors).toEqual([{ code: "EPERM", monoMs: 400 }]);
  });

  it("E11 el primer evento nunca se reemplaza y no decide dos veces", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { entry: captured } = entry({ ctx });

    recordFirstCreationEvent(captured, { type: "spawn", monoMs: 100 }, ctx);
    recordFirstCreationEvent(captured, { type: "error", monoMs: 200, code: "X" }, ctx);
    expect(captured.firstEvent).toEqual({ type: "spawn", monoMs: 100 });

    captured.creationDeadlineMonoMs = 1_000;
    expect(decideFromObservation(captured, ctx)).toBe("settled-in-time");
    // Ya decidido: no cambia aunque el reloj avance.
    clock.set(9_999);
    expect(decideFromObservation(captured, ctx)).toBe("settled-in-time");
  });

  it("E12 el timeout por espera también es irreversible si después llega un evento puntual", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    await tick();
    clock.set(1_000);
    await pending;
    expect(captured.creationWait).toBe("timed-out");

    // Un evento posterior no revierte la decisión ya tomada.
    clock.set(1_100);
    child.spawnEvent();
    expect(captured.creationWait).toBe("timed-out");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminación: solo por objeto, nunca por PID
// ─────────────────────────────────────────────────────────────────────────────

describe("terminateCaptured", () => {
  async function settledEntry(pid: number, ctx: CleanupContext): Promise<{ captured: CapturedEntry; child: FakeChild }> {
    const { child, entry: captured } = entry({ pid, ctx });
    const pending = awaitCreation(captured, ctx, stagedRace(["settled"]));
    child.spawnEvent();
    await pending;
    return { captured, child };
  }

  it("T1 un spawn-failed nunca llega a kill()", () => {
    const ctx = fakeClock().ctx();
    const { child, entry: captured } = entry({ pid: null, ctx });
    child.errorEvent("ENOENT");

    const result = terminateCaptured(captured, ctx);
    expect(result).toEqual({ kind: "refused", refusal: "not-spawned" });
    expect(child.killCalls).toEqual([]);
  });

  it("T2 una creación pendiente no se señala", () => {
    const ctx = fakeClock().ctx();
    const { child, entry: captured } = entry({ ctx });
    const result = terminateCaptured(captured, ctx);
    expect(result.refusal).toBe("not-spawned");
    expect(child.killCalls).toEqual([]);
  });

  it("T3 un PID protegido se rechaza antes de llamar a kill()", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ protectedPids: new Set([4242]) });
    const { captured, child } = await settledEntry(4242, ctx);

    const result = terminateCaptured(captured, ctx);
    expect(result).toEqual({ kind: "refused", refusal: "protected" });
    expect(child.killCalls).toEqual([]);
  });

  it("T4 un PID inválido (null) se rechaza con un motivo explícito", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ pid: null, ctx });
    const pending = awaitCreation(captured, ctx, stagedRace(["settled"]));
    // `spawn` sin PID válido: el proceso existe pero no se puede señalar.
    child.spawnEvent();
    await pending;
    expect(captured.creationState).toBe("spawned");
    expect(captured.pid).toBeNull();

    const result = terminateCaptured(captured, ctx);
    expect(result).toEqual({ kind: "refused", refusal: "invalid-pid" });
    expect(child.killCalls).toEqual([]);
  });

  it("T5 kill() que devuelve true NO confirma la terminación por sí solo", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ exitTimeoutMs: 50 });
    const { captured, child } = await settledEntry(4242, ctx);
    child.killReturn = true;

    const result = terminateCaptured(captured, ctx);
    expect(result).toEqual({ kind: "signalled", killReturned: true, errorCode: null });

    const outcome = await cleanupCapturedWith({ captured, ctx });
    expect(outcome.result.exitConfirmed).toEqual([]);
    expect(outcome.result.exitUnconfirmed).toEqual([4242]);
    expect(cleanupSucceeded(outcome.result)).toBe(false);
  });

  it("T6 kill() que devuelve false se registra y no se toma como éxito", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ exitTimeoutMs: 50 });
    const { captured, child } = await settledEntry(4242, ctx);
    child.killReturn = false;

    const result = terminateCaptured(captured, ctx);
    expect(result.kind).toBe("signalled");
    expect(result.killReturned).toBe(false);
    expect(captured.killAttempts).toHaveLength(1);
    expect(captured.exitSeen).toBe(false);
  });

  it("T7 un kill() que lanza registra el error sin inventar salida", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { captured, child } = await settledEntry(4242, ctx);
    child.kill = () => {
      const error = new Error("no se pudo") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    };

    const result = terminateCaptured(captured, ctx);
    expect(result.kind).toBe("signalled");
    expect(result.killReturned).toBe(false);
    expect(result.errorCode).toBe("ESRCH");
    expect(captured.exitSeen).toBe(false);
  });

  it("T8 un exit posterior sí confirma la terminación", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx({ exitTimeoutMs: 1_000 });
    const { captured, child } = await settledEntry(4242, ctx);

    const pending = waitForAllCapturedExits([captured], ctx.exitTimeoutMs);
    child.exitEvent(0);
    const { exited, timedOut } = await pending;

    expect(exited.has(captured)).toBe(true);
    expect(timedOut.size).toBe(0);
  });
});

/**
 * Limpieza sobre un registro controlado (sin el registro global del espía).
 *
 * Reutiliza la ruta real de `cleanupCaptured` registrando las entradas en una
 * tabla local: se prueba la clasificación y la espera, no el espía.
 */
async function cleanupCapturedWith(input: {
  captured: CapturedEntry;
  ctx: CleanupContext;
}): Promise<{ result: import("./helpers/proc-tree.ts").CleanupResult }> {
  const entryList = [input.captured];
  const timedOut = new Set<CapturedEntry>();
  if (input.captured.killAttempts.length > 0) {
    const { timedOut: late } = await waitForAllCapturedExits(entryList, input.ctx.exitTimeoutMs);
    for (const item of late) timedOut.add(item);
  }
  const { classifyAll } = await import("./helpers/proc-tree.ts");
  return { result: classifyAll(entryList, timedOut) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Espera concurrente y clasificación multidimensional
// ─────────────────────────────────────────────────────────────────────────────

describe("waitForAllCapturedExits", () => {
  it("W1 una entrada no se contabiliza dos veces por `exit` y `close`", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const first = entry({ ctx });
    const second = entry({ ctx });
    for (const item of [first, second]) {
      item.child.spawnEvent();
      // Marca la creación como puntual para la clasificación posterior.
      item.entry.creationDeadlineMonoMs = 1_000;
      recordFirstCreationEvent(item.entry, { type: "spawn", monoMs: 10 }, ctx);
      decideFromObservation(item.entry, ctx);
    }

    const pending = waitForAllCapturedExits([first.entry, second.entry], 5_000);
    // El primero emite AMBOS eventos; el segundo, solo `exit`.
    first.child.exitEvent(0);
    second.child.exitEvent(0);
    const { exited, timedOut } = await pending;

    expect(exited.size).toBe(2);
    expect(timedOut.size).toBe(0);
  });

  it("W2 un evento ocurrido ANTES de empezar la espera no se pierde", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ ctx });
    child.spawnEvent();
    child.exitEvent(0);

    const { exited } = await waitForAllCapturedExits([captured], 5_000);
    expect(exited.has(captured)).toBe(true);
  });

  it("W3 un proceso terminado por señal (exitCode null) cuenta como salida confirmada", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ ctx });
    child.spawnEvent();
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");

    expect(captured.exitCode).toBeNull();
    const { exited } = await waitForAllCapturedExits([captured], 5_000);
    expect(exited.has(captured)).toBe(true);
  });

  it("W4 al vencer el plazo devuelve los pendientes como no confirmados", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ ctx });
    child.spawnEvent();

    const { exited, timedOut } = await waitForAllCapturedExits([captured], 20);
    expect(exited.size).toBe(0);
    expect(timedOut.has(captured)).toBe(true);
  });

  it("W5 espera sin entradas resuelve al instante", async () => {
    const { exited, timedOut } = await waitForAllCapturedExits([], 5_000);
    expect(exited.size).toBe(0);
    expect(timedOut.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Listeners: los temporales se retiran, los permanentes de `onCaptured` quedan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Baseline de listeners PERMANENTES que instala `onCaptured()` sobre un `spawn`
 * ya emitido: `error` (on), `exit` (once) y `close` (once). El de `spawn` es
 * `once` y ya se consumió, así que no cuenta.
 */
function permanentListeners(ctx: CleanupContext): {
  child: FakeChild;
  captured: CapturedEntry;
  exit: number;
  close: number;
  error: number;
} {
  const built = entry({ pid: 4242, ctx });
  built.child.spawnEvent();
  return {
    child: built.child,
    captured: built.entry,
    exit: built.child.listenerCount("exit"),
    close: built.child.listenerCount("close"),
    error: built.child.listenerCount("error"),
  };
}

describe("listeners de la espera de salida", () => {
  it("W6 tras el TIMEOUT no quedan listeners temporales y los permanentes siguen", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const base = permanentListeners(ctx);
    expect(base.exit).toBe(1);
    expect(base.close).toBe(1);

    const { timedOut } = await waitForAllCapturedExits([base.captured], 20);
    expect(timedOut.has(base.captured)).toBe(true);

    // Vuelve a la referencia: ningún `once` temporal sobrevive al timeout.
    expect(base.child.listenerCount("exit")).toBe(base.exit);
    expect(base.child.listenerCount("close")).toBe(base.close);
    expect(base.child.listenerCount("error")).toBe(base.error);
  });

  it("W7 tras el ÉXITO los temporales se consumen y los permanentes siguen intactos", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const base = permanentListeners(ctx);

    const pending = waitForAllCapturedExits([base.captured], 5_000);
    // Los temporales (`once`) están instalados durante la espera.
    expect(base.child.listenerCount("exit")).toBe(base.exit + 1);
    expect(base.child.listenerCount("close")).toBe(base.close + 1);

    base.child.exitEvent(0);
    const { exited } = await pending;
    expect(exited.has(base.captured)).toBe(true);

    // `exitEvent()` emite `exit` Y `close`: consume el `once` permanente de cada
    // evento además del temporal, así que quedan en 0 para ambos. El `on` de
    // `error` es permanente y NO lo toca la espera.
    expect(base.child.listenerCount("exit")).toBe(0);
    expect(base.child.listenerCount("close")).toBe(0);
    expect(base.child.listenerCount("error")).toBe(base.error);
  });

  it("W7b dos esperas seguidas no dejan listeners temporales acumulados", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const base = permanentListeners(ctx);

    // Primera espera: vence sin que el proceso muera.
    await waitForAllCapturedExits([base.captured], 20);
    expect(base.child.listenerCount("exit")).toBe(base.exit);
    expect(base.child.listenerCount("close")).toBe(base.close);

    // Segunda espera: el proceso sale de verdad. Los permanentes se consumen.
    const pending = waitForAllCapturedExits([base.captured], 5_000);
    base.child.exitEvent(0);
    await pending;
    expect(base.child.listenerCount("exit")).toBe(0);
    expect(base.child.listenerCount("close")).toBe(0);
    expect(base.child.listenerCount("error")).toBe(base.error);
  });

  it("W8 el listener PERMANENTE de `onCaptured` sigue registrando tras una espera", async () => {
    const clock = fakeClock();
    const ctx = clock.ctx();
    const base = permanentListeners(ctx);

    await waitForAllCapturedExits([base.captured], 20);
    expect(base.captured.exitSeen).toBe(false);

    // El `on("error")` permanente (no `once`) sigue vivo después de la espera.
    base.child.errorEvent("EPERM");
    expect(base.captured.runtimeErrors).toEqual([{ code: "EPERM", monoMs: clock.now() }]);

    // Y un `exit` posterior sigue llegando al registro permanente.
    base.child.emit("exit", 3, null);
    expect(base.captured.exitSeen).toBe(true);
    expect(base.captured.exitCode).toBe(3);
  });
});

describe("clasificación multidimensional", () => {
  /** Entrada con un spawn puntual ya decidido. */
  function settled(ctx: CleanupContext, pid: number) {
    const built = entry({ pid, ctx });
    built.entry.creationDeadlineMonoMs = 1_000;
    built.child.spawnEvent();
    recordFirstCreationEvent(built.entry, { type: "spawn", monoMs: 100 }, ctx);
    decideFromObservation(built.entry, ctx);
    return built;
  }

  it("C1 timeout y spawn-failed simultáneos quedan en AMBOS agregados", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ pid: undefined, ctx });
    captured.creationDeadlineMonoMs = 1_000;
    captured.creationWait = "timed-out";
    child.errorEvent("ENOENT"); // tarde: el timeout ya estaba decidido

    const result = classifyAll([captured]);
    expect(captured.creationWait).toBe("timed-out");
    expect(captured.creationState).toBe("spawn-failed");
    expect(result.deadBeforeIdentity).toContain(0);
    // Aditivo: el plazo vencido se conserva aunque la creación falló después.
    expect(result.creationTimedOut).toEqual([0]);
    expect(captured.lateCreationEventType).toBe("error");
  });

  it("C1b timeout → error tardío → classifyAll sobre la MISMA entrada (secuencia real)", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ pid: undefined, ctx });

    // t=0: se fija la fecha límite. El adaptador despierta el temporizador sin
    // que exista evento, así que el bucle solo puede declarar timeout cuando el
    // reloj alcance el deadline.
    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    expect(captured.creationDeadlineMonoMs).toBe(1_000);
    await tick();

    clock.set(1_100);
    await pending;
    expect(captured.creationWait).toBe("timed-out");
    expect(captured.firstEvent).toBeNull();

    // Error DESPUÉS del deadline y después de que `awaitCreation()` ya devolvió.
    clock.set(1_150);
    child.errorEvent("ENOENT");

    expect(captured.creationState).toBe("spawn-failed");
    expect(captured.creationWait).toBe("timed-out");
    expect(captured.firstEvent).toEqual({ type: "error", monoMs: 1_150, code: "ENOENT" });
    expect(captured.lateCreationEventType).toBe("error");
    // 1150 - 1000: positivo y contra la fecha límite ORIGINAL.
    expect(captured.lateCreationEventAfterMs).toBe(150);

    const result = classifyAll([captured]);
    // Los tres hechos se conservan a la vez, en agregados independientes.
    expect(result.deadBeforeIdentity).toEqual([0]);
    expect(result.creationPending).toEqual([0]);
    expect(result.creationTimedOut).toEqual([0]);
    expect(result.survivorLateSpawn).toEqual([]);
    expect(result.exitConfirmed).toEqual([]);
    expect(result.exitUnconfirmed).toEqual([]);
    expect(cleanupSucceeded(result)).toBe(false);
  });

  it("C1c timeout → spawn tardío → classifyAll: timed-out + pendiente + superviviente", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx({ creationTimeoutMs: 1_000 });
    const { child, entry: captured } = entry({ pid: 7301, ctx });

    const pending = awaitCreation(captured, ctx, stagedRace(["timer-wake"]));
    expect(captured.creationDeadlineMonoMs).toBe(1_000);
    await tick();
    clock.set(1_050);
    await pending;
    expect(captured.creationWait).toBe("timed-out");

    clock.set(1_075);
    child.spawnEvent();

    expect(captured.creationWait).toBe("timed-out");
    expect(captured.creationState).toBe("spawned");
    expect(captured.pid).toBe(7301);
    expect(captured.lateCreationEventType).toBe("spawn");
    expect(captured.lateCreationEventAfterMs).toBe(75);

    const result = classifyAll([captured]);
    expect(result.creationTimedOut).toEqual([7301]);
    expect(result.survivorLateSpawn).toEqual([7301]);
    expect(result.creationPending).toEqual([7301]);
    // Un superviviente tardío NO se cuenta como terminación confirmada.
    expect(result.exitConfirmed).toEqual([]);
    expect(cleanupSucceeded(result)).toBe(false);
    // Y el evento tardío nunca deja un retraso negativo ni revierte el timeout.
    expect(captured.lateCreationEventAfterMs).toBeGreaterThanOrEqual(0);
  });

  it("C2 un superviviente tardío se informa y NO se cuenta como terminado", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ pid: 7001, ctx });
    captured.creationDeadlineMonoMs = 1_000;
    captured.creationWait = "timed-out";
    child.spawnEvent();

    const result = classifyAll([captured]);
    expect(result.survivorLateSpawn).toEqual([7001]);
    expect(result.exitConfirmed).toEqual([]);
    expect(cleanupSucceeded(result)).toBe(false);
  });

  it("C3 una entrada confirmada y una sin confirmar no se mezclan", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const good = settled(ctx, 8001);
    const bad = settled(ctx, 8002);
    good.child.exitEvent(0);
    terminateCaptured(bad.entry, ctx);

    const result = classifyAll([good.entry, bad.entry]);
    expect(result.exitConfirmed).toEqual([8001]);
    expect(result.exitUnconfirmed).toEqual([8002]);
    expect(cleanupSucceeded(result)).toBe(false);
  });

  it("C4 los errores de runtime se agregan por código", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const built = settled(ctx, 9001);
    built.child.errorEvent("EPERM");
    built.child.errorEvent("EPERM");

    const result = classifyAll([built.entry]);
    expect(result.runtimeErrors).toEqual([{ code: "EPERM", count: 2 }]);
    // Un error de runtime no invalida la creación.
    expect(built.entry.creationState).toBe("spawned");
  });

  it("C5 una creación pendiente aparece como tal y no como éxito", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { entry: captured } = entry({ ctx });

    const result = classifyAll([captured]);
    // Sin `spawn` no hay PID: se cuenta con el marcador `0` ("sin-pid") y el
    // hecho NO se pierde.
    expect(result.creationPending).toEqual([0]);
    expect(cleanupSucceeded(result)).toBe(false);
    expect(describeCleanup(result)).toContain("creación pendiente: sin-pid");
  });

  it("C5b una creación pendiente con PID observado conserva ese PID", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ pid: 5151, ctx });

    // El objeto conoce su PID pero `awaitCreation()` todavía no corrió.
    child.spawnEvent();
    expect(captured.pid).toBe(5151);
    expect(captured.creationWait).toBe("pending");

    const result = classifyAll([captured]);
    expect(result.creationPending).toEqual([5151]);
    expect(result.exitConfirmed).toEqual([]);
    expect(result.deadBeforeIdentity).toEqual([]);
  });

  it("C5c un spawn-failed sin PID también aparece con el marcador 0", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const { child, entry: captured } = entry({ pid: null, ctx });
    child.errorEvent("ENOENT");

    const result = classifyAll([captured]);
    expect(result.deadBeforeIdentity).toEqual([0]);
    expect(cleanupSucceeded(result)).toBe(false);
    expect(describeCleanup(result)).toContain("no llegaron a crearse: sin-pid");
  });

  it("C6 sin incidencias, la limpieza se considera satisfactoria", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const clock = fakeClock();
    const ctx = clock.ctx();
    const built = settled(ctx, 9101);
    built.child.exitEvent(0);

    const result = classifyAll([built.entry]);
    expect(cleanupSucceeded(result)).toBe(true);
  });

  it("C7 un fallo de enumeración impide declarar éxito aunque no haya entradas", async () => {
    const { classifyAll } = await import("./helpers/proc-tree.ts");
    const result = classifyAll([]);
    expect(cleanupSucceeded(result)).toBe(true);
    expect(cleanupSucceeded(result, "WMI no responde")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parser del CSV de procesos (formato, sin sistema operativo)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CSV de la consulta de Windows, con el encabezado EXACTO que produce
 * `ConvertTo-Csv -NoTypeInformation` sobre los objetos del script.
 */
function csv(lines: string[]): string {
  return ["\"pid\",\"ppid\",\"cmd\"", ...lines].join("\r\n") + "\r\n";
}

/**
 * PID que el fixture usa como "proceso actual" sin coincidir con el real.
 *
 * T-A4.5 necesita un PID que NO sea `process.pid`: se excluye explícitamente en
 * lugar de confiar en que un número fijo nunca coincida.
 */
function safeForeignPid(): number {
  return process.pid === 4 ? 5 : 4;
}

describe("rowsFromWindowsCsv: formato de la tabla", () => {
  it("T-A4.1 un PID duplicado degrada la cobertura y se informa", () => {
    // Solo importa el formato: el parser no conoce `process.pid`.
    const table = rowsFromWindowsCsv(
      csv([
        "\"4\",\"1900\",\"System\"",
        "\"1900\",\"4\",\"cmd.exe /c a\"",
        "\"1900\",\"9\",\"cmd.exe /c b\"",
      ]),
    );
    expect(table.map((item) => item.pid)).toEqual([4, 1900, 1900]);

    const result = transitiveDescendants(table, [4]);
    expect(result.issues).toContainEqual({ kind: "pid-duplicated", pid: 1900 });
    expect(result.coverage).toBe("partial");
  });

  it("T-A4.2 un ppid inválido usa el centinela -1 y nunca 0", () => {
    // `Number("")` y `Number(" ")` valen 0: si se convirtieran, la fila
    // quedaría colgada de la raíz 0 y parecería una relación real.
    const table = rowsFromWindowsCsv(
      csv([
        "\"4\",\"0\",\"System\"",
        "\"1900\",\"\",\"cmd.exe /c vacio\"",
        "\"1901\",\"   \",\"cmd.exe /c blanco\"",
        "\"1902\",\"-7\",\"cmd.exe /c negativo\"",
        "\"1903\",\"abc\",\"cmd.exe /c texto\"",
      ]),
    );
    expect(table.map((item) => [item.pid, item.ppid])).toEqual([
      [4, 0],
      [1900, -1],
      [1901, -1],
      [1902, -1],
      [1903, -1],
    ]);

    // El centinela degrada la cobertura (la descendencia no se puede afirmar),
    // sin añadir una incidencia nueva a la unión pública.
    const result = transitiveDescendants(table, [4]);
    expect(result.coverage).toBe("partial");
    expect(result.descendants).toEqual([]);
  });

  it("T-A4.2b una fila con menos de tres celdas se descarta como incompleta", () => {
    const table = rowsFromWindowsCsv(
      csv([
        "\"4\",\"0\",\"System\"",
        "\"1900\",\"4\"", // dos celdas: incompleta
        "\"1901\",\"4\",\"\"", // tercera celda vacía: válida
      ]),
    );
    expect(table.map((item) => [item.pid, item.ppid, item.cmd])).toEqual([
      [4, 0, "System"],
      [1901, 4, ""],
    ]);
  });

  it("T-A4.3 se conserva el PID 4 y se descarta el PID 0 (parser puro)", () => {
    const table = rowsFromWindowsCsv(
      csv([
        "\"0\",\"0\",\"Idle\"",
        "\"4\",\"0\",\"System\"",
        "\"-3\",\"4\",\"no-positivo\"",
        "\"\",\"4\",\"vacio\"",
        "\" \",\"4\",\"blanco\"",
        "\"xyz\",\"4\",\"texto\"",
        "\"1904\",\"4\",\"cmd.exe /c real\"",
      ]),
    );
    // El PID 4 (System) NUNCA se descarta; 0 y los ilegibles sí.
    expect(table.map((item) => item.pid)).toEqual([4, 1904]);
  });

  it("T-A4.4a un encabezado distinto es un error de formato (todas las plataformas)", () => {
    // Sin encabezado, el encabezado NO se parsea como fila: se descarta toda la
    // tabla en lugar de inventar procesos.
    const invalid = [
      "",
      "\"1900\",\"4\",\"cmd.exe /c sin-encabezado\"\r\n",
      "\"Pid\",\"ParentProcessId\",\"CommandLine\"\r\n\"1900\",\"4\",\"x\"\r\n",
      "\"pid\",\"ppid\"\r\n\"1900\",\"4\"\r\n",
      "\"cmd\",\"pid\",\"ppid\"\r\n\"x\",\"1900\",\"4\"\r\n",
      csv([]),
    ];
    for (const text of invalid) {
      expect(rowsFromWindowsCsv(text), JSON.stringify(text)).toEqual([]);
    }

    // El encabezado válido se acepta normalizado (BOM inicial, espacios y
    // mayúsculas), y BOM + comillas siguen funcionando.
    const accepted = rowsFromWindowsCsv(
      "\uFEFF\"PID\" , \"Ppid\",\"Cmd\"\r\n\"1900\",\"4\",\"cmd.exe /c ok\"\r\n",
    );
    expect(accepted.map((item) => item.pid)).toEqual([1900]);
  });

  it("T-A4.4b producción: el encabezado inválido llega como error DURO de enumeración", async () => {
    // Solo Windows: fuera de Windows la tabla sale de `ps`, no del parser.
    // Se observa el comportamiento PERMITIDO (error + sin filas); la categoría
    // interna del parser no forma parte del contrato publicado.
    if (!IS_WINDOWS) return;
    const restore = setProcessEnumerator(async () => {
      return "\"1900\",\"4\",\"cmd.exe /c sin-encabezado\"\r\n";
    });
    try {
      const table = await processTable();
      expect(table).toEqual([]);
      expect(processTableError()).toMatch(/encabezado/);
    } finally {
      restore();
    }
  });

  it("T-A4.5 producción: una tabla sin `process.pid` es un error duro (solo Windows)", async () => {
    if (!IS_WINDOWS) return;
    const foreign = safeForeignPid();
    expect(foreign).not.toBe(process.pid);
    const version = process.version.replace(/^v/, "");
    const restore = setProcessEnumerator(async () => {
      return csv([
        `\"4\",\"0\",\"System\"`,
        `\"${foreign}\",\"4\",\"cmd.exe /c otro\"`,
        `\"2010\",\"${foreign}\",\"cmd.exe /c nieto\"`,
        `\"2011\",\"${foreign}\",\"node ${version}\"`,
      ]);
    });
    try {
      const table = await processTable();
      // La tabla es válida en formato, pero no incluye el proceso actual: no se
      // puede afirmar nada sobre la cobertura.
      expect(table).toEqual([]);
      expect(processTableError()).toMatch(/proceso actual/);
    } finally {
      restore();
    }
  });

  it("T-A4.6 el centinela del parser degrada la cobertura de descendientes", () => {
    // Dirección `ppid → pid`: una fila con `ppid` inválido no aporta arista.
    const table = rowsFromWindowsCsv(
      csv([
        "\"4\",\"0\",\"System\"",
        "\"1905\",\"\",\"cmd.exe /c huerfano\"",
        "\"1906\",\"1905\",\"cmd.exe /c hijo\"",
      ]),
    );
    const result = transitiveDescendants(table, [4]);
    // 1905 no aparece: no está colgado de 4 ni de nadie conocido.
    expect(result.descendants).toEqual([]);
    expect(result.coverage).toBe("partial");
    // No se inventa una incidencia nueva: solo aparecen los tipos ya publicados.
    expect(result.issues).toEqual([]);
  });
});
