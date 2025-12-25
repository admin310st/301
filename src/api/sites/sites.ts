// src/api/sites/sites.ts

/**
 * Sites API
 *
 * CRUD операции с сайтами.
 * Site = тег/точка приёма трафика.
 * 
 * Статусы:
 * - active: принимает трафик
 * - paused: временно приостановлен
 * - archived: архивирован
 * 
 * При блокировке домена-acceptor тег site перевешивается на резервный домен.
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireAuth, requireEditor } from "../lib/auth";

// ============================================================
// TYPES
// ============================================================

interface SiteRecord {
  id: number;
  project_id: number;
  site_name: string;
  site_tag: string | null;
  status: "active" | "paused" | "archived";
  created_at: string;
  updated_at: string;
  // Joined
  project_name?: string;
  // Computed
  domains_count?: number;
  acceptor_domain?: string | null;
}

interface CreateSiteRequest {
  site_name: string;
  site_tag?: string;
}

interface UpdateSiteRequest {
  site_name?: string;
  site_tag?: string;
  status?: "active" | "paused" | "archived";
}

interface DomainBrief {
  id: number;
  domain_name: string;
  role: "acceptor" | "donor" | "reserve";
  blocked: number;
  blocked_reason: string | null;
}

// ============================================================
// QUOTA HELPERS
// ============================================================

/**
 * Проверка квоты сайтов
 */
async function checkSiteQuota(
  env: Env,
  accountId: number
): Promise<{ ok: true } | { ok: false; error: string; limit: number; used: number }> {
  const quota = await env.DB301.prepare(
    `SELECT 
       ql.max_sites,
       COALESCE(qu.sites_used, 0) as sites_used
     FROM accounts a
     JOIN quota_limits ql ON a.plan_tier = ql.plan_tier
     LEFT JOIN quota_usage qu ON a.id = qu.account_id
     WHERE a.id = ?`
  )
    .bind(accountId)
    .first<{ max_sites: number; sites_used: number }>();

  if (!quota) {
    return { ok: false, error: "quota_not_found", limit: 0, used: 0 };
  }

  if (quota.sites_used >= quota.max_sites) {
    return {
      ok: false,
      error: "quota_exceeded",
      limit: quota.max_sites,
      used: quota.sites_used,
    };
  }

  return { ok: true };
}

/**
 * Инкремент использованных сайтов
 */
async function incrementSitesUsed(env: Env, accountId: number): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage 
     SET sites_used = sites_used + 1, updated_at = CURRENT_TIMESTAMP 
     WHERE account_id = ?`
  )
    .bind(accountId)
    .run();
}

/**
 * Декремент использованных сайтов
 */
async function decrementSitesUsed(env: Env, accountId: number): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage 
     SET sites_used = MAX(0, sites_used - 1), updated_at = CURRENT_TIMESTAMP 
     WHERE account_id = ?`
  )
    .bind(accountId)
    .run();
}

// ============================================================
// HANDLERS: LIST (by project)
// ============================================================

/**
 * GET /projects/:id/sites
 * Список сайтов проекта
 */
export async function handleListProjectSites(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const projectId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Проверяем владение проектом
  const project = await env.DB301.prepare(
    "SELECT id, project_name FROM projects WHERE id = ? AND account_id = ?"
  )
    .bind(projectId, accountId)
    .first<{ id: number; project_name: string }>();

  if (!project) {
    return c.json({ ok: false, error: "project_not_found" }, 404);
  }

  // Query param для фильтра по статусу
  const status = c.req.query("status");

  let query = `
    SELECT 
      s.id, s.project_id, s.site_name, s.site_tag, s.status,
      s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM domains WHERE site_id = s.id) as domains_count,
      (SELECT domain_name FROM domains WHERE site_id = s.id AND role = 'acceptor' AND blocked = 0 LIMIT 1) as acceptor_domain
    FROM sites s
    WHERE s.project_id = ?
  `;
  const bindings: (number | string)[] = [projectId];

  if (status) {
    query += " AND s.status = ?";
    bindings.push(status);
  }

  query += " ORDER BY s.created_at";

  const sites = await env.DB301.prepare(query)
    .bind(...bindings)
    .all<SiteRecord>();

  return c.json({
    ok: true,
    project: {
      id: project.id,
      project_name: project.project_name,
    },
    total: sites.results.length,
    sites: sites.results,
  });
}

// ============================================================
// HANDLERS: GET
// ============================================================

/**
 * GET /sites/:id
 * Детали сайта + домены привязанные к нему
 */
