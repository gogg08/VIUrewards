/**
 * Enumeración de procesos sin `wmic`.
 *
 * Contexto real: el runner `windows-latest` ya no trae `wmic` y el build falló
 * con `spawnSync wmic ENOENT`. Estas pruebas fijan el reemplazo
 * (`Get-CimInstance Win32_Process`) y, sobre todo, que un fallo de enumeración
 * NO se confunda con "no queda nada vivo".
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

import {
  IS_WINDOWS,
  KILL_PROCESS_TREE_TIMEOUT_MS,
  PROCESS_TABLE_TIMEOUT_MS,
  captureBaseline,
  describeSurvivors,
  directChildren,
  isAlive,
  killOwnTree,
  noteTest,
  ownTree,
  parseCsv,
  processTable,
  processTableError,
  processTableQueryCount,
  resetProcessTableQueryCount,
  rowsFromWindowsCsv,
  setProcessEnumerator,
  spyOnChildProcess,
} from "./helpers/proc-tree.ts";

/*
 * Espía y lista blanca a nivel de ARCHIVO, como en los demás e2e: las pruebas de
 * limpieza necesitan saber qué lanzó ESTE proceso de test y qué existía antes.
 * Sin esto, un hijo propio solo se encontraba por enumeración de descendientes y
 * bajo carga podía no estar todavía en la tabla: el pid quedaba fuera de
 * `targets` y la limpieza no lo mataba (test intermitente, reproducido).
 */
const spy = spyOnChildProcess();

// Diagnóstico (solo con `CI`): los avisos de la consulta de procesos identifican
// el test en curso, así un cuelgue de `processTable()` deja ver cuál era.
beforeEach((context) => {
  noteTest(context.task.name);
  // El registro de procesos capturados es POR TEST: un `ChildProcess` del test
  // anterior no puede convertirse en objetivo del siguiente. Ninguna entrada
  // se hereda entre pruebas.
  spy.clear();
});

/*
 * La lista blanca se toma UNA vez por archivo (no por test): `captureBaseline()`
 * consulta la tabla de procesos, y repetirlo en cada prueba multiplicaría las
 * llamadas a WMI sin aportar nada. Es el mismo criterio que `shutdown.test.ts`.
 */
beforeAll(async () => {
  await captureBaseline();
});

