import { describe, expect, it } from "vitest";

import { AlertQueue, QueueInputError } from "./queue.ts";
import { PlayClip } from "./action.ts";
import { effectiveDurationSec, validateTrim } from "./trim.ts";

describe("AlertQueue - un clip a la vez", () => {
  it("el primer ítem arranca y el resto espera", () => {
    const queue = new AlertQueue();
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });

    const state = queue.getState();
    expect(state.status).toBe("playing");
    expect(state.current?.clipId).toBe("a");
    expect(state.pending.map((item) => item.clipId)).toEqual(["b"]);
    expect(state.size).toBe(1);
  });

  it("acepta cualquier clipId no vacío y rechaza el resto", () => {
    const queue = new AlertQueue();
    expect(() => queue.enqueue({ clipId: "" })).toThrow(QueueInputError);
    expect(() => queue.enqueue({ clipId: "   " })).toThrow(QueueInputError);
    expect(queue.getState().status).toBe("idle");
  });
});

describe("AlertQueue - orden por prioridad y FIFO", () => {
  it("prioriza por número y desempata por orden de llegada", () => {
    const queue = new AlertQueue();
    queue.enqueue({ clipId: "actual", priority: 0 });
    queue.enqueue({ clipId: "prio-baja", priority: 1 });
    queue.enqueue({ clipId: "prio-alta-1", priority: 10 });
    queue.enqueue({ clipId: "prio-alta-2", priority: 10 });

    expect(queue.getState().pending.map((item) => item.clipId)).toEqual([
      "prio-alta-1",
      "prio-alta-2",
      "prio-baja",
    ]);

    queue.skip();
    expect(queue.getState().current?.clipId).toBe("prio-alta-1");
  });
});

describe("AlertQueue - operaciones", () => {
  it("skip descarta el actual y avanza", () => {
    const queue = new AlertQueue();
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    queue.skip();
    expect(queue.getState().current?.clipId).toBe("b");
    expect(queue.skip()).toBeNull();
    expect(queue.getState().status).toBe("idle");
  });

  it("complete avanza solo si el itemId coincide", () => {
    const queue = new AlertQueue();
    const first = queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });

    // Mensaje tardío de otro ítem: se ignora.
    queue.complete("id-inexistente");
    expect(queue.getState().current?.clipId).toBe("a");

    queue.complete(first.id);
    expect(queue.getState().current?.clipId).toBe("b");
  });

  it("pause detiene el avance y resume reanuda (o arranca un pendiente)", () => {
    const queue = new AlertQueue();
    queue.enqueue({ clipId: "a" });
    queue.pause();
    queue.enqueue({ clipId: "b" });
    expect(queue.getState().status).toBe("paused");
    expect(queue.getState().current?.clipId).toBe("a");

    queue.resume();
    expect(queue.getState().status).toBe("playing");
    expect(queue.getState().current?.clipId).toBe("a");
  });

  it("si está pausada y vacía, resume arranca el primer pendiente", () => {
    const queue = new AlertQueue();
    queue.pause();
    queue.enqueue({ clipId: "a" });
    expect(queue.getState().pending.map((item) => item.clipId)).toEqual(["a"]);

    queue.resume();
    expect(queue.getState().current?.clipId).toBe("a");
    expect(queue.getState().pending).toHaveLength(0);
  });

  it("clear vacía la espera pero deja el actual", () => {
    const queue = new AlertQueue();
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    queue.enqueue({ clipId: "c" });

    expect(queue.clear()).toBe(2);
    expect(queue.getState().current?.clipId).toBe("a");
    expect(queue.getState().pending).toHaveLength(0);
  });

  it("normaliza los parámetros de reproducción", () => {
    const queue = new AlertQueue();
    const item = queue.enqueue({
      clipId: "a",
      volume: 5,
      maxDurationSec: 0,
      position: { x: -1, y: 2 },
    });
    expect(item.params.volume).toBe(1);
    expect(item.params.maxDurationSec).toBe(1);
    expect(item.params.position).toEqual({ x: 0, y: 1 });
  });

  it("notifica a los suscriptores y permite desuscribirse", () => {
    const queue = new AlertQueue();
    let calls = 0;
    const unsubscribe = queue.onChange(() => calls++);

    queue.enqueue({ clipId: "a" });
    expect(calls).toBe(1);
    unsubscribe();
    queue.enqueue({ clipId: "b" });
    expect(calls).toBe(1);
  });
});

