/**
 * Declaración ambiental mínima de `better-sqlite3` (Fase 3).
 *
 * El paquete no trae tipos propios y la regla del proyecto es preguntar antes de
 * agregar dependencias, así que en lugar de sumar `@types/better-sqlite3`
 * declaramos acá solo la superficie que usamos. Si en el futuro se prefiere el
 * paquete oficial de tipos, se puede borrar este archivo y agregar el devDependency.
 *
 * Los parámetros se tipan con `unknown[]`: aceptan cualquier valor sin caer en `any`.
 */

declare module "better-sqlite3" {
  namespace BetterSqlite3 {
    interface Options {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
    }

    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Statement<Row = unknown> {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): Row | undefined;
      all(...params: unknown[]): Row[];
      iterate(...params: unknown[]): IterableIterator<Row>;
    }

    interface Database {
      readonly open: boolean;
      pragma(source: string, options?: { simple?: boolean }): unknown;
      exec(source: string): this;
      prepare<Row = unknown>(source: string): Statement<Row>;
      transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
      close(): this;
    }

    interface DatabaseConstructor {
      new (filename?: string, options?: Options): Database;
      (filename?: string, options?: Options): Database;
    }
  }

  const BetterSqlite3: BetterSqlite3.DatabaseConstructor;
  export = BetterSqlite3;
}