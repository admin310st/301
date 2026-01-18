// src/api/integrations/providers/cloudflare/client-env.ts

/**
 * Client Environment Setup Orchestrator
 *
 * Автоматически создаёт окружение на CF аккаунте клиента:
 * - D1 Database (shared)
 * - KV Namespace (for integration keys)
 * - Workers (Health, TDS)
 * - Secrets, Bindings, Cron triggers
 *
 * Вызывается после успешной инициализации CF ключа.
 */

import { Env } from "../../../types/worker";
import { setupD1, executeD1Query } from "./d1";
import { setupKV, putKVValue } from "./kv";
import {
  deployWorkerScript,
  setWorkerSecrets,
  setWorkerCrons,
  WorkerBindings,
} from "./workers";
import { signJWT } from "../../../lib/jwt";
import { getHealthWorkerBundle } from "../../../health/bundle";
import { syncDomainList, type DomainListItem } from "./d1-sync";

// ============================================================
// CONSTANTS
// ============================================================

const CLIENT_D1_NAME = "301-client";
const CLIENT_KV_NAME = "301-keys";
const HEALTH_WORKER_NAME = "301-health";
const TDS_WORKER_NAME = "301-tds";

// ============================================================
// SCHEMAS
// ============================================================

/**
 * Unified D1 schema for all client workers
 */
const CLIENT_D1_SCHEMA = `
-- ============================================================
-- 301 Client D1 Schema (Shared)
-- ============================================================

-- Domain list (shared by Health and TDS)
CREATE TABLE IF NOT EXISTS domain_list (
    domain_name TEXT PRIMARY KEY,
    role TEXT,
    zone_id TEXT,
    active INTEGER DEFAULT 1,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Traffic stats (shared)
CREATE TABLE IF NOT EXISTS traffic_stats (
    domain_name TEXT PRIMARY KEY,
    zone_id TEXT,
    clicks_yesterday INTEGER DEFAULT 0,
    clicks_today INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- Health Worker Tables
-- ============================================================

-- Domain threats (from VirusTotal)
CREATE TABLE IF NOT EXISTS domain_threats (
    domain_name TEXT PRIMARY KEY,
    threat_score INTEGER,
    categories TEXT,
    reputation INTEGER,
    source TEXT,
    checked_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT
);

-- Threat check queue
CREATE TABLE IF NOT EXISTS threat_check_queue (
    domain_name TEXT PRIMARY KEY,
    priority INTEGER DEFAULT 0,
    source TEXT DEFAULT 'virustotal',
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_queue_status_priority
ON threat_check_queue(status, priority DESC, added_at);

-- ============================================================
-- TDS Worker Tables
-- ============================================================

-- TDS Rules Cache
CREATE TABLE IF NOT EXISTS tds_rules (
    id INTEGER PRIMARY KEY,
    domain_name TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    conditions TEXT NOT NULL,
    action TEXT NOT NULL,
    action_url TEXT,
    status_code INTEGER DEFAULT 302,
    active INTEGER DEFAULT 1,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tds_rules_domain
ON tds_rules(domain_name, active, priority DESC);

-- Domain TDS Config
CREATE TABLE IF NOT EXISTS domain_config (
    domain_name TEXT PRIMARY KEY,
    tds_enabled INTEGER DEFAULT 1,
    default_action TEXT DEFAULT 'pass',
    default_url TEXT,
    smartshield_enabled INTEGER DEFAULT 0,
    bot_action TEXT DEFAULT 'pass',
    bot_redirect_url TEXT,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Sync Status
CREATE TABLE IF NOT EXISTS sync_status (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO sync_status (key, value) VALUES ('last_sync', NULL);
`;

// ============================================================
// TYPES
// ============================================================

export interface ClientEnvSetupOptions {
  cfAccountId: string;
  cfToken: string;
  accountId: number;  // 301.st account ID
  env: Env;           // For JWT signing
  vtApiKey?: string;  // VirusTotal API key (optional)
}

export interface ClientEnvSetupResult {
  ok: boolean;
  error?: string;

  d1?: {
    database_id: string;
    database_name: string;
    created: boolean;
  };

  kv?: {
    namespace_id: string;
    namespace_name: string;
    created: boolean;
  };

  workers?: {
    health?: {
      name: string;
      deployed: boolean;
      secrets_set: string[];
      crons: string[];
    };
    tds?: {
      name: string;
      deployed: boolean;
      secrets_set: string[];
    };
  };

  initial_sync?: {
    domains_synced: number;
    error?: string;
  };
}

// ============================================================
// MAIN SETUP FUNCTION
// ============================================================

/**
 * Setup complete client environment
 *
 * Called after CF key initialization.
 * Creates D1, KV, deploys workers, sets secrets.
 */
