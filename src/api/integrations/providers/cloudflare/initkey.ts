// src/api/integrations/providers/cloudflare/initkey.ts

/**
 * Инициализация ключа Cloudflare
 *
 * Flow (pending-first для защиты от race condition):
 * 1. Auth → owner only
 * 2. Parse input
 * 3. Verify bootstrap → получаем token_id
 * 4. Get account info → cf_account_name
 * 5. Глобальная проверка + резервирование (pending)
 * 6. Get & resolve permissions
 * 7. Generate token name and dates
 * 8. Create working token в CF
 * 9. Verify working token
 * 10. Delete old CF token (если rotate)
 * 11. Finalize: UPDATE pending→active или UPDATE existing (rotate)
 * 12. Delete bootstrap token
 * 13. Sync zones (если create)
 * 14. Return success
 *
 * При ошибке после шага 5:
 * - DELETE pending запись
 * - DELETE CF token (если создан)
 */

import type { Context } from "hono";
import type { Env } from "../../../types/worker";
import { nanoid } from "nanoid";
import { encrypt } from "../../../lib/crypto";
import { requireOwner } from "../../../lib/auth";
import { withRetry } from "../../../lib/retry";
import {
  updateKey,
  deleteKey,
  type KeyRecord,
} from "../../keys/storage";
import { CF_REQUIRED_PERMISSIONS } from "./permissions";
import { Errors, success, parseCFError, parseNetworkError } from "./responses";
import type { CFApiResponse } from "./responses";

// ============================================================
// TYPES
// ============================================================

interface InitKeyRequest {
  cf_account_id: string;
  bootstrap_token: string;
  key_alias?: string;
  confirm_replace?: boolean;
}

interface PermissionGroup {
  id: string;
  name: string;
  scopes?: string[];
}

interface TokenVerifyResult {
  id: string;
  status: string;
}

interface CreatedToken {
  id: string;
  name: string;
  value: string;
}

