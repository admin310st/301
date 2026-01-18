// src/api/integrations/providers/virustotal/initkey.ts

import { Context } from "hono";
import { Env } from "../../../types/worker";
import { encrypt } from "../../../lib/crypto";
import { requireOwner } from "../../../lib/auth";

// ============================================================
// TYPES
// ============================================================

interface InitKeyRequest {
  api_key: string;
  key_alias?: string;
}

interface VTQuotaResponse {
  data: {
    api_requests_daily?: {
      user: { allowed: number; used: number };
    };
    api_requests_hourly?: {
      user: { allowed: number; used: number };
    };
  };
}

interface VTErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

// ============================================================
// VIRUSTOTAL API
// ============================================================

const VT_API_URL = "https://www.virustotal.com/api/v3";

/**
 * Verify VT API key by getting user quotas
 * GET /api/v3/users/{user_id}/overall_quotas
 *
 * For API key verification, we use a simple domain lookup
 */
async function verifyVirusTotalKey(
  apiKey: string
): Promise<{
  ok: boolean;
  error?: string;
  tier?: string;
  daily_quota?: number;
  daily_used?: number;
}> {
  try {
    // Use domains endpoint to verify key (simple test)
    const response = await fetch(`${VT_API_URL}/domains/google.com`, {
      method: "GET",
      headers: {
        "x-apikey": apiKey,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { ok: false, error: "invalid_api_key" };
      }
      if (response.status === 429) {
        return { ok: false, error: "rate_limit_exceeded" };
      }

      const errorBody = await response.json() as VTErrorResponse;
      return {
        ok: false,
        error: `vt_error: ${errorBody.error?.code || response.status}`,
      };
    }

    // Key is valid, try to get quota info
    const quotaInfo = await getQuotaInfo(apiKey);

    return {
      ok: true,
      tier: quotaInfo.tier,
      daily_quota: quotaInfo.daily_quota,
      daily_used: quotaInfo.daily_used,
    };
  } catch (err) {
    return {
      ok: false,
      error: `vt_network_error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

/**
 * Get quota information (optional, may fail for some accounts)
 */
async function getQuotaInfo(apiKey: string): Promise<{
  tier: string;
  daily_quota: number;
  daily_used: number;
}> {
  // Default free tier values
  const defaults = {
    tier: "free",
    daily_quota: 500,
    daily_used: 0,
  };

  try {
    // Try to get quota from /users/me (requires full API access)
    const response = await fetch(`${VT_API_URL}/users/me`, {
      method: "GET",
      headers: {
        "x-apikey": apiKey,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      // Quota endpoint may not be available for all users
      return defaults;
    }

    const data = await response.json() as VTQuotaResponse;

    const daily = data.data?.api_requests_daily?.user;
    if (daily) {
      return {
        tier: daily.allowed > 500 ? "premium" : "free",
        daily_quota: daily.allowed,
        daily_used: daily.used,
      };
    }

    return defaults;
  } catch {
    return defaults;
  }
}

// ============================================================
// MAIN HANDLER
// ============================================================

/**
 * POST /integrations/virustotal/init
 *
 * Body: {
 *   api_key: string,
 *   key_alias?: string
 * }
 *
 * Flow:
 * 1. Validate input
 * 2. Verify key via VT API
 * 3. Encrypt & store in D1
 * 4. Return success with quota info
 */
export async function handleInitKeyVirusTotal(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // 1. Parse & validate input
  let body: InitKeyRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { api_key, key_alias } = body;

  if (!api_key || typeof api_key !== "string") {
    return c.json({ ok: false, error: "api_key_required" }, 400);
  }

  // Basic format check (VT keys are 64 hex characters)
  const trimmedKey = api_key.trim();
  if (!/^[a-f0-9]{64}$/i.test(trimmedKey)) {
    return c.json({ ok: false, error: "invalid_api_key_format" }, 400);
  }

  // 2. Auth — проверяем JWT и получаем account_id
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // 3. Verify key via VirusTotal API
  const verification = await verifyVirusTotalKey(trimmedKey);

  if (!verification.ok) {
    return c.json({
      ok: false,
      error: verification.error,
    }, 400);
  }

  // 4. Check for duplicate (only one VT key per account)
  const existing = await env.DB301.prepare(
    `SELECT id FROM account_keys
     WHERE account_id = ? AND provider = 'virustotal' AND status = 'active'`
  )
    .bind(accountId)
    .first();

  if (existing) {
    return c.json({
      ok: false,
      error: "virustotal_key_already_exists",
      existing_key_id: existing.id,
      message: "Only one VirusTotal key per account is allowed. Delete existing key first.",
    }, 409);
  }

  // 5. Encrypt & store
  const tokenName = key_alias?.trim() || "virustotal";

  const secrets = {
    apiKey: trimmedKey,
  };

  const encrypted = await encrypt(secrets, env.MASTER_SECRET);

  const result = await env.DB301.prepare(
    `INSERT INTO account_keys
      (account_id, provider, name, key_encrypted, status, created_at, updated_at)
     VALUES (?, 'virustotal', ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(
      accountId,
      tokenName,
      JSON.stringify(encrypted)
    )
    .run();

  const keyId = result.meta?.last_row_id;

  // 6. Success
  return c.json({
    ok: true,
    key_id: keyId,
    message: "VirusTotal integration configured successfully",
    tier: verification.tier,
    quota: {
      daily_limit: verification.daily_quota,
      daily_used: verification.daily_used,
    },
  });
}

/**
 * GET /integrations/virustotal/quota
 *
 * Returns current quota usage for account's VT key
 */
export async function handleGetVirusTotalQuota(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // Auth
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Get key
  const keyRow = await env.DB301.prepare(
    `SELECT key_encrypted FROM account_keys
     WHERE account_id = ? AND provider = 'virustotal' AND status = 'active'`
  )
    .bind(accountId)
    .first<{ key_encrypted: string }>();

  if (!keyRow) {
    return c.json({ ok: false, error: "virustotal_not_configured" }, 404);
  }

  // Decrypt
  const { decrypt } = await import("../../../lib/crypto");
  const decrypted = await decrypt(JSON.parse(keyRow.key_encrypted), env.MASTER_SECRET);
  const apiKey = (decrypted as { apiKey: string }).apiKey;

  // Get quota
  const quotaInfo = await getQuotaInfo(apiKey);

  return c.json({
    ok: true,
    tier: quotaInfo.tier,
    quota: {
      daily_limit: quotaInfo.daily_quota,
      daily_used: quotaInfo.daily_used,
      daily_remaining: quotaInfo.daily_quota - quotaInfo.daily_used,
    },
  });
}
