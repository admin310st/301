// src/api/health/setup.ts

/**
 * Client Worker Setup Endpoint
 *
 * POST /health/client/setup
 *
 * Полный setup Client Worker на CF аккаунте клиента:
 * 1. Создать D1 database
 * 2. Установить секреты (VT_API_KEY, JWT_TOKEN, ACCOUNT_ID)
 *
 * Требования:
 * - Активная интеграция Cloudflare (account_keys)
 * - Worker уже задеплоен (вручную или через wrangler)
 */

import { Context } from "hono";
import { Env } from "../types/worker";
import { requireOwner } from "../lib/auth";
import { listKeys, getDecryptedKey } from "../integrations/keys/storage";
import { setupD1 } from "../integrations/providers/cloudflare/d1";
import {
  setWorkerSecrets,
  checkWorkerExists,
  listWorkerSecrets,
} from "../integrations/providers/cloudflare/workers";
import { signJWT } from "../lib/jwt";
import {
  upsertWorkerConfig,
  generateWranglerToml,
  getWorkerConfig,
} from "../workers/config";

// ============================================================
// CONSTANTS
// ============================================================

const DEFAULT_WORKER_NAME = "301-client";
const DEFAULT_D1_NAME = "301-client";
const REQUIRED_SECRETS = ["JWT_TOKEN", "ACCOUNT_ID"];
const OPTIONAL_SECRETS = ["VT_API_KEY", "CF_API_TOKEN"];

