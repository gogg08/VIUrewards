import { describe, expect, it } from "vitest";

import { AlertQueue, QueueInputError } from "./queue.ts";
import { PlayClip } from "./action.ts";

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
});
