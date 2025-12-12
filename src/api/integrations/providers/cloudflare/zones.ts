// src/api/integrations/providers/cloudflare/zones.ts

/**
 * Cloudflare Zones Management
 * 
 * CRUD операции с зонами + DNS + проверка NS
 * Кэширование в KV, учёт квот в D1
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
  result_info?: {
    page: number;
    per_page: number;
    total_count: number;
    total_pages: number;
  };
}

interface CFZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  name_servers: string[];
  original_name_servers: string[];
  created_on: string;
  modified_on: string;
}

interface CreateZoneRequest {
  domain: string;
  account_key_id: number;
  registrar_key_id?: number;
  auto_update_ns?: boolean;
}

interface QuotaLimits {
  max_zones: number;
  max_domains: number;
}

interface QuotaUsage {
  zones_used: number;
  domains_used: number;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const CACHE_TTL_DEFAULT = 15 * 60; // 15 минут в секундах

// ============================================================
// HELPERS: CF API
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

/**
 * Получить данные ключа из D1 + расшифрованный токен
 */
async function getAccountKey(
  env: Env,
  keyId: number,
  accountId: number
): Promise<{ token: string; cfAccountId: string } | null> {
  const key = await env.DB301.prepare(
    `SELECT kv_key, provider_scope FROM account_keys 
     WHERE id = ? AND account_id = ? AND provider = 'cloudflare' AND status = 'active'`
  ).bind(keyId, accountId).first<{ kv_key: string; provider_scope: string }>();

  if (!key) return null;

  const token = await getDecryptedToken(env, key.kv_key);
  if (!token) return null;

  const scope = JSON.parse(key.provider_scope || "{}");
  return { token, cfAccountId: scope.cf_account_id };
}

// ============================================================
// HELPERS: QUOTA
// ============================================================

/**
 * Получить лимиты и использование квот
 */
async function getQuota(
  env: Env,
  accountId: number
): Promise<{ limits: QuotaLimits; usage: QuotaUsage } | null> {
  const result = await env.DB301.prepare(
    `SELECT 
       ql.max_zones, ql.max_domains,
       qu.zones_used, qu.domains_used
     FROM accounts a
     JOIN quota_limits ql ON a.plan_tier = ql.plan_tier
     LEFT JOIN quota_usage qu ON a.id = qu.account_id
     WHERE a.id = ?`
  ).bind(accountId).first<{
    max_zones: number;
    max_domains: number;
    zones_used: number | null;
    domains_used: number | null;
  }>();

  if (!result) return null;

  return {
    limits: {
      max_zones: result.max_zones,
      max_domains: result.max_domains,
    },
    usage: {
      zones_used: result.zones_used || 0,
      domains_used: result.domains_used || 0,
    },
  };
}

/**
 * Проверить можно ли создать зону
 */
async function canCreateZone(
  env: Env,
  accountId: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const quota = await getQuota(env, accountId);
  if (!quota) {
    return { ok: false, error: "quota_not_found" };
  }

  if (quota.usage.zones_used >= quota.limits.max_zones) {
    return { ok: false, error: "quota_zones_exceeded" };
  }

  return { ok: true };
}

/**
 * Инкремент использования зон
 */
async function incrementZonesUsed(env: Env, accountId: number): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage SET zones_used = zones_used + 1, updated_at = CURRENT_TIMESTAMP
     WHERE account_id = ?`
  ).bind(accountId).run();
}

/**
 * Декремент использования зон
 */
async function decrementZonesUsed(env: Env, accountId: number): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage SET zones_used = MAX(0, zones_used - 1), updated_at = CURRENT_TIMESTAMP
     WHERE account_id = ?`
  ).bind(accountId).run();
}

// ============================================================
// HELPERS: CACHE
// ============================================================

/**
 * Получить TTL кэша из настроек
 */
async function getCacheTTL(env: Env): Promise<number> {
  const settings = await env.KV_CREDENTIALS.get("settings:cron");
  if (settings) {
    const parsed = JSON.parse(settings);
    return (parsed.cache_ttl || 15) * 60; // минуты → секунды
  }
  return CACHE_TTL_DEFAULT;
}

