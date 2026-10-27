import { defineConfig } from "vitest/config";

/**
 * Configuración de tests.
 *
 * `npm test` corre los tests rápidos: todo `src/**` MÁS los tests puros de la
 * guarda de procesos (`tests/e2e/proc-tree-guard.test.ts`). Las pruebas que
 * necesitan binarios reales (ffmpeg/ffprobe) o que crean y terminan procesos
 * viven en los demás archivos de `tests/e2e` y se corren con `npm run test:e2e`,
 * que apunta directo a esa carpeta.
 *
 * El `exclude` no nombra los archivos E2E: quedan fuera por construcción, porque
 * no coinciden con ninguno de los patrones de `include`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/e2e/proc-tree-guard.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
