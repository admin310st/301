// src/api/integrations/providers/cloudflare/zoneconf.ts

/**
 * Cloudflare Zone Configuration
 * 
 * Управление настройками зоны:
 * - DNS записи
 * - SSL/TLS
 * - Cache
 * - WAF/Security
 */

import { Context } from "hono";
import { Env } from "../../../types/worker";
import { requireAuth, requireEditor } from "../../../lib/auth";
import { decrypt } from "../../../lib/crypto";

// ============================================================
// TYPES
// ============================================================

interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface CFDNSRecord {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
  created_on: string;
  modified_on: string;
}

interface BatchDNSRequest {
  create?: Array<{
    type: string;
    name: string;
    content: string;
    ttl?: number;
    proxied?: boolean;
  }>;
  update?: Array<{
    id: string;
    type?: string;
    name?: string;
    content?: string;
    ttl?: number;
    proxied?: boolean;
  }>;
  delete?: string[];
}

// SSL Types
type SSLMode = "off" | "flexible" | "full" | "strict";

interface SSLSettings {
  mode: SSLMode;
  certificate_status: string;
  validation_errors?: string[];
}

// Cache Types
type CacheLevel = "off" | "basic" | "simplified" | "standard" | "aggressive";

interface CacheSettings {
  level: CacheLevel;
  browser_ttl: number;
  development_mode: boolean;
}

// WAF/Security Types
type SecurityLevel = "off" | "essentially_off" | "low" | "medium" | "high" | "under_attack";

interface SecuritySettings {
  security_level: SecurityLevel;
  waf_enabled: boolean;
  browser_check: boolean;
}

// Zone Settings Update Request
interface UpdateZoneSettingsRequest {
  ssl_mode?: SSLMode;
  cache_level?: CacheLevel;
  browser_ttl?: number;
  development_mode?: boolean;
  security_level?: SecurityLevel;
  waf_enabled?: boolean;
  browser_check?: boolean;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const CACHE_TTL_DEFAULT = 15 * 60; // 15 минут

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

/**
 * Получить TTL кэша из настроек
 */
async function getCacheTTL(env: Env): Promise<number> {
  const settings = await env.KV_CREDENTIALS.get("settings:cron");
  if (settings) {
    const parsed = JSON.parse(settings);
    return (parsed.cache_ttl || 15) * 60;
  }
  return CACHE_TTL_DEFAULT;
}

/**
 * Получить DNS записи из кэша
 */
async function getCachedDNS(
  env: Env,
  cfZoneId: string
): Promise<CFDNSRecord[] | null> {
  const cached = await env.KV_CREDENTIALS.get(`cache:dns:${cfZoneId}`);
  return cached ? JSON.parse(cached) : null;
}

/**
 * Сохранить DNS записи в кэш
 */
async function setCachedDNS(
  env: Env,
  cfZoneId: string,
  records: CFDNSRecord[]
): Promise<void> {
  const ttl = await getCacheTTL(env);
  await env.KV_CREDENTIALS.put(
    `cache:dns:${cfZoneId}`,
    JSON.stringify(records),
    { expirationTtl: ttl }
  );
}

/**
 * Инвалидировать кэш DNS
 */
async function invalidateDNSCache(env: Env, cfZoneId: string): Promise<void> {
  await env.KV_CREDENTIALS.delete(`cache:dns:${cfZoneId}`);
}

// ============================================================
// CF API: DNS
// ============================================================

/**
 * GET /zones/{zone_id}/dns_records — список DNS записей
 */
async function cfListDNS(
  cfZoneId: string,
  token: string
): Promise<{ ok: true; records: CFDNSRecord[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/dns_records?per_page=100`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<CFDNSRecord[]>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to list DNS records" };
    }

    return { ok: true, records: data.result };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * POST /zones/{zone_id}/dns_records — создать DNS запись
 */
async function cfCreateDNS(
  cfZoneId: string,
  record: { type: string; name: string; content: string; ttl?: number; proxied?: boolean },
  token: string
): Promise<{ ok: true; record: CFDNSRecord } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/dns_records`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl || 1, // 1 = auto
          proxied: record.proxied ?? true,
        }),
      }
    );

    const data = await response.json() as CFApiResponse<CFDNSRecord>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to create DNS record" };
    }

    return { ok: true, record: data.result };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * PATCH /zones/{zone_id}/dns_records/{record_id} — обновить DNS запись
 */
