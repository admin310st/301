// src/api/integrations/providers/cloudflare/zones.ts

/**
 * Cloudflare Zones Management
 * 
 * - CRUD операции с зонами
 * - Синхронизация зон из CF в D1
 * - Проверка активации
 * - Учёт квот
 */

import type { Context } from "hono";
import type { Env } from "../../../types/worker";
import { requireAuth, requireOwner } from "../../../lib/auth";
import { getDecryptedKey } from "../../keys/storage";
import { updateDomainsPhishingStatus } from "../../domains/health";

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
  meta?: {
    phishing_detected?: boolean;
    custom_certificate_quota?: number;
    page_rule_quota?: number;
    step?: number;
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
       a.plan_tier,
       ql.max_zones, ql.max_domains,
       qu.zones_used, qu.domains_used
     FROM accounts a
     LEFT JOIN quota_limits ql ON a.plan_tier = ql.plan_tier
     LEFT JOIN quota_usage qu ON a.id = qu.account_id
     WHERE a.id = ?`
  ).bind(accountId).first<{
    plan_tier: string | null;
    max_zones: number | null;
    max_domains: number | null;
    zones_used: number | null;
    domains_used: number | null;
  }>();

  if (!result) return null;

  return {
    limits: {
      max_zones: result.max_zones ?? 10,
      max_domains: result.max_domains ?? 10,
    },
    usage: {
      zones_used: result.zones_used ?? 0,
      domains_used: result.domains_used ?? 0,
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
    `INSERT INTO quota_usage (account_id, zones_used, domains_used)
     VALUES (?, ?, 0)
     ON CONFLICT(account_id) DO UPDATE SET 
       zones_used = zones_used + ?, 
       updated_at = CURRENT_TIMESTAMP`
  ).bind(accountId, count, count).run();
}

/**
 * Инкремент использования доменов
 */
async function incrementDomainsUsed(env: Env, accountId: number, count: number = 1): Promise<void> {
  await env.DB301.prepare(
    `INSERT INTO quota_usage (account_id, zones_used, domains_used)
     VALUES (?, 0, ?)
     ON CONFLICT(account_id) DO UPDATE SET 
       domains_used = domains_used + ?, 
       updated_at = CURRENT_TIMESTAMP`
  ).bind(accountId, count, count).run();
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
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFZone[]>;

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
    const response = await fetch(`${CF_API_BASE}/zones/${zoneId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as CFApiResponse<CFZone>;

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
    const response = await fetch(`${CF_API_BASE}/zones`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: domain,
        account: { id: cfAccountId },
        type: "full",
        jump_start: false,
      }),
    });

    const data = (await response.json()) as CFApiResponse<CFZone>;

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
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${CF_API_BASE}/zones/${zoneId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = (await response.json()) as CFApiResponse<unknown>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to delete zone" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

// ============================================================
// CF API: ZONE PHISHING CHECK
// ============================================================

/**
 * Проверить статус phishing для зоны
 * CF Trust & Safety блокирует зоны за phishing → meta.phishing_detected = true
 *
 * @param cfZoneId - CF Zone ID
 * @param token - CF API token
 * @returns { phishing_detected: boolean } или ошибку
 */
export async function checkZonePhishing(
  cfZoneId: string,
  token: string
): Promise<{ ok: true; phishing_detected: boolean } | { ok: false; error: string }> {
  const result = await cfGetZone(cfZoneId, token);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    phishing_detected: result.zone.meta?.phishing_detected ?? false
  };
}

// ============================================================
// INTERNAL: SYNC ZONES (for initkey.ts)
// ============================================================

/**
 * Синхронизация зон из CF → D1
 * Вызывается из initkey.ts после создания ключа
 * 
 * @param env - Environment
 * @param accountId - ID аккаунта 301.st
 * @param keyId - ID ключа в account_keys
 * @param cfAccountId - CF Account ID
 * @param token - Working token (уже расшифрован)
 */
