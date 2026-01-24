// src/api/domains/domains.ts

/**
 * Domains API
 *
 * CRUD операции с доменами
 * Группировка по root domain (2-го уровня)
 * 
 * Этап 3: Добавление поддоменов (после проверки NS)
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireAuth, requireEditor } from "../lib/auth";
import { getDecryptedKey } from "../integrations/keys/storage";
import { computeDomainHealthStatus } from "./health";
import { syncDomainToClient, deleteDomainFromClient } from "../integrations/providers/cloudflare/d1-sync";

// ============================================================
// TYPES
// ============================================================

interface DomainRecord {
  id: number;
  account_id: number;
  site_id: number | null;
  zone_id: number | null;
  key_id: number | null;
  parent_id: number | null;
  domain_name: string;
  role: "acceptor" | "donor" | "reserve";
  ns: string | null;
  ns_verified: number;
  proxied: number;
  blocked: number;
  blocked_reason: string | null;
  ssl_status: string;
  expired_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined from sites/projects
  site_name: string | null;
  site_status: string | null;
  project_id: number | null;
  project_name: string | null;
  // Health data (joined from domain_threats + redirect_rules)
  threat_score: number | null;
  threat_categories: string | null;
  threat_checked_at: string | null;
  clicks_yesterday: number | null;
  clicks_today: number | null;
}

interface DomainGroup {
  root: string;
  zone_id: number | null;
  domains: Omit<DomainRecord, "account_id">[];
}

interface CreateDomainRequest {
  domain_name: string;
  zone_id?: number;
  parent_id?: number;
  role?: "acceptor" | "donor" | "reserve";
}

interface BatchCreateDomainsRequest {
  zone_id: number;
  domains: Array<{
    name: string;  // короткое имя: www, api, blog
    role?: "acceptor" | "donor" | "reserve";
  }>;
}

interface UpdateDomainRequest {
  role?: "acceptor" | "donor" | "reserve";
  site_id?: number | null;
  blocked?: boolean;
  blocked_reason?: "unavailable" | "ad_network" | "hosting_registrar" | "government" | "manual" | null;
}

interface ZoneData {
  key_id: number;
  ns_expected: string;
  verified: number;
  cf_zone_id: string;
  root_domain: string;
}

interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface CFDNSRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_DOMAINS_PER_BATCH = 10;

// ============================================================
// CF API HELPERS
// ============================================================

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
 * Извлечь root domain (2-го уровня) из полного имени
 * aaa.bbb.example.com → example.com
 * example.com → example.com
 */
function getRootDomain(domainName: string): string {
  const parts = domainName.split(".");
  if (parts.length <= 2) {
    return domainName;
  }
  return parts.slice(-2).join(".");
}

/**
 * Группировка доменов по root domain
 * Сортировка: сначала root, потом поддомены по алфавиту
 */
function groupByRoot(domains: DomainRecord[]): DomainGroup[] {
  const groups = new Map<string, { zone_id: number | null; domains: DomainRecord[] }>();

  // Группируем по root
  for (const domain of domains) {
    const root = getRootDomain(domain.domain_name);
    if (!groups.has(root)) {
      groups.set(root, { zone_id: null, domains: [] });
    }
    const group = groups.get(root)!;
    group.domains.push(domain);

    // zone_id берём от root домена
    if (domain.domain_name === root && domain.zone_id) {
      group.zone_id = domain.zone_id;
    }
  }

  // Сортируем группы по root
  const sortedRoots = Array.from(groups.keys()).sort();

  const result: DomainGroup[] = [];

  for (const root of sortedRoots) {
    const group = groups.get(root)!;

    // Сортируем домены внутри группы: root первый, потом по алфавиту
    group.domains.sort((a, b) => {
      if (a.domain_name === root) return -1;
      if (b.domain_name === root) return 1;
      return a.domain_name.localeCompare(b.domain_name);
    });

    // Убираем account_id из ответа
    const domainsWithoutAccountId = group.domains.map(({ account_id, ...rest }) => rest);

    result.push({
      root,
      zone_id: group.zone_id,
      domains: domainsWithoutAccountId,
    });
  }

  return result;
}

/**
 * Группировка доменов по root domain с добавлением health статуса
 * Используется в GET /domains для UI светофора
 */