async function cfUpdateDNS(
  cfZoneId: string,
  recordId: string,
  record: { type?: string; name?: string; content?: string; ttl?: number; proxied?: boolean },
  token: string
): Promise<{ ok: true; record: CFDNSRecord } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/dns_records/${recordId}`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(record),
      }
    );

    const data = await response.json() as CFApiResponse<CFDNSRecord>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to update DNS record" };
    }

    return { ok: true, record: data.result };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * DELETE /zones/{zone_id}/dns_records/{record_id} — удалить DNS запись
 */
async function cfDeleteDNS(
  cfZoneId: string,
  recordId: string,
  token: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/dns_records/${recordId}`,
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
      return { ok: false, error: data.errors?.[0]?.message || "Failed to delete DNS record" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

// ============================================================
// HANDLERS
// ============================================================

/**
 * GET /zones/:id/dns
 * Список DNS записей зоны
 */
export async function handleListDNS(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Получаем зону
  const zone = await env.DB301.prepare(
    `SELECT z.cf_zone_id, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ cf_zone_id: string; kv_key: string }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Проверяем кэш
  const cached = await getCachedDNS(env, zone.cf_zone_id);
  if (cached) {
    return c.json({ ok: true, records: cached, cached: true });
  }

  // Получаем токен
  const token = await getDecryptedToken(env, zone.kv_key);
  if (!token) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Запрашиваем CF
  const cfResult = await cfListDNS(zone.cf_zone_id, token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_list_failed", message: cfResult.error }, 500);
  }

  // Кэшируем
  await setCachedDNS(env, zone.cf_zone_id, cfResult.records);

  return c.json({ ok: true, records: cfResult.records, cached: false });
}

/**
 * POST /zones/:id/dns/batch
 * Пакетные операции с DNS
 */
export async function handleBatchDNS(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Parse request
  let body: BatchDNSRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { create = [], update = [], delete: deleteIds = [] } = body;

  // Проверка лимитов (CF batch limit = 100)
  const totalOps = create.length + update.length + deleteIds.length;
  if (totalOps > 100) {
    return c.json({ ok: false, error: "batch_limit_exceeded", max: 100 }, 400);
  }

  // Получаем зону
  const zone = await env.DB301.prepare(
    `SELECT z.cf_zone_id, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ cf_zone_id: string; kv_key: string }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Получаем токен
  const token = await getDecryptedToken(env, zone.kv_key);
  if (!token) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  const results = {
    created: [] as CFDNSRecord[],
    updated: [] as CFDNSRecord[],
    deleted: [] as string[],
    errors: [] as Array<{ operation: string; id?: string; error: string }>,
  };

  // CREATE
  for (const record of create) {
    const result = await cfCreateDNS(zone.cf_zone_id, record, token);
    if (result.ok) {
      results.created.push(result.record);
    } else {
      results.errors.push({ operation: "create", error: result.error });
    }
  }

  // UPDATE
  for (const record of update) {
    const { id, ...data } = record;
    const result = await cfUpdateDNS(zone.cf_zone_id, id, data, token);
    if (result.ok) {
      results.updated.push(result.record);
    } else {
      results.errors.push({ operation: "update", id, error: result.error });
    }
  }

  // DELETE
  for (const recordId of deleteIds) {
    const result = await cfDeleteDNS(zone.cf_zone_id, recordId, token);
    if (result.ok) {
      results.deleted.push(recordId);
    } else {
      results.errors.push({ operation: "delete", id: recordId, error: result.error });
    }
  }

  // Инвалидируем кэш DNS
  await invalidateDNSCache(env, zone.cf_zone_id);

  return c.json({
    ok: results.errors.length === 0,
    results,
  });
}

// ============================================================
// CF API: ZONE SETTINGS
// ============================================================

/**
 * GET /zones/{zone_id}/settings — получить все настройки зоны
 */
async function cfGetZoneSettings(
  cfZoneId: string,
  token: string
): Promise<{ ok: true; settings: Array<{ id: string; value: unknown }> } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/settings`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json() as CFApiResponse<Array<{ id: string; value: unknown }>>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to get zone settings" };
    }

    return { ok: true, settings: data.result };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * PATCH /zones/{zone_id}/settings/{setting_id} — обновить настройку
 */
async function cfUpdateZoneSetting(
  cfZoneId: string,
  settingId: string,
  value: unknown,
  token: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/settings/${settingId}`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value }),
      }
    );

    const data = await response.json() as CFApiResponse<unknown>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to update setting" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

/**
 * POST /zones/{zone_id}/purge_cache — очистить кэш
 */
async function cfPurgeCache(
  cfZoneId: string,
  token: string,
  options?: { purge_everything?: boolean; files?: string[] }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const body = options?.files 
      ? { files: options.files }
      : { purge_everything: true };

    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json() as CFApiResponse<unknown>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to purge cache" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "CF API request failed" };
  }
}

// ============================================================
// HELPERS: ZONE ACCESS
// ============================================================

/**
 * Получить зону с токеном для операций
 */
async function getZoneWithToken(
  env: Env,
  zoneId: number,
  accountId: number
): Promise<{ ok: true; cfZoneId: string; token: string } | { ok: false; error: string; status: number }> {
  const zone = await env.DB301.prepare(
    `SELECT z.cf_zone_id, ak.kv_key
     FROM zones z
     JOIN account_keys ak ON z.key_id = ak.id
     WHERE z.id = ? AND z.account_id = ?`
  ).bind(zoneId, accountId).first<{ cf_zone_id: string; kv_key: string }>();

  if (!zone) {
    return { ok: false, error: "zone_not_found", status: 404 };
  }

  const token = await getDecryptedToken(env, zone.kv_key);
  if (!token) {
    return { ok: false, error: "key_invalid", status: 500 };
  }

  return { ok: true, cfZoneId: zone.cf_zone_id, token };
}