export async function syncZonesInternal(
  env: Env,
  accountId: number,
  keyId: number,
  cfAccountId: string,
  token: string
): Promise<{
  ok: boolean;
  zones_synced: number;
  domains_synced: number;
  errors?: string[];
}> {
  const stats = {
    zones_found: 0,
    zones_created: 0,
    zones_updated: 0,
    domains_created: 0,
    domains_updated: 0,
    skipped_quota: 0,
    errors: [] as string[],
  };

  // Получаем квоты
  const quota = await getQuota(env, accountId);
  if (!quota) {
    return { ok: false, zones_synced: 0, domains_synced: 0, errors: ["quota_not_found"] };
  }

  // Запрашиваем список зон из CF
  const cfResult = await cfListZones(cfAccountId, token);
  if (!cfResult.ok) {
    return { ok: false, zones_synced: 0, domains_synced: 0, errors: [cfResult.error] };
  }

  stats.zones_found = cfResult.zones.length;

  for (const cfZone of cfResult.zones) {
    try {
      const nsExpected = cfZone.name_servers.join(",");
      const status = mapCFStatus(cfZone.status);
      const plan = mapCFPlan(cfZone.plan);
      const verified = status === "active" ? 1 : 0;

      // Проверяем существует ли зона в D1
      const existingZone = await env.DB301.prepare(
        `SELECT id FROM zones WHERE cf_zone_id = ? AND account_id = ?`
      )
        .bind(cfZone.id, accountId)
        .first<{ id: number }>();

      let zoneId: number;

      if (existingZone) {
        // UPDATE существующей зоны
        zoneId = existingZone.id;
        await env.DB301.prepare(
          `UPDATE zones 
           SET key_id = ?, status = ?, plan = ?, ns_expected = ?, verified = ?, 
               last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(keyId, status, plan, nsExpected, verified, zoneId)
          .run();
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
        )
          .bind(accountId, keyId, cfZone.id, status, plan, nsExpected, verified)
          .run();

        zoneId = insertResult.meta.last_row_id as number;
        stats.zones_created++;
      }

      // Проверяем phishing status
      const phishingDetected = cfZone.meta?.phishing_detected ?? false;

      // Обрабатываем root domain
      const existingDomain = await env.DB301.prepare(
        `SELECT id FROM domains WHERE domain_name = ? AND account_id = ?`
      )
        .bind(cfZone.name, accountId)
        .first<{ id: number }>();

      if (existingDomain) {
        // UPDATE существующего домена (включая phishing status)
        await env.DB301.prepare(
          `UPDATE domains
           SET zone_id = ?, key_id = ?, ns = ?, ns_verified = ?,
               blocked = ?, blocked_reason = CASE WHEN ? = 1 THEN 'phishing' ELSE blocked_reason END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(zoneId, keyId, nsExpected, verified, phishingDetected ? 1 : 0, phishingDetected ? 1 : 0, existingDomain.id)
          .run();
        stats.domains_updated++;
      } else {
        // Проверяем квоту доменов
        const currentDomains = quota.usage.domains_used + stats.domains_created;
        if (currentDomains >= quota.limits.max_domains) {
          // Зону создали, но домен не влезает в квоту — пропускаем домен
          continue;
        }

        // INSERT нового домена (root) с phishing status
        await env.DB301.prepare(
          `INSERT INTO domains (account_id, zone_id, key_id, domain_name, ns, ns_verified, role, blocked, blocked_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reserve', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        )
          .bind(
            accountId, zoneId, keyId, cfZone.name, nsExpected, verified,
            phishingDetected ? 1 : 0,
            phishingDetected ? "phishing" : null
          )
          .run();
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

  return {
    ok: stats.errors.length === 0,
    zones_synced: stats.zones_created + stats.zones_updated,
    domains_synced: stats.domains_created + stats.domains_updated,
    errors: stats.errors.length > 0 ? stats.errors : undefined,
  };
}


// ============================================================
// HANDLERS: LIS
// ============================================================

/**
 * GET /zones
 * Список зон аккаунта из D1
 * Возвращает external_account_id, key_alias и cf_account_name из account_keys
 */
export async function handleListZones(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  const zones = await env.DB301.prepare(
    `SELECT z.id, z.cf_zone_id, z.key_id, z.status, z.plan, z.ns_expected, z.verified, z.ssl_status, 
            z.ssl_mode, z.auto_https, z.caching_level, z.waf_mode, z.last_sync_at, 
            z.created_at, ak.key_alias, ak.external_account_id, ak.provider_scope,
            d.domain_name as root_domain
     FROM zones z
     LEFT JOIN account_keys ak ON z.key_id = ak.id
     LEFT JOIN domains d ON d.zone_id = z.id AND d.domain_name = (
       SELECT MIN(domain_name) FROM domains WHERE zone_id = z.id
     )
     WHERE z.account_id = ?
     ORDER BY z.created_at DESC`
  )
    .bind(accountId)
    .all();

  // Извлекаем cf_account_name из provider_scope
  const zonesWithAccountName = zones.results.map((zone: any) => {
    let cf_account_name = null;
    if (zone.provider_scope) {
      try {
        const scope = JSON.parse(zone.provider_scope);
        cf_account_name = scope.cf_account_name || null;
      } catch {
        // ignore parse errors
      }
    }
    // Удаляем provider_scope из ответа (содержит внутренние данные)
    const { provider_scope, ...rest } = zone;
    return { ...rest, cf_account_name };
  });

  return c.json({ ok: true, zones: zonesWithAccountName });
}

/**
 * GET /zones/:id
 * Детали зоны
 * 
 * Возвращает external_account_id, key_alias и cf_account_name из account_keys
 */
export async function handleGetZone(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  const zoneRow = await env.DB301.prepare(
    `SELECT z.*, ak.key_alias, ak.external_account_id, ak.provider_scope
     FROM zones z
     LEFT JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  )
    .bind(zoneId, accountId)
    .first<any>();

  if (!zoneRow) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Извлекаем cf_account_name из provider_scope
  let cf_account_name = null;
  if (zoneRow.provider_scope) {
    try {
      const scope = JSON.parse(zoneRow.provider_scope);
      cf_account_name = scope.cf_account_name || null;
    } catch {
      // ignore parse errors
    }
  }

  // Удаляем provider_scope из ответа
  const { provider_scope, ...zone } = zoneRow;
  const zoneWithAccountName = { ...zone, cf_account_name };

  // Получаем домены зоны
  const domains = await env.DB301.prepare(
    `SELECT id, domain_name, role, ns, ns_verified, proxied, blocked, blocked_reason, ssl_status
     FROM domains WHERE zone_id = ?`
  )
    .bind(zoneId)
    .all();

  return c.json({ ok: true, zone: zoneWithAccountName, domains: domains.results });
}
// ============================================================
// HANDLERS: CREATE
// ============================================================

/**
 * POST /zones
 * Создать зону в CF и D1
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

  const { domain, account_key_id } = body;

  if (!domain || !account_key_id) {
    return c.json({ ok: false, error: "missing_fields", fields: ["domain", "account_key_id"] }, 400);
  }

  // Проверяем квоту
  const quotaCheck = await canCreateZone(env, accountId);
  if (!quotaCheck.ok) {
    return c.json({ ok: false, error: quotaCheck.error }, 403);
  }

  // Получаем ключ CF
  const keyData = await getDecryptedKey(env, account_key_id);
  if (!keyData || keyData.record.account_id !== accountId) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  const token = keyData.secrets.token;
  const scope = keyData.scope as { cf_account_id?: string };
  const cfAccountId = keyData.record.external_account_id || scope.cf_account_id;

  if (!cfAccountId) {
    return c.json({ ok: false, error: "cf_account_id_missing" }, 400);
  }

  // Создаём зону в CF
  const cfResult = await cfCreateZone(cfAccountId, domain, token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_create_failed", message: cfResult.error }, 500);
  }

  const cfZone = cfResult.zone;
  const nsExpected = cfZone.name_servers.join(",");
  const status = mapCFStatus(cfZone.status);
  const plan = mapCFPlan(cfZone.plan);

  // Сохраняем зону в D1
  const insertResult = await env.DB301.prepare(
    `INSERT INTO zones (account_id, key_id, cf_zone_id, status, plan, ns_expected, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(accountId, account_key_id, cfZone.id, status, plan, nsExpected)
    .run();

  const zoneId = insertResult.meta.last_row_id as number;

  // Проверяем phishing status
  const phishingDetected = cfZone.meta?.phishing_detected ?? false;

  // Создаём root домен
  // Если зона заблокирована за phishing, сразу устанавливаем blocked
  await env.DB301.prepare(
    `INSERT INTO domains (account_id, zone_id, key_id, domain_name, ns, ns_verified, role, blocked, blocked_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'reserve', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(
      accountId,
      zoneId,
      account_key_id,
      domain,
      nsExpected,
      phishingDetected ? 1 : 0,
      phishingDetected ? "phishing" : null
    )
    .run();

  // Обновляем квоты
  await incrementZonesUsed(env, accountId);
  await incrementDomainsUsed(env, accountId);

  // Инвалидируем кэш
  await invalidateZonesCache(env, accountId);

  return c.json({
    ok: true,
    zone: {
      id: zoneId,
      cf_zone_id: cfZone.id,
      domain,
      status,
      plan,
      name_servers: cfZone.name_servers,
      phishing_detected: phishingDetected,
    },
  });
}

// ============================================================
// HANDLERS: DELETE
// ============================================================

/**
 * DELETE /zones/:id
 * Удалить зону из CF и D1
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
    `SELECT z.id, z.cf_zone_id, z.key_id
     FROM zones z
     WHERE z.id = ? AND z.account_id = ?`
  )
    .bind(zoneId, accountId)
    .first<{ id: number; cf_zone_id: string; key_id: number }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Получаем токен
  const keyData = await getDecryptedKey(env, zone.key_id);
  if (!keyData) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Удаляем зону в CF
  const cfResult = await cfDeleteZone(zone.cf_zone_id, keyData.secrets.token);
  if (!cfResult.ok) {
    // Логируем ошибку, но продолжаем удаление из D1
    console.error(`Failed to delete zone in CF: ${cfResult.error}`);
  }

  // Удаляем домены зоны
  await env.DB301.prepare(`DELETE FROM domains WHERE zone_id = ?`).bind(zoneId).run();

  // Удаляем зону
  await env.DB301.prepare(`DELETE FROM zones WHERE id = ?`).bind(zoneId).run();

  // Обновляем квоты
  await decrementZonesUsed(env, accountId);

  // Инвалидируем кэш
  await invalidateZonesCache(env, accountId);

  return c.json({ ok: true });
}

// ============================================================
// HANDLERS: SYNC
// ============================================================

/**
 * POST /zones/sync
 * Синхронизация зон из CF → D1
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
  const keyData = await getDecryptedKey(env, account_key_id);
  if (!keyData || keyData.record.account_id !== accountId) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  const token = keyData.secrets.token;
  const cfAccountId = keyData.record.external_account_id;

  if (!cfAccountId) {
    return c.json({ ok: false, error: "cf_account_id_missing" }, 400);
  }

  // Вызываем внутреннюю функцию синхронизации
  const result = await syncZonesInternal(env, accountId, account_key_id, cfAccountId, token);

  return c.json({
    ok: result.ok,
    zones_synced: result.zones_synced,
    domains_synced: result.domains_synced,
    errors: result.errors,
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
    `SELECT z.id, z.cf_zone_id, z.key_id
     FROM zones z
     WHERE z.id = ? AND z.account_id = ?`
  )
    .bind(zoneId, accountId)
    .first<{ id: number; cf_zone_id: string; key_id: number }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Получаем токен
  const keyData = await getDecryptedKey(env, zone.key_id);
  if (!keyData) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Запрашиваем детали зоны из CF
  const cfResult = await cfGetZone(zone.cf_zone_id, keyData.secrets.token);
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
  )
    .bind(status, plan, nsExpected, verified, zone.id)
    .run();

  // Обновляем ns_verified для доменов этой зоны
  const domainsResult = await env.DB301.prepare(
    `UPDATE domains
     SET ns_verified = CASE WHEN ns = ? THEN 1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP
     WHERE zone_id = ?`
  )
    .bind(nsExpected, zone.id)
    .run();

  // Проверяем phishing status и обновляем домены
  const phishingDetected = cfZone.meta?.phishing_detected ?? false;
  const phishingResult = await updateDomainsPhishingStatus(env, zone.id, phishingDetected);

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
      phishing_detected: phishingDetected,
      original_registrar: cfZone.original_registrar,
      activated_on: cfZone.activated_on,
    },
    domains_updated: domainsResult.meta.changes,
    domains_phishing_updated: phishingResult.updated,
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
    `SELECT z.id, z.cf_zone_id, z.ns_expected, z.key_id
     FROM zones z
     WHERE z.id = ? AND z.account_id = ?`
  )
    .bind(zoneId, accountId)
    .first<{ id: number; cf_zone_id: string; ns_expected: string; key_id: number }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Получаем токен
  const keyData = await getDecryptedKey(env, zone.key_id);
  if (!keyData) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Запрашиваем актуальный статус зоны из CF
  const cfResult = await cfGetZone(zone.cf_zone_id, keyData.secrets.token);
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
  )
    .bind(newStatus, verified, zone.id)
    .run();

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
    )
      .bind(zone.ns_expected, zone.id)
      .run();
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
    `SELECT z.id, z.cf_zone_id, z.ns_expected, z.key_id
     FROM zones z
     WHERE z.status = 'pending'
     LIMIT 50`
  ).all<{ id: number; cf_zone_id: string; ns_expected: string; key_id: number }>();

  for (const zone of pendingZones.results) {
    stats.checked++;

    try {
      const keyData = await getDecryptedKey(env, zone.key_id);
      if (!keyData) {
        stats.errors++;
        continue;
      }

      const cfResult = await cfGetZone(zone.cf_zone_id, keyData.secrets.token);
      if (!cfResult.ok) {
        stats.errors++;
        continue;
      }

      if (cfResult.zone.status === "active") {
        // Обновляем статус зоны
        await env.DB301.prepare(
          `UPDATE zones SET status = 'active', verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        )
          .bind(zone.id)
          .run();

        // Пересчитываем ns_verified для доменов этой зоны
        const updateResult = await env.DB301.prepare(
          `UPDATE domains 
           SET ns_verified = CASE 
             WHEN ns = ? THEN 1 
             ELSE 0 
           END,
           updated_at = CURRENT_TIMESTAMP
           WHERE zone_id = ?`
        )
          .bind(zone.ns_expected, zone.id)
          .run();

        stats.activated++;
        stats.domains_updated += updateResult.meta.changes;
      }
    } catch {
      stats.errors++;
    }
  }

  return stats;
}
