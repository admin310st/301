/**
 * Deploy Webhook Handler
 *
 * POST /deploy
 * Receives self-check results from client workers after deployment.
 * Verifies worker identity via API key (SHA-256 hash in DB301).
 *
 * On setup_ok:
 * - Records deployment confirmation in DB301 (account_keys.client_env)
 * - Returns ok → worker writes setup_reported='ok' to its D1
 * - Init cron becomes no-op, cleaned up lazily by status live check
 *
 * On setup_error:
 * - Logs error for monitoring
 * - Returns ok (worker retries on next cron)
 */

import type { Context } from "hono";
import type { Env } from "./index";
import { verifyApiKey } from "./auth";

// ============================================================
// TYPES
// ============================================================

interface DeployWebhookPayload {
  type: "setup_ok" | "setup_error";
  worker_name: string;
  account_id: number;
  checks?: {
    d1: boolean;
    kv: boolean;
    tables: string[];
    secrets: string[];
  };
  error?: string;
  timestamp: string;
}

// ============================================================
// HANDLER
// ============================================================

/**
 * POST /deploy
 *
 * 1. Verify API key (SHA-256 hash lookup)
 * 2. Parse payload
 * 3. On setup_ok: record confirmation in DB301
 * 4. Return ok (client worker writes setup_reported on success)
 */
export async function handleDeployWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  // 1. Verify API key
  const auth = await verifyApiKey(c);
  if (auth instanceof Response) return auth;

  const accountId = auth.account_id;
  const cfAccountId = auth.cf_account_id;

  // 2. Parse payload
  let payload: DeployWebhookPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  // Validate account_id matches
  if (payload.account_id && payload.account_id !== accountId) {
    return c.json({ ok: false, error: "account_id_mismatch" }, 403);
  }

  // 3. Process
  if (payload.type === "setup_ok") {
    console.log(
      `[deploy-webhook] Worker ${payload.worker_name} self-check OK for account ${accountId}`,
      JSON.stringify(payload.checks)
    );

    // Record deployment confirmation in DB301
    // Update client_env JSON to mark worker as confirmed
    try {
      await recordDeployConfirmation(
        c.env,
        accountId,
        cfAccountId,
        payload.worker_name,
        payload.checks
      );
    } catch (err) {
      console.error("[deploy-webhook] Failed to record confirmation:", err);
      // Non-fatal: still return ok so worker marks setup_reported
    }

    return c.json({ ok: true, status: "acknowledged" });
  }

  if (payload.type === "setup_error") {
    console.error(
      `[deploy-webhook] Worker ${payload.worker_name} self-check FAILED for account ${accountId}:`,
      payload.error
    );

    return c.json({ ok: true, status: "error_logged" });
  }

  return c.json({ ok: false, error: "unknown_type" }, 400);
}

// ============================================================
// DB HELPERS
// ============================================================

/**
 * Record worker self-check confirmation in account_keys.client_env
 *
 * Updates the JSON field to mark specific worker as confirmed
 * with timestamp. This data is used by live status checks.
 */
async function recordDeployConfirmation(
  env: Env,
  accountId: number,
  cfAccountId: string,
  workerName: string,
  checks?: DeployWebhookPayload["checks"]
): Promise<void> {
  const row = await env.DB301.prepare(`
    SELECT id, client_env FROM account_keys
    WHERE account_id = ? AND provider = 'cloudflare'
      AND external_account_id = ? AND status = 'active'
    LIMIT 1
  `).bind(accountId, cfAccountId).first<{ id: number; client_env: string | null }>();

  if (!row) return;

  let clientEnv: Record<string, unknown> = {};
  if (row.client_env) {
    try {
      clientEnv = JSON.parse(row.client_env);
    } catch {
      clientEnv = {};
    }
  }

  // Add deploy confirmation
  const confirmKey = workerName === "301-health"
    ? "health_confirmed_at"
    : workerName === "301-tds"
      ? "tds_confirmed_at"
      : `${workerName}_confirmed_at`;

  clientEnv[confirmKey] = new Date().toISOString();

  // Store checks info
  if (checks) {
    const checksKey = workerName === "301-health"
      ? "health_checks"
      : workerName === "301-tds"
        ? "tds_checks"
        : `${workerName}_checks`;

    clientEnv[checksKey] = checks;
  }

  await env.DB301.prepare(
    "UPDATE account_keys SET client_env = ? WHERE id = ?"
  ).bind(JSON.stringify(clientEnv), row.id).run();
}