/**
 * Получить зоны из кэша
 */
async function getCachedZones(
  env: Env,
  accountId: number
): Promise<CFZone[] | null> {
  const cached = await env.KV_CREDENTIALS.get(`cache:zones:${accountId}`);
  return cached ? JSON.parse(cached) : null;
}

/**
 * Сохранить зоны в кэш
 */
async function setCachedZones(
  env: Env,
  accountId: number,
  zones: CFZone[]
): Promise<void> {
  const ttl = await getCacheTTL(env);
  await env.KV_CREDENTIALS.put(
    `cache:zones:${accountId}`,
    JSON.stringify(zones),
    { expirationTtl: ttl }
  );
}

/**
 * Инвалидировать кэш зон
 */
async function invalidateZonesCache(env: Env, accountId: number): Promise<void> {
  await env.KV_CREDENTIALS.delete(`cache:zones:${accountId}`);
}

// ============================================================
// CF API: ZONES
// ============================================================

/**
 * GET /zones — список зон аккаунта CF
 */
async function cfListZones(
  cfAccountId: string,
  token: string
): Promise<{ ok: true; zones: CFZone[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones?account.id=${cfAccountId}&per_page=50`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<CFZone[]>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to list zones" };
    }

    return { ok: true, zones: data.result };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * GET /zones/{zone_id} — детали зоны
 */
async function cfGetZone(
  zoneId: string,
  token: string
): Promise<{ ok: true; zone: CFZone } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${zoneId}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<CFZone>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to get zone" };
    }

    return { ok: true, zone: data.result };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * POST /zones — создать зону
 */
async function cfCreateZone(
  cfAccountId: string,
  domain: string,
  token: string
): Promise<{ ok: true; zone: CFZone } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: domain,
          account: { id: cfAccountId },
          type: "full",
        }),
      }
    );

    const data = await response.json() as CFApiResponse<CFZone>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to create zone" };
    }

    return { ok: true, zone: data.result };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * DELETE /zones/{zone_id} — удалить зону
 */
async function cfDeleteZone(
  zoneId: string,
  token: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${zoneId}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<{ id: string }>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to delete zone" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}



// ============================================================
// HANDLERS: ZONES
// ============================================================

/**
 * GET /zones
 * Список зон аккаунта (из D1 + кэш)
 */
export async function handleListZones(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  
  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Получаем зоны из D1
  const zones = await env.DB301.prepare(
    `SELECT z.*, ak.key_alias as key_name
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.account_id = ? AND z.status != 'deleted'
     ORDER BY z.created_at DESC`
  ).bind(accountId).all();

  return c.json({
    ok: true,
    zones: zones.results,
  });
}

/**
 * GET /zones/:id
 * Детали зоны
 */
export async function handleGetZone(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Получаем зону из D1
  const zone = await env.DB301.prepare(
    `SELECT z.*, ak.key_alias as key_name, ak.kv_key, ak.provider_scope
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  return c.json({
    ok: true,
    zone,
  });
}

/**
 * POST /zones
 * Создать зону
 */
export async function handleCreateZone(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Parse request
  let body: CreateZoneRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { domain, account_key_id, registrar_key_id, auto_update_ns } = body;

  if (!domain || !account_key_id) {
    return c.json({ ok: false, error: "missing_fields", fields: ["domain", "account_key_id"] }, 400);
  }

  // Проверяем квоту
  const quotaCheck = await canCreateZone(env, accountId);
  if (!quotaCheck.ok) {
    return c.json({ ok: false, error: quotaCheck.error }, 403);
  }

  // Получаем ключ CF
  const keyData = await getAccountKey(env, account_key_id, accountId);
  if (!keyData) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  // Создаём зону в CF
  const cfResult = await cfCreateZone(keyData.cfAccountId, domain, keyData.token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_create_failed", message: cfResult.error }, 500);
  }

  const cfZone = cfResult.zone;
  const nsRecords = cfZone.name_servers.join(",");

  // Сохраняем в D1
  const insertResult = await env.DB301.prepare(
    `INSERT INTO zones (account_id, key_id, cf_zone_id, status, ns_expected, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).bind(accountId, account_key_id, cfZone.id, nsRecords).run();

  const zoneId = insertResult.meta.last_row_id;

  // Инкрементим квоту
  await incrementZonesUsed(env, accountId);

  // Инвалидируем кэш
  await invalidateZonesCache(env, accountId);

  // Если есть интеграция с регистратором — обновляем NS
  let nsUpdated = false;
  if (registrar_key_id && auto_update_ns) {
    // TODO: вызов Namecheap API для обновления NS
    // nsUpdated = await updateRegistrarNS(env, registrar_key_id, accountId, domain, cfZone.name_servers);
  }

  return c.json({
    ok: true,
    zone_id: zoneId,
    cf_zone_id: cfZone.id,
    ns_records: cfZone.name_servers,
    ns_updated: nsUpdated,
  });
}

/**
 * DELETE /zones/:id
 * Удалить зону
 */
export async function handleDeleteZone(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Получаем зону
  const zone = await env.DB301.prepare(
    `SELECT z.cf_zone_id, ak.kv_key, ak.provider_scope
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ cf_zone_id: string; kv_key: string; provider_scope: string }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Получаем токен
  const token = await getDecryptedToken(env, zone.kv_key);
  if (!token) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Удаляем в CF
  const cfResult = await cfDeleteZone(zone.cf_zone_id, token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_delete_failed", message: cfResult.error }, 500);
  }

  // Помечаем как удалённую в D1
  await env.DB301.prepare(
    `UPDATE zones SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(zoneId).run();

  // Декрементим квоту
  await decrementZonesUsed(env, accountId);

  // Инвалидируем кэш
  await invalidateZonesCache(env, accountId);
  await invalidateDNSCache(env, zone.cf_zone_id);

  return c.json({ ok: true });
}



// ============================================================
// HANDLERS: ACTIVATION CHECK
// ============================================================

/**
 * POST /zones/:id/check-activation
 * Проверить NS записи зоны
 */
export async function handleCheckActivation(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Получаем зону
  const zone = await env.DB301.prepare(
    `SELECT z.cf_zone_id, z.ns_expected, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ cf_zone_id: string; ns_expected: string; kv_key: string }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Получаем токен
  const token = await getDecryptedToken(env, zone.kv_key);
  if (!token) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Запрашиваем актуальный статус зоны из CF
  const cfResult = await cfGetZone(zone.cf_zone_id, token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_get_failed", message: cfResult.error }, 500);
  }

  const cfZone = cfResult.zone;
  const isActive = cfZone.status === "active";

  // Обновляем статус в D1
  const newStatus = isActive ? "active" : "pending";
  const verified = isActive ? 1 : 0;

  await env.DB301.prepare(
    `UPDATE zones SET status = ?, verified = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(newStatus, verified, zoneId).run();

  return c.json({
    ok: true,
    status: newStatus,
    verified: isActive,
    cf_status: cfZone.status,
    name_servers: cfZone.name_servers,
  });
}

// ============================================================
// EXPORTED FUNCTIONS FOR CRON
// ============================================================

/**
 * Проверить активацию всех pending зон
 * Вызывается из system/cron.ts
 */
export async function checkPendingZones(env: Env): Promise<{
  checked: number;
  activated: number;
  errors: number;
}> {
  const stats = { checked: 0, activated: 0, errors: 0 };

  // Получаем все pending зоны
  const pendingZones = await env.DB301.prepare(
    `SELECT z.id, z.cf_zone_id, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.status = 'pending'
     LIMIT 50`
  ).all<{ id: number; cf_zone_id: string; kv_key: string }>();

  for (const zone of pendingZones.results) {
    stats.checked++;

    const token = await getDecryptedToken(env, zone.kv_key);
    if (!token) {
      stats.errors++;
      continue;
    }

    const cfResult = await cfGetZone(zone.cf_zone_id, token);
    if (!cfResult.ok) {
      stats.errors++;
      continue;
    }

    if (cfResult.zone.status === "active") {
      await env.DB301.prepare(
        `UPDATE zones SET status = 'active', verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(zone.id).run();
      stats.activated++;
    }
  }

  return stats;
}