export async function setupClientEnvironment(
  options: ClientEnvSetupOptions
): Promise<ClientEnvSetupResult> {
  const { cfAccountId, cfToken, accountId, env, vtApiKey } = options;

  const result: ClientEnvSetupResult = { ok: true };

  // ============================================================
  // 1. Setup D1 Database
  // ============================================================

  const d1Result = await setupD1({
    cfAccountId,
    token: cfToken,
    dbName: CLIENT_D1_NAME,
    schema: CLIENT_D1_SCHEMA,
  });

  if (!d1Result.ok) {
    return {
      ok: false,
      error: `D1 setup failed: ${d1Result.error}`,
    };
  }

  result.d1 = {
    database_id: d1Result.database_id!,
    database_name: d1Result.database_name!,
    created: d1Result.created || false,
  };

  // ============================================================
  // 2. Setup KV Namespace
  // ============================================================

  const kvResult = await setupKV(cfAccountId, CLIENT_KV_NAME, cfToken);

  if (!kvResult.ok) {
    return {
      ok: false,
      error: `KV setup failed: ${kvResult.error}`,
      d1: result.d1,
    };
  }

  result.kv = {
    namespace_id: kvResult.namespace_id!,
    namespace_name: kvResult.namespace_title!,
    created: kvResult.created || false,
  };

  // Store VT API key in KV if provided
  if (vtApiKey) {
    await putKVValue(
      cfAccountId,
      kvResult.namespace_id!,
      "VT_API_KEY",
      vtApiKey,
      cfToken
    );
  }

  // ============================================================
  // 3. Generate JWT for workers
  // ============================================================

  const jwtToken = await signJWT(
    {
      type: "client_worker",
      acc: accountId,
      cf_account_id: cfAccountId,
    },
    env,
    "365d"  // 1 year
  );

  // ============================================================
  // 4. Deploy Health Worker
  // ============================================================

  result.workers = {};

  const healthBundle = getHealthWorkerBundle();

  const healthBindings: WorkerBindings = {
    d1: [{ name: "DB", id: d1Result.database_id! }],
    kv: [{ name: "KV", namespace_id: kvResult.namespace_id! }],
    vars: {
      WEBHOOK_URL: "https://webhook.301.st/health",
      ACCOUNT_ID: String(accountId),
    },
  };

  const healthDeployResult = await deployWorkerScript(
    cfAccountId,
    HEALTH_WORKER_NAME,
    healthBundle,
    healthBindings,
    cfToken
  );

  if (!healthDeployResult.ok) {
    return {
      ok: false,
      error: `Health worker deploy failed: ${healthDeployResult.error}`,
      d1: result.d1,
      kv: result.kv,
    };
  }

  // Set secrets for Health worker
  const healthSecrets: Record<string, string> = {
    JWT_TOKEN: jwtToken,
  };

  const healthSecretsResult = await setWorkerSecrets(
    cfAccountId,
    HEALTH_WORKER_NAME,
    healthSecrets,
    cfToken
  );

  // Set cron for Health worker
  const healthCrons = ["0 */12 * * *"];  // Every 12 hours
  await setWorkerCrons(cfAccountId, HEALTH_WORKER_NAME, healthCrons, cfToken);

  result.workers.health = {
    name: HEALTH_WORKER_NAME,
    deployed: true,
    secrets_set: healthSecretsResult.set,
    crons: healthCrons,
  };

  // ============================================================
  // 5. Initial Sync: Push domains to client D1
  // ============================================================

  try {
    // Get all active domains for this account from 301.st D1
    const domainsResult = await env.DB301.prepare(`
      SELECT d.domain_name, d.role, z.cf_zone_id as zone_id,
             CASE WHEN d.blocked = 0 THEN 1 ELSE 0 END as active
      FROM domains d
      LEFT JOIN zones z ON d.zone_id = z.id
      WHERE d.account_id = ?
    `).bind(accountId).all<{
      domain_name: string;
      role: string | null;
      zone_id: string | null;
      active: number;
    }>();

    if (domainsResult.results && domainsResult.results.length > 0) {
      const domainItems: DomainListItem[] = domainsResult.results.map(d => ({
        domain_name: d.domain_name,
        role: d.role || undefined,
        zone_id: d.zone_id || undefined,
        active: d.active === 1,
      }));

      const syncResult = await syncDomainList(
        cfAccountId,
        d1Result.database_id!,
        cfToken,
        domainItems
      );

      result.initial_sync = {
        domains_synced: syncResult.ok ? syncResult.synced : 0,
        error: syncResult.error,
      };
    } else {
      result.initial_sync = {
        domains_synced: 0,
      };
    }
  } catch (e) {
    console.error("Initial sync failed:", e);
    result.initial_sync = {
      domains_synced: 0,
      error: e instanceof Error ? e.message : "unknown_error",
    };
  }

  // ============================================================
  // 6. TDS Worker (placeholder - будет добавлен позже)
  // ============================================================

  // TDS worker будет добавлен в следующей итерации
  // Сейчас создаём только инфраструктуру

  return result;
}

// ============================================================
// HELPER: Check if environment is set up
// ============================================================

export interface ClientEnvStatus {
  d1_exists: boolean;
  d1_id?: string;
  kv_exists: boolean;
  kv_id?: string;
  health_worker_exists: boolean;
  tds_worker_exists: boolean;
}

/**
 * Check client environment status
 */
export async function checkClientEnvironment(
  cfAccountId: string,
  cfToken: string
): Promise<ClientEnvStatus> {
  const { checkD1Exists } = await import("./d1");
  const { checkKVExists } = await import("./kv");
  const { checkWorkerExists } = await import("./workers");

  const [d1Check, kvCheck, healthCheck, tdsCheck] = await Promise.all([
    checkD1Exists(cfAccountId, CLIENT_D1_NAME, cfToken),
    checkKVExists(cfAccountId, CLIENT_KV_NAME, cfToken),
    checkWorkerExists(cfAccountId, HEALTH_WORKER_NAME, cfToken),
    checkWorkerExists(cfAccountId, TDS_WORKER_NAME, cfToken),
  ]);

  return {
    d1_exists: d1Check.exists,
    d1_id: d1Check.database?.uuid,
    kv_exists: kvCheck.exists,
    kv_id: kvCheck.namespace?.id,
    health_worker_exists: healthCheck.exists,
    tds_worker_exists: tdsCheck.exists,
  };
}
