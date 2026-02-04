// src/api/integrations/providers/namecheap/initkey.ts

import { Context } from "hono";
import { Env } from "../../../types/worker";
import { encrypt } from "../../../lib/crypto";
import { requireOwner } from "../../../lib/auth";
import { getProxyIps, namecheapVerifyKey } from "./namecheap";

// TYPES

interface InitKeyRequest {
  username: string;
  api_key: string;
  key_alias?: string;
}

// MAIN HANDLER

/**
 * POST /integrations/namecheap/init
 *
 * Body: {
 *   username: string,
 *   api_key: string,
 *   key_alias?: string
 * }
 *
 * Flow:
 * 1. Validate input
 * 2. Get proxies from KV
 * 3. Verify key via namecheap.users.getBalances (with proxy fallback)
 * 4. Encrypt & store in D1 + KV
 * 5. Return success
 */
export async function handleInitKeyNamecheap(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // 1. Parse & validate input
  let body: InitKeyRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { username, api_key, key_alias } = body;

  if (!username || typeof username !== "string") {
    return c.json({ ok: false, error: "username_required" }, 400);
  }

  if (!api_key || typeof api_key !== "string") {
    return c.json({ ok: false, error: "api_key_required" }, 400);
  }

  // 2. Auth — проверяем JWT и получаем account_id
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // 3. Encrypt credentials for verification
  const secrets = {
    apiKey: api_key.trim(),
    username: username.trim(),
  };

  const encrypted = await encrypt(secrets, env.MASTER_SECRET);

  // 4. Verify key via Namecheap API
  const verification = await namecheapVerifyKey(env, encrypted);

  if (!verification.ok) {
    // Специфичные сообщения для UI
    if (verification.error === "ip_not_whitelisted") {
      const proxyIps = (await getProxyIps(env)).join(", ");

      return c.json({
        ok: false,
        error: "ip_not_whitelisted",
        message: "Add these IPs to your Namecheap API whitelist",
        ips: proxyIps,
      }, 400);
    }

    return c.json({
      ok: false,
      error: verification.error,
    }, 400);
  }

  // 5. Check for duplicate (same username for this account)
  const existing = await env.DB301.prepare(
    `SELECT id FROM account_keys
     WHERE account_id = ? AND provider = 'namecheap' AND external_account_id = ?`
  )
    .bind(accountId, username.trim().toLowerCase())
    .first();

  if (existing) {
    return c.json({
      ok: false,
      error: "namecheap_key_already_exists",
      existing_key_id: existing.id,
    }, 409);
  }

  // 6. Store in D1
  const tokenName = key_alias?.trim() || `namecheap-${username}`;

  const result = await env.DB301.prepare(
    `INSERT INTO account_keys
      (account_id, provider, name, key_encrypted, external_account_id, status, created_at, updated_at)
     VALUES (?, 'namecheap', ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(
      accountId,
      tokenName,
      JSON.stringify(encrypted),
      username.trim().toLowerCase()
    )
    .run();

  const keyId = result.meta?.last_row_id;

  // 7. Success
  return c.json({
    ok: true,
    key_id: keyId,
    message: "Namecheap integration configured successfully",
    balance: verification.balance,
  });
}
