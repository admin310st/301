// src/api/integrations/providers/cloudflare/initkey.ts

import { Context } from "hono";
import { Env } from "../../../types/worker";
import { createKey } from "../../keys/storage";
import { CF_REQUIRED_PERMISSIONS } from "./permissions";
import { requireOwner } from "../../../lib/auth";

// TYPES

interface InitKeyRequest {
  cf_account_id: string;
  bootstrap_token: string;
  key_alias?: string;
}

interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface PermissionGroup {
  id: string;
  name: string;
  scopes: string[];
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

// CF API HELPERS

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * GET /accounts/{account_id}/tokens/verify
 * Проверка токена и получение его ID
 */
async function verifyToken(
  cfAccountId: string,
  token: string
): Promise<{ ok: true; tokenId: string; status: string } | { ok: false; error: string }> {
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

    const data = await response.json() as CFApiResponse<TokenVerifyResult>;

    if (!response.ok || !data.success) {
      const errorMsg = data.errors?.[0]?.message || "Token verification failed";
      return { ok: false, error: errorMsg };
    }

    return { ok: true, tokenId: data.result.id, status: data.result.status };
  } catch (e) {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * GET /accounts/{account_id}/tokens/permission_groups
 * Получение полного списка permission groups (200+)
 */
async function getPermissionGroups(
  cfAccountId: string,
  token: string
): Promise<{ ok: true; groups: PermissionGroup[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/tokens/permission_groups`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<PermissionGroup[]>;

    if (!response.ok || !data.success) {
      const errorMsg = data.errors?.[0]?.message || "Failed to get permission groups";
      return { ok: false, error: errorMsg };
    }

    return { ok: true, groups: data.result };
  } catch (e) {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * Сверить permissions из CF с нашими CF_REQUIRED_PERMISSIONS
 * Возвращает ok или список missing names
 */
function resolvePermissions(
  cfGroups: PermissionGroup[]
): { ok: true } | { ok: false; missing: string[] } {
  const cfByName = new Map(cfGroups.map(g => [g.name, g]));
  const missing: string[] = [];
  const mismatched: Array<{ name: string; expected: string; actual: string }> = [];

  for (const required of CF_REQUIRED_PERMISSIONS) {
    const cfGroup = cfByName.get(required.name);
    
    if (!cfGroup) {
      missing.push(required.name);
    } else if (cfGroup.id !== required.id) {
      // ID изменился — логируем для отладки
      mismatched.push({
        name: required.name,
        expected: required.id,
        actual: cfGroup.id,
      });
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  // Если есть mismatched — логируем warning
  if (mismatched.length > 0) {
    console.warn("Permission ID mismatch detected:", mismatched);
  }

  return { ok: true };
}

/**
 * Построить payload для создания токена
 * Использует актуальные ID из CF response
 */
function buildCreateTokenPayload(
  cfAccountId: string,
  tokenName: string,
  cfGroups: PermissionGroup[],
  expiresOn?: string,
  notBefore?: string
): object {
  const cfByName = new Map(cfGroups.map(g => [g.name, g]));

  // Разделяем permissions по scope и берём актуальные ID из CF
  const accountPermissions = CF_REQUIRED_PERMISSIONS
    .filter(p => p.scope === "account")
    .map(p => {
      const cfGroup = cfByName.get(p.name);
      return { id: cfGroup?.id || p.id, name: p.name };
    });

  const zonePermissions = CF_REQUIRED_PERMISSIONS
    .filter(p => p.scope === "zone")
    .map(p => {
      const cfGroup = cfByName.get(p.name);
      return { id: cfGroup?.id || p.id, name: p.name };
    });

  const payload: Record<string, unknown> = {
    name: tokenName,
    policies: [
      {
        effect: "allow",
        resources: {
          [`com.cloudflare.api.account.${cfAccountId}`]: "*",
        },
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

  if (notBefore) {
    payload.not_before = notBefore;
  }

  if (expiresOn) {
    payload.expires_on = expiresOn;
  }

  return payload;
}

/**
 * POST /accounts/{account_id}/tokens — создать новый токен
 */
async function createCFToken(
  cfAccountId: string,
  bootstrapToken: string,
  payload: object
): Promise<{ ok: true; token: CreatedToken } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/tokens`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bootstrapToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json() as CFApiResponse<CreatedToken>;

    if (!response.ok || !data.success) {
      const errorMsg = data.errors?.[0]?.message || "Failed to create token";
      return { ok: false, error: errorMsg };
    }

    return { ok: true, token: data.result };
  } catch (e) {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * DELETE /accounts/{account_id}/tokens/{token_id} — удалить токен
 */
async function deleteCFToken(
  cfAccountId: string,
  tokenId: string,
  authToken: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/accounts/${cfAccountId}/tokens/${tokenId}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<unknown>;

    if (!response.ok || !data.success) {
      const errorMsg = data.errors?.[0]?.message || "Failed to delete token";
      return { ok: false, error: errorMsg };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: "CF API request failed" };
  }
}

// MAIN HANDLER

/**
 * POST /integrations/initkey/cf
 * 
 * Создание working token из bootstrap token
 */
export async function handleInitKeyCF(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // 1. Auth — проверяем JWT и получаем account_id
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // 2. Парсим request
  let body: InitKeyRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { cf_account_id, bootstrap_token, key_alias } = body;

  if (!cf_account_id || !bootstrap_token) {
    return c.json({ 
      ok: false, 
      error: "missing_fields", 
      fields: ["cf_account_id", "bootstrap_token"] 
    }, 400);
  }

  // 3. Verify bootstrap → получаем token_id
  const bootstrapVerify = await verifyToken(cf_account_id, bootstrap_token);

  if (!bootstrapVerify.ok) {
    return c.json({
      ok: false,
      error: "bootstrap_invalid",
      message: bootstrapVerify.error,
    }, 400);
  }

  if (bootstrapVerify.status !== "active") {
    return c.json({
      ok: false,
      error: "bootstrap_not_active",
      status: bootstrapVerify.status,
    }, 400);
  }

  const bootstrapTokenId = bootstrapVerify.tokenId;

  // 4. GET permission_groups → полный список (200+)
  const permGroupsResult = await getPermissionGroups(cf_account_id, bootstrap_token);

  if (!permGroupsResult.ok) {
    return c.json({
      ok: false,
      error: "permission_groups_failed",
      message: permGroupsResult.error,
    }, 400);
  }

  // 5. Сверяем нужные permissions по name
  const resolveResult = resolvePermissions(permGroupsResult.groups);

  if (!resolveResult.ok) {
    return c.json({
      ok: false,
      error: "permissions_missing",
      missing: resolveResult.missing,
    }, 400);
  }

  // 6. Генерируем имя и даты для working token
  const now = new Date();
  const tokenName = `301st-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${now.toISOString().slice(11, 19).replace(/:/g, "")}`;
  
  const notBefore = now.toISOString().split('.')[0] + 'Z';
  
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 5);
  const expiresOn = expiresAt.toISOString().split('.')[0] + 'Z';

  // 7. Формируем payload и создаём working token
  const payload = buildCreateTokenPayload(
    cf_account_id,
    tokenName,
    permGroupsResult.groups,
    expiresOn,
    notBefore
  );

  const createResult = await createCFToken(cf_account_id, bootstrap_token, payload);

  if (!createResult.ok) {
    return c.json({
      ok: false,
      error: "token_creation_failed",
      message: createResult.error,
    }, 500);
  }

  const workingToken = createResult.token;

  // 8. Verify working token
  const workingVerify = await verifyToken(cf_account_id, workingToken.value);

  if (!workingVerify.ok) {
    // Working token не работает — удаляем его
    await deleteCFToken(cf_account_id, workingToken.id, bootstrap_token);
    return c.json({
      ok: false,
      error: "working_token_invalid",
      message: workingVerify.error,
    }, 500);
  }

  // 9. Сохраняем working token в storage
  const storageResult = await createKey(env, {
    account_id: accountId,
    provider: "cloudflare",
    key_alias: tokenName,
    secrets: {
      token: workingToken.value,
    },
    external_account_id: cf_account_id,
    provider_scope: {
      cf_token_id: workingToken.id,
      cf_token_name: workingToken.name,
    },
    expires_at: expiresOn,
  });

  if (!storageResult.ok) {
    // Критическая ошибка — working token создан но не сохранён
    // Пытаемся удалить working token
    await deleteCFToken(cf_account_id, workingToken.id, workingToken.value);
    return c.json({
      ok: false,
      error: "storage_failed",
    }, 500);
  }

  // 10. Удаляем bootstrap token (используем сам bootstrap для удаления)
  const deleteResult = await deleteCFToken(cf_account_id, bootstrapTokenId, bootstrap_token);

  if (!deleteResult.ok) {
    // Не критично — working token уже создан и сохранён
    console.error(`Failed to delete bootstrap token: ${deleteResult.error}`);
  }

  // 11. Успех
  return c.json({
    ok: true,
    key_id: storageResult.key_id,
  });
}

