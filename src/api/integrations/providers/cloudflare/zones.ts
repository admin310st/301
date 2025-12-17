// src/api/integrations/providers/cloudflare/zones.ts

/**
 * Cloudflare Zones Management
 * 
 * - CRUD операции с зонами
 * - Синхронизация зон из CF в D1
 * - Проверка активации
 * - Учёт квот
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
  original_registrar?: string;
  created_on: string;
  modified_on: string;
  activated_on?: string;
  plan?: {
    id: string;
    name: string;
  };
}

interface CreateZoneRequest {
  domain: string;
  account_key_id: number;
  registrar_key_id?: number;
  auto_update_ns?: boolean;
}

interface SyncZonesRequest {
  account_key_id: number;
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
): Promise<{ token: string; cfAccountId: string; keyId: number } | null> {
  const key = await env.DB301.prepare(
    `SELECT id, kv_key, provider_scope FROM account_keys 
     WHERE id = ? AND account_id = ? AND provider = 'cloudflare' AND status = 'active'`
  ).bind(keyId, accountId).first<{ id: number; kv_key: string; provider_scope: string }>();

  if (!key) return null;

  const token = await getDecryptedToken(env, key.kv_key);
  if (!token) return null;

  const scope = JSON.parse(key.provider_scope || "{}");
  return { token, cfAccountId: scope.cf_account_id, keyId: key.id };
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
async function incrementZonesUsed(env: Env, accountId: number, count: number = 1): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage SET zones_used = zones_used + ?, updated_at = CURRENT_TIMESTAMP
     WHERE account_id = ?`
  ).bind(count, accountId).run();
}

/**
 * Инкремент использования доменов
 */
async function incrementDomainsUsed(env: Env, accountId: number, count: number = 1): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage SET domains_used = domains_used + ?, updated_at = CURRENT_TIMESTAMP
     WHERE account_id = ?`
  ).bind(count, accountId).run();
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
 * Инвалидировать кэш зон
 */
async function invalidateZonesCache(env: Env, accountId: number): Promise<void> {
  await env.KV_CREDENTIALS.delete(`cache:zones:${accountId}`);
}

// ============================================================
// HELPERS: STATUS MAPPING
// ============================================================

/**
 * Маппинг CF status → D1 status
 */
function mapCFStatus(cfStatus: string): "active" | "pending" | "error" | "deleted" {
  switch (cfStatus) {
    case "active":
      return "active";
    case "pending":
    case "initializing":
      return "pending";
    case "moved":
    case "deactivated":
      return "error";
    case "deleted":
      return "deleted";
    default:
      return "pending";
  }
}

/**
 * Маппинг CF plan → D1 plan
 */
function mapCFPlan(cfPlan?: { id: string }): "free" | "pro" | "business" | "enterprise" {
  if (!cfPlan) return "free";
  switch (cfPlan.id) {
    case "pro":
      return "pro";
    case "business":
      return "business";
    case "enterprise":
      return "enterprise";
    default:
      return "free";
  }
}

// ============================================================
// CF API: ZONES
// ============================================================

/**
 * GET /zones — список всех зон аккаунта CF
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
// HANDLERS: CRUD
// ============================================================

/**
 * GET /zones
 * Список зон аккаунта (из D1)
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
    `INSERT INTO zones (account_id, key_id, cf_zone_id, status, ns_expected, plan, last_sync_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, 'free', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).bind(accountId, account_key_id, cfZone.id, nsRecords).run();

  const zoneId = insertResult.meta.last_row_id;

  // Создаём root domain в domains
  await env.DB301.prepare(
    `INSERT INTO domains (account_id, zone_id, key_id, domain_name, ns, ns_verified, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'reserve', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  ).bind(accountId, zoneId, account_key_id, cfZone.name, nsRecords).run();

  // Инкрементим квоты
  await incrementZonesUsed(env, accountId);
  await incrementDomainsUsed(env, accountId);

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
    `SELECT z.cf_zone_id, z.account_id, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ cf_zone_id: string; account_id: number; kv_key: string }>();

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

  // Инвалидируем кэш зон
  await invalidateZonesCache(env, accountId);

  // Инвалидируем кэш DNS (в KV)
  await env.KV_CREDENTIALS.delete(`cache:dns:${zone.cf_zone_id}`);

  return c.json({ ok: true });
}

// ============================================================
// HANDLERS: SYNC
// ============================================================

