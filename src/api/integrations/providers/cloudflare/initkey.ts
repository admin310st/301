// src/api/integrations/providers/cloudflare/initkey.ts

/**
 * Инициализация ключа Cloudflare
 *
 * Flow:
 * 1. Bootstrap token → Working token
 * 2. Working token сохраняется через storage.ts (KV + D1)
 * 3. Bootstrap удаляется
 *
 * Сценарии:
 * - СОЗДАНИЕ: новый CF аккаунт → createKey + syncZones
 * - РОТАЦИЯ: тот же CF аккаунт → updateKey
 * - ЗАМЕНА: другой CF аккаунт (free plan) → deleteKey + createKey + syncZones
 */

import type { Context } from "hono";
import type { Env } from "../../../types/worker";
import { requireOwner } from "../../../lib/auth";
import { withRetry } from "../../../lib/retry";
import {
  createKey,
  updateKey,
  deleteKey,
  findKeyByExternalId,
  listKeys,
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
    await deleteCFToken(oldKey.external_account_id, oldScope.cf_token_id, bootstrapToken).catch(
      (e) => console.warn("Failed to delete old CF token:", e)
    );
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
 * Проверка лимита CF ключей
 * 
 * Логика:
 * - free: 1 CF аккаунт
 * - pro/buss: без лимита (пока)
 */
async function checkCFKeyQuota(
  env: Env,
  accountId: number
): Promise<{ limit: number; current: number; plan: string }> {
  // Получаем plan_tier аккаунта
  const accountRow = await env.DB301.prepare(
    `SELECT plan_tier FROM accounts WHERE id = ?`
  )
    .bind(accountId)
    .first<{ plan_tier: string }>();

  const plan = accountRow?.plan_tier ?? "free";

  // Лимит CF аккаунтов по тарифу
  const limitByPlan: Record<string, number> = {
    free: 1,
    pro: 10,
    buss: 100,
  };
  const limit = limitByPlan[plan] ?? 1;

  // Считаем текущие активные CF ключи
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
  // 3. Глобальная проверка — CF аккаунт уже используется в ДРУГОМ аккаунте 301?
  // ─────────────────────────────────────────────────────────

  const globalExisting = await env.DB301.prepare(
    `SELECT id, account_id FROM account_keys 
     WHERE provider = 'cloudflare' 
     AND external_account_id = ? 
     AND status = 'active'
     AND account_id != ?`
  )
    .bind(cf_account_id, accountId)
    .first<{ id: number; account_id: number }>();

  if (globalExisting) {
    return Errors.externalAccountAlreadyUsed(c, "cloudflare", cf_account_id);
  }

  // ─────────────────────────────────────────────────────────
  // 4. Проверка тарифа
  // ─────────────────────────────────────────────────────────

  const quota = await checkCFKeyQuota(env, accountId);

  // ─────────────────────────────────────────────────────────
  // 5. Определение сценария
  // ─────────────────────────────────────────────────────────

  const existingSameAccount = await findKeyByExternalId(env, accountId, "cloudflare", cf_account_id);
  const existingCFKeys = await listKeys(env, accountId, "cloudflare");
  const existingOtherAccount = existingCFKeys.find(
    (k) => k.external_account_id !== cf_account_id && k.status === "active"
  );

  let scenario: "create" | "rotate" | "replace";
  let oldKeyForCleanup: KeyRecord | null = null;

  if (existingSameAccount && existingSameAccount.status === "active") {
    scenario = "rotate";
  } else if (existingOtherAccount) {
    if (quota.limit <= quota.current && !confirm_replace) {
      return Errors.cfAccountConflict(
        c,
        existingOtherAccount.external_account_id || "",
        existingOtherAccount.id,
        cf_account_id
      );
    }
    scenario = confirm_replace ? "replace" : "create";
    if (confirm_replace) {
      oldKeyForCleanup = existingOtherAccount;
    }
  } else {
    if (quota.current >= quota.limit) {
      return Errors.quotaExceeded(c, quota.limit, quota.current, quota.plan);
    }
    scenario = "create";
  }

  // ─────────────────────────────────────────────────────────
  // 6. Verify bootstrap token
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
  // 7. Get account info (name для UI)
  // ─────────────────────────────────────────────────────────

  const accountInfoResult = await getAccountInfo(cf_account_id, bootstrap_token);
  const cfAccountName = accountInfoResult.ok ? accountInfoResult.name : null;

  // ─────────────────────────────────────────────────────────
  // 8. Get & resolve permissions
  // ─────────────────────────────────────────────────────────

  const permGroupsResult = await getPermissionGroups(cf_account_id, bootstrap_token);
  if (!permGroupsResult.ok) {
    return Errors.cfError(c, permGroupsResult.error);
  }

  const resolveResult = resolvePermissions(permGroupsResult.groups);
  if (!resolveResult.ok) {
    return Errors.permissionsMissing(c, resolveResult.missing);
  }

  // ─────────────────────────────────────────────────────────
  // 9. Generate token name and dates
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
  // 10. Create working token
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
    return Errors.cfError(c, createResult.error);
  }

  const workingToken = createResult.token;

  // ─────────────────────────────────────────────────────────
  // 11. Verify working token
  // ─────────────────────────────────────────────────────────

  const workingVerify = await verifyToken(cf_account_id, workingToken.value);
  if (!workingVerify.ok) {
    await deleteCFToken(cf_account_id, workingToken.id, bootstrap_token).catch((e) =>
      console.error("Rollback: failed to delete working token:", e)
    );
    return Errors.cfError(c, workingVerify.error);
  }

  // ─────────────────────────────────────────────────────────
  // 12. Delete old integration (replace scenario)
  // ─────────────────────────────────────────────────────────

  if (scenario === "replace" && oldKeyForCleanup) {
    const cleanupResult = await deleteExistingCFIntegration(env, oldKeyForCleanup, bootstrap_token);
    if (!cleanupResult.ok) {
      await deleteCFToken(cf_account_id, workingToken.id, bootstrap_token).catch(() => {});
      return Errors.cleanupFailed(c, cleanupResult.error);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 13. Delete old working token + cleanup duplicates (rotate scenario)
  // ─────────────────────────────────────────────────────────

  if (scenario === "rotate" && existingSameAccount) {
    const oldScope = existingSameAccount.provider_scope
      ? JSON.parse(existingSameAccount.provider_scope)
      : {};
    if (oldScope.cf_token_id) {
      await deleteCFToken(cf_account_id, oldScope.cf_token_id, bootstrap_token).catch((e) =>
        console.warn("Failed to delete old working token:", e)
      );
    }

    // Чистка дубликатов: удаляем ВСЕ другие ключи с этим external_account_id
    // Правило: 1 CF аккаунт = 1 ключ в 301.st
    const duplicates = existingCFKeys.filter(
      (k) =>
        k.external_account_id === cf_account_id &&
        k.id !== existingSameAccount.id &&
        k.status === "active"
    );

    for (const dup of duplicates) {
      console.warn(`Cleaning duplicate CF key: id=${dup.id}`);
      const dupScope = dup.provider_scope ? JSON.parse(dup.provider_scope) : {};

      // Удаляем токен в CF (best effort)
      if (dupScope.cf_token_id) {
        await deleteCFToken(cf_account_id, dupScope.cf_token_id, bootstrap_token).catch(() => {});
      }

      // Удаляем ключ из storage (D1 + KV)
      await deleteKey(env, dup.id).catch((e) =>
        console.error(`Failed to delete duplicate key ${dup.id}:`, e)
      );
    }
  }

  // ─────────────────────────────────────────────────────────
  // 14. Save key via storage.ts
  // ─────────────────────────────────────────────────────────

  let keyId: number;

  if (scenario === "rotate" && existingSameAccount) {
    const updateResult = await updateKey(env, {
      key_id: existingSameAccount.id,
      secrets: { token: workingToken.value },
      provider_scope: { cf_token_id: workingToken.id, cf_token_name: workingToken.name, cf_account_name: cfAccountName },
      expires_at: expiresOn,
    });

    if (!updateResult.ok) {
      await deleteCFToken(cf_account_id, workingToken.id, workingToken.value).catch(() => {});
      return Errors.storageFailed(c, workingToken.id, cf_account_id);
    }

    keyId = existingSameAccount.id;
  } else {
    const storageResult = await createKey(env, {
      account_id: accountId,
      provider: "cloudflare",
      key_alias: tokenName,
      secrets: { token: workingToken.value },
      external_account_id: cf_account_id,
      provider_scope: { cf_token_id: workingToken.id, cf_token_name: workingToken.name, cf_account_name: cfAccountName },
      expires_at: expiresOn,
    });

    if (!storageResult.ok) {
      await deleteCFToken(cf_account_id, workingToken.id, workingToken.value).catch(() => {});
      return Errors.storageFailed(c, workingToken.id, cf_account_id);
    }

    keyId = storageResult.key_id;
  }

  // ─────────────────────────────────────────────────────────
  // 15. Delete bootstrap token (best effort)
  // ─────────────────────────────────────────────────────────

  await deleteCFToken(cf_account_id, bootstrapTokenId, bootstrap_token).catch((e) =>
    console.warn("Failed to delete bootstrap token:", e)
  );

  // ─────────────────────────────────────────────────────────
  // 16. Sync zones (if no zones exist for this key)
  // ─────────────────────────────────────────────────────────

  let syncResult: { zones: number; domains: number } | undefined;

  // Проверяем есть ли зоны у этого ключа
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
  // 17. Return success
  // ─────────────────────────────────────────────────────────

  return success(c, {
    key_id: keyId,
    is_rotation: scenario === "rotate",
    sync: syncResult,
  });
}

