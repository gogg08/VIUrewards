/**
 * ¿Se está ejecutando este archivo como programa principal?
 *
 * Los puntos de entrada del producto (`scripts/start.ts`, el arnés de cierre y
 * `scripts/play-test.ts`) solo arrancan si el archivo es el que invocó el
 * usuario; importarlo desde un test o una herramienta nunca debe abrir la base
 * ni levantar el servidor.
 *
 * La comparación ingenua (`import.meta.url === pathToFileURL(argv[1]).href`)
 * falla cuando el camino pasa por un enlace simbólico o una junction: Node
 * resuelve el módulo y `import.meta.url` trae la ruta **real**, mientras que
 * `argv[1]` conserva la ruta tal como se la dieron. El caso medido: una
 * instalación bajo `%LOCALAPPDATA%\Programs`, que es una junction, arrancaba y
 * terminaba con código 0 sin imprimir nada. Por eso los dos lados se resuelven
 * primero a su ruta real (`fs.realpathSync.native`, que además devuelve la
 * capitalización canónica del disco en Windows).
 *
 * No se usa `import.meta.main`: no existe en todas las versiones de Node ni
 * está en los tipos del proyecto, y bajo vitest quedaría indefinido.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `metaUrl` es `import.meta.url` del archivo que se está evaluando; `argv1` es
 * `process.argv[1]`.
 *
 * - `argv1` indefinido (REPL, `node -e`, vitest): `false`.
 * - Si algún lado no se puede resolver a una ruta real (archivo inexistente,
 *   URL que no es `file:`), cae a la comparación vieja y conserva el
 *   comportamiento de los casos sin enlaces.
 */
export function isEntryPoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync.native(fileURLToPath(metaUrl)) === realpathSync.native(argv1);
  } catch {
    return pathToFileURL(argv1).href === metaUrl;
  }
}
