/**
 * Deploy Webhook Handler
 *
 * POST /deploy
 * Receives self-check results from client workers after deployment.
 * On success: removes init cron (*/1), keeps working cron.
 */

import type { Context } from "hono";
import type { Env } from "./index";
import { verifyJWT, getAccountIdFromPayload } from "./jwt";

// ============================================================
// TYPES
// ============================================================

interface DeployWebhookPayload {
  type: "setup_ok" | "setup_error";
  worker_name: string;
  account_id: number;
  checks?: {
    d1: boolean;
    tables: string[];
    secrets: string[];
  };
  error?: string;
  timestamp: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const HEALTH_CRON_WORKING = "0 */12 * * *";

// ============================================================
// CF API HELPERS
// ============================================================

async function setWorkerCrons(
  cfAccountId: string,
  scriptName: string,
  crons: string[],
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/workers/scripts/${scriptName}/schedules`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(crons.map((cron) => ({ cron }))),
      }
    );

    const data = (await response.json()) as { success: boolean; errors?: Array<{ message: string }> };

    if (!data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to update crons" };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

/**
 * Decrypt CF token from account_keys KV
 */
async function getTokenForAccount(
  env: Env,
  accountId: number
): Promise<{ cfAccountId: string; cfToken: string } | null> {
  // Get active CF key for this account
  const keyRow = await env.DB301.prepare(`
    SELECT id, external_account_id, kv_key
    FROM account_keys
    WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active'
    LIMIT 1
  `).bind(accountId).first<{
    id: number;
    external_account_id: string;
    kv_key: string;
  }>();

  if (!keyRow) return null;

  // Get encrypted token from KV
  const encrypted = await env.KV_SESSIONS.get(keyRow.kv_key);
  if (!encrypted) {
    // Try KV_CREDENTIALS if available (webhook worker might not have it)
    return null;
  }

  // Note: Webhook worker doesn't have KV_CREDENTIALS binding
  // Token decryption is handled differently — we rely on the JWT payload
  // to identify the account, but we need the CF token to update crons.
  // For now, store cfAccountId from the JWT and skip cron removal
  // (the worker handles repeated init crons gracefully).

  return null;
}

// ============================================================
// HANDLER
// ============================================================

/**
 * POST /deploy
 *
 * 1. Verify JWT
 * 2. Parse payload
 * 3. If setup_ok → log success, attempt to remove init cron
 * 4. If setup_error → log error
 */
export async function handleDeployWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // 1. Authorization
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json({ ok: false, error: "missing_authorization" }, 401);
  }

  const token = authHeader.replace("Bearer ", "");

  // 2. Verify JWT
  const jwtPayload = await verifyJWT(token, env);
  if (!jwtPayload) {
    return c.json({ ok: false, error: "invalid_token" }, 401);
  }

  const accountId = getAccountIdFromPayload(jwtPayload);
  if (!accountId) {
    return c.json({ ok: false, error: "missing_account_id_in_token" }, 401);
  }

  // Verify it's a client_worker token
  if (jwtPayload.type !== "client_worker") {
    return c.json({ ok: false, error: "invalid_token_type" }, 403);
  }

  // 3. Parse payload
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

  // 4. Process
  if (payload.type === "setup_ok") {
    console.log(
      `[deploy-webhook] Worker ${payload.worker_name} self-check OK for account ${accountId}`,
      JSON.stringify(payload.checks)
    );

    // Try to remove init cron via CF API
    // We need the CF token, which requires decryption.
    // The webhook worker has MASTER_SECRET but not KV_CREDENTIALS.
    // We'll get the encrypted token from DB → decrypt → call CF API.
    const cfAccountId = jwtPayload.cf_account_id as string | undefined;

    if (cfAccountId) {
      // Get the KV key to decrypt token
      const keyRow = await env.DB301.prepare(`
        SELECT kv_key FROM account_keys
        WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active'
        LIMIT 1
      `).bind(accountId).first<{ kv_key: string }>();

      if (keyRow) {
        // Read encrypted token from KV_SESSIONS (webhook has this binding)
        const encrypted = await env.KV_SESSIONS.get(keyRow.kv_key);

        if (encrypted) {
          try {
            // Decrypt using the same crypto as jwt.ts
            const encryptedData = JSON.parse(encrypted);
            const decrypted = await decryptPayload<{ token: string }>(
              encryptedData,
              env.MASTER_SECRET
            );

            if (decrypted?.token && payload.worker_name === "301-health") {
              // Remove init cron, keep working cron
              const cronResult = await setWorkerCrons(
                cfAccountId,
                payload.worker_name,
                [HEALTH_CRON_WORKING],
                decrypted.token
              );

              if (cronResult.ok) {
                console.log(`[deploy-webhook] Removed init cron for ${payload.worker_name}`);
              } else {
                console.warn(`[deploy-webhook] Failed to update crons:`, cronResult.error);
              }
            }
          } catch (e) {
            console.warn("[deploy-webhook] Token decryption failed:", e);
          }
        }
      }
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
// CRYPTO (same as webhook/jwt.ts)
// ============================================================

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getMasterKey(secret: string): Promise<CryptoKey> {
  const keyData = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function decryptPayload<T = unknown>(
  payload: { iv: string; ct: string },
  masterSecret: string
): Promise<T> {
  const ivBytes = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0));
  const ctBytes = Uint8Array.from(atob(payload.ct), (c) => c.charCodeAt(0));

  const key = await getMasterKey(masterSecret);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes },
    key,
    ctBytes
  );

  const text = decoder.decode(decrypted);
  try {
    return JSON.parse(text);
  } catch {
    return text as unknown as T;
  }
}
