// src/api/integrations/providers/cloudflare/client-env.ts

/**
 * @deprecated Moved to src/api/client-env/setup.ts
 * This file re-exports for backward compatibility.
 */

export {
  setupClientEnvironment,
  type ClientEnvSetupOptions,
  type ClientEnvSetupResult,
  type ClientEnvResult,
  CLIENT_D1_NAME,
  CLIENT_KV_NAME,
  HEALTH_WORKER_NAME,
  TDS_WORKER_NAME,
} from "../../../client-env/setup";

export {
  type ClientEnvStatusResult,
} from "../../../client-env/status";
