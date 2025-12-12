// src/api/integrations/providers/cloudflare/keys.ts

/**
 * Cloudflare Account Keys Management
 * 
 * CRUD операции с ключами + проверка валидности
 */

import { Context } from "hono";
import { Env } from "../../../types/worker";
import { requireAuth, requireOwner } from "../../../lib/auth";
import { decrypt } from "../../../lib/crypto";

// ============================================================
// TYPES
// ============================================================

interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface AccountKey {
  id: number;
  account_id: number;
  provider: string;
  provider_scope: string;
  key_alias: string;
  kv_key: string;
  status: string;
  expires_at: string | null;
  last_used: string | null;
  created_at: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ============================================================
// HELPERS
// ============================================================

/**
 * Получить расшифрованный токен из KV
 */
async function getDecryptedToken(
  env: Env,
  kvKey: string
): Promise<string | null> {
  const encrypted = await env.KV_CREDENTIALS.get(kvKey);
  if (!encrypted) return null;
  
  try {
    const data = JSON.parse(encrypted);
    return await decrypt(data.token, env.ENCRYPTION_KEY);
  } catch {
    return null;
  }
}

// ============================================================
// HANDLERS
// ============================================================

/**
 * GET /integrations/cloudflare/keys
 * Список ключей CF аккаунта
 */
export async function handleListKeys(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  const keys = await env.DB301.prepare(
    `SELECT id, provider, provider_scope, key_alias, status, expires_at, last_used, created_at
     FROM account_keys
     WHERE account_id = ? AND provider = 'cloudflare'
     ORDER BY created_at DESC`
  ).bind(accountId).all<Omit<AccountKey, "account_id" | "kv_key">>();

  return c.json({
    ok: true,
    keys: keys.results,
  });
}

/**
 * GET /integrations/cloudflare/keys/:id
 * Детали ключа
 */
export async function handleGetKey(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const keyId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  const key = await env.DB301.prepare(
    `SELECT id, provider, provider_scope, key_alias, status, expires_at, last_used, created_at
     FROM account_keys
     WHERE id = ? AND account_id = ? AND provider = 'cloudflare'`
  ).bind(keyId, accountId).first<Omit<AccountKey, "account_id" | "kv_key">>();

  if (!key) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  return c.json({
    ok: true,
    key,
  });
}

/**
 * DELETE /integrations/cloudflare/keys/:id
 * Удалить ключ (soft delete — меняем статус)
 */
export async function handleDeleteKey(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const keyId = parseInt(c.req.param("id"));

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем что ключ существует и принадлежит аккаунту
  const key = await env.DB301.prepare(
    `SELECT id, kv_key FROM account_keys
     WHERE id = ? AND account_id = ? AND provider = 'cloudflare'`
  ).bind(keyId, accountId).first<{ id: number; kv_key: string }>();

  if (!key) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  // Проверяем что нет привязанных зон
  const zonesCount = await env.DB301.prepare(
    `SELECT COUNT(*) as count FROM zones WHERE key_id = ? AND status != 'deleted'`
  ).bind(keyId).first<{ count: number }>();

  if (zonesCount && zonesCount.count > 0) {
    return c.json({ 
      ok: false, 
      error: "key_has_zones", 
      zones_count: zonesCount.count 
    }, 400);
  }

  // Soft delete — меняем статус
  await env.DB301.prepare(
    `UPDATE account_keys SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(keyId).run();

  // Удаляем из KV
  await env.KV_CREDENTIALS.delete(key.kv_key);

  return c.json({ ok: true });
}

/**
 * POST /integrations/cloudflare/keys/:id/verify
 * Проверить валидность ключа
 */
export async function handleVerifyKey(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const keyId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Получаем ключ
  const key = await env.DB301.prepare(
    `SELECT kv_key, provider_scope FROM account_keys
     WHERE id = ? AND account_id = ? AND provider = 'cloudflare'`
  ).bind(keyId, accountId).first<{ kv_key: string; provider_scope: string }>();

  if (!key) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  // Расшифровываем токен
  const token = await getDecryptedToken(env, key.kv_key);
  if (!token) {
    return c.json({ ok: false, error: "key_decrypt_failed" }, 500);
  }

  const scope = JSON.parse(key.provider_scope || "{}");
  const cfAccountId = scope.cf_account_id;

  if (!cfAccountId) {
    return c.json({ ok: false, error: "cf_account_id_missing" }, 500);
  }

  // Проверяем через CF API
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/tokens/verify`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<{ id: string; status: string }>;

    if (!data.success) {
      // Обновляем статус в D1
      await env.DB301.prepare(
        `UPDATE account_keys SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(keyId).run();

      return c.json({
        ok: false,
        error: "token_invalid",
        cf_error: data.errors?.[0]?.message,
      });
    }

    const isActive = data.result.status === "active";

    // Обновляем статус и last_used
    await env.DB301.prepare(
      `UPDATE account_keys 
       SET status = ?, last_used = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`
    ).bind(isActive ? "active" : "error", keyId).run();

    return c.json({
      ok: true,
      valid: isActive,
      cf_status: data.result.status,
      cf_token_id: data.result.id,
    });
  } catch (e) {
    return c.json({ ok: false, error: "cf_api_failed" }, 500);
  }
}

// ============================================================
// CRON FUNCTION
// ============================================================

/**
 * Проверить валидность всех ключей CF
 * Вызывается из system/cron.ts (раз в 24 часа)
 */
export async function verifyAccountKeys(env: Env): Promise<{
  checked: number;
  valid: number;
  invalid: number;
}> {
  const stats = { checked: 0, valid: 0, invalid: 0 };

  // Получаем все активные ключи CF
  const keys = await env.DB301.prepare(
    `SELECT id, account_id, kv_key, provider_scope FROM account_keys
     WHERE provider = 'cloudflare' AND status = 'active'`
  ).all<{ id: number; account_id: number; kv_key: string; provider_scope: string }>();

  for (const key of keys.results) {
    stats.checked++;

    const token = await getDecryptedToken(env, key.kv_key);
    if (!token) {
      stats.invalid++;
      await env.DB301.prepare(
        `UPDATE account_keys SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(key.id).run();
      continue;
    }

    const scope = JSON.parse(key.provider_scope || "{}");
    const cfAccountId = scope.cf_account_id;

    if (!cfAccountId) {
      stats.invalid++;
      continue;
    }

    // Проверяем токен через CF API
    try {
      const response = await fetch(
        `${CF_API_BASE}/accounts/${cfAccountId}/tokens/verify`,
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await response.json() as CFApiResponse<{ status: string }>;

      if (data.success && data.result.status === "active") {
        stats.valid++;
        await env.DB301.prepare(
          `UPDATE account_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(key.id).run();
      } else {
        stats.invalid++;
        await env.DB301.prepare(
          `UPDATE account_keys SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(key.id).run();
      }
    } catch {
      stats.invalid++;
    }
  }

  return stats;
}

