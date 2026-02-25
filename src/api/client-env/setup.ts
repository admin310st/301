// src/api/client-env/setup.ts

/**
 * Client Environment Setup Orchestrator
 *
 * Creates ALL resources on client's CF account in one call:
 * 1. D1 Database (301-client) — shared by health & TDS workers
 * 2. KV Namespace (301-keys) — integration keys
 * 3. Health Worker (301-health) — domain monitoring
 * 4. TDS Worker (301-tds) — traffic distribution
 * 5. Initial domain sync
 *
 * All-or-nothing: any step failure triggers full rollback.
 */

import { Env } from "../types/worker";
import { setupD1, deleteD1Database } from "../integrations/providers/cloudflare/d1";
import { setupKV, deleteKVNamespace, putKVValue } from "../integrations/providers/cloudflare/kv";
import {
  deployWorkerScript,
  setWorkerSecrets,
  setWorkerCrons,
  deleteWorkerScript,
  WorkerBindings,
} from "../integrations/providers/cloudflare/workers";
import { signJWT } from "../lib/jwt";
import { getHealthWorkerBundle } from "../health/bundle";
import { getTdsWorkerBundle } from "../tds/bundle";
import { syncDomainList, type DomainListItem } from "../integrations/providers/cloudflare/d1-sync";

// ============================================================
// CONSTANTS (single source of truth)
// ============================================================

export const CLIENT_D1_NAME = "301-client";
export const CLIENT_KV_NAME = "301-keys";
export const HEALTH_WORKER_NAME = "301-health";
export const TDS_WORKER_NAME = "301-tds";

export const HEALTH_CRON_WORKING = "0 */12 * * *";
export const HEALTH_CRON_INIT = "*/1 * * * *";

export const DEPLOY_WEBHOOK_URL = "https://webhook.301.st/deploy";
export const HEALTH_WEBHOOK_URL = "https://webhook.301.st/health";
export const TDS_API_URL = "https://api.301.st";

export const JWT_TTL = "365d";

// ============================================================
// UNIFIED D1 SCHEMA
// ============================================================

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

CREATE TABLE IF NOT EXISTS tds_rules (
    id INTEGER PRIMARY KEY,
    domain_name TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    conditions TEXT NOT NULL,
    action TEXT NOT NULL,
    action_url TEXT,
    status_code INTEGER DEFAULT 302,
    variants TEXT,
    algorithm TEXT DEFAULT 'thompson_sampling',
    active INTEGER DEFAULT 1,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tds_rules_domain
ON tds_rules(domain_name, active, priority DESC);

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

CREATE TABLE IF NOT EXISTS stats_hourly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_name TEXT NOT NULL,
    rule_id INTEGER,
    hour TEXT NOT NULL,
    hits INTEGER DEFAULT 0,
    redirects INTEGER DEFAULT 0,
    blocks INTEGER DEFAULT 0,
    passes INTEGER DEFAULT 0,
    by_country TEXT,
    by_device TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(domain_name, rule_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_stats_hourly_domain_hour
ON stats_hourly(domain_name, hour DESC);

CREATE TABLE IF NOT EXISTS mab_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    variant_url TEXT NOT NULL,
    impressions INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rule_id, variant_url)
);

