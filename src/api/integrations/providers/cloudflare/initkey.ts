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
 * Проверка тарифного лимита
 */
async function checkCFKeyQuota(
  env: Env,
  accountId: number
): Promise<{ limit: number; current: number; plan: string }> {
  const quotaRow = await env.DB301.prepare(
    `
    SELECT ql.max_cf_accounts, p.name as plan_name
    FROM accounts a
    LEFT JOIN quota_limits ql ON a.plan_id = ql.plan_id
    LEFT JOIN plans p ON a.plan_id = p.id
    WHERE a.id = ?
    `
  )
    .bind(accountId)
    .first<{ max_cf_accounts: number | null; plan_name: string | null }>();

  const countRow = await env.DB301.prepare(
    `SELECT COUNT(*) as count FROM account_keys 
     WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active'`
  )
    .bind(accountId)
    .first<{ count: number }>();

  return {
    limit: quotaRow?.max_cf_accounts ?? 1,
    current: countRow?.count ?? 0,
    plan: quotaRow?.plan_name ?? "free",
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
  // 3. Проверка тарифа
  // ─────────────────────────────────────────────────────────

  const quota = await checkCFKeyQuota(env, accountId);

  // ─────────────────────────────────────────────────────────
  // 4. Определение сценария
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
  // 5. Verify bootstrap token
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
  // 6. Get & resolve permissions
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
  // 8. Create working token
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
  // 9. Verify working token
  // ─────────────────────────────────────────────────────────

  const workingVerify = await verifyToken(cf_account_id, workingToken.value);
  if (!workingVerify.ok) {
    await deleteCFToken(cf_account_id, workingToken.id, bootstrap_token).catch((e) =>
      console.error("Rollback: failed to delete working token:", e)
    );
    return Errors.cfError(c, workingVerify.error);
  }

  // ─────────────────────────────────────────────────────────
  // 10. Delete old integration (replace scenario)
  // ─────────────────────────────────────────────────────────

  if (scenario === "replace" && oldKeyForCleanup) {
    const cleanupResult = await deleteExistingCFIntegration(env, oldKeyForCleanup, bootstrap_token);
    if (!cleanupResult.ok) {
      await deleteCFToken(cf_account_id, workingToken.id, bootstrap_token).catch(() => {});
      return Errors.cleanupFailed(c, cleanupResult.error);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 11. Delete old working token (rotate scenario)
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
  }

  // ─────────────────────────────────────────────────────────
  // 12. Save key via storage.ts
  // ─────────────────────────────────────────────────────────

  let keyId: number;

  if (scenario === "rotate" && existingSameAccount) {
    const updateResult = await updateKey(env, {
      key_id: existingSameAccount.id,
      secrets: { token: workingToken.value },
      provider_scope: { cf_token_id: workingToken.id, cf_token_name: workingToken.name },
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
      provider_scope: { cf_token_id: workingToken.id, cf_token_name: workingToken.name },
      expires_at: expiresOn,
    });

    if (!storageResult.ok) {
      await deleteCFToken(cf_account_id, workingToken.id, workingToken.value).catch(() => {});
      return Errors.storageFailed(c, workingToken.id, cf_account_id);
    }

    keyId = storageResult.key_id;
  }

  // ─────────────────────────────────────────────────────────
  // 13. Delete bootstrap token (best effort)
  // ─────────────────────────────────────────────────────────

  await deleteCFToken(cf_account_id, bootstrapTokenId, bootstrap_token).catch((e) =>
    console.warn("Failed to delete bootstrap token:", e)
  );

  // ─────────────────────────────────────────────────────────
  // 14. Sync zones (create/replace scenarios)
  // ─────────────────────────────────────────────────────────

  let syncResult: { zones: number; domains: number } | undefined;

  if (scenario === "create" || scenario === "replace") {
    try {
      const { syncZonesInternal } = await import("./zones");
      const sync = await syncZonesInternal(env, accountId, keyId, cf_account_id, workingToken.value);
      syncResult = { zones: sync.zones_synced ?? 0, domains: sync.domains_synced ?? 0 };
    } catch (e) {
      console.error("Zones sync failed:", e);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 15. Return success
  // ─────────────────────────────────────────────────────────

  return success(c, {
    key_id: keyId,
    is_rotation: scenario === "rotate",
    sync: syncResult,
  });
}