function groupByRootWithHealth(domains: DomainRecord[]): DomainGroup[] {
  const groups = new Map<string, { zone_id: number | null; domains: DomainRecord[] }>();

  // Группируем по root
  for (const domain of domains) {
    const root = getRootDomain(domain.domain_name);
    if (!groups.has(root)) {
      groups.set(root, { zone_id: null, domains: [] });
    }
    const group = groups.get(root)!;
    group.domains.push(domain);

    // zone_id берём от root домена
    if (domain.domain_name === root && domain.zone_id) {
      group.zone_id = domain.zone_id;
    }
  }

  // Сортируем группы по root
  const sortedRoots = Array.from(groups.keys()).sort();

  const result: DomainGroup[] = [];

  for (const root of sortedRoots) {
    const group = groups.get(root)!;

    // Сортируем домены внутри группы: root первый, потом по алфавиту
    group.domains.sort((a, b) => {
      if (a.domain_name === root) return -1;
      if (b.domain_name === root) return 1;
      return a.domain_name.localeCompare(b.domain_name);
    });

    // Формируем ответ с health статусом
    const domainsWithHealth = group.domains.map((domain) => {
      const {
        account_id,
        threat_score,
        threat_categories,
        threat_checked_at,
        clicks_yesterday,
        clicks_today,
        ...rest
      } = domain;

      // Вычисляем health статус
      const healthStatus = computeDomainHealthStatus({
        blocked: domain.blocked,
        blocked_reason: domain.blocked_reason,
        threat_score: domain.threat_score,
        clicks_yesterday: clicks_yesterday ?? undefined,
        clicks_today: clicks_today ?? undefined,
      });

      // Парсим categories
      let categories: string[] | null = null;
      if (threat_categories) {
        try {
          categories = JSON.parse(threat_categories);
        } catch {
          categories = null;
        }
      }

      return {
        ...rest,
        health: {
          status: healthStatus,
          threat_score: threat_score,
          categories: categories,
          checked_at: threat_checked_at,
        },
      };
    });

    result.push({
      root,
      zone_id: group.zone_id,
      domains: domainsWithHealth as unknown as Omit<DomainRecord, "account_id">[],
    });
  }

  return result;
}

/**
 * Проверка квоты доменов
 */