-- ============================================================
-- Sync Status (shared)
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_status (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO sync_status (key, value) VALUES ('last_sync', NULL);
INSERT OR IGNORE INTO sync_status (key, value) VALUES ('version', NULL);
INSERT OR IGNORE INTO sync_status (key, value) VALUES ('last_rules_sync', NULL);
INSERT OR IGNORE INTO sync_status (key, value) VALUES ('setup_reported', NULL);
`;

// ============================================================
// TYPES
// ============================================================

export interface ClientEnvSetupOptions {
  cfAccountId: string;
  cfToken: string;
  accountId: number;
  env: Env;
  vtApiKey?: string;
}

export interface ClientEnvResult {
  d1_id?: string;
  kv_id?: string;
  health_worker: boolean;
  tds_worker: boolean;
  ready: boolean;
}

export interface ClientEnvSetupResult {
  ok: boolean;
  error?: string;
  client_env?: ClientEnvResult;
  initial_sync?: {
    domains_synced: number;
    error?: string;
  };
}

// ============================================================
// ROLLBACK STATE
// ============================================================

interface RollbackState {
  cfAccountId: string;
  cfToken: string;
  d1Id?: string;
  kvId?: string;
  healthDeployed?: boolean;
  tdsDeployed?: boolean;
}

async function rollbackAll(state: RollbackState): Promise<void> {
  const { cfAccountId, cfToken } = state;

  // Reverse order of creation
  if (state.tdsDeployed) {
    await deleteWorkerScript(cfAccountId, TDS_WORKER_NAME, cfToken).catch((e) =>
      console.error("[client-env] Rollback: failed to delete TDS worker:", e)
    );
  }

  if (state.healthDeployed) {
    await deleteWorkerScript(cfAccountId, HEALTH_WORKER_NAME, cfToken).catch((e) =>
      console.error("[client-env] Rollback: failed to delete Health worker:", e)
    );
  }

  if (state.kvId) {
    await deleteKVNamespace(cfAccountId, state.kvId, cfToken).catch((e) =>
      console.error("[client-env] Rollback: failed to delete KV:", e)
    );
  }

  if (state.d1Id) {
    await deleteD1Database(cfAccountId, state.d1Id, cfToken).catch((e) =>
      console.error("[client-env] Rollback: failed to delete D1:", e)
    );
  }
}

// ============================================================
// MAIN SETUP
// ============================================================

export async function setupClientEnvironment(
  options: ClientEnvSetupOptions
): Promise<ClientEnvSetupResult> {
  const { cfAccountId, cfToken, accountId, env, vtApiKey } = options;

  const rb: RollbackState = { cfAccountId, cfToken };

  // ──────────────────────────────────────────────────────────
  // 1. D1 Database
  // ──────────────────────────────────────────────────────────

  const d1Result = await setupD1({
    cfAccountId,
    token: cfToken,
    dbName: CLIENT_D1_NAME,
    schema: CLIENT_D1_SCHEMA,
  });

  if (!d1Result.ok) {
    return { ok: false, error: `D1 setup failed: ${d1Result.error}` };
  }

  rb.d1Id = d1Result.database_id!;

  // ──────────────────────────────────────────────────────────
  // 2. KV Namespace
  // ──────────────────────────────────────────────────────────

  const kvResult = await setupKV(cfAccountId, CLIENT_KV_NAME, cfToken);

  if (!kvResult.ok) {
    await rollbackAll(rb);
    return { ok: false, error: `KV setup failed: ${kvResult.error}` };
  }

  rb.kvId = kvResult.namespace_id!;

  // Store VT API key in KV if provided
  if (vtApiKey) {
    await putKVValue(cfAccountId, kvResult.namespace_id!, "VT_API_KEY", vtApiKey, cfToken);
  }

  // ──────────────────────────────────────────────────────────
  // 3. Generate JWT for workers (365d)
  // ──────────────────────────────────────────────────────────

  const jwtToken = await signJWT(
    {
      type: "client_worker",
      acc: accountId,
      cf_account_id: cfAccountId,
    },
    env,
    JWT_TTL
  );

  // ──────────────────────────────────────────────────────────
  // 4. Deploy Health Worker
  // ──────────────────────────────────────────────────────────

  const healthBundle = getHealthWorkerBundle();

  const healthBindings: WorkerBindings = {
    d1: [{ name: "DB", id: d1Result.database_id! }],
    kv: [{ name: "KV", namespace_id: kvResult.namespace_id! }],
    vars: {
      WEBHOOK_URL: HEALTH_WEBHOOK_URL,
      DEPLOY_WEBHOOK_URL: DEPLOY_WEBHOOK_URL,
      ACCOUNT_ID: String(accountId),
    },
  };

  const healthDeploy = await deployWorkerScript(
    cfAccountId,
    HEALTH_WORKER_NAME,
    healthBundle,
    healthBindings,
    cfToken
  );

  if (!healthDeploy.ok) {
    await rollbackAll(rb);
    return { ok: false, error: `Health worker deploy failed: ${healthDeploy.error}` };
  }

  rb.healthDeployed = true;

  // Set secrets
  await setWorkerSecrets(cfAccountId, HEALTH_WORKER_NAME, { JWT_TOKEN: jwtToken }, cfToken);

  // Set crons: init (*/1) + working (0 */12)
  await setWorkerCrons(
    cfAccountId,
    HEALTH_WORKER_NAME,
    [HEALTH_CRON_INIT, HEALTH_CRON_WORKING],
    cfToken
  );

  // ──────────────────────────────────────────────────────────
  // 5. Deploy TDS Worker
  // ──────────────────────────────────────────────────────────

  const tdsBundle = getTdsWorkerBundle();

  const tdsBindings: WorkerBindings = {
    d1: [{ name: "DB", id: d1Result.database_id! }],
    vars: {
      API_URL: TDS_API_URL,
      DEPLOY_WEBHOOK_URL: DEPLOY_WEBHOOK_URL,
      ACCOUNT_ID: String(accountId),
    },
  };

  const tdsDeploy = await deployWorkerScript(
    cfAccountId,
    TDS_WORKER_NAME,
    tdsBundle,
    tdsBindings,
    cfToken
  );

  if (!tdsDeploy.ok) {
    await rollbackAll(rb);
    return { ok: false, error: `TDS worker deploy failed: ${tdsDeploy.error}` };
  }

  rb.tdsDeployed = true;

  // Set secrets
  await setWorkerSecrets(cfAccountId, TDS_WORKER_NAME, { JWT_TOKEN: jwtToken }, cfToken);

  // ──────────────────────────────────────────────────────────
  // 6. Initial domain sync
  // ──────────────────────────────────────────────────────────

  let initialSync: ClientEnvSetupResult["initial_sync"];

  try {
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
      const domainItems: DomainListItem[] = domainsResult.results.map((d) => ({
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

      initialSync = {
        domains_synced: syncResult.ok ? syncResult.synced : 0,
        error: syncResult.error,
      };
    } else {
      initialSync = { domains_synced: 0 };
    }
  } catch (e) {
    console.error("[client-env] Initial sync failed:", e);
    initialSync = {
      domains_synced: 0,
      error: e instanceof Error ? e.message : "unknown_error",
    };
    // Domain sync failure is non-fatal — don't rollback
  }

  // ──────────────────────────────────────────────────────────
  // 7. Build client_env result
  // ──────────────────────────────────────────────────────────

  const clientEnv: ClientEnvResult = {
    d1_id: d1Result.database_id!,
    kv_id: kvResult.namespace_id!,
    health_worker: true,
    tds_worker: true,
    ready: true,
  };

  return {
    ok: true,
    client_env: clientEnv,
    initial_sync: initialSync,
  };
}
