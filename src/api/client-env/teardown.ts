// src/api/client-env/teardown.ts

/**
 * Client Environment Teardown
 *
 * Removes ALL resources from client's CF account:
 * Workers → KV → D1 → DB record
 */

import { Env } from "../types/worker";
import { deleteD1Database } from "../integrations/providers/cloudflare/d1";
import { deleteKVNamespace } from "../integrations/providers/cloudflare/kv";
import { deleteWorkerScript } from "../integrations/providers/cloudflare/workers";
import { listKeys, getDecryptedKey } from "../integrations/keys/storage";
import {
  HEALTH_WORKER_NAME,
  TDS_WORKER_NAME,
  type ClientEnvResult,
} from "./setup";

// ============================================================
// TYPES
// ============================================================

export interface TeardownResult {
  ok: boolean;
  error?: string;
  deleted: {
    health_worker: boolean;
    tds_worker: boolean;
    kv: boolean;
    d1: boolean;
  };
  errors: string[];
}

// ============================================================
// TEARDOWN
// ============================================================

/**
 * Remove all client environment resources
 *
 * Best-effort: tries to delete everything, collects errors.
 * Updates account_keys.client_env to null.
 */
export async function teardownClientEnvironment(
  env: Env,
  accountId: number
): Promise<TeardownResult> {
  const result: TeardownResult = {
    ok: true,
    deleted: {
      health_worker: false,
      tds_worker: false,
      kv: false,
      d1: false,
    },
    errors: [],
  };

  // 1. Get CF credentials
  const cfKeys = await listKeys(env, accountId, "cloudflare");
  const activeCfKey = cfKeys.find((k) => k.status === "active");

  if (!activeCfKey) {
    return { ...result, ok: false, error: "cloudflare_integration_required" };
  }

  const decrypted = await getDecryptedKey(env, activeCfKey.id);
  if (!decrypted) {
    return { ...result, ok: false, error: "cf_key_decrypt_failed" };
  }

  const cfToken = decrypted.secrets.token;
  const cfAccountId = activeCfKey.external_account_id!;

  // 2. Parse client_env
  let clientEnv: ClientEnvResult | null = null;
  try {
    const row = await env.DB301.prepare(
      "SELECT client_env FROM account_keys WHERE id = ?"
    ).bind(activeCfKey.id).first<{ client_env: string | null }>();

    if (row?.client_env) {
      clientEnv = JSON.parse(row.client_env);
    }
  } catch {
    // Will try to delete by known names even without client_env
  }

  // 3. Delete workers (best effort)
  const healthDelete = await deleteWorkerScript(cfAccountId, HEALTH_WORKER_NAME, cfToken);
  if (healthDelete.ok) {
    result.deleted.health_worker = true;
  } else if (healthDelete.error) {
    result.errors.push(`health_worker: ${healthDelete.error}`);
  }

  const tdsDelete = await deleteWorkerScript(cfAccountId, TDS_WORKER_NAME, cfToken);
  if (tdsDelete.ok) {
    result.deleted.tds_worker = true;
  } else if (tdsDelete.error) {
    result.errors.push(`tds_worker: ${tdsDelete.error}`);
  }

  // 4. Delete KV
  if (clientEnv?.kv_id) {
    const kvDelete = await deleteKVNamespace(cfAccountId, clientEnv.kv_id, cfToken);
    if (kvDelete.ok) {
      result.deleted.kv = true;
    } else if (kvDelete.error) {
      result.errors.push(`kv: ${kvDelete.error}`);
    }
  }

  // 5. Delete D1
  if (clientEnv?.d1_id) {
    const d1Delete = await deleteD1Database(cfAccountId, clientEnv.d1_id, cfToken);
    if (d1Delete.ok) {
      result.deleted.d1 = true;
    } else if (d1Delete.error) {
      result.errors.push(`d1: ${d1Delete.error}`);
    }
  }

  // 6. Clear client_env in DB
  await env.DB301.prepare(
    "UPDATE account_keys SET client_env = NULL WHERE id = ?"
  ).bind(activeCfKey.id).run();

  result.ok = result.errors.length === 0;

  return result;
}
