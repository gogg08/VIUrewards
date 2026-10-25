import { defineConfig } from "vitest/config";

/**
 * Configuración de los tests del PAQUETE (Fase de distribución, Etapa 2).
 *
 * `npm run test:dist` construye el paquete portable (si no existe) y corre el
 * smoke test contra el ZIP ya extraído, con el `node.exe` incluido. Es lento
 * (descarga el runtime y las herramientas la primera vez), así que no forma
 * parte de `npm test` ni de `npm run test:e2e`.
 *
 * Requiere Windows x64 y Node en la versión fijada por `scripts/dist/config.ts`.
 */
export default defineConfig({
  test: {
    include: ["tests/dist/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