describe("PlayClip (Action)", () => {
  it("encola un ítem a través del sink, sin depender de AlertQueue", () => {
    const queue = new AlertQueue();
    const action = new PlayClip({ clipId: "clip-1", priority: 3, volume: 0.5 });

    expect(action.kind).toBe("play_clip");
    const item = action.execute({ queue });

    expect(item.clipId).toBe("clip-1");
    expect(item.priority).toBe(3);
    expect(item.params.volume).toBe(0.5);
    expect(queue.getState().current?.clipId).toBe("clip-1");
  });

  it("pasa el recorte a la cola", () => {
    const queue = new AlertQueue();
    const action = new PlayClip({ clipId: "clip-1", trimStart: 2, trimEnd: 5 });
    const item = action.execute({ queue });
    expect(item.params.trimStart).toBe(2);
    expect(item.params.trimEnd).toBe(5);
  });
});

describe("recorte (validateTrim)", () => {
  it("sin recorte usa 0 y null", () => {
    expect(validateTrim(undefined, undefined)).toEqual({ ok: true, trimStart: 0, trimEnd: null });
    expect(validateTrim(null, null)).toEqual({ ok: true, trimStart: 0, trimEnd: null });
  });

  it("acepta un rango válido y lo normaliza", () => {
    expect(validateTrim("2" as unknown, 5)).toMatchObject({ ok: false });
    expect(validateTrim(2, 5)).toEqual({ ok: true, trimStart: 2, trimEnd: 5 });
    expect(validateTrim(0, null)).toEqual({ ok: true, trimStart: 0, trimEnd: null });
  });

  it("rechaza inicio negativo, fin no numérico y fin <= inicio", () => {
    expect(validateTrim(-1, 5).ok).toBe(false);
    expect(validateTrim(3, Number.NaN).ok).toBe(false);
    expect(validateTrim(5, 5).ok).toBe(false);
    expect(validateTrim(5, 3).ok).toBe(false);
  });

  it("con duración exige 0 <= inicio < fin <= duración", () => {
    expect(validateTrim(2, 8, 10).ok).toBe(true);
    expect(validateTrim(10, null, 10).ok).toBe(false);
    expect(validateTrim(2, 11, 10).ok).toBe(false);
    expect(validateTrim(0, null, 10).ok).toBe(true);
  });
});

describe("duración efectiva con recorte", () => {
  it("el menor entre el recorte y la duración máxima", () => {
    // Recorte más corto que el máximo.
    expect(effectiveDurationSec(2, 5, 30)).toBe(3);
    // Duración máxima más corta que el recorte.
    expect(effectiveDurationSec(2, 20, 4)).toBe(4);
    // Sin fin de recorte: manda la duración máxima.
    expect(effectiveDurationSec(2, null, 6)).toBe(6);
  });
});

describe("AlertQueue - recorte inválido", () => {
  it("lanza QueueInputError con code INVALID_TRIM", () => {
    const queue = new AlertQueue();
    try {
      queue.enqueue({ clipId: "a", trimStart: 5, trimEnd: 2 });
      throw new Error("no debería llegar acá");
    } catch (error) {
      expect(error).toBeInstanceOf(QueueInputError);
      expect((error as QueueInputError).code).toBe("INVALID_TRIM");
    }
    expect(queue.getState().status).toBe("idle");
  });

  it("aplica el recorte en los parámetros del ítem", () => {
    const queue = new AlertQueue();
    const item = queue.enqueue({ clipId: "a", trimStart: 1.5, trimEnd: 4 });
    expect(item.params.trimStart).toBe(1.5);
    expect(item.params.trimEnd).toBe(4);
  });
});

