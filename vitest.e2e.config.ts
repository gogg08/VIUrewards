import { defineConfig } from "vitest/config";

/**
 * Configuración SOLO para las pruebas de integración con binarios reales
 * (ffmpeg/ffprobe). Se corre con `npm run test:e2e`. No la usa `npm test`.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
  },
});
