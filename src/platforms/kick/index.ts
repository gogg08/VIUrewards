/**
 * Punto de entrada del adaptador de Kick. Solo lo importa el registro
 * `src/platforms/index.ts`; el resto de la app usa la interfaz genérica.
 */

export { createKickIntegration, KickIntegration, type KickIntegrationOptions } from "./integration.ts";