async function checkDomainQuota(
  env: Env,
  accountId: number,
  count: number
): Promise<{ ok: true; remaining: number } | { ok: false; error: string; limit: number; used: number }> {
  const quota = await env.DB301.prepare(
    `SELECT 
       ql.max_domains,
       COALESCE(qu.domains_used, 0) as domains_used
     FROM accounts a
     JOIN quota_limits ql ON a.plan_tier = ql.plan_tier
     LEFT JOIN quota_usage qu ON a.id = qu.account_id
     WHERE a.id = ?`
  )
    .bind(accountId)
    .first<{ max_domains: number; domains_used: number }>();

  if (!quota) {
    return { ok: false, error: "quota_not_found", limit: 0, used: 0 };
  }

  const remaining = quota.max_domains - quota.domains_used;

  if (remaining < count) {
    return {
      ok: false,
      error: "quota_exceeded",
      limit: quota.max_domains,
      used: quota.domains_used,
    };
  }

  return { ok: true, remaining };
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
 * Получить данные зоны с проверкой владения и verified
 */
async function getVerifiedZone(
  env: Env,
  zoneId: number,
  accountId: number
): Promise<{ ok: true; zone: ZoneData } | { ok: false; error: string }> {
  const zone = await env.DB301.prepare(
    `SELECT z.key_id, z.ns_expected, z.verified, z.cf_zone_id,
            (SELECT domain_name FROM domains WHERE zone_id = z.id AND parent_id IS NULL LIMIT 1) as root_domain
     FROM zones z
     WHERE z.id = ? AND z.account_id = ?`
  )
    .bind(zoneId, accountId)
    .first<ZoneData>();

  if (!zone) {
    return { ok: false, error: "zone_not_found" };
  }

  if (!zone.verified) {
    return { ok: false, error: "zone_not_verified" };
  }

  if (!zone.cf_zone_id) {
    return { ok: false, error: "zone_cf_id_missing" };
  }

  return { ok: true, zone };
}

// ============================================================
// HANDLERS: LIST & GET
// ============================================================

/**
 * GET /domains
 * Список всех доменов аккаунта с группировкой по root
 */
export async function handleListDomains(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Query params
  const role = c.req.query("role");
  const blocked = c.req.query("blocked");
  const zoneId = c.req.query("zone_id");
  const siteId = c.req.query("site_id");
  const projectId = c.req.query("project_id");

  // Собираем WHERE условия
  const conditions: string[] = ["d.account_id = ?"];
  const bindings: (string | number)[] = [accountId];

  if (role) {
    conditions.push("d.role = ?");
    bindings.push(role);
  }

  if (blocked !== undefined && blocked !== null) {
    conditions.push("d.blocked = ?");
    bindings.push(blocked === "true" || blocked === "1" ? 1 : 0);
  }

  if (zoneId) {
    conditions.push("d.zone_id = ?");
    bindings.push(parseInt(zoneId));
  }

  if (siteId) {
    conditions.push("d.site_id = ?");
    bindings.push(parseInt(siteId));
  }

  if (projectId) {
    conditions.push("d.project_id = ?");
    bindings.push(parseInt(projectId));
  }

  const whereClause = conditions.join(" AND ");

  const result = await env.DB301.prepare(
    `SELECT d.id, d.account_id, d.site_id, d.zone_id, d.key_id, d.parent_id,
            d.domain_name, d.role, d.ns, d.ns_verified, d.proxied,
            d.blocked, d.blocked_reason, d.ssl_status, d.expired_at,
            d.created_at, d.updated_at,
            s.site_name, s.status as site_status,
            p.id as project_id, p.project_name,
            t.threat_score, t.categories as threat_categories, t.checked_at as threat_checked_at,
            COALESCE(r.clicks_yesterday, 0) as clicks_yesterday,
            COALESCE(r.clicks_today, 0) as clicks_today
     FROM domains d
     LEFT JOIN sites s ON d.site_id = s.id
     LEFT JOIN projects p ON s.project_id = p.id
     LEFT JOIN domain_threats t ON d.id = t.domain_id
     LEFT JOIN (
       SELECT domain_id,
              SUM(clicks_yesterday) as clicks_yesterday,
              SUM(clicks_today) as clicks_today
       FROM redirect_rules
       WHERE enabled = 1
       GROUP BY domain_id
     ) r ON d.id = r.domain_id
     WHERE ${whereClause}
     ORDER BY d.domain_name`
  )
    .bind(...bindings)
    .all<DomainRecord>();

  const grouped = groupByRootWithHealth(result.results);

  return c.json({
    ok: true,
    total: result.results.length,
    groups: grouped,
  });
}

/**
 * GET /domains/:id
 * Получить конкретный домен
 */
export async function handleGetDomain(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  const domain = await env.DB301.prepare(
    `SELECT d.*, 
            z.cf_zone_id, z.status as zone_status, z.ns_expected,
            s.site_name, s.status as site_status,
            p.id as project_id, p.project_name
     FROM domains d
     LEFT JOIN zones z ON d.zone_id = z.id
     LEFT JOIN sites s ON d.site_id = s.id
     LEFT JOIN projects p ON s.project_id = p.id
     WHERE d.id = ? AND d.account_id = ?`
  )
    .bind(domainId, accountId)
    .first();

  if (!domain) {
    return c.json({ ok: false, error: "domain_not_found" }, 404);
  }

  return c.json({ ok: true, domain });
}

// ============================================================
// HANDLERS: CREATE (single)
// ============================================================

/**
 * POST /domains
 * Создать поддомен (3-го/4-го уровня)
 * 
 * Требования:
 * - zones.verified = 1
 * - Квота доменов не превышена
 * - Создаётся DNS A запись в CF
 */
export async function handleCreateDomain(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  let body: CreateDomainRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { domain_name, zone_id, parent_id } = body;
  const role = "reserve"; // Роль всегда reserve при создании

  if (!domain_name) {
    return c.json({ ok: false, error: "missing_fields", fields: ["domain_name"] }, 400);
  }

  // Запрет создания root domain (2-го уровня)
  const domainParts = domain_name.split(".");
  if (domainParts.length <= 2) {
    return c.json({
      ok: false,
      error: "cannot_create_root_domain",
      message: "Root domains (2nd level) are created via /domains/zones/batch.",
    }, 400);
  }

  // Проверяем уникальность
  const existing = await env.DB301.prepare(
    "SELECT id FROM domains WHERE domain_name = ?"
  )
    .bind(domain_name)
    .first();

  if (existing) {
    return c.json({ ok: false, error: "domain_already_exists" }, 409);
  }

  // Проверяем квоту
  const quotaCheck = await checkDomainQuota(env, accountId, 1);
  if (!quotaCheck.ok) {
    return c.json({
      ok: false,
      error: quotaCheck.error,
      limit: quotaCheck.limit,
      used: quotaCheck.used,
    }, 403);
  }

  // Получаем данные зоны (обязательно zone_id для поддоменов)
  if (!zone_id) {
    return c.json({ ok: false, error: "zone_id_required" }, 400);
  }

  const zoneResult = await getVerifiedZone(env, zone_id, accountId);
  if (!zoneResult.ok) {
    if (zoneResult.error === "zone_not_verified") {
      return c.json({
        ok: false,
        error: "zone_not_verified",
        message: "NS записи ещё не подтверждены. Проверьте статус зоны.",
      }, 400);
    }
    return c.json({ ok: false, error: zoneResult.error }, 404);
  }

  const zone = zoneResult.zone;

  // Проверяем parent_id если указан
  if (parent_id) {
    const parent = await env.DB301.prepare(
      "SELECT id FROM domains WHERE id = ? AND account_id = ?"
    )
      .bind(parent_id, accountId)
      .first();

    if (!parent) {
      return c.json({ ok: false, error: "parent_not_found" }, 404);
    }
  }

  // Получаем токен CF
  const keyData = await getDecryptedKey(env, zone.key_id);
  if (!keyData) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  // Создаём DNS A запись в CF
  const dnsResult = await cfCreateDNS(
    zone.cf_zone_id,
    {
      type: "A",
      name: domain_name,
      content: "192.0.2.1",
      proxied: true,
    },
    keyData.secrets.token
  );

  if (!dnsResult.ok) {
    return c.json({
      ok: false,
      error: "dns_create_failed",
      message: dnsResult.error,
    }, 500);
  }

  // Создаём домен в D1
  const result = await env.DB301.prepare(
    `INSERT INTO domains (account_id, zone_id, key_id, parent_id, domain_name, role, ns, ns_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(accountId, zone_id, zone.key_id, parent_id || null, domain_name, role, zone.ns_expected)
    .run();

  const newId = result.meta.last_row_id;

  // Инкремент квоты
  await incrementDomainsUsed(env, accountId, 1);

  // Sync to client D1 (non-blocking)
  syncDomainToClient(env, newId as number).catch(e =>
    console.warn("Client sync failed:", e)
  );

  return c.json({
    ok: true,
    domain: {
      id: newId,
      domain_name,
      zone_id,
      parent_id: parent_id || null,
      role,
      cf_dns_record_id: dnsResult.record.id,
    },
  });
}

// ============================================================
// HANDLERS: CREATE BATCH
// ============================================================

/**
 * POST /domains/batch
 * Batch создание поддоменов (до 10 за раз)
 * 
 * Требования:
 * - zones.verified = 1
 * - Квота доменов не превышена
 * - Создаются DNS A записи в CF
 */
export async function handleBatchCreateDomains(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Parse request
  let body: BatchCreateDomainsRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { zone_id, domains } = body;

  // Validate input
  if (!zone_id) {
    return c.json({ ok: false, error: "missing_field", field: "zone_id" }, 400);
  }

  if (!domains || !Array.isArray(domains) || domains.length === 0) {
    return c.json({ ok: false, error: "missing_field", field: "domains" }, 400);
  }

  if (domains.length > MAX_DOMAINS_PER_BATCH) {
    return c.json({
      ok: false,
      error: "too_many_domains",
      max: MAX_DOMAINS_PER_BATCH,
      received: domains.length,
    }, 400);
  }

  // Получаем данные зоны
  const zoneResult = await getVerifiedZone(env, zone_id, accountId);
  if (!zoneResult.ok) {
    if (zoneResult.error === "zone_not_verified") {
      return c.json({
        ok: false,
        error: "zone_not_verified",
        message: "NS записи ещё не подтверждены. Проверьте статус зоны.",
      }, 400);
    }
    return c.json({ ok: false, error: zoneResult.error }, 404);
  }

  const zone = zoneResult.zone;

  if (!zone.root_domain) {
    return c.json({ ok: false, error: "zone_root_domain_missing" }, 500);
  }

  // Проверяем квоту
  const quotaCheck = await checkDomainQuota(env, accountId, domains.length);
  if (!quotaCheck.ok) {
    return c.json({
      ok: false,
      error: quotaCheck.error,
      limit: quotaCheck.limit,
      used: quotaCheck.used,
      requested: domains.length,
    }, 403);
  }

  // Получаем токен CF
  const keyData = await getDecryptedKey(env, zone.key_id);
  if (!keyData) {
    return c.json({ ok: false, error: "key_invalid" }, 500);
  }

  const token = keyData.secrets.token;

  // Получаем parent_id (root domain)
  const rootDomain = await env.DB301.prepare(
    "SELECT id FROM domains WHERE zone_id = ? AND parent_id IS NULL LIMIT 1"
  )
    .bind(zone_id)
    .first<{ id: number }>();

  const parentId = rootDomain?.id || null;

  // Результаты
  const results: {
    success: Array<{ domain: string; id: number; cf_dns_record_id: string }>;
    failed: Array<{ domain: string; error: string }>;
  } = {
    success: [],
    failed: [],
  };

  let domainsCreated = 0;

  for (const item of domains) {
    const shortName = item.name.trim().toLowerCase();
    const fullDomain = `${shortName}.${zone.root_domain}`;
    const domainRole = "reserve"; // Роль всегда reserve при создании

    // Проверяем уникальность
    const existing = await env.DB301.prepare(
      "SELECT id FROM domains WHERE domain_name = ?"
    )
      .bind(fullDomain)
      .first();

    if (existing) {
      results.failed.push({ domain: fullDomain, error: "domain_already_exists" });
      continue;
    }

    // Создаём DNS A запись в CF
    const dnsResult = await cfCreateDNS(
      zone.cf_zone_id,
      {
        type: "A",
        name: shortName,  // CF сам добавит .root_domain
        content: "192.0.2.1",
        proxied: true,
      },
      token
    );

    if (!dnsResult.ok) {
      results.failed.push({ domain: fullDomain, error: `dns_create_failed: ${dnsResult.error}` });
      continue;
    }

    // Создаём домен в D1
    try {
      const insertResult = await env.DB301.prepare(
        `INSERT INTO domains (account_id, zone_id, key_id, parent_id, domain_name, role, ns, ns_verified, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
        .bind(accountId, zone_id, zone.key_id, parentId, fullDomain, domainRole, zone.ns_expected)
        .run();

      const newId = insertResult.meta.last_row_id as number;
      domainsCreated++;

      results.success.push({
        domain: fullDomain,
        id: newId,
        cf_dns_record_id: dnsResult.record.id,
      });
    } catch (e) {
      // DNS создан, но D1 упал — логируем
      console.error(`D1 insert failed for ${fullDomain}:`, e);
      results.failed.push({ domain: fullDomain, error: "db_write_failed" });
    }
  }

  // Инкремент квоты
  if (domainsCreated > 0) {
    await incrementDomainsUsed(env, accountId, domainsCreated);

    // Sync created domains to client D1 (non-blocking)
    for (const item of results.success) {
      syncDomainToClient(env, item.id).catch(e =>
        console.warn("Client sync failed for domain", item.id, e)
      );
    }
  }

  return c.json({
    ok: results.success.length > 0,
    results,
  });
}

// ============================================================
// HANDLERS: UPDATE
// ============================================================

/**
 * PATCH /domains/:id
 * Обновить домен
 */
export async function handleUpdateDomain(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование
  const existing = await env.DB301.prepare(
    "SELECT id FROM domains WHERE id = ? AND account_id = ?"
  )
    .bind(domainId, accountId)
    .first();

  if (!existing) {
    return c.json({ ok: false, error: "domain_not_found" }, 404);
  }

  let body: UpdateDomainRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { role, site_id, blocked, blocked_reason } = body;

  // Собираем UPDATE
  const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const bindings: (string | number | null)[] = [];

  if (role !== undefined) {
    updates.push("role = ?");
    bindings.push(role);
  }

  if (site_id !== undefined) {
    updates.push("site_id = ?");
    bindings.push(site_id);
  }

  if (blocked !== undefined) {
    updates.push("blocked = ?");
    bindings.push(blocked ? 1 : 0);
  }

  if (blocked_reason !== undefined) {
    updates.push("blocked_reason = ?");
    bindings.push(blocked_reason);
  }

  if (bindings.length === 0) {
    return c.json({ ok: false, error: "no_fields_to_update" }, 400);
  }

  bindings.push(domainId);

  await env.DB301.prepare(`UPDATE domains SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...bindings)
    .run();

  // Sync to client D1 if role or blocked changed (non-blocking)
  if (role !== undefined || blocked !== undefined) {
    syncDomainToClient(env, domainId).catch(e =>
      console.warn("Client sync failed:", e)
    );
  }

  return c.json({ ok: true });
}

// ============================================================
// CF API: DELETE DNS
// ============================================================

/**
 * Найти DNS запись по имени
 */
async function cfFindDNSByName(
  cfZoneId: string,
  name: string,
  token: string
): Promise<{ ok: true; recordId: string } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/dns_records?name=${encodeURIComponent(name)}&type=A`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFDNSRecord[]>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to find DNS record" };
    }

    if (!data.result || data.result.length === 0) {
      return { ok: false, error: "dns_record_not_found" };
    }

    return { ok: true, recordId: data.result[0].id };
  } catch {
    return { ok: false, error: "CF DNS API request failed" };
  }
}

