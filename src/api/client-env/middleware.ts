// src/api/client-env/middleware.ts

/**
 * Client Environment Middleware
 *
 * Fast check: SELECT client_env FROM account_keys (~1ms)
 * If ready=true → skip.
 * If not → run full setup, save result to DB.
 */

import { Env } from "../types/worker";
import { listKeys, getDecryptedKey } from "../integrations/keys/storage";
import { setupClientEnvironment, type ClientEnvResult } from "./setup";

// ============================================================
// TYPES
// ============================================================

export interface EnsureResult {
  ok: boolean;
  error?: string;
  /** Was the environment already ready? */
  was_ready: boolean;
  client_env?: ClientEnvResult;
}

// ============================================================
// MIDDLEWARE
// ============================================================

/**
 * Ensure client environment is ready
 *
 * Called before operations that need client infrastructure
 * (redirect apply, TDS rules, health setup).
 *
 * Fast path: ~1ms (single SELECT, check ready flag)
 * Slow path: ~15-30s (full setup on CF account)
 */
export async function ensureClientEnvironment(
  env: Env,
  accountId: number
): Promise<EnsureResult> {
  // 1. Get active CF key
  const cfKeys = await listKeys(env, accountId, "cloudflare");
  const activeCfKey = cfKeys.find((k) => k.status === "active");

  if (!activeCfKey) {
    return {
      ok: false,
      error: "cloudflare_integration_required",
      was_ready: false,
    };
  }

  // 2. Check client_env in DB (fast path)
  const row = await env.DB301.prepare(
    "SELECT client_env FROM account_keys WHERE id = ?"
  ).bind(activeCfKey.id).first<{ client_env: string | null }>();

  if (row?.client_env) {
    try {
      const clientEnv: ClientEnvResult = JSON.parse(row.client_env);

      if (clientEnv.ready) {
        return {
          ok: true,
          was_ready: true,
          client_env: clientEnv,
        };
      }
    } catch {
      // Invalid JSON — re-setup
    }
  }

  // 3. Slow path: setup
  const decrypted = await getDecryptedKey(env, activeCfKey.id);
  if (!decrypted) {
    return {
      ok: false,
      error: "cf_key_decrypt_failed",
      was_ready: false,
    };
  }

  const cfToken = decrypted.secrets.token;
  const cfAccountId = activeCfKey.external_account_id!;

  const setupResult = await setupClientEnvironment({
    cfAccountId,
    cfToken,
    accountId,
    env,
  });

  if (!setupResult.ok) {
    return {
      ok: false,
      error: setupResult.error,
      was_ready: false,
    };
  }

  // 4. Save client_env to DB
  if (setupResult.client_env) {
    await env.DB301.prepare(
      "UPDATE account_keys SET client_env = ? WHERE id = ?"
    ).bind(JSON.stringify(setupResult.client_env), activeCfKey.id).run();
  }

  return {
    ok: true,
    was_ready: false,
    client_env: setupResult.client_env,
  };
}
