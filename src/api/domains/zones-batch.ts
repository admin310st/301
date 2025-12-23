// src/api/domains/zones-batch.ts

/**
 * Batch Zone Creation
 *
 * Этап 1: Создание зон в CF → получение NS
 * - UI присылает список root доменов
 * - Создаём зоны в CF последовательно
 * - Анализируем ответы CF (success / error codes)
 * - Записываем успешные в D1 (zones + domains)
 * - Возвращаем NS для успешных, ошибки для неуспешных
 *
 * Пользователь сам настраивает NS у регистратора (может занять неделю+).
 * Проверка NS — отдельный этап (cron или /zones/:id/check-activation).
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireOwner } from "../lib/auth";
import { getDecryptedKey } from "../integrations/keys/storage";

// ============================================================
// TYPES
// ============================================================

interface BatchCreateRequest {
  account_key_id: number;
  domains: string[];
}

interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface CFZone {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
  plan: { id: string };
}

interface CFDNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

interface SuccessResult {
  domain: string;
  zone_id: number;
  cf_zone_id: string;
  name_servers: string[];
  status: "pending";
}

interface FailedResult {
  domain: string;
  error: string;
  error_message: string;
}

interface BatchCreateResponse {
  ok: boolean;
  results: {
    success: SuccessResult[];
    failed: FailedResult[];
  };
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_DOMAINS_PER_BATCH = 10;

/**
 * Маппинг ошибок CF → наши коды
 */
const CF_ERROR_MAP: Record<number, { code: string; message: string }> = {
  1097: {
    code: "zone_already_in_cf",
    message: "Зона уже существует в этом Cloudflare аккаунте",
  },
  1049: {
    code: "zone_banned",
    message: "Домен заблокирован Cloudflare (blacklist)",
  },
  1061: {
    code: "not_registrable",
    message: "Это поддомен, не регистрируемый домен. Сначала добавьте root domain",
  },
  1099: {
    code: "zone_held",
    message: "Домен заблокирован (held) в Cloudflare",
  },
  1105: {
    code: "zone_in_another_account",
    message: "Домен уже добавлен в другой Cloudflare аккаунт",
  },
  1224: {
    code: "zone_already_pending",
    message: "Домен уже ожидает активации в этом аккаунте",
  },
};

// ============================================================
// CF API HELPERS
// ============================================================

/**
 * POST /zones — создать зону в CF
 */
async function cfCreateZone(
  cfAccountId: string,
  domain: string,
  token: string
): Promise<
  | { ok: true; zone: CFZone }
  | { ok: false; code: number; message: string }
> {
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
      const err = data.errors?.[0];
      return {
        ok: false,
        code: err?.code || 0,
        message: err?.message || "Unknown CF error",
      };
    }

    return { ok: true, zone: data.result };
  } catch (e) {
    return { ok: false, code: 0, message: `CF API request failed: ${String(e)}` };
  }
}

/**
 * POST /zones/{zone_id}/dns_records — создать DNS запись
 */
async function cfCreateDNS(
  cfZoneId: string,
  record: { type: string; name: string; content: string; proxied?: boolean; ttl?: number },
  token: string
): Promise<{ ok: true; record: CFDNSRecord } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/dns_records`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: record.type,
          name: record.name,
          content: record.content,
          proxied: record.proxied ?? true,
          ttl: record.ttl ?? 1, // auto
        }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFDNSRecord>;

    if (!response.ok || !data.success) {
      return {
        ok: false,
        error: data.errors?.[0]?.message || "Failed to create DNS record",
      };
    }

    return { ok: true, record: data.result };
  } catch {
    return { ok: false, error: "CF DNS API request failed" };
  }
}

// ============================================================
// D1 HELPERS
// ============================================================

/**
 * Маппинг CF plan → наш план
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

/**
 * Проверка квоты зон
 */
async function checkZoneQuota(
  env: Env,
  accountId: number,
  count: number
): Promise<{ ok: true; remaining: number } | { ok: false; error: string }> {
  const quota = await env.DB301.prepare(
    `SELECT 
       ql.max_zones,
       COALESCE(qu.zones_used, 0) as zones_used
     FROM accounts a
     JOIN quota_limits ql ON a.plan_tier = ql.plan_tier
     LEFT JOIN quota_usage qu ON a.id = qu.account_id
     WHERE a.id = ?`
  )
    .bind(accountId)
    .first<{ max_zones: number; zones_used: number }>();

  if (!quota) {
    return { ok: false, error: "quota_not_found" };
  }

  const remaining = quota.max_zones - quota.zones_used;

  if (remaining < count) {
    return {
      ok: false,
      error: `quota_exceeded:zones:need=${count}:available=${remaining}`,
    };
  }

  return { ok: true, remaining };
}

/**
 * Инкремент использованных зон
 */
async function incrementZonesUsed(
  env: Env,
  accountId: number,
  count: number = 1
): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage 
     SET zones_used = zones_used + ?, updated_at = CURRENT_TIMESTAMP 
     WHERE account_id = ?`
  )
    .bind(count, accountId)
    .run();
}

/**
 * Инкремент использованных доменов
 */
