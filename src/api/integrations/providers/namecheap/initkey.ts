// src/api/integrations/providers/namecheap/initkey.ts

import { Context } from "hono";
import { Env } from "../../../types/worker";
import { requireOwner } from "../../../lib/auth";
import { createKey, findKeyByExternalId } from "../../keys/storage";
import { getProxyIps, namecheapVerifyKey } from "./namecheap";
import type { NamecheapSecrets } from "./namecheap";

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
 * 2. Verify key via namecheap.users.getBalances (with Squid proxy)
 * 3. Store via storage.ts (encrypt → KV, metadata → D1)
 * 4. Return success
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

  // 3. Prepare secrets for verification
  const secrets: NamecheapSecrets = {
    apiKey: api_key.trim(),
    username: username.trim(),
  };

  // 4. Verify key via Namecheap API
  const verification = await namecheapVerifyKey(env, secrets);

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
  const existing = await findKeyByExternalId(env, accountId, "namecheap", username.trim().toLowerCase());

  if (existing) {
    return c.json({
      ok: false,
      error: "namecheap_key_already_exists",
      existing_key_id: existing.id,
    }, 409);
  }

  // 6. Store via storage.ts (encrypt → KV_CREDENTIALS, metadata → D1)
  const tokenName = key_alias?.trim() || `namecheap-${username}`;

  const result = await createKey(env, {
    account_id: accountId,
    provider: "namecheap",
    key_alias: tokenName,
    secrets,
    external_account_id: username.trim().toLowerCase(),
  });

  if (!result.ok) {
    return c.json({ ok: false, error: result.error }, 500);
  }

  // 7. Success
  return c.json({
    ok: true,
    key_id: result.key_id,
    message: "Namecheap integration configured successfully",
    balance: verification.balance,
  });
}
