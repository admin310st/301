// src/api/workers/index.ts

/**
 * Worker Configuration Module
 *
 * Manages wrangler.toml configurations for client workers:
 * - Health Worker (301-client): Domain health monitoring
 * - TDS Worker (301-tds): Traffic distribution system
 */

export {
  // Types
  type WorkerType,
  type WorkerRoute,
  type WorkerConfig,

  // Config generation
  generateWranglerToml,

  // Database operations
  getWorkerConfig,
  getWorkerConfigs,
  upsertWorkerConfig,

  // HTTP handlers
  handleGenerateConfig,
  handleGetConfigs,
  handleGetConfig,
  handleUpdateConfig,
  handleDownloadConfig,
  handleAddRoute,
  handleRemoveRoute,
  handleSetupWorker,
} from "./config";
