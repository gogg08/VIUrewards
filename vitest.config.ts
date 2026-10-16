import { defineConfig } from "vitest/config";

/**
 * Configuración de tests.
 *
 * `npm test` corre los tests rápidos (todo fuera de `tests/e2e`). Las pruebas que
 * necesitan binarios reales (ffmpeg/ffprobe) viven en `tests/e2e` y se corren con
 * `npm run test:e2e`, que apunta directo a esa carpeta.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "tests/e2e/**"],
  },
});