/**
 * Удалить DNS запись
 */
async function cfDeleteDNS(
  cfZoneId: string,
  recordId: string,
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/dns_records/${recordId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<unknown>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to delete DNS record" };
    }

    return { ok: true };
  } catch {
    return { ok: false, error: "CF DNS API request failed" };
  }
}

// ============================================================
// D1 HELPERS: QUOTA DECREMENT
// ============================================================

/**
 * Декремент использованных доменов
 */
async function decrementDomainsUsed(
  env: Env,
  accountId: number,
  count: number = 1
): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage 
     SET domains_used = MAX(0, domains_used - ?), updated_at = CURRENT_TIMESTAMP 
     WHERE account_id = ?`
  )
    .bind(count, accountId)
    .run();
}

// ============================================================
// HANDLERS: DELETE
// ============================================================

/**
 * DELETE /domains/:id
 * Удалить домен (поддомен) + DNS запись в CF
 */
export async function handleDeleteDomain(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование и получаем данные для удаления DNS
  const domain = await env.DB301.prepare(
    `SELECT d.id, d.domain_name, d.zone_id, d.key_id, z.cf_zone_id
     FROM domains d
     LEFT JOIN zones z ON d.zone_id = z.id
     WHERE d.id = ? AND d.account_id = ?`
  )
    .bind(domainId, accountId)
    .first<{ 
      id: number; 
      domain_name: string; 
      zone_id: number | null; 
      key_id: number | null;
      cf_zone_id: string | null;
    }>();

  if (!domain) {
    return c.json({ ok: false, error: "domain_not_found" }, 404);
  }

  // Проверяем — это root domain зоны?
  if (domain.zone_id) {
    const rootCheck = getRootDomain(domain.domain_name);
    if (rootCheck === domain.domain_name) {
      return c.json({
        ok: false,
        error: "cannot_delete_root_domain",
        message: "Root domain is managed by zone. Delete the zone instead.",
      }, 400);
    }
  }

  // Удаляем DNS запись в CF (если есть zone и key)
  let dnsDeleted = false;
  if (domain.cf_zone_id && domain.key_id) {
    const keyData = await getDecryptedKey(env, domain.key_id);
    
    if (keyData) {
      // Находим DNS запись по имени
      const findResult = await cfFindDNSByName(
        domain.cf_zone_id,
        domain.domain_name,
        keyData.secrets.token
      );

      if (findResult.ok) {
        // Удаляем DNS запись
        const deleteResult = await cfDeleteDNS(
          domain.cf_zone_id,
          findResult.recordId,
          keyData.secrets.token
        );
        
        dnsDeleted = deleteResult.ok;
        
        if (!deleteResult.ok) {
          console.warn(`Failed to delete DNS for ${domain.domain_name}: ${deleteResult.error}`);
        }
      } else {
        // DNS запись не найдена — не критично, продолжаем удаление из D1
        console.warn(`DNS record not found for ${domain.domain_name}: ${findResult.error}`);
      }
    }
  }

  // Delete from client D1 first (before we lose domain info)
  if (domain.key_id) {
    deleteDomainFromClient(env, domain.key_id, domain.domain_name).catch(e =>
      console.warn("Client sync delete failed:", e)
    );
  }

  // Очищаем связанные записи перед удалением
  await env.DB301.prepare("DELETE FROM rule_domain_map WHERE domain_id = ?").bind(domainId).run();
  await env.DB301.prepare("DELETE FROM redirect_rules WHERE domain_id = ?").bind(domainId).run();

  // Удаляем из D1
  await env.DB301.prepare("DELETE FROM domains WHERE id = ?").bind(domainId).run();

  // Декремент квоты
  await decrementDomainsUsed(env, accountId, 1);

  return c.json({ 
    ok: true,
    dns_deleted: dnsDeleted,
  });
}
