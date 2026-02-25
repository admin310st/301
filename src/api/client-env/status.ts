// src/api/client-env/status.ts

/**
 * Client Environment Status
 *
 * Fast check from DB301, optional live check via CF API.
 */

import { Env } from "../types/worker";
import { listKeys, getDecryptedKey } from "../integrations/keys/storage";
import { checkWorkerExists } from "../integrations/providers/cloudflare/workers";
import { checkD1Exists } from "../integrations/providers/cloudflare/d1";
import { checkKVExists } from "../integrations/providers/cloudflare/kv";
import {
  CLIENT_D1_NAME,
  CLIENT_KV_NAME,
  HEALTH_WORKER_NAME,
  TDS_WORKER_NAME,
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

  const [d1Check, kvCheck, healthCheck, tdsCheck] = await Promise.all([
    checkD1Exists(cfAccountId, CLIENT_D1_NAME, cfToken),
    checkKVExists(cfAccountId, CLIENT_KV_NAME, cfToken),
    checkWorkerExists(cfAccountId, HEALTH_WORKER_NAME, cfToken),
    checkWorkerExists(cfAccountId, TDS_WORKER_NAME, cfToken),
  ]);

  const liveCheck = {
    d1: d1Check.exists,
    kv: kvCheck.exists,
    health_worker: healthCheck.exists,
    tds_worker: tdsCheck.exists,
  };

  const allReady = liveCheck.d1 && liveCheck.kv && liveCheck.health_worker && liveCheck.tds_worker;

  return {
    ok: true,
    status: allReady ? "ready" : "partial",
    client_env: clientEnv,
    live_check: liveCheck,
  };
}