export async function handleGetSite(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const siteId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  // Получаем сайт с проверкой владения через проект
  const site = await env.DB301.prepare(
    `SELECT 
       s.id, s.project_id, s.site_name, s.site_tag, s.status,
       s.created_at, s.updated_at,
       p.project_name
     FROM sites s
     JOIN projects p ON s.project_id = p.id
     WHERE s.id = ? AND p.account_id = ?`
  )
    .bind(siteId, accountId)
    .first<SiteRecord>();

  if (!site) {
    return c.json({ ok: false, error: "site_not_found" }, 404);
  }

  // Получаем домены сайта
  const domains = await env.DB301.prepare(
    `SELECT id, domain_name, role, blocked, blocked_reason
     FROM domains
     WHERE site_id = ?
     ORDER BY 
       CASE role 
         WHEN 'acceptor' THEN 1 
         WHEN 'donor' THEN 2 
         ELSE 3 
       END,
       domain_name`
  )
    .bind(siteId)
    .all<DomainBrief>();

  return c.json({
    ok: true,
    site,
    domains: domains.results,
  });
}

// ============================================================
// HANDLERS: CREATE
// ============================================================

/**
 * POST /projects/:id/sites
 * Создать сайт в проекте
 */
export async function handleCreateSite(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const projectId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем владение проектом
  const project = await env.DB301.prepare(
    "SELECT id FROM projects WHERE id = ? AND account_id = ?"
  )
    .bind(projectId, accountId)
    .first();

  if (!project) {
    return c.json({ ok: false, error: "project_not_found" }, 404);
  }

  // Parse request
  let body: CreateSiteRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { site_name, site_tag = null } = body;

  if (!site_name) {
    return c.json({ ok: false, error: "missing_field", field: "site_name" }, 400);
  }

  // Проверяем квоту
  const quotaCheck = await checkSiteQuota(env, accountId);
  if (!quotaCheck.ok) {
    return c.json({
      ok: false,
      error: quotaCheck.error,
      limit: quotaCheck.limit,
      used: quotaCheck.used,
    }, 403);
  }

  // Создаём сайт
  let siteId: number;
  try {
    const result = await env.DB301.prepare(
      `INSERT INTO sites (project_id, site_name, site_tag, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
      .bind(projectId, site_name, site_tag)
      .run();

    siteId = result.meta.last_row_id as number;
  } catch (e) {
    console.error("Site insert failed:", e);
    return c.json({ ok: false, error: "db_write_failed" }, 500);
  }

  // Инкремент квоты
  await incrementSitesUsed(env, accountId);

  return c.json({
    ok: true,
    site: {
      id: siteId,
      project_id: projectId,
      site_name,
      site_tag,
      status: "active",
    },
  });
}

// ============================================================
// HANDLERS: UPDATE
// ============================================================

/**
 * PATCH /sites/:id
 * Обновить сайт
 */
export async function handleUpdateSite(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const siteId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование и владение
  const existing = await env.DB301.prepare(
    `SELECT s.id 
     FROM sites s
     JOIN projects p ON s.project_id = p.id
     WHERE s.id = ? AND p.account_id = ?`
  )
    .bind(siteId, accountId)
    .first();

  if (!existing) {
    return c.json({ ok: false, error: "site_not_found" }, 404);
  }

  // Parse request
  let body: UpdateSiteRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { site_name, site_tag, status } = body;

  // Валидация статуса
  if (status && !["active", "paused", "archived"].includes(status)) {
    return c.json({ ok: false, error: "invalid_status" }, 400);
  }

  // Собираем UPDATE
  const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const bindings: (string | null)[] = [];

  if (site_name !== undefined) {
    updates.push("site_name = ?");
    bindings.push(site_name);
  }

  if (site_tag !== undefined) {
    updates.push("site_tag = ?");
    bindings.push(site_tag);
  }

  if (status !== undefined) {
    updates.push("status = ?");
    bindings.push(status);
  }

  if (bindings.length === 0) {
    return c.json({ ok: false, error: "no_fields_to_update" }, 400);
  }

  bindings.push(String(siteId));

  await env.DB301.prepare(`UPDATE sites SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...bindings)
    .run();

  return c.json({ ok: true });
}

// ============================================================
// HANDLERS: DELETE
// ============================================================

/**
 * DELETE /sites/:id
 * Удалить сайт
 * 
 * При удалении:
 * - domains.site_id становится NULL
 * - Сайт удаляется
 */
export async function handleDeleteSite(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const siteId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование и владение
  const existing = await env.DB301.prepare(
    `SELECT s.id, s.project_id
     FROM sites s
     JOIN projects p ON s.project_id = p.id
     WHERE s.id = ? AND p.account_id = ?`
  )
    .bind(siteId, accountId)
    .first<{ id: number; project_id: number }>();

  if (!existing) {
    return c.json({ ok: false, error: "site_not_found" }, 404);
  }

  // Проверяем — это последний сайт в проекте?
  const sitesCount = await env.DB301.prepare(
    "SELECT COUNT(*) as count FROM sites WHERE project_id = ?"
  )
    .bind(existing.project_id)
    .first<{ count: number }>();

  if (sitesCount && sitesCount.count <= 1) {
    return c.json({
      ok: false,
      error: "cannot_delete_last_site",
      message: "Project must have at least one site. Delete the project instead.",
    }, 400);
  }

  // Обнуляем site_id у доменов
  await env.DB301.prepare(
    "UPDATE domains SET site_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE site_id = ?"
  )
    .bind(siteId)
    .run();

  // Удаляем сайт
  await env.DB301.prepare("DELETE FROM sites WHERE id = ?").bind(siteId).run();

  // Декремент квоты
  await decrementSitesUsed(env, accountId);

  return c.json({ ok: true });
}

// ============================================================
// HANDLERS: ASSIGN DOMAIN
// ============================================================

/**
 * POST /sites/:id/domains
 * Привязать домен к сайту (назначить тег)
 */
export async function handleAssignDomainToSite(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const siteId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование сайта и владение
  const site = await env.DB301.prepare(
    `SELECT s.id, s.project_id
     FROM sites s
     JOIN projects p ON s.project_id = p.id
     WHERE s.id = ? AND p.account_id = ?`
  )
    .bind(siteId, accountId)
    .first<{ id: number; project_id: number }>();

  if (!site) {
    return c.json({ ok: false, error: "site_not_found" }, 404);
  }

  // Parse request
  let body: { domain_id: number; role?: "acceptor" | "donor" | "reserve" };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { domain_id, role } = body;

  if (!domain_id) {
    return c.json({ ok: false, error: "missing_field", field: "domain_id" }, 400);
  }

  // Проверяем что домен принадлежит аккаунту
  const domain = await env.DB301.prepare(
    "SELECT id, domain_name, project_id FROM domains WHERE id = ? AND account_id = ?"
  )
    .bind(domain_id, accountId)
    .first<{ id: number; domain_name: string; project_id: number | null }>();

  if (!domain) {
    return c.json({ ok: false, error: "domain_not_found" }, 404);
  }

  // Проверяем что домен в том же проекте (или без проекта)
  if (domain.project_id && domain.project_id !== site.project_id) {
    return c.json({
      ok: false,
      error: "domain_in_different_project",
      message: "Domain belongs to a different project. Reassign it first.",
    }, 400);
  }

  // Обновляем домен
  const updates: string[] = [
    "site_id = ?",
    "project_id = ?",
    "updated_at = CURRENT_TIMESTAMP",
  ];
  const bindings: (number | string)[] = [siteId, site.project_id];

  if (role) {
    updates.push("role = ?");
    bindings.push(role);
  }

  bindings.push(domain_id);

  await env.DB301.prepare(`UPDATE domains SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...bindings)
    .run();

  return c.json({
    ok: true,
    domain: {
      id: domain_id,
      domain_name: domain.domain_name,
      site_id: siteId,
      project_id: site.project_id,
      role: role || undefined,
    },
  });
}

/**
 * DELETE /sites/:id/domains/:domainId
 * Отвязать домен от сайта (убрать тег)
 */
export async function handleUnassignDomainFromSite(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const siteId = parseInt(c.req.param("id"));
  const domainId = parseInt(c.req.param("domainId"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование сайта и владение
  const site = await env.DB301.prepare(
    `SELECT s.id
     FROM sites s
     JOIN projects p ON s.project_id = p.id
     WHERE s.id = ? AND p.account_id = ?`
  )
    .bind(siteId, accountId)
    .first();

  if (!site) {
    return c.json({ ok: false, error: "site_not_found" }, 404);
  }

  // Проверяем что домен привязан к этому сайту
  const domain = await env.DB301.prepare(
    "SELECT id FROM domains WHERE id = ? AND site_id = ? AND account_id = ?"
  )
    .bind(domainId, siteId, accountId)
    .first();

  if (!domain) {
    return c.json({ ok: false, error: "domain_not_assigned" }, 404);
  }

  // Отвязываем домен (site_id = NULL, role = reserve)
  await env.DB301.prepare(
    `UPDATE domains 
     SET site_id = NULL, role = 'reserve', updated_at = CURRENT_TIMESTAMP 
     WHERE id = ?`
  )
    .bind(domainId)
    .run();

  return c.json({ ok: true });
}