describe("AlertQueue - invariante anti-atasco (secuencias)", () => {
  // Modelo de secuencias: combina operaciones y verifica que la cola nunca
  // quede con ítems en espera sin nada reproduciéndose (salvo pausa explícita).
  const OPS = [
    "enqueue-a",
    "enqueue-b",
    "skip",
    "pause",
    "resume",
    "clear",
    "complete-current",
    "complete-unknown",
    "complete-stale",
  ] as const;
  type Op = (typeof OPS)[number];

  interface Ref {
    seenCurrent: string[];
  }

  function applyOp(queue: AlertQueue, op: Op, ref: Ref): void {
    switch (op) {
      case "enqueue-a":
        queue.enqueue({ clipId: "a" });
        break;
      case "enqueue-b":
        queue.enqueue({ clipId: "b" });
        break;
      case "skip":
        queue.skip();
        break;
      case "pause":
        queue.pause();
        break;
      case "resume":
        queue.resume();
        break;
      case "clear":
        queue.clear();
        break;
      case "complete-current":
        queue.complete(queue.getState().current?.id);
        break;
      case "complete-unknown":
        queue.complete("no-existe");
        break;
      case "complete-stale": {
        const currentId = queue.getState().current?.id;
        // Mensaje tardío de un ítem anterior (distinto del actual).
        const stale = ref.seenCurrent.find((id) => id !== currentId) ?? "no-existe";
        queue.complete(stale);
        break;
      }
    }
    const currentId = queue.getState().current?.id;
    if (currentId && !ref.seenCurrent.includes(currentId)) ref.seenCurrent.push(currentId);
  }

  function assertSane(queue: AlertQueue, seq: readonly Op[]): void {
    const state = queue.getState();
    const where = `secuencia [${seq.join(", ")}]`;
    // No puede quedar "idle" con ítems en espera: sería un atasco invisible.
    if (state.status === "idle" && state.size > 0) {
      throw new Error(`Atasco: idle con ${state.size} en espera en ${where}`);
    }
    // Si no está pausada y hay pendientes, debe haber un actual.
    if (state.status !== "paused" && state.pending.length > 0 && state.current === null) {
      throw new Error(`Atasco: pendientes sin actual y sin pausa en ${where}`);
    }
  }

  function* sequences(length: number): Generator<Op[]> {
    if (length === 0) {
      yield [];
      return;
    }
    for (const prefix of sequences(length - 1)) {
      for (const op of OPS) yield [...prefix, op];
    }
  }

  it("ninguna secuencia de hasta 4 operaciones deja la cola atascada", () => {
    for (let length = 1; length <= 4; length++) {
      for (const seq of sequences(length)) {
        const queue = new AlertQueue();
        const ref: Ref = { seenCurrent: [] };
        for (const op of seq) {
          applyOp(queue, op, ref);
          assertSane(queue, seq);
        }
      }
    }
  });

  it("regresión: pausar + saltar + encolar ya no queda en idle", () => {
    const queue = new AlertQueue();
    queue.enqueue({ clipId: "a" });
    queue.pause();
    queue.skip();
    queue.enqueue({ clipId: "b" });

    const stuck = queue.getState();
    expect(stuck.status).toBe("paused");
    expect(stuck.size).toBe(1);
    expect(stuck.current).toBeNull();

    queue.resume();
    expect(queue.getState().current?.clipId).toBe("b");
    expect(queue.getState().status).toBe("playing");
  });

  it("regresión: fin natural en pausa + encolar es reanudable", () => {
    const queue = new AlertQueue();
    const first = queue.enqueue({ clipId: "a" });
    queue.pause();
    queue.complete(first.id);
    queue.enqueue({ clipId: "b" });

    expect(queue.getState().status).toBe("paused");
    expect(queue.getState().size).toBe(1);

    queue.resume();
    expect(queue.getState().current?.clipId).toBe("b");
  });
});

describe("AlertQueue - reproductor conectado", () => {
  it("sin reproductor los ítems quedan en espera y arrancan al conectarse", () => {
    const queue = new AlertQueue();
    queue.setPlayerReady(false);
    queue.enqueue({ clipId: "a" });

    expect(queue.getState().status).toBe("idle");
    expect(queue.getState().current).toBeNull();
    expect(queue.getState().size).toBe(1);

    queue.setPlayerReady(true);
    expect(queue.getState().current?.clipId).toBe("a");
    expect(queue.getState().status).toBe("playing");
  });

  it("no arranca en pausa aunque el reproductor se conecte", () => {
    const queue = new AlertQueue();
    queue.setPlayerReady(false);
    queue.pause();
    queue.enqueue({ clipId: "a" });
    queue.setPlayerReady(true);

    expect(queue.getState().status).toBe("paused");
    expect(queue.getState().current).toBeNull();
    expect(queue.getState().size).toBe(1);

    queue.resume();
    expect(queue.getState().current?.clipId).toBe("a");
  });
});

// --- Compuerta de inicio global (Modo Chill) ----------------------------------

