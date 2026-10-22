/**
 * Error de arranque: otra copia de VIUrewards tiene los datos compartidos.
 *
 * Vive aparte de `instance-lock.ts` para que lo importe cualquier capa (el
 * arranque, el servidor, los tests) sin arrastrar el módulo del cerrojo.
 *
 * `scripts/start.ts` lo usa para salir con código de error SIN abrir la base,
 * sin reconciliar y sin levantar el servidor: dos copias sobre el mismo `media/`
 * y la misma base competirían por los archivos y por SQLite.
 */

/** Código de salida del arranque cuando falta la exclusividad. */
export const SHARED_DATA_IN_USE_EXIT_CODE = 3;

export class SharedDataInUseError extends Error {
  /** Mensaje en español, listo para la consola. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "SharedDataInUseError";
    this.reason = reason;
  }
}