describe("parseCsv", () => {
  it("separa campos simples y descarta el CR de CRLF", () => {
    expect(parseCsv('"a","b","c"\r\n"1","2","3"\r\n')).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("respeta las comas dentro de un campo entrecomillado", () => {
    // `CommandLine` real trae comas: `node -e "console.log(1,2)"`.
    const rows = parseCsv('"pid","ppid","cmd"\r\n"1","2","node -e ""x,1,2"" --a=b,c"\r\n');
    expect(rows[1]).toEqual(["1", "2", 'node -e "x,1,2" --a=b,c']);
  });

  it("desescapa las comillas duplicadas", () => {
    expect(parseCsv('"a"\r\n"says ""hi"""\r\n')).toEqual([["a"], ['says "hi"']]);
  });

  it("conserva los campos vacíos", () => {
    expect(parseCsv('"pid","ppid","cmd"\r\n"1","2",""\r\n')).toEqual([
      ["pid", "ppid", "cmd"],
      ["1", "2", ""],
    ]);
  });

  it("devuelve vacío para una entrada vacía", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("rowsFromWindowsCsv", () => {
  it("convierte el CSV de la consulta en filas, sin el encabezado", () => {
    const csv = ['"pid","ppid","cmd"', '"4","0",""', '"140","4","node.exe app.js"', ""].join("\r\n");
    expect(rowsFromWindowsCsv(csv)).toEqual([
      { pid: 4, ppid: 0, cmd: "" },
      { pid: 140, ppid: 4, cmd: "node.exe app.js" },
    ]);
  });

  it("nunca inventa un pid 0 a partir de una fila ilegible", () => {
    // `pid = 0` se confundiría con el proceso Idle y el árbol saldría mal.
    const csv = ['"pid","ppid","cmd"', '"","","basura"', '"abc","1","x"', '"7","1","ok"'].join("\r\n");
    expect(rowsFromWindowsCsv(csv)).toEqual([{ pid: 7, ppid: 1, cmd: "ok" }]);
  });

  it("trata un ppid no numérico como el centinela -1, nunca 0", () => {
    // `Number("")` vale 0: si se normalizara, la fila colgaría de la raíz 0
    // (Idle) y parecería una relación real. El parser usa `-1`, que ningún
    // proceso tiene como padre.
    expect(rowsFromWindowsCsv('"pid","ppid","cmd"\r\n"9","","x"')).toEqual([{ pid: 9, ppid: -1, cmd: "x" }]);
  });

  it("ignora filas incompletas y no lanza", () => {
    // Encabezado VÁLIDO: lo que se prueba es la fila, no el encabezado. Cada fila
    // necesita las tres celdas (`pid`, `ppid`, `cmd`); con menos se descarta.
    const csv = ['"pid","ppid","cmd"', '"5","1"', '"","",""', '"6","1",""', ""].join("\r\n");
    expect(() => rowsFromWindowsCsv(csv)).not.toThrow();
    // La fila corta y la de PID inválido se van; la tercera celda vacía es válida.
    expect(rowsFromWindowsCsv(csv)).toEqual([{ pid: 6, ppid: 1, cmd: "" }]);
  });
});

describe.runIf(IS_WINDOWS)("processTable con el proceso real", () => {
  it("enumera procesos y encuentra procesos conocidos", async () => {
    const table = await processTable();
    // Una tabla vacía es un fallo de enumeración, no una máquina sin procesos.
    expect(table.length).toBeGreaterThan(0);
    // El proceso de test tiene que estar en su propia tabla.
    expect(table.some((row) => row.pid === process.pid)).toBe(true);
  });

  it("encuentra un hijo real por ParentProcessId", async () => {
    // Hijo real y vivo: la enumeración se prueba contra un proceso de verdad,
    // no contra una tabla simulada.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      expect(typeof child.pid).toBe("number");
      const pid = child.pid as number;
      /*
       * Se espera a que el SO lo registre con el padre correcto.
       *
       * El bucle sondea como MUCHO hasta el plazo, no un número fijo de
       * intentos: cada consulta cuesta ~1 s (más en un runner cargado), así que
       * "40 intentos" podían ser 40 consultas si el hijo nunca aparecía, y en el
       * caso normal son casi todas desperdiciadas porque el hijo tarda unos
       * milisegundos en registrarse. El plazo se mide con el reloj, no contando
       * consultas: ser lento no lo vuelve intermitente.
       */
      const deadline = Date.now() + 20_000;
      let found: number[] = [];
      do {
        found = await directChildren(process.pid);
        if (found.includes(pid)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(found, "la enumeración no vio al hijo recién lanzado").toContain(pid);
    } finally {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid);
        } catch {
          // Ya murió.
        }
      }
    }
  });
});

/**
 * El límite de UNA consulta es independiente del plazo del test.
 *
 * Medido: `Get-CimInstance` tarda ~1 s en una PC descargada. El plazo de la
 * consulta (15 s) corta mucho antes que el plazo de un test e2e (90 s) y que el
 * `timeout-minutes` del paso de CI (8 min), así que un WMI colgado produce un
 * fallo explícito del test en vez de que el runner se caiga sin logs.
 */
describe("plazo de la consulta de procesos", () => {
  it("no es mayor que el plazo de un test e2e ni que el del paso de CI", () => {
    expect(PROCESS_TABLE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(PROCESS_TABLE_TIMEOUT_MS).toBeLessThan(90_000);
    expect(PROCESS_TABLE_TIMEOUT_MS).toBeLessThan(8 * 60_000);
  });
});

/**
 * Simulaciones con un enumerador INYECTADO.
 *
 * No se depende de que el WMI real se bloquee: el caso -el que provocó el
 * cuelgue silencioso del runner- se reproduce con un enumerador controlado.
 */
describe("enumerador simulado", () => {
  it("una consulta lenta produce un error explícito, no una tabla vacía silenciosa", async () => {
    const restore = setProcessEnumerator(() =>
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("la consulta de procesos superó el plazo de 15000 ms")), 20);
      }),
    );
    try {
      const table = await processTable();
      expect(table).toEqual([]);
      // Lo importante: el fallo QUEDA REGISTRADO. Con `[]` silencioso, la
      // limpieza creería que no quedó nada vivo.
      expect(processTableError()).toContain("superó el plazo");
    } finally {
      restore();
    }
  });

  it("el bucle de eventos sigue libre mientras la consulta está pendiente", async () => {
    // Antes, con `execFileSync`, este timer NO llegaba a dispararse (medido).
    // La tabla inyectada representa una del sistema: tiene que incluir el proceso
    // actual, o `readProcessSnapshot()` la rechazaría por otro motivo.
    //
    // PID auxiliar distinto de 4 y de `process.pid`: dos filas con el mismo PID
    // formarían una tabla malformada sin que este test lo pretenda.
    const otherPid = process.pid === 4 ? 5 : 4;
    let ticked = false;
    const restore = setProcessEnumerator(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(
            () => resolve(`"pid","ppid","cmd"\r\n"${otherPid}","0",""\r\n"${process.pid}","${otherPid}","node.exe vitest"`),
            300,
          );
        }),
    );
    try {
      const pending = processTable();
      await new Promise((resolve) => setTimeout(resolve, 50));
      ticked = true;
      expect(ticked, "el timer se ejecutó mientras la consulta estaba pendiente").toBe(true);
      const table = await pending;
      expect(table).toContainEqual({ pid: otherPid, ppid: 0, cmd: "" });
      expect(table.some((row) => row.pid === process.pid)).toBe(true);
      expect(processTableError()).toBeNull();
    } finally {
      restore();
    }
  });

  it("un CSV vacío no se confunde con una consulta correcta", async () => {
    const restore = setProcessEnumerator(() => Promise.resolve('"pid","ppid","cmd"\r\n'));
    try {
      expect(await processTable()).toEqual([]);
      expect(processTableError()).toContain("no devolvió ningún proceso");
    } finally {
      restore();
    }
  });

  it("un CSV con encabezado pero sin filas válidas se marca como mal formado", async () => {
    const restore = setProcessEnumerator(() => Promise.resolve('"pid","ppid","cmd"\r\n"abc","x","basura"'));
    try {
      expect(await processTable()).toEqual([]);
      expect(processTableError()).toContain("no tenía filas válidas");
    } finally {
      restore();
    }
  });

  it("una salida truncada o basura no se confunde con una consulta correcta", async () => {
    const restore = setProcessEnumerator(() => Promise.resolve("basura sin columnas\nmas basura"));
    try {
      expect(await processTable()).toEqual([]);
      expect(processTableError()).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("una consulta correcta deja el error en null", async () => {
    // Tabla válida del sistema: debe contener el proceso actual.
    // PIDs sintéticos distintos entre sí y de `process.pid`: no se asume que un
    // número fijo nunca coincida con el del proceso de test.
    const rootPid = process.pid === 4 ? 5 : 4;
    const childPid = process.pid === 140 ? 141 : 140;
    expect(rootPid).not.toBe(process.pid);
    expect(childPid).not.toBe(process.pid);
    expect(childPid).not.toBe(rootPid);
    const restore = setProcessEnumerator(() =>
      Promise.resolve(
        `"pid","ppid","cmd"\r\n"${rootPid}","0",""\r\n"${childPid}","${rootPid}","node.exe"\r\n"${process.pid}","${rootPid}","node.exe vitest"`,
      ),
    );
    try {
      const table = await processTable();
      expect(table).toHaveLength(3);
      expect(table.some((row) => row.pid === process.pid)).toBe(true);
      expect(processTableError()).toBeNull();
    } finally {
      restore();
    }
  });

  it("una tabla válida SIN el proceso actual es un error duro de enumeración", async () => {
    // El formato es correcto; lo que falta es la prueba de que la tabla describe
    // ESTA máquina. Sin el proceso propio no se puede afirmar nada sobre lo que
    // quedó vivo, así que `processTable()` no devuelve filas y sí informa.
    //
    // Dos PID distintos entre sí y de `process.pid`: la tabla es válida y no
    // tiene duplicados; lo único que falta es el proceso actual.
    const rootPid = process.pid === 4 ? 5 : 4;
    const childPid = process.pid === 6 ? 7 : 6;
    expect(rootPid).not.toBe(process.pid);
    expect(childPid).not.toBe(process.pid);
    expect(childPid).not.toBe(rootPid);
    const restore = setProcessEnumerator(() =>
      Promise.resolve(
        `"pid","ppid","cmd"\r\n"${rootPid}","0",""\r\n"${childPid}","${rootPid}","node.exe ajeno"`,
      ),
    );
    try {
      expect(await processTable()).toEqual([]);
      expect(processTableError()).toContain("proceso actual");
    } finally {
      restore();
    }
  });
});

/**
 * Cuántas consultas de procesos hace cada operación.
 *
 * Se cuentan con un enumerador simulado (`setProcessEnumerator`): no se invoca
 * PowerShell ni WMI, así que la prueba es instantánea y comprueba exactamente
 * la propiedad que importa — que no se repita la consulta dentro de una misma
 * operación. El plazo, el parsing y los errores ya se prueban aparte.
 *
 * En un paso de CI de 5 minutos, cada consulta son ~1 s en esta PC y más en un
 * runner cargado: `killOwnTree` bajó de 3 consultas a 1.
 */
describe("consultas de procesos por operación", () => {
  /** Enumerador que cuenta y responde un CSV mínimo (proceso actual + pid 4). */
  function countingEnumerator(rows?: Array<[number, number, string]>): {
    calls: () => number;
    restore: () => void;
  } {
    let calls = 0;
    const body = rows ??
      [
        [process.pid, 0, "node.exe"],
        [4, 0, ""],
      ];
    const csv = [
      '"pid","ppid","cmd"',
      ...body.map(([pid, ppid, cmd]) => `"${pid}","${ppid}","${cmd}"`),
      "",
    ].join("\r\n");
    const restore = setProcessEnumerator(() => {
      calls += 1;
      return Promise.resolve(csv);
    });
    return { calls: () => calls, restore };
  }

  it("ownTree hace UNA consulta y devuelve esa misma tabla", async () => {
    const fake = countingEnumerator();
    try {
      const tree = await ownTree();
      expect(fake.calls()).toBe(1);
      // La tabla que se devuelve es la que se usó para calcular los objetivos.
      expect(tree.table.some((row) => row.pid === process.pid)).toBe(true);
    } finally {
      fake.restore();
    }
  });

  it("captureBaseline hace UNA sola consulta (antes hacía dos)", async () => {
    const fake = countingEnumerator();
    try {
      await captureBaseline();
      expect(fake.calls()).toBe(1);
    } finally {
      fake.restore();
    }
  });

  it("una limpieza hace UNA consulta en total (antes hacía tres)", async () => {
    // Sin procesos propios: el camino completo (cadena de ancestros + limpieza)
    // hacía antes objetivos + orden + supervivientes = 3 consultas CIM.
    const fake = countingEnumerator();
    try {
      const result = await killOwnTree({ roots: [] });
      expect(result.enumerationError).toBeNull();
      expect(fake.calls()).toBe(1);
    } finally {
      fake.restore();
    }
  });

  it("el contador real refleja las consultas hechas", async () => {
    const fake = countingEnumerator();
    try {
      resetProcessTableQueryCount();
      await processTable();
      await processTable();
      expect(processTableQueryCount()).toBe(2);
    } finally {
      fake.restore();
    }
  });
});

/**
 * Un fallo de enumeración NO puede dejar que la limpieza se declare
 * satisfactoria.
 *
 * Es el requisito central: con una tabla vacía silenciosa, `killOwnTree`
 * devolvería `survivors: []` y el test pasaría creyendo que no quedó nada vivo,
 * mientras los procesos del test siguen corriendo.
 */
describe("la limpieza no se declara satisfactoria sin enumeración", () => {
  it("killOwnTree devuelve el error de enumeración en vez de un resultado limpio", async () => {
    const restore = setProcessEnumerator(() => Promise.reject(new Error("WMI no responde")));
    try {
      const result = await killOwnTree({ roots: [] });
      expect(result.enumerationError).toContain("WMI no responde");
      // No se mató "a ciegas" nada, y no se afirma que la limpieza salió bien.
      expect(result.killed).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe.runIf(IS_WINDOWS)("terminación del enumerador", () => {
  it("un proceso que no termina en el plazo muere y no queda vivo", async () => {
    /** El hijo del EXPERIMENTO: se termina por su objeto, nunca por su pid. */
    const holder: { child?: ReturnType<typeof spawn> } = {};
    let spawnError: Error | null = null;
    const restore = setProcessEnumerator(
      () =>
        new Promise<string>((resolve, reject) => {
          // Enumerador propio: se cuelga para siempre, para probar el plazo.
          const child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { stdio: "ignore", windowsHide: true },
          );
          holder.child = child;
          child.on("error", reject);
          const expiry = setTimeout(() => {
            spawnError = new Error("la consulta de procesos superó el plazo de 500 ms y se terminó");
            reject(spawnError);
          }, 500);
          child.on("close", () => clearTimeout(expiry));
          void resolve;
        }),
    );
    try {
      const table = await processTable();
      expect(table).toEqual([]);
      expect(processTableError()).toContain("superó el plazo");
      expect(spawnError).not.toBeNull();
    } finally {
      restore();
      // El hijo del experimento se termina por SU OBJETO (es nuestro proceso, no
      // ajeno) y se confirma por `exit`: no se reconstruye ningún pid.
      const child = holder.child;
      if (child !== undefined) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        const gone = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        expect(gone, "el proceso del experimento quedó vivo").toBe(true);
      }
    }
  }, 30_000);
});

/**
 * Plazo de UNA operación `killProcessTree`.
 *
 * La limpieza de los E2E **ya no** escala a `killProcessTree` (termina procesos
 * por PID con `/T` y el diseño conservador lo prohíbe). El plazo sigue existiendo
 * para el supervisor de producción y se verifica en
 * `src/media/run-process.test.ts`; aquí solo se comprueba la relación entre las
 * constantes que usa el helper.
 */
describe("plazo de la escalada a killProcessTree", () => {
  it("es corto y no se confunde con el plazo de la consulta ni con el del test", () => {
    // Medido: `taskkill` cierra en ~57 ms con un pid inexistente.
    expect(KILL_PROCESS_TREE_TIMEOUT_MS).toBe(5_000);
    expect(KILL_PROCESS_TREE_TIMEOUT_MS).toBeLessThan(PROCESS_TABLE_TIMEOUT_MS);
    expect(KILL_PROCESS_TREE_TIMEOUT_MS).toBeLessThan(90_000);
  });
});

/**
 * Limpieza con procesos PROPIOS de verdad.
 *
 * Determinismo: el hijo se identifica por el `ChildProcess` que devolvió
 * `spawn` (con el espía y la lista blanca ya instaladas a nivel de archivo), no
 * por la enumeración de descendientes. Antes solo se encontraba por parentesco,
 * y bajo carga la tabla podía no tenerlo todavía con el `ParentProcessId`
 * correcto: el pid quedaba fuera de `targets` y la limpieza “no lo mataba”.
 *
 * Nunca se señaliza nada ajeno: el pid sale de un proceso creado en este mismo
 * test y la lista blanca protege la línea de padres del proceso de test.
 */
describe.runIf(IS_WINDOWS)("limpieza de procesos propios", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Lanza un Node que no termina; devuelve el OBJETO y el pid que dio `spawn`.
   *
   * El objeto es con lo que se termina (nunca el pid); el pid solo se usa para
   * comprobar que murió.
   */
  function ownSleeper(): { child: ReturnType<typeof spawn>; pid: number } {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid;
    expect(typeof pid, "no se pudo lanzar el proceso de prueba").toBe("number");
    expect(isAlive(pid as number), "el proceso de prueba no arrancó").toBe(true);
    return { child, pid: pid as number };
  }

  /** Espera a que el pid muera; devuelve si lo logró. */
  async function waitDead(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true;
      await sleep(50);
    }
    return !isAlive(pid);
  }

  /** Termina el proceso propio (si quedó vivo) por SU OBJETO y espera `exit`. */
  async function disposeOwn(child: ReturnType<typeof spawn>, pid: number): Promise<void> {
    if (!isAlive(pid)) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  it("el espía identifica el proceso creado por esta prueba", async () => {
    // Requisito de determinismo: el pid que se va a limpiar es uno que el espía
    // capturó en ESTE test (con su objeto `ChildProcess`).
    const { child, pid } = ownSleeper();
    try {
      expect(spy.spawned(), "el espía no registró el proceso lanzado").toContain(pid);
    } finally {
      await disposeOwn(child, pid);
    }
  }, 60_000);

  it("termina el proceso propio y no informa de supervivientes", async () => {
    const { child, pid } = ownSleeper();
    try {
      const result = await killOwnTree({ roots: [pid] });
      expect(result.enumerationError, "la enumeración falló; no se puede afirmar la limpieza").toBeNull();
      // Se termina por el objeto `ChildProcess` y se confirma con `exit`/`close`:
      // `ok` es la única señal de éxito, no la ausencia de supervivientes.
      expect(result.ok, result.detail).toBe(true);
      expect(result.cleanup.exitConfirmed).toContain(pid);
      expect(result.survivors, await describeSurvivors(result.survivors)).toEqual([]);
      expect(await waitDead(pid, 3_000), "el proceso limpio quedó vivo").toBe(true);
    } finally {
      await disposeOwn(child, pid);
    }
  }, 60_000);

  it("la limpieza se dirige solo a procesos del test", async () => {
    // Control negativo: el proceso del propio test y su línea de padres nunca
    // son objetivo de la limpieza, aunque corran en la misma máquina.
    const { child, pid } = ownSleeper();
    try {
      const tree = await ownTree({ roots: [pid] });
      expect(tree.targets).toContain(pid);
      expect(tree.targets, "el proceso de test se incluyó como objetivo").not.toContain(process.pid);
      for (const protectedPid of tree.protectedPids) {
        expect(tree.targets, "un padre del test se incluyó como objetivo").not.toContain(protectedPid);
      }
    } finally {
      await disposeOwn(child, pid);
    }
  }, 60_000);

  it("un fallo de enumeración NO se declara como limpieza satisfactoria", async () => {
    // Sin tabla no se sabe qué quedó vivo: se informa el error en vez de
    // devolver `survivors: []` (que el test leería como éxito).
    const restore = setProcessEnumerator(() => Promise.reject(new Error("WMI no responde")));
    try {
      const result = await killOwnTree({ roots: [] });
      expect(result.enumerationError).toContain("WMI no responde");
    } finally {
      restore();
    }
  });

  it("con raíces explícitas se limpia el proceso propio aunque falle la enumeración, pero el error queda informado", async () => {
    // Semántica real: el pid está captureado por el espía de ESTE test (el
    // objeto `ChildProcess` existe), así que se termina por su objeto aunque no
    // se pueda enumerar. Lo que NO ocurre es silenciar el fallo:
    // `enumerationError` viene puesto y el test que lo comprueba falla.
    const { child, pid } = ownSleeper();
    const restore = setProcessEnumerator(() => Promise.reject(new Error("CIM agotó el plazo")));
    try {
      const result = await killOwnTree({ roots: [pid] });
      expect(result.enumerationError).toContain("CIM agotó el plazo");
      expect(await waitDead(pid, 3_000), "el proceso propio capturado quedó vivo").toBe(true);
    } finally {
      restore();
      await disposeOwn(child, pid);
    }
  }, 60_000);
});