function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor: tiempo agotado"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("AlertQueue - compuerta de inicio global", () => {
  it("sin compuerta el siguiente arranca enseguida (comportamiento de siempre)", () => {
    const queue = new AlertQueue();
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    queue.complete(queue.getState().current?.id);
    expect(queue.getState().current?.clipId).toBe("b");
  });

  it("espera el intervalo desde el FIN de la alerta anterior hasta el inicio de la siguiente", async () => {
    const queue = new AlertQueue();
    let lastEnd = 0;
    const intervalMs = 150;
    // La espera cuenta desde el fin, tal como lo sella el servidor con `markEnd`.
    queue.setStartGate({ remainingMs: () => (lastEnd ? Math.max(0, intervalMs - (Date.now() - lastEnd)) : 0) });

    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    // La alerta "a" sigue sonando: no hay espera ni bloqueo, solo espera a que termine.
    expect(queue.getState().current?.clipId).toBe("a");
    lastEnd = Date.now();
    const endedAt = lastEnd;
    queue.complete(queue.getState().current?.id);

    // Con la compuerta cerrada, el siguiente todavía no arrancó.
    expect(queue.getState().current).toBeNull();
    expect(queue.getState().size).toBe(1);

    await waitFor(() => queue.getState().current !== null);
    expect(queue.getState().current?.clipId).toBe("b");
    expect(Date.now() - endedAt).toBeGreaterThanOrEqual(intervalMs - 20);
  });

  it("la cola solo consulta la compuerta: no registra inicios (los sella el servidor)", () => {
    const queue = new AlertQueue();
    let calls = 0;
    // El contrato de la cola es solo `remainingMs`; nada se marca al promover.
    queue.setStartGate({
      remainingMs: () => {
        calls += 1;
        return 0;
      },
    });
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    queue.complete(queue.getState().current?.id);
    expect(queue.getState().current?.clipId).toBe("b");
    expect(calls).toBeGreaterThan(0);
  });

  it("sin un fin registrado no agrega espera y la primera alerta arranca", () => {
    const queue = new AlertQueue();
    // La compuerta real devuelve 0 hasta que una alerta termina: la primera suena.
    let ended = false;
    queue.setStartGate({ remainingMs: () => (ended ? 60_000 : 0) });
    queue.enqueue({ clipId: "a" });
    expect(queue.getState().current?.clipId).toBe("a");
    // La alerta "a" suena: que la compuerta esté cerrada no la interrumpe.
    ended = true;
    expect(queue.getState().current?.clipId).toBe("a");
    // Al terminar, el siguiente (si hay) espera el intervalo.
    queue.enqueue({ clipId: "b" });
    queue.complete(queue.getState().current?.id);
    expect(queue.getState().current).toBeNull();
    expect(queue.getState().size).toBe(1);
  });

  it("con intervalo 0 no agrega espera", () => {
    const queue = new AlertQueue();
    queue.setStartGate({ remainingMs: () => 0 });
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    queue.complete(queue.getState().current?.id);
    expect(queue.getState().current?.clipId).toBe("b");
  });

  it("apagar la compuerta con un pendiente programado lo libera", async () => {
    const queue = new AlertQueue();
    let active = true;
    let lastEnd = 0;
    queue.setStartGate({ remainingMs: () => (active && lastEnd ? Math.max(0, 60_000 - (Date.now() - lastEnd)) : 0) });
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    lastEnd = Date.now();
    queue.complete(queue.getState().current?.id);
    expect(queue.getState().current).toBeNull();

    active = false;
    queue.setStartGate({ remainingMs: () => 0 });
    expect(queue.getState().current?.clipId).toBe("b");
  });

  it("skip y complete también esperan el intervalo (no lo saltean)", async () => {
    const queue = new AlertQueue();
    let lastEnd = 0;
    const intervalMs = 120;
    queue.setStartGate({ remainingMs: () => (lastEnd ? Math.max(0, intervalMs - (Date.now() - lastEnd)) : 0) });
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    lastEnd = Date.now();
    queue.skip();
    expect(queue.getState().current).toBeNull();
    await waitFor(() => queue.getState().current !== null);
    expect(queue.getState().current?.clipId).toBe("b");
  });

  it("en pausa no arranca aunque la compuerta esté abierta, y al reanudar sí", () => {
    const queue = new AlertQueue();
    queue.setStartGate({ remainingMs: () => 0 });
    queue.enqueue({ clipId: "a" });
    queue.pause();
    queue.complete(queue.getState().current?.id);
    expect(queue.getState().current).toBeNull();
    queue.resume();
    expect(queue.getState().current).toBeNull();
    expect(queue.getState().size).toBe(0);
    queue.enqueue({ clipId: "b" });
    expect(queue.getState().current?.clipId).toBe("b");
  });

  it("dispose() cancela el temporizador pendiente: la cola no promociona después del cierre", async () => {
    const queue = new AlertQueue();
    queue.setStartGate({ remainingMs: () => 60 });
    queue.enqueue({ clipId: "a" });
    queue.enqueue({ clipId: "b" });
    // El primero suena y termina: la compuerta retiene al segundo con un timer.
    queue.complete(queue.getState().current?.id);
    expect(queue.getState().current).toBeNull();

    queue.dispose();
    await new Promise((resolve) => setTimeout(resolve, 120));
    // Sin dispose() el segundo habría arrancado al vencer el intervalo.
    expect(queue.getState().current).toBeNull();
    expect(queue.getState().pending.map((item) => item.clipId)).toEqual(["a", "b"]);
  });

  it("dispose() es idempotente y se puede llamar sin timer pendiente", () => {
    const queue = new AlertQueue();
    expect(() => queue.dispose()).not.toThrow();
    queue.dispose();
  });
});