/**
 * POST /zones/sync
 * Синхронизация зон из CF → D1
 * Опрашивает CF API, создаёт/обновляет записи в zones и domains (root)
 */
export async function handleSyncZones(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Parse request
  let body: SyncZonesRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { account_key_id } = body;

  if (!account_key_id) {
    return c.json({ ok: false, error: "missing_fields", fields: ["account_key_id"] }, 400);
  }

  // Получаем ключ CF
  const keyData = await getAccountKey(env, account_key_id, accountId);
  if (!keyData) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  // Получаем квоты
  const quota = await getQuota(env, accountId);
  if (!quota) {
    return c.json({ ok: false, error: "quota_not_found" }, 500);
  }

  // Запрашиваем список зон из CF
  const cfResult = await cfListZones(keyData.cfAccountId, keyData.token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_list_failed", message: cfResult.error }, 500);
  }

  const stats = {
    zones_found: cfResult.zones.length,
    zones_created: 0,
    zones_updated: 0,
    domains_created: 0,
    domains_updated: 0,
    skipped_quota: 0,
    errors: [] as string[],
  };

  for (const cfZone of cfResult.zones) {
    try {
      const nsExpected = cfZone.name_servers.join(",");
      const status = mapCFStatus(cfZone.status);
      const plan = mapCFPlan(cfZone.plan);
      const verified = status === "active" ? 1 : 0;

      // Проверяем существует ли зона в D1
      const existingZone = await env.DB301.prepare(
        `SELECT id FROM zones WHERE cf_zone_id = ? AND account_id = ?`
      ).bind(cfZone.id, accountId).first<{ id: number }>();

      let zoneId: number;

      if (existingZone) {
        // UPDATE существующей зоны
        zoneId = existingZone.id;
        await env.DB301.prepare(
          `UPDATE zones 
           SET status = ?, plan = ?, ns_expected = ?, verified = ?, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(status, plan, nsExpected, verified, zoneId).run();
        stats.zones_updated++;
      } else {
        // Проверяем квоту перед созданием
        const currentZones = quota.usage.zones_used + stats.zones_created;
        if (currentZones >= quota.limits.max_zones) {
          stats.skipped_quota++;
          continue;
        }

        // INSERT новой зоны
        const insertResult = await env.DB301.prepare(
          `INSERT INTO zones (account_id, key_id, cf_zone_id, status, plan, ns_expected, verified, last_sync_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).bind(accountId, keyData.keyId, cfZone.id, status, plan, nsExpected, verified).run();
        
        zoneId = insertResult.meta.last_row_id as number;
        stats.zones_created++;
      }

      // Обрабатываем root domain
      const existingDomain = await env.DB301.prepare(
        `SELECT id FROM domains WHERE domain_name = ? AND account_id = ?`
      ).bind(cfZone.name, accountId).first<{ id: number }>();

      if (existingDomain) {
        // UPDATE существующего домена
        await env.DB301.prepare(
          `UPDATE domains 
           SET zone_id = ?, key_id = ?, ns = ?, ns_verified = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).bind(zoneId, keyData.keyId, nsExpected, verified, existingDomain.id).run();
        stats.domains_updated++;
      } else {
        // Проверяем квоту доменов
        const currentDomains = quota.usage.domains_used + stats.domains_created;
        if (currentDomains >= quota.limits.max_domains) {
          // Зону создали, но домен не влезает в квоту — пропускаем домен
          continue;
        }

        // INSERT нового домена (root)
        await env.DB301.prepare(
          `INSERT INTO domains (account_id, zone_id, key_id, domain_name, ns, ns_verified, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserve', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).bind(accountId, zoneId, keyData.keyId, cfZone.name, nsExpected, verified).run();
        stats.domains_created++;
      }

    } catch (e) {
      stats.errors.push(`Zone ${cfZone.name}: ${String(e)}`);
    }
  }

  // Обновляем quota_usage
  if (stats.zones_created > 0) {
    await incrementZonesUsed(env, accountId, stats.zones_created);
  }
  if (stats.domains_created > 0) {
    await incrementDomainsUsed(env, accountId, stats.domains_created);
  }

  // Инвалидируем кэш
  await invalidateZonesCache(env, accountId);

  return c.json({
    ok: stats.errors.length === 0,
    stats,
  });
}

/**
 * POST /zones/:id/sync
 * Синхронизация одной зоны из CF → D1 (детали)
 */
export async function handleSyncZone(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Получаем зону из D1
  const zone = await env.DB301.prepare(
    `SELECT z.id, z.cf_zone_id, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ id: number; cf_zone_id: string; kv_key: string }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Получаем токен
  const token = await getDecryptedToken(env, zone.kv_key);
  if (!token) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Запрашиваем детали зоны из CF
  const cfResult = await cfGetZone(zone.cf_zone_id, token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_get_failed", message: cfResult.error }, 500);
  }

  const cfZone = cfResult.zone;
  const nsExpected = cfZone.name_servers.join(",");
  const status = mapCFStatus(cfZone.status);
  const plan = mapCFPlan(cfZone.plan);
  const verified = status === "active" ? 1 : 0;

  // Обновляем зону в D1
  await env.DB301.prepare(
    `UPDATE zones 
     SET status = ?, plan = ?, ns_expected = ?, verified = ?, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).bind(status, plan, nsExpected, verified, zone.id).run();

  // Обновляем ns_verified для доменов этой зоны
  const domainsResult = await env.DB301.prepare(
    `UPDATE domains 
     SET ns_verified = CASE WHEN ns = ? THEN 1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP
     WHERE zone_id = ?`
  ).bind(nsExpected, zone.id).run();

  return c.json({
    ok: true,
    zone: {
      id: zone.id,
      cf_zone_id: cfZone.id,
      name: cfZone.name,
      status,
      plan,
      ns_expected: nsExpected,
      verified,
      original_registrar: cfZone.original_registrar,
      activated_on: cfZone.activated_on,
    },
    domains_updated: domainsResult.meta.changes,
  });
}

// ============================================================
// HANDLERS: ACTIVATION CHECK
// ============================================================

/**
 * POST /zones/:id/check-activation
 * Проверить NS записи зоны (ручной вызов)
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
    `SELECT z.id, z.cf_zone_id, z.ns_expected, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ id: number; cf_zone_id: string; ns_expected: string; kv_key: string }>();

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

  // Обновляем статус зоны в D1
  const newStatus = isActive ? "active" : "pending";
  const verified = isActive ? 1 : 0;

  await env.DB301.prepare(
    `UPDATE zones SET status = ?, verified = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(newStatus, verified, zone.id).run();

  // Если зона активирована — пересчитываем ns_verified для доменов
  let domainsUpdated = 0;
  if (isActive) {
    const updateResult = await env.DB301.prepare(
      `UPDATE domains 
       SET ns_verified = CASE 
         WHEN ns = ? THEN 1 
         ELSE 0 
       END,
       updated_at = CURRENT_TIMESTAMP
       WHERE zone_id = ?`
    ).bind(zone.ns_expected, zone.id).run();
    domainsUpdated = updateResult.meta.changes;
  }

  return c.json({
    ok: true,
    status: newStatus,
    verified: isActive,
    cf_status: cfZone.status,
    name_servers: cfZone.name_servers,
    domains_updated: domainsUpdated,
  });
}

// ============================================================
// EXPORTED FUNCTIONS FOR CRON
// ============================================================

/**
 * Проверить активацию всех pending зон
 * Вызывается из jobs/cron.ts
 */
export async function checkPendingZones(env: Env): Promise<{
  checked: number;
  activated: number;
  domains_updated: number;
  errors: number;
}> {
  const stats = { checked: 0, activated: 0, domains_updated: 0, errors: 0 };

  // Получаем все pending зоны
  const pendingZones = await env.DB301.prepare(
    `SELECT z.id, z.cf_zone_id, z.ns_expected, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.status = 'pending'
     LIMIT 50`
  ).all<{ id: number; cf_zone_id: string; ns_expected: string; kv_key: string }>();

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
      // Обновляем статус зоны
      await env.DB301.prepare(
        `UPDATE zones SET status = 'active', verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(zone.id).run();

      // Пересчитываем ns_verified для доменов этой зоны
      const updateResult = await env.DB301.prepare(
        `UPDATE domains 
         SET ns_verified = CASE 
           WHEN ns = ? THEN 1 
           ELSE 0 
         END,
         updated_at = CURRENT_TIMESTAMP
         WHERE zone_id = ?`
      ).bind(zone.ns_expected, zone.id).run();

      stats.activated++;
      stats.domains_updated += updateResult.meta.changes;
    }
  }

  return stats;
}
