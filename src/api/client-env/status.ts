// src/api/client-env/status.ts

/**
 * Client Environment Status
 *
 * Fast check from DB301, optional live check via CF API.
 * Live check also performs lazy init cron cleanup.
 */

import { Env } from "../types/worker";
import { listKeys, getDecryptedKey } from "../integrations/keys/storage";
import {
  checkWorkerExists,
  getWorkerCrons,
  setWorkerCrons,
} from "../integrations/providers/cloudflare/workers";
import { checkD1Exists } from "../integrations/providers/cloudflare/d1";
import { checkKVExists } from "../integrations/providers/cloudflare/kv";
import {
  CLIENT_D1_NAME,
  CLIENT_KV_NAME,
  HEALTH_WORKER_NAME,
  TDS_WORKER_NAME,
  HEALTH_CRON_INIT,
  HEALTH_CRON_WORKING,
  TDS_CRON_INIT,
  TDS_CRON_WORKING,
  type ClientEnvResult,
} from "./setup";

// ============================================================
// TYPES
// ============================================================

export interface ClientEnvStatusResult {
  ok: boolean;
  error?: string;
  status: "ready" | "not_configured" | "partial" | "no_integration";
  client_env?: ClientEnvResult | null;
  live_check?: {
    d1: boolean;
    kv: boolean;
    health_worker: boolean;
    tds_worker: boolean;
    crons_cleaned?: boolean;
  };
}

// ============================================================
// STATUS CHECK
// ============================================================

/**
 * Get client environment status
 *
 * Fast path: check client_env JSON in account_keys (~1ms)
 * Live path: verify resources actually exist on CF account
 *            + lazy cleanup of init crons if environment is ready
 */
export async function getClientEnvStatus(
  env: Env,
  accountId: number,
  live = false
): Promise<ClientEnvStatusResult> {
  // 1. Get CF integration
  const cfKeys = await listKeys(env, accountId, "cloudflare");
  const activeCfKey = cfKeys.find((k) => k.status === "active");

  if (!activeCfKey) {
    return {
      ok: true,
      status: "no_integration",
    };
  }

  // 2. Read client_env from DB
  const row = await env.DB301.prepare(
    "SELECT client_env FROM account_keys WHERE id = ?"
  ).bind(activeCfKey.id).first<{ client_env: string | null }>();

  let clientEnv: ClientEnvResult | null = null;

  if (row?.client_env) {
    try {
      clientEnv = JSON.parse(row.client_env);
    } catch {
      clientEnv = null;
    }
  }

  if (!clientEnv) {
    return {
      ok: true,
      status: "not_configured",
      client_env: null,
    };
  }

  // Fast path: if not live check, use DB data
  if (!live) {
    return {
      ok: true,
      status: clientEnv.ready ? "ready" : "partial",
      client_env: clientEnv,
    };
  }

  // 3. Live check: verify resources on CF
  const decrypted = await getDecryptedKey(env, activeCfKey.id);
  if (!decrypted) {
    return {
      ok: false,
      error: "cf_key_decrypt_failed",
      status: "partial",
      client_env: clientEnv,
    };
  }

  const cfToken = decrypted.secrets.token;
  const cfAccountId = activeCfKey.external_account_id!;

  const [d1Check, kvCheck, healthCheck, tdsCheck, healthCrons, tdsCrons] = await Promise.all([
    checkD1Exists(cfAccountId, CLIENT_D1_NAME, cfToken),
    checkKVExists(cfAccountId, CLIENT_KV_NAME, cfToken),
    checkWorkerExists(cfAccountId, HEALTH_WORKER_NAME, cfToken),
    checkWorkerExists(cfAccountId, TDS_WORKER_NAME, cfToken),
    getWorkerCrons(cfAccountId, HEALTH_WORKER_NAME, cfToken),
    getWorkerCrons(cfAccountId, TDS_WORKER_NAME, cfToken),
  ]);

  const allReady = d1Check.exists && kvCheck.exists && healthCheck.exists && tdsCheck.exists;

  // 4. Lazy init cron cleanup
  // If environment is ready, remove */1 init crons (best effort)
  let cronsCleaned = false;
  if (allReady && clientEnv.ready) {
    cronsCleaned = await cleanupInitCrons(
      cfAccountId, cfToken,
      healthCrons.crons || [],
      tdsCrons.crons || [],
    );
  }

  const liveCheck = {
    d1: d1Check.exists,
    kv: kvCheck.exists,
    health_worker: healthCheck.exists,
    tds_worker: tdsCheck.exists,
    crons_cleaned: cronsCleaned || undefined,
  };

  return {
    ok: true,
    status: allReady ? "ready" : "partial",
    client_env: clientEnv,
    live_check: liveCheck,
  };
}

// ============================================================
// LAZY CRON CLEANUP
// ============================================================

/**
 * Remove init crons from workers if still present.
 * Init cron pattern: every 1 minute. Replaced with working cron only.
 * Called during live status check when environment is ready.
 * Returns true if any crons were cleaned up.
 */
async function cleanupInitCrons(
  cfAccountId: string,
  cfToken: string,
  healthCrons: string[],
  tdsCrons: string[],
): Promise<boolean> {
  let cleaned = false;

  // Health worker: remove init cron, keep working cron
  if (healthCrons.includes(HEALTH_CRON_INIT)) {
    const workingOnly = healthCrons.filter((c) => c !== HEALTH_CRON_INIT);
    if (workingOnly.length === 0) workingOnly.push(HEALTH_CRON_WORKING);
    const result = await setWorkerCrons(cfAccountId, HEALTH_WORKER_NAME, workingOnly, cfToken);
    if (result.ok) {
      console.log("[client-env] Cleaned init cron from 301-health");
      cleaned = true;
    }
  }

  // TDS worker: remove init cron, keep working cron
  if (tdsCrons.includes(TDS_CRON_INIT)) {
    const workingOnly = tdsCrons.filter((c) => c !== TDS_CRON_INIT);
    if (workingOnly.length === 0) workingOnly.push(TDS_CRON_WORKING);
    const result = await setWorkerCrons(cfAccountId, TDS_WORKER_NAME, workingOnly, cfToken);
    if (result.ok) {
      console.log("[client-env] Cleaned init cron from 301-tds");
      cleaned = true;
    }
  }

  return cleaned;
}
