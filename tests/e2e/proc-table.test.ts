/**
 * Enumeración de procesos sin `wmic`.
 *
 * Contexto real: el runner `windows-latest` ya no trae `wmic` y el build falló
 * con `spawnSync wmic ENOENT`. Estas pruebas fijan el reemplazo
 * (`Get-CimInstance Win32_Process`) y, sobre todo, que un fallo de enumeración
 * NO se confunda con "no queda nada vivo".
 */

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

import {
  IS_WINDOWS,
  directChildren,
  parseCsv,
  processTable,
  rowsFromWindowsCsv,
} from "./helpers/proc-tree.ts";

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
  it("enumera procesos y encuentra procesos conocidos", () => {
    const table = processTable();
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
        found = directChildren(process.pid);
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