// ============================================================
// HANDLERS: ZONE SETTINGS
// ============================================================

/**
 * GET /zones/:id/settings
 * Получить все настройки зоны
 */
export async function handleGetZoneSettings(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const zoneData = await getZoneWithToken(env, zoneId, auth.account_id);
  if (!zoneData.ok) {
    return c.json({ ok: false, error: zoneData.error }, zoneData.status);
  }

  const cfResult = await cfGetZoneSettings(zoneData.cfZoneId, zoneData.token);
  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_get_failed", message: cfResult.error }, 500);
  }

  // Преобразуем в удобный формат
  const settingsMap: Record<string, unknown> = {};
  for (const s of cfResult.settings) {
    settingsMap[s.id] = s.value;
  }

  return c.json({
    ok: true,
    settings: {
      ssl_mode: settingsMap["ssl"],
      cache_level: settingsMap["cache_level"],
      browser_ttl: settingsMap["browser_cache_ttl"],
      development_mode: settingsMap["development_mode"] === "on",
      security_level: settingsMap["security_level"],
      waf_enabled: settingsMap["waf"] === "on",
      browser_check: settingsMap["browser_check"] === "on",
      always_use_https: settingsMap["always_use_https"] === "on",
      min_tls_version: settingsMap["min_tls_version"],
    },
  });
}

/**
 * PATCH /zones/:id/settings
 * Обновить настройки зоны (batch)
 */
export async function handleUpdateZoneSettings(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  let body: UpdateZoneSettingsRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const zoneData = await getZoneWithToken(env, zoneId, auth.account_id);
  if (!zoneData.ok) {
    return c.json({ ok: false, error: zoneData.error }, zoneData.status);
  }

  const results = {
    updated: [] as string[],
    errors: [] as Array<{ setting: string; error: string }>,
  };

  // Маппинг наших полей на CF settings
  const settingsToUpdate: Array<{ id: string; value: unknown }> = [];

  if (body.ssl_mode !== undefined) {
    settingsToUpdate.push({ id: "ssl", value: body.ssl_mode });
  }
  if (body.cache_level !== undefined) {
    settingsToUpdate.push({ id: "cache_level", value: body.cache_level });
  }
  if (body.browser_ttl !== undefined) {
    settingsToUpdate.push({ id: "browser_cache_ttl", value: body.browser_ttl });
  }
  if (body.development_mode !== undefined) {
    settingsToUpdate.push({ id: "development_mode", value: body.development_mode ? "on" : "off" });
  }
  if (body.security_level !== undefined) {
    settingsToUpdate.push({ id: "security_level", value: body.security_level });
  }
  if (body.waf_enabled !== undefined) {
    settingsToUpdate.push({ id: "waf", value: body.waf_enabled ? "on" : "off" });
  }
  if (body.browser_check !== undefined) {
    settingsToUpdate.push({ id: "browser_check", value: body.browser_check ? "on" : "off" });
  }

  // Обновляем каждую настройку
  for (const setting of settingsToUpdate) {
    const result = await cfUpdateZoneSetting(zoneData.cfZoneId, setting.id, setting.value, zoneData.token);
    if (result.ok) {
      results.updated.push(setting.id);
    } else {
      results.errors.push({ setting: setting.id, error: result.error });
    }
  }

  // Обновляем D1 (локальное состояние)
  if (body.ssl_mode !== undefined) {
    await env.DB301.prepare(
      `UPDATE zones SET ssl_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(body.ssl_mode, zoneId).run();
  }
  if (body.cache_level !== undefined) {
    await env.DB301.prepare(
      `UPDATE zones SET caching_level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(body.cache_level, zoneId).run();
  }
  if (body.security_level !== undefined || body.waf_enabled !== undefined) {
    const wafMode = body.waf_enabled === false ? "off" : (body.security_level || "medium");
    await env.DB301.prepare(
      `UPDATE zones SET waf_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(wafMode, zoneId).run();
  }

  return c.json({
    ok: results.errors.length === 0,
    results,
  });
}

/**
 * POST /zones/:id/purge-cache
 * Очистить кэш зоны
 */
export async function handlePurgeCache(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  let body: { files?: string[] } = {};
  try {
    body = await c.req.json();
  } catch {
    // Если body нет — purge all
  }

  const zoneData = await getZoneWithToken(env, zoneId, auth.account_id);
  if (!zoneData.ok) {
    return c.json({ ok: false, error: zoneData.error }, zoneData.status);
  }

  const cfResult = await cfPurgeCache(zoneData.cfZoneId, zoneData.token, {
    purge_everything: !body.files,
    files: body.files,
  });

  if (!cfResult.ok) {
    return c.json({ ok: false, error: "cf_purge_failed", message: cfResult.error }, 500);
  }

  return c.json({
    ok: true,
    purged: body.files ? body.files.length : "all",
  });
}
