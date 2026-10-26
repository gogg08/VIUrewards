/**
 * Enumeración de procesos sin `wmic`.
 *
 * Contexto real: el runner `windows-latest` ya no trae `wmic` y el build falló
 * con `spawnSync wmic ENOENT`. Estas pruebas fijan el reemplazo
 * (`Get-CimInstance Win32_Process`) y, sobre todo, que un fallo de enumeración
 * NO se confunda con "no queda nada vivo".
 */

import { beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

import {
  IS_WINDOWS,
  PROCESS_TABLE_TIMEOUT_MS,
  directChildren,
  isAlive,
  killOwnTree,
  noteTest,
  parseCsv,
  processTable,
  processTableError,
  rowsFromWindowsCsv,
  setProcessEnumerator,
} from "./helpers/proc-tree.ts";

// Diagnóstico (solo con `CI`): los avisos de la consulta de procesos identifican
// el test en curso, así un cuelgue de `processTable()` deja ver cuál era.
beforeEach((context) => {
  noteTest(context.task.name);
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

  it("trata un ppid no numérico como 0 en vez de NaN", () => {
    expect(rowsFromWindowsCsv('"pid","ppid","cmd"\r\n"9","","x"')).toEqual([{ pid: 9, ppid: 0, cmd: "x" }]);
  });

  it("ignora filas incompletas y no lanza", () => {
    expect(() => rowsFromWindowsCsv('"pid"\r\n"5"\r\n\r\n')).not.toThrow();
    expect(rowsFromWindowsCsv('"pid"\r\n"5"\r\n\r\n')).toEqual([]);
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
      // Se espera a que el SO lo registre con el padre correcto.
      let found: number[] = [];
      for (let attempt = 0; attempt < 40 && found.length === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        found = await directChildren(process.pid);
      }
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
    let ticked = false;
    const restore = setProcessEnumerator(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve('"pid","ppid","cmd"\r\n"4","0",""'), 300);
        }),
    );
    try {
      const pending = processTable();
      await new Promise((resolve) => setTimeout(resolve, 50));
      ticked = true;
      expect(ticked, "el timer se ejecutó mientras la consulta estaba pendiente").toBe(true);
      const table = await pending;
      expect(table).toEqual([{ pid: 4, ppid: 0, cmd: "" }]);
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
    const restore = setProcessEnumerator(() =>
      Promise.resolve('"pid","ppid","cmd"\r\n"4","0",""\r\n"140","4","node.exe"'),
    );
    try {
      const table = await processTable();
      expect(table).toHaveLength(2);
      expect(processTableError()).toBeNull();
    } finally {
      restore();
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
    let spawnError: Error | null = null;
    const pidHolder: { pid?: number } = {};
    const restore = setProcessEnumerator(
      () =>
        new Promise<string>((resolve, reject) => {
          // Enumerador propio: se cuelga para siempre, para probar el plazo.
          const child = spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { stdio: "ignore", windowsHide: true },
          );
          pidHolder.pid = child.pid;
          child.on("error", reject);
          const expiry = setTimeout(() => {
            spawnError = new Error("la consulta de procesos superó el plazo de 500 ms y se terminó");
            reject(spawnError);
          }, 500);
          child.on("close", () => clearTimeout(expiry));
          // Aseguramos que tras el rechazo el hijo se termina de verdad.
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
      // El hijo del experimento se termina aquí (es NUESTRO proceso, no ajeno).
      const pid = pidHolder.pid;
      if (pid !== undefined) {
        try {
          process.kill(pid);
        } catch {
          // Ya murió.
        }
        // Se le da un instante al SO para registrar la salida.
        for (let i = 0; i < 20 && isAlive(pid); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(isAlive(pid), "el proceso del experimento quedó vivo").toBe(false);
      }
    }
  });
});