async function incrementDomainsUsed(
  env: Env,
  accountId: number,
  count: number = 1
): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage 
     SET domains_used = domains_used + ?, updated_at = CURRENT_TIMESTAMP 
     WHERE account_id = ?`
  )
    .bind(count, accountId)
    .run();
}

/**
 * Инвалидация кэша зон
 */
async function invalidateZonesCache(env: Env, accountId: number): Promise<void> {
  await env.KV_CREDENTIALS.delete(`cache:zones:${accountId}`).catch(() => {});
}

// ============================================================
// ERROR MAPPING
// ============================================================

/**
 * Преобразовать ошибку CF в наш формат
 */
function mapCFError(code: number, rawMessage: string): { code: string; message: string } {
  const mapped = CF_ERROR_MAP[code];
  if (mapped) {
    return mapped;
  }
  return {
    code: `cf_error_${code}`,
    message: rawMessage,
  };
}

// ============================================================
// HANDLER
// ============================================================

/**
 * POST /domains/zones/batch
 *
 * Batch создание зон в CF.
 * Только root домены — поддомены создаются отдельно после проверки NS.
 */
export async function handleBatchCreateZones(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // 1. Auth — только owner
  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // 2. Parse request
  let body: BatchCreateRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { account_key_id, domains } = body;

  // 3. Validate input
  if (!account_key_id) {
    return c.json({ ok: false, error: "missing_field", field: "account_key_id" }, 400);
  }

  if (!domains || !Array.isArray(domains) || domains.length === 0) {
    return c.json({ ok: false, error: "missing_field", field: "domains" }, 400);
  }

  // Dedupe и trim
  const uniqueDomains = [...new Set(domains.map((d) => d.trim().toLowerCase()))];

  if (uniqueDomains.length === 0) {
    return c.json({ ok: false, error: "empty_domains_list" }, 400);
  }

  // Лимит на количество доменов в одном запросе
  if (uniqueDomains.length > MAX_DOMAINS_PER_BATCH) {
    return c.json({
      ok: false,
      error: "too_many_domains",
      max: MAX_DOMAINS_PER_BATCH,
      received: uniqueDomains.length,
    }, 400);
  }

  // 4. Получаем ключ CF
  const keyData = await getDecryptedKey(env, account_key_id);
  if (!keyData || keyData.record.account_id !== accountId) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  if (keyData.record.provider !== "cloudflare") {
    return c.json({ ok: false, error: "key_not_cloudflare" }, 400);
  }

  const token = keyData.secrets.token;
  const cfAccountId =
    keyData.record.external_account_id ||
    (keyData.scope as { cf_account_id?: string }).cf_account_id;

  if (!cfAccountId) {
    return c.json({ ok: false, error: "cf_account_id_missing" }, 400);
  }

  // 5. Проверяем квоту
  const quotaCheck = await checkZoneQuota(env, accountId, uniqueDomains.length);
  if (!quotaCheck.ok) {
    return c.json({ ok: false, error: quotaCheck.error }, 403);
  }

  // 6. Обрабатываем домены последовательно
  const results: BatchCreateResponse["results"] = {
    success: [],
    failed: [],
  };

  let zonesCreated = 0;
  let domainsCreated = 0;

  for (const domain of uniqueDomains) {
    // 6.1 Создаём зону в CF
    const cfResult = await cfCreateZone(cfAccountId, domain, token);

    if (!cfResult.ok) {
      // Ошибка CF
      const mapped = mapCFError(cfResult.code, cfResult.message);
      results.failed.push({
        domain,
        error: mapped.code,
        error_message: mapped.message,
      });
      continue;
    }

    const cfZone = cfResult.zone;
    const nsExpected = cfZone.name_servers.join(",");
    const plan = mapCFPlan(cfZone.plan);

    // 6.2 Создаём A запись 1.1.1.1 (placeholder)
    const dnsResult = await cfCreateDNS(
      cfZone.id,
      {
        type: "A",
        name: "@",
        content: "1.1.1.1",
        proxied: true,
      },
      token
    );

    if (!dnsResult.ok) {
      // DNS не создался, но зона есть — логируем, продолжаем
      console.warn(`DNS A record failed for ${domain}: ${dnsResult.error}`);
    }

    // 6.3 Записываем зону в D1
    let zoneId: number;
    try {
      const insertResult = await env.DB301.prepare(
        `INSERT INTO zones (
          account_id, key_id, cf_zone_id, status, plan, ns_expected, verified,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
        .bind(accountId, account_key_id, cfZone.id, plan, nsExpected)
        .run();

      zoneId = insertResult.meta.last_row_id as number;
      zonesCreated++;
    } catch (e) {
      // D1 ошибка — зона в CF создана, но в D1 не записана
      // Это проблема — логируем и добавляем в failed
      console.error(`D1 zone insert failed for ${domain}:`, e);
      results.failed.push({
        domain,
        error: "db_write_failed",
        error_message: "Зона создана в CF, но не записана в БД. Обратитесь в поддержку.",
      });
      continue;
    }

    // 6.4 Записываем root domain в D1
    try {
      await env.DB301.prepare(
        `INSERT INTO domains (
          account_id, zone_id, key_id, domain_name, ns, ns_verified, role,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 'reserve', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
        .bind(accountId, zoneId, account_key_id, domain, nsExpected)
        .run();

      domainsCreated++;
    } catch (e) {
      // Domain insert failed — зона есть, домена нет
      console.error(`D1 domain insert failed for ${domain}:`, e);
      // Не критично, зона создана — добавляем в success но логируем
    }

    // 6.5 Success
    results.success.push({
      domain,
      zone_id: zoneId,
      cf_zone_id: cfZone.id,
      name_servers: cfZone.name_servers,
      status: "pending",
    });
  }

  // 7. Обновляем quota_usage
  if (zonesCreated > 0) {
    await incrementZonesUsed(env, accountId, zonesCreated);
  }
  if (domainsCreated > 0) {
    await incrementDomainsUsed(env, accountId, domainsCreated);
  }

  // 8. Инвалидируем кэш
  await invalidateZonesCache(env, accountId);

  // 9. Response
  return c.json({
    ok: results.success.length > 0,
    results,
  } satisfies BatchCreateResponse);
}
