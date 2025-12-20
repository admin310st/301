// src/api/domain/domains.ts

/**
 * Domains API
 *
 * CRUD операции с доменами
 * Группировка по root domain (2-го уровня)
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireAuth, requireEditor } from "../lib/auth";

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

interface UpdateDomainRequest {
  role?: "acceptor" | "donor" | "reserve";
  site_id?: number | null;
  blocked?: boolean;
  blocked_reason?: "unavailable" | "ad_network" | "hosting_registrar" | "government" | "manual" | null;
}

// ============================================================
// HELPERS
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

// ============================================================
// HANDLERS
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
  const role = c.req.query("role"); // фильтр по роли
  const blocked = c.req.query("blocked"); // фильтр по блокировке
  const zoneId = c.req.query("zone_id"); // фильтр по зоне
  const siteId = c.req.query("site_id"); // фильтр по сайту
  const projectId = c.req.query("project_id"); // фильтр по проекту

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
    conditions.push("p.id = ?");
    bindings.push(parseInt(projectId));
  }

  const whereClause = conditions.join(" AND ");

  const result = await env.DB301.prepare(
    `SELECT d.id, d.account_id, d.site_id, d.zone_id, d.key_id, d.parent_id,
            d.domain_name, d.role, d.ns, d.ns_verified, d.proxied, 
            d.blocked, d.blocked_reason, d.ssl_status, d.expired_at,
            d.created_at, d.updated_at,
            s.site_name, s.status as site_status,
            p.id as project_id, p.project_name
     FROM domains d
     LEFT JOIN sites s ON d.site_id = s.id
     LEFT JOIN projects p ON s.project_id = p.id
     WHERE ${whereClause}
     ORDER BY d.domain_name`
  )
    .bind(...bindings)
    .all<DomainRecord>();

  const grouped = groupByRoot(result.results);

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

/**
 * POST /domains
 * Создать домен (3-го/4-го уровня)
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

  const { domain_name, zone_id, parent_id, role = "reserve" } = body;

  if (!domain_name) {
    return c.json({ ok: false, error: "missing_fields", fields: ["domain_name"] }, 400);
  }

  // Запрет создания root domain (2-го уровня) — они создаются через sync зон
  const domainParts = domain_name.split(".");
  if (domainParts.length <= 2) {
    return c.json({
      ok: false,
      error: "cannot_create_root_domain",
      message: "Root domains (2nd level) are created via zone sync. Use /zones/sync or add zone in Cloudflare.",
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

  // Если указан zone_id — проверяем владение
  let keyId: number | null = null;
  let ns: string | null = null;

  if (zone_id) {
    const zone = await env.DB301.prepare(
      "SELECT key_id, ns_expected FROM zones WHERE id = ? AND account_id = ?"
    )
      .bind(zone_id, accountId)
      .first<{ key_id: number; ns_expected: string }>();

    if (!zone) {
      return c.json({ ok: false, error: "zone_not_found" }, 404);
    }

    keyId = zone.key_id;
    ns = zone.ns_expected;
  }

  // Если указан parent_id — проверяем владение
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

  // Создаём домен
  const result = await env.DB301.prepare(
    `INSERT INTO domains (account_id, zone_id, key_id, parent_id, domain_name, role, ns, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(accountId, zone_id || null, keyId, parent_id || null, domain_name, role, ns)
    .run();

  const newId = result.meta.last_row_id;

  return c.json({
    ok: true,
    domain: {
      id: newId,
      domain_name,
      zone_id: zone_id || null,
      parent_id: parent_id || null,
      role,
    },
  });
}

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

  return c.json({ ok: true });
}

/**
 * DELETE /domains/:id
 * Удалить домен
 */
export async function handleDeleteDomain(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование и что это не root domain зоны
  const domain = await env.DB301.prepare(
    `SELECT d.id, d.domain_name, d.zone_id, z.cf_zone_id
     FROM domains d
     LEFT JOIN zones z ON d.zone_id = z.id
     WHERE d.id = ? AND d.account_id = ?`
  )
    .bind(domainId, accountId)
    .first<{ id: number; domain_name: string; zone_id: number | null; cf_zone_id: string | null }>();

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

  // Удаляем
  await env.DB301.prepare("DELETE FROM domains WHERE id = ?").bind(domainId).run();

  return c.json({ ok: true });
}