interface ExistingKeyInfo {
  id: number;
  account_id: number;
  status: string;
  provider_scope: string | null;
  kv_key: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ============================================================
// CF API HELPERS
// ============================================================

/**
 * GET /accounts/{account_id}/tokens/verify
 */
async function verifyToken(
  cfAccountId: string,
  token: string
): Promise<
  { ok: true; tokenId: string; status: string } | { ok: false; error: ReturnType<typeof parseCFError> }
> {
  try {
    const response = await fetch(`${CF_API_BASE}/accounts/${cfAccountId}/tokens/verify`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as CFApiResponse<TokenVerifyResult>;

    if (!response.ok || !data.success) {
      return { ok: false, error: parseCFError(data) };
    }

    return { ok: true, tokenId: data.result.id, status: data.result.status };
  } catch (e) {
    return { ok: false, error: parseNetworkError(e) };
  }
}

/**
 * GET /accounts/{account_id}/tokens/permission_groups
 */
async function getPermissionGroups(
  cfAccountId: string,
  token: string
): Promise<{ ok: true; groups: PermissionGroup[] } | { ok: false; error: ReturnType<typeof parseCFError> }> {
  try {
    const response = await fetch(`${CF_API_BASE}/accounts/${cfAccountId}/tokens/permission_groups`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as CFApiResponse<PermissionGroup[]>;

    if (!response.ok || !data.success) {
      return { ok: false, error: parseCFError(data) };
    }

    return { ok: true, groups: data.result };
  } catch (e) {
    return { ok: false, error: parseNetworkError(e) };
  }
}

/**
 * GET /accounts/{account_id}
 * Получение информации об аккаунте (name для UI)
 */
async function getAccountInfo(
  cfAccountId: string,
  token: string
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${CF_API_BASE}/accounts/${cfAccountId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as CFApiResponse<{ id: string; name: string }>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to get account info" };
    }

    return { ok: true, name: data.result.name };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * Сверить permissions из CF с нашими CF_REQUIRED_PERMISSIONS
 */
function resolvePermissions(
  cfGroups: PermissionGroup[]
): { ok: true } | { ok: false; missing: string[] } {
  const cfByName = new Map(cfGroups.map((g) => [g.name, g]));
  const missing: string[] = [];

  for (const required of CF_REQUIRED_PERMISSIONS) {
    if (!cfByName.has(required.name)) {
      missing.push(required.name);
    }
  }

  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

/**
 * Построить payload для создания токена
 */
function buildCreateTokenPayload(
  cfAccountId: string,
  tokenName: string,
  cfGroups: PermissionGroup[],
  expiresOn: string,
  notBefore: string
): object {
  const cfByName = new Map(cfGroups.map((g) => [g.name, g]));

  const accountPermissions = CF_REQUIRED_PERMISSIONS.filter((p) => p.scope === "account").map(
    (p) => ({ id: cfByName.get(p.name)?.id || p.id })
  );

  const zonePermissions = CF_REQUIRED_PERMISSIONS.filter((p) => p.scope === "zone").map((p) => ({
    id: cfByName.get(p.name)?.id || p.id,
  }));

  return {
    name: tokenName,
    not_before: notBefore,
    expires_on: expiresOn,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${cfAccountId}`]: "*" },
        permission_groups: accountPermissions,
      },
      {
        effect: "allow",
        resources: {
          [`com.cloudflare.api.account.${cfAccountId}`]: {
            "com.cloudflare.api.account.zone.*": "*",
          },
        },
        permission_groups: zonePermissions,
      },
    ],
  };
}

/**
 * POST /accounts/{account_id}/tokens
 */
async function createCFToken(
  cfAccountId: string,
  bootstrapToken: string,
  payload: object
): Promise<{ ok: true; token: CreatedToken } | { ok: false; error: ReturnType<typeof parseCFError> }> {
  try {
    const response = await fetch(`${CF_API_BASE}/accounts/${cfAccountId}/tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bootstrapToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as CFApiResponse<CreatedToken>;

    if (!response.ok || !data.success) {
      return { ok: false, error: parseCFError(data) };
    }

    return { ok: true, token: data.result };
  } catch (e) {
    return { ok: false, error: parseNetworkError(e) };
  }
}

/**
 * DELETE /accounts/{account_id}/tokens/{token_id}
 */
async function deleteCFToken(
  cfAccountId: string,
  tokenId: string,
  authToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${CF_API_BASE}/accounts/${cfAccountId}/tokens/${tokenId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as CFApiResponse<unknown>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to delete token" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Проверка лимита CF ключей
 */
async function checkCFKeyQuota(
  env: Env,
  accountId: number
): Promise<{ limit: number; current: number; plan: string }> {
  const accountRow = await env.DB301.prepare(
    `SELECT plan_tier FROM accounts WHERE id = ?`
  )
    .bind(accountId)
    .first<{ plan_tier: string }>();

  const plan = accountRow?.plan_tier ?? "free";

  const limitByPlan: Record<string, number> = {
    free: 1,
    pro: 10,
    buss: 100,
  };
  const limit = limitByPlan[plan] ?? 1;

  const countRow = await env.DB301.prepare(
    `SELECT COUNT(DISTINCT external_account_id) as count 
     FROM account_keys 
     WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active'`
  )
    .bind(accountId)
    .first<{ count: number }>();

  return {
    limit,
    current: countRow?.count ?? 0,
    plan,
  };
}

/**
 * Удаление старой CF интеграции при замене
 */
async function deleteExistingCFIntegration(
  env: Env,
  oldKey: KeyRecord,
  bootstrapToken: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const oldScope = oldKey.provider_scope ? JSON.parse(oldKey.provider_scope) : {};

  // 1. CF API — удаляем старый working token (best effort)
  if (oldScope.cf_token_id && oldKey.external_account_id) {
    const deleteResult = await deleteCFToken(oldKey.external_account_id, oldScope.cf_token_id, bootstrapToken);
    if (!deleteResult.ok) {
      console.warn("Failed to delete old CF token:", oldScope.cf_token_id, deleteResult.error);
    }
  }

  // 2. D1 — удаляем zones и domains (с retry)
  try {
    await withRetry(async () => {
      await env.DB301.batch([
        env.DB301.prepare("DELETE FROM domains WHERE key_id = ?").bind(oldKey.id),
        env.DB301.prepare("DELETE FROM zones WHERE key_id = ?").bind(oldKey.id),
      ]);
    });
  } catch (e) {
    console.error("Failed to delete zones/domains:", e);
    return { ok: false, error: "cleanup_zones_failed" };
  }

  // 3. Удаляем ключ через storage (D1 + KV)
  const deleteResult = await deleteKey(env, oldKey.id);
  if (!deleteResult.ok) {
    return { ok: false, error: deleteResult.error };
  }

  return { ok: true };
}

/**
 * Rollback: удалить pending запись и CF токен
 */
async function rollback(
  env: Env,
  pendingKeyId: number | null,
  kvKey: string | null,
  cfAccountId: string,
  cfTokenId: string | null,
  bootstrapToken: string
): Promise<void> {
  // Удаляем pending запись из D1
  if (pendingKeyId) {
    await env.DB301.prepare("DELETE FROM account_keys WHERE id = ?")
      .bind(pendingKeyId)
      .run()
      .catch((e) => console.error("Rollback: failed to delete pending key:", e));
  }

  // Удаляем из KV
  if (kvKey) {
    await env.KV_CREDENTIALS.delete(kvKey).catch((e) =>
      console.error("Rollback: failed to delete KV:", e)
    );
  }

  // Удаляем CF токен
  if (cfTokenId) {
    const result = await deleteCFToken(cfAccountId, cfTokenId, bootstrapToken);
    if (!result.ok) {
      console.error("Rollback: failed to delete CF token:", cfTokenId, result.error);
    }
  }
}

// ============================================================
// MAIN HANDLER
// ============================================================

/**
 * POST /integrations/cloudflare/init
 */
export async function handleInitKeyCF(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // ─────────────────────────────────────────────────────────
  // 1. Auth — только owner может добавлять интеграции
  // ─────────────────────────────────────────────────────────

  const auth = await requireOwner(c, env);
  if (!auth) {
    return Errors.ownerRequired(c);
  }

  const accountId = auth.account_id;

  // ─────────────────────────────────────────────────────────
  // 2. Parse & validate input
  // ─────────────────────────────────────────────────────────

  let body: InitKeyRequest;
  try {
    body = await c.req.json();
  } catch {
    return Errors.invalidJson(c);
  }

  const { cf_account_id, bootstrap_token, key_alias, confirm_replace } = body;

  if (!cf_account_id || !bootstrap_token) {
    const missing: string[] = [];
    if (!cf_account_id) missing.push("cf_account_id");
    if (!bootstrap_token) missing.push("bootstrap_token");
    return Errors.missingFields(c, missing);
  }

  // ─────────────────────────────────────────────────────────
  // 3. Verify bootstrap token
  // ─────────────────────────────────────────────────────────

  const bootstrapVerify = await verifyToken(cf_account_id, bootstrap_token);
  if (!bootstrapVerify.ok) {
    return Errors.cfError(c, bootstrapVerify.error);
  }
  if (bootstrapVerify.status !== "active") {
    return Errors.bootstrapNotActive(c, bootstrapVerify.status);
  }

  const bootstrapTokenId = bootstrapVerify.tokenId;

  // ─────────────────────────────────────────────────────────
  // 4. Get account info (name для UI)
  // ─────────────────────────────────────────────────────────

  const accountInfoResult = await getAccountInfo(cf_account_id, bootstrap_token);
  const cfAccountName = accountInfoResult.ok ? accountInfoResult.name : null;

  // ─────────────────────────────────────────────────────────
  // 5. Глобальная проверка + резервирование (pending)
  // ─────────────────────────────────────────────────────────

  // 5.1 Проверяем существующие записи
  const existingKey = await env.DB301.prepare(
    `SELECT id, account_id, status, provider_scope, kv_key
     FROM account_keys 
     WHERE provider = 'cloudflare' AND external_account_id = ?
     ORDER BY CASE status WHEN 'active' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END
     LIMIT 1`
  )
    .bind(cf_account_id)
    .first<ExistingKeyInfo>();

  let scenario: "create" | "rotate" | "replace";
  let existingActiveKey: ExistingKeyInfo | null = null;
  let pendingKeyId: number | null = null;
  let kvKey: string | null = null;

  if (existingKey) {
    if (existingKey.status === "pending") {
      // Уже есть pending — race condition
      return Errors.keyCreationInProgress(c);
    }

    if (existingKey.status === "active") {
      if (existingKey.account_id === accountId) {
        // Тот же аккаунт — rotate
        scenario = "rotate";
        existingActiveKey = existingKey;
      } else {
        // Другой аккаунт — blocked
        return Errors.externalAccountAlreadyUsed(c, "cloudflare", cf_account_id);
      }
    } else {
      // revoked/expired — можно создавать новый
      scenario = "create";
    }
  } else {
    scenario = "create";
  }

  // 5.2 Проверка тарифа (только для create)
  if (scenario === "create") {
    const quota = await checkCFKeyQuota(env, accountId);

    // Проверяем есть ли другой CF ключ (для replace)
    const otherCFKey = await env.DB301.prepare(
      `SELECT id, external_account_id, provider_scope, kv_key
       FROM account_keys
       WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active' AND external_account_id != ?
       LIMIT 1`
    )
      .bind(accountId, cf_account_id)
      .first<ExistingKeyInfo & { external_account_id: string }>();

    // Лимит достигнут?
    if (quota.current >= quota.limit) {
      if (otherCFKey) {
        // Есть другой CF ключ — предлагаем замену
        if (!confirm_replace) {
          return Errors.cfAccountConflict(
            c,
            otherCFKey.external_account_id,
            otherCFKey.id,
            cf_account_id
          );
        }
        scenario = "replace";
        existingActiveKey = otherCFKey;
      } else {
        // Нет других ключей, но лимит достигнут (edge case)
        return Errors.quotaExceeded(c, quota.limit, quota.current, quota.plan);
      }
    }
    // else: лимит позволяет — просто добавляем новый (scenario остаётся "create")
  }

  // 5.3 Резервируем место (INSERT pending) — только для create/replace
  if (scenario === "create" || scenario === "replace") {
    kvKey = `cloudflare:${accountId}:${nanoid(12)}`;

    try {
      const result = await env.DB301.prepare(
        `INSERT INTO account_keys (
          account_id, provider, external_account_id, status, kv_key, key_alias
        ) VALUES (?, 'cloudflare', ?, 'pending', ?, ?)`
      )
        .bind(accountId, cf_account_id, kvKey, key_alias || `pending-${Date.now()}`)
        .run();

      pendingKeyId = result.meta?.last_row_id as number;
    } catch (e) {
      // UNIQUE constraint — race condition
      console.error("Failed to insert pending key:", e);
      return Errors.keyCreationInProgress(c);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 6. Get & resolve permissions
  // ─────────────────────────────────────────────────────────

  const permGroupsResult = await getPermissionGroups(cf_account_id, bootstrap_token);
  if (!permGroupsResult.ok) {
    await rollback(env, pendingKeyId, null, cf_account_id, null, bootstrap_token);
    return Errors.cfError(c, permGroupsResult.error);
  }

  const resolveResult = resolvePermissions(permGroupsResult.groups);
  if (!resolveResult.ok) {
    await rollback(env, pendingKeyId, null, cf_account_id, null, bootstrap_token);
    return Errors.permissionsMissing(c, resolveResult.missing);
  }

  // ─────────────────────────────────────────────────────────
  // 7. Generate token name and dates
  // ─────────────────────────────────────────────────────────

  const now = new Date();
  const tokenName =
    key_alias ||
    `301st-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${now
      .toISOString()
      .slice(11, 19)
      .replace(/:/g, "")}`;

  const notBefore = now.toISOString().split(".")[0] + "Z";
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 5);
  const expiresOn = expiresAt.toISOString().split(".")[0] + "Z";

  // ─────────────────────────────────────────────────────────
  // 8. Create working token в CF
  // ─────────────────────────────────────────────────────────

  const payload = buildCreateTokenPayload(
    cf_account_id,
    tokenName,
    permGroupsResult.groups,
    expiresOn,
    notBefore
  );

  const createResult = await createCFToken(cf_account_id, bootstrap_token, payload);
  if (!createResult.ok) {
    await rollback(env, pendingKeyId, null, cf_account_id, null, bootstrap_token);
    return Errors.cfError(c, createResult.error);
  }

  const workingToken = createResult.token;

  // ─────────────────────────────────────────────────────────
  // 9. Verify working token
  // ─────────────────────────────────────────────────────────

  const workingVerify = await verifyToken(cf_account_id, workingToken.value);
  if (!workingVerify.ok) {
    await rollback(env, pendingKeyId, null, cf_account_id, workingToken.id, bootstrap_token);
    return Errors.cfError(c, workingVerify.error);
  }

  // ─────────────────────────────────────────────────────────
  // 10. Delete old CF token (rotate/replace scenarios)
  // ─────────────────────────────────────────────────────────

  if ((scenario === "rotate" || scenario === "replace") && existingActiveKey) {
    const oldScope = existingActiveKey.provider_scope
      ? JSON.parse(existingActiveKey.provider_scope)
      : {};

    if (oldScope.cf_token_id) {
      const deleteOldResult = await deleteCFToken(cf_account_id, oldScope.cf_token_id, bootstrap_token);
      if (!deleteOldResult.ok) {
        console.warn("Failed to delete old CF token:", oldScope.cf_token_id, deleteOldResult.error);
      }
    }

    // Для replace — удаляем старую интеграцию полностью
    if (scenario === "replace") {
      const cleanupResult = await deleteExistingCFIntegration(env, existingActiveKey as KeyRecord, bootstrap_token);
      if (!cleanupResult.ok) {
        await rollback(env, pendingKeyId, null, cf_account_id, workingToken.id, bootstrap_token);
        return Errors.cleanupFailed(c, cleanupResult.error);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // 11. Finalize: encrypt secrets + UPDATE D1
  // ─────────────────────────────────────────────────────────

  let keyId: number;

  // Шифруем secrets
  let encrypted: string;
  try {
    const encryptedData = await encrypt({ token: workingToken.value }, env.MASTER_SECRET);
    encrypted = JSON.stringify(encryptedData);
  } catch (e) {
    console.error("Encryption failed:", e);
    await rollback(env, pendingKeyId, null, cf_account_id, workingToken.id, bootstrap_token);
    return Errors.storageFailed(c, workingToken.id, cf_account_id);
  }

  // Сохраняем в KV
  try {
    await env.KV_CREDENTIALS.put(kvKey!, encrypted);
  } catch (e) {
    console.error("KV write failed:", e);
    await rollback(env, pendingKeyId, null, cf_account_id, workingToken.id, bootstrap_token);
    return Errors.storageFailed(c, workingToken.id, cf_account_id);
  }

  const providerScope = JSON.stringify({
    cf_token_id: workingToken.id,
    cf_token_name: workingToken.name,
    cf_account_name: cfAccountName,
  });

  if (scenario === "rotate" && existingActiveKey) {
    // UPDATE existing record — используем существующий kv_key
    const rotateKvKey = existingActiveKey.kv_key;
    
    try {
      await withRetry(async () => {
        await env.DB301.prepare(
          `UPDATE account_keys 
           SET provider_scope = ?, expires_at = ?
           WHERE id = ?`
        )
          .bind(providerScope, expiresOn, existingActiveKey.id)
          .run();
      });

      // Обновляем секрет в KV (перезаписываем)
      await env.KV_CREDENTIALS.put(rotateKvKey, encrypted);
    } catch (e) {
      console.error("D1 update failed:", e);
      await rollback(env, null, null, cf_account_id, workingToken.id, bootstrap_token);
      return Errors.storageFailed(c, workingToken.id, cf_account_id);
    }

    keyId = existingActiveKey.id;
  } else {
    // UPDATE pending → active
    try {
      await withRetry(async () => {
        await env.DB301.prepare(
          `UPDATE account_keys 
           SET status = 'active', provider_scope = ?, key_alias = ?, expires_at = ?
           WHERE id = ?`
        )
          .bind(providerScope, tokenName, expiresOn, pendingKeyId)
          .run();
      });
    } catch (e) {
      console.error("D1 update failed:", e);
      await rollback(env, pendingKeyId, kvKey, cf_account_id, workingToken.id, bootstrap_token);
      return Errors.storageFailed(c, workingToken.id, cf_account_id);
    }

    keyId = pendingKeyId!;
  }

  // ─────────────────────────────────────────────────────────
  // 12. Delete bootstrap token (best effort)
  // ─────────────────────────────────────────────────────────

  const deleteBootstrapResult = await deleteCFToken(cf_account_id, bootstrapTokenId, bootstrap_token);
  if (!deleteBootstrapResult.ok) {
    console.warn("Failed to delete bootstrap token:", bootstrapTokenId, deleteBootstrapResult.error);
  }

  // ─────────────────────────────────────────────────────────
  // 13. Sync zones (if no zones exist for this key)
  // ─────────────────────────────────────────────────────────

  let syncResult: { zones: number; domains: number } | undefined;

  const zonesCount = await env.DB301.prepare(
    "SELECT COUNT(*) as cnt FROM zones WHERE key_id = ?"
  )
    .bind(keyId)
    .first<{ cnt: number }>();

  if (!zonesCount || zonesCount.cnt === 0) {
    try {
      const { syncZonesInternal } = await import("./zones");
      const sync = await syncZonesInternal(env, accountId, keyId, cf_account_id, workingToken.value);
      syncResult = { zones: sync.zones_synced ?? 0, domains: sync.domains_synced ?? 0 };
    } catch (e) {
      console.error("Zones sync failed:", e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 14. Setup client environment (D1, KV, Workers)
  // ─────────────────────────────────────────────────────────

  let clientEnvResult: {
    d1?: { database_id: string; created: boolean };
    kv?: { namespace_id: string; created: boolean };
    workers?: { health?: { deployed: boolean } };
  } | undefined;

  // Setup only for new integrations (not rotate)
  if (scenario !== "rotate") {
    try {
      const { setupClientEnvironment } = await import("../../../client-env/setup");
      const envSetup = await setupClientEnvironment({
        cfAccountId: cf_account_id,
        cfToken: workingToken.value,
        accountId,
        env,
      });

      if (envSetup.ok && envSetup.client_env) {
        clientEnvResult = {
          d1: envSetup.client_env.d1_id ? {
            database_id: envSetup.client_env.d1_id,
            created: true,
          } : undefined,
          kv: envSetup.client_env.kv_id ? {
            namespace_id: envSetup.client_env.kv_id,
            created: true,
          } : undefined,
          workers: {
            health: envSetup.client_env.health_worker ? { deployed: true } : undefined,
          },
        };

        // Save client_env to DB
        await env.DB301.prepare(
          "UPDATE account_keys SET client_env = ? WHERE id = ?"
        ).bind(JSON.stringify(envSetup.client_env), keyId).run();
      } else {
        console.warn("Client environment setup failed:", envSetup.error);
      }
    } catch (e) {
      console.error("Client environment setup error:", e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 15. Return success
  // ─────────────────────────────────────────────────────────

  return success(c, {
    key_id: keyId,
    is_rotation: scenario === "rotate",
    sync: syncResult,
    client_env: clientEnvResult,
  });
}