// Client D1 Schema (embedded)
const CLIENT_SCHEMA = `
-- domain_threats
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

-- threat_check_queue
CREATE TABLE IF NOT EXISTS threat_check_queue (
    domain_name TEXT PRIMARY KEY,
    priority INTEGER DEFAULT 0,
    source TEXT DEFAULT 'virustotal',
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_queue_status_priority
ON threat_check_queue(status, priority DESC, added_at);

-- domain_list
CREATE TABLE IF NOT EXISTS domain_list (
    domain_name TEXT PRIMARY KEY,
    role TEXT,
    zone_id TEXT,
    active INTEGER DEFAULT 1,
    synced_at TEXT
);

-- traffic_stats
CREATE TABLE IF NOT EXISTS traffic_stats (
    domain_name TEXT PRIMARY KEY,
    zone_id TEXT,
    clicks_yesterday INTEGER DEFAULT 0,
    clicks_today INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

// ============================================================
// TYPES
// ============================================================

interface SetupRequest {
  worker_name?: string;  // default: "301-client"
  d1_name?: string;      // default: "301-client"
  skip_d1?: boolean;     // skip D1 setup (if already exists)
}

interface SetupResult {
  ok: boolean;
  error?: string;

  // D1 info
  d1?: {
    database_id: string;
    database_name: string;
    created: boolean;
  };

  // Worker info
  worker?: {
    name: string;
    exists: boolean;
    secrets_set: string[];
    secrets_errors: Array<{ name: string; error: string }>;
  };

  // Info for user
  jwt_token?: string;
}

// ============================================================
// HANDLER
// ============================================================

/**
 * POST /health/client/setup
 *
 * Body: {
 *   worker_name?: string,
 *   d1_name?: string,
 *   skip_d1?: boolean
 * }
 */
export async function handleSetupClientWorker(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // 1. Auth
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // 2. Parse body
  let body: SetupRequest = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty body is ok
  }

  const workerName = body.worker_name || DEFAULT_WORKER_NAME;
  const d1Name = body.d1_name || DEFAULT_D1_NAME;
  const skipD1 = body.skip_d1 || false;

  // 3. Get Cloudflare integration key
  const cfKeys = await listKeys(env, accountId, "cloudflare");
  const activeCfKey = cfKeys.find((k) => k.status === "active");

  if (!activeCfKey) {
    return c.json({
      ok: false,
      error: "cloudflare_integration_required",
      message: "Please add Cloudflare integration first via POST /integrations/cloudflare/init",
    }, 400);
  }

  // Get CF credentials
  let cfToken: string;
  let cfAccountId: string;
  try {
    const decrypted = await getDecryptedKey(env, activeCfKey.id);
    if (!decrypted) {
      return c.json({ ok: false, error: "cf_key_decrypt_failed" }, 500);
    }
    cfToken = decrypted.secrets.token;
    cfAccountId = activeCfKey.external_account_id!;
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : "cf_key_error",
    }, 400);
  }

  if (!cfAccountId) {
    return c.json({ ok: false, error: "cf_account_id_missing" }, 400);
  }

  // 4. Get VirusTotal key (optional)
  let vtApiKey: string | undefined;
  const vtKeys = await listKeys(env, accountId, "virustotal");
  const activeVtKey = vtKeys.find((k) => k.status === "active");

  if (activeVtKey) {
    try {
      const decrypted = await getDecryptedKey(env, activeVtKey.id);
      if (decrypted) {
        vtApiKey = decrypted.secrets.apiKey;
      }
    } catch {
      // VT key is optional, continue without it
      console.warn("[Setup] Failed to decrypt VT key, continuing without it");
    }
  }

  const result: SetupResult = { ok: true };

  // 5. Setup D1 (unless skipped)
  if (!skipD1) {
    const d1Result = await setupD1({
      cfAccountId,
      token: cfToken,
      dbName: d1Name,
      schema: CLIENT_SCHEMA,
    });

    if (!d1Result.ok) {
      return c.json({
        ok: false,
        error: "d1_setup_failed",
        details: d1Result.error,
      }, 500);
    }

    result.d1 = {
      database_id: d1Result.database_id!,
      database_name: d1Result.database_name!,
      created: d1Result.created || false,
    };
  }

  // 6. Check if worker exists
  const workerCheck = await checkWorkerExists(cfAccountId, workerName, cfToken);

  if (!workerCheck.exists) {
    return c.json({
      ok: false,
      error: "worker_not_deployed",
      message: `Worker "${workerName}" not found. Please deploy it first using wrangler deploy.`,
      d1: result.d1,
    }, 400);
  }

  // 7. Generate JWT for M2M communication (1 year)
  const jwtToken = await signJWT(
    {
      type: "client_worker",
      acc: accountId,
      cf_account_id: cfAccountId,
    },
    env,
    "365d"
  );

  // 8. Build secrets to set
  const secrets: Record<string, string> = {
    JWT_TOKEN: jwtToken,
    ACCOUNT_ID: String(accountId),
  };

  if (vtApiKey) {
    secrets.VT_API_KEY = vtApiKey;
  }

  // 9. Set worker secrets
  const secretsResult = await setWorkerSecrets(cfAccountId, workerName, secrets, cfToken);

  result.worker = {
    name: workerName,
    exists: true,
    secrets_set: secretsResult.set,
    secrets_errors: secretsResult.errors,
  };

  result.jwt_token = jwtToken;

  if (secretsResult.errors.length > 0) {
    return c.json({
      ok: false,
      error: "secrets_setup_partial",
      ...result,
    }, 500);
  }

  // 10. Save config to database for future use
  const configToml = generateWranglerToml("health", {
    workerName,
    d1DatabaseId: result.d1?.database_id || "YOUR_DATABASE_ID_HERE",
    d1DatabaseName: d1Name,
  });

  await upsertWorkerConfig(env, accountId, "health", {
    workerName,
    d1DatabaseId: result.d1?.database_id,
    d1DatabaseName: d1Name,
    configToml,
    secretsConfigured: secretsResult.set,
    deployed: true,
  });

  return c.json(result);
}

/**
 * GET /health/client/status
 *
 * Check Client Worker setup status
 */
export async function handleGetClientStatus(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // 1. Auth
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // 2. Get CF key
  const cfKeys = await listKeys(env, accountId, "cloudflare");
  const activeCfKey = cfKeys.find((k) => k.status === "active");

  if (!activeCfKey) {
    return c.json({
      ok: true,
      status: "not_configured",
      cloudflare: false,
      virustotal: false,
      worker: null,
    });
  }

  // Get CF credentials
  let cfToken: string;
  let cfAccountId: string;
  try {
    const decrypted = await getDecryptedKey(env, activeCfKey.id);
    if (!decrypted) {
      return c.json({ ok: false, error: "cf_key_decrypt_failed" }, 500);
    }
    cfToken = decrypted.secrets.token;
    cfAccountId = activeCfKey.external_account_id!;
  } catch (err) {
    return c.json({
      ok: false,
      error: err instanceof Error ? err.message : "cf_key_error",
    }, 400);
  }

  // 3. Check VT key
  const vtKeys = await listKeys(env, accountId, "virustotal");
  const hasVtKey = vtKeys.some((k) => k.status === "active");

  // 4. Check worker
  const workerCheck = await checkWorkerExists(cfAccountId, DEFAULT_WORKER_NAME, cfToken);

  let secretsStatus = null;
  if (workerCheck.exists) {
    const secretsList = await listWorkerSecrets(cfAccountId, DEFAULT_WORKER_NAME, cfToken);
    if (secretsList.ok) {
      const presentSet = new Set(secretsList.secrets || []);
      const missing = REQUIRED_SECRETS.filter((s) => !presentSet.has(s));
      const present = [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS].filter((s) => presentSet.has(s));

      secretsStatus = {
        configured: missing.length === 0,
        present,
        missing,
      };
    }
  }

  // 5. Get stored config
  const storedConfig = await getWorkerConfig(env, accountId, "health");

  return c.json({
    ok: true,
    status: workerCheck.exists && secretsStatus?.configured ? "ready" : "incomplete",
    cloudflare: true,
    cf_account_id: cfAccountId,
    virustotal: hasVtKey,
    worker: workerCheck.exists ? {
      name: DEFAULT_WORKER_NAME,
      deployed: true,
      secrets: secretsStatus,
    } : {
      name: DEFAULT_WORKER_NAME,
      deployed: false,
    },
    config: storedConfig ? {
      d1_database_id: storedConfig.d1_database_id,
      d1_database_name: storedConfig.d1_database_name,
      cron_schedule: storedConfig.cron_schedule,
      last_deployed_at: storedConfig.last_deployed_at,
    } : null,
  });
}
