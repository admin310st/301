// src/api/projects/projects.ts

/**
 * Projects API
 *
 * CRUD операции с проектами.
 * При создании проекта автоматически создаётся один сайт.
 * Интеграции (CF ключи) привязываются через project_integrations.
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireAuth, requireOwner, requireEditor } from "../lib/auth";

// ============================================================
// TYPES
// ============================================================

interface ProjectRecord {
  id: number;
  account_id: number;
  project_name: string;
  description: string | null;
  brand_tag: string | null;
  commercial_terms: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  // Computed
  sites_count?: number;
  domains_count?: number;
}

interface CreateProjectRequest {
  project_name: string;
  description?: string;
  brand_tag?: string;
  commercial_terms?: string;
  start_date?: string;
  end_date?: string;
  // Автосоздание сайта
  site_name?: string;
}

interface UpdateProjectRequest {
  project_name?: string;
  description?: string;
  brand_tag?: string;
  commercial_terms?: string;
  start_date?: string;
  end_date?: string;
}

interface IntegrationRecord {
  id: number;
  project_id: number;
  account_key_id: number;
  created_at: string;
  // Joined
  provider: string;
  key_alias: string;
  status: string;
  external_account_id: string | null;
}

// ============================================================
// QUOTA HELPERS
// ============================================================

/**
 * Проверка квоты проектов
 */
async function checkProjectQuota(
  env: Env,
  accountId: number
): Promise<{ ok: true } | { ok: false; error: string; limit: number; used: number }> {
  const quota = await env.DB301.prepare(
    `SELECT 
       ql.max_projects,
       COALESCE(qu.projects_used, 0) as projects_used
     FROM accounts a
     JOIN quota_limits ql ON a.plan_tier = ql.plan_tier
     LEFT JOIN quota_usage qu ON a.id = qu.account_id
     WHERE a.id = ?`
  )
    .bind(accountId)
    .first<{ max_projects: number; projects_used: number }>();

  if (!quota) {
    return { ok: false, error: "quota_not_found", limit: 0, used: 0 };
  }

  if (quota.projects_used >= quota.max_projects) {
    return {
      ok: false,
      error: "quota_exceeded",
      limit: quota.max_projects,
      used: quota.projects_used,
    };
  }

  return { ok: true };
}

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
      error: "site_quota_exceeded",
      limit: quota.max_sites,
      used: quota.sites_used,
    };
  }

  return { ok: true };
}

/**
 * Инкремент использованных проектов
 */
async function incrementProjectsUsed(env: Env, accountId: number): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage 
     SET projects_used = projects_used + 1, updated_at = CURRENT_TIMESTAMP 
     WHERE account_id = ?`
  )
    .bind(accountId)
    .run();
}

/**
 * Декремент использованных проектов
 */
async function decrementProjectsUsed(env: Env, accountId: number): Promise<void> {
  await env.DB301.prepare(
    `UPDATE quota_usage 
     SET projects_used = MAX(0, projects_used - 1), updated_at = CURRENT_TIMESTAMP 
     WHERE account_id = ?`
  )
    .bind(accountId)
    .run();
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

// ============================================================
// HANDLERS: LIST & GET
// ============================================================

/**
 * GET /projects
 * Список проектов аккаунта
 */
export async function handleListProjects(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  const projects = await env.DB301.prepare(
    `SELECT 
       p.id, p.project_name, p.description, p.brand_tag, 
       p.commercial_terms, p.start_date, p.end_date,
       p.created_at, p.updated_at,
       (SELECT COUNT(*) FROM sites WHERE project_id = p.id) as sites_count,
       (SELECT COUNT(*) FROM domains WHERE project_id = p.id) as domains_count
     FROM projects p
     WHERE p.account_id = ?
     ORDER BY p.created_at DESC`
  )
    .bind(accountId)
    .all<ProjectRecord>();

  return c.json({
    ok: true,
    total: projects.results.length,
    projects: projects.results,
  });
}

/**
 * GET /projects/:id
 * Детали проекта
 */
export async function handleGetProject(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const projectId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const { account_id: accountId } = auth;

  const project = await env.DB301.prepare(
    `SELECT 
       p.*,
       (SELECT COUNT(*) FROM sites WHERE project_id = p.id) as sites_count,
       (SELECT COUNT(*) FROM domains WHERE project_id = p.id) as domains_count
     FROM projects p
     WHERE p.id = ? AND p.account_id = ?`
  )
    .bind(projectId, accountId)
    .first<ProjectRecord>();

  if (!project) {
    return c.json({ ok: false, error: "project_not_found" }, 404);
  }

  // Получаем сайты проекта
  const sites = await env.DB301.prepare(
    `SELECT id, site_name, site_tag, status, created_at
     FROM sites WHERE project_id = ?
     ORDER BY created_at`
  )
    .bind(projectId)
    .all();

  // Получаем интеграции проекта
  const integrations = await env.DB301.prepare(
    `SELECT 
       pi.id, pi.account_key_id, pi.created_at,
       ak.provider, ak.key_alias, ak.status, ak.external_account_id
     FROM project_integrations pi
     JOIN account_keys ak ON pi.account_key_id = ak.id
     WHERE pi.project_id = ?`
  )
    .bind(projectId)
    .all<IntegrationRecord>();

  return c.json({
    ok: true,
    project,
    sites: sites.results,
    integrations: integrations.results,
  });
}

// ============================================================
// HANDLERS: CREATE
// ============================================================

/**
 * POST /projects
 * Создать проект + автоматически создать первый сайт
 */
export async function handleCreateProject(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Parse request
  let body: CreateProjectRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const {
    project_name,
    description = null,
    brand_tag = null,
    commercial_terms = null,
    start_date = null,
    end_date = null,
    site_name,
  } = body;

  if (!project_name) {
    return c.json({ ok: false, error: "missing_field", field: "project_name" }, 400);
  }

  // Проверяем квоту проектов
  const projectQuota = await checkProjectQuota(env, accountId);
  if (!projectQuota.ok) {
    return c.json({
      ok: false,
      error: projectQuota.error,
      limit: projectQuota.limit,
      used: projectQuota.used,
    }, 403);
  }

  // Проверяем квоту сайтов (для автосоздания)
  const siteQuota = await checkSiteQuota(env, accountId);
  if (!siteQuota.ok) {
    return c.json({
      ok: false,
      error: siteQuota.error,
      limit: siteQuota.limit,
      used: siteQuota.used,
    }, 403);
  }

  // Создаём проект
  let projectId: number;
  try {
    const result = await env.DB301.prepare(
      `INSERT INTO projects (account_id, project_name, description, brand_tag, commercial_terms, start_date, end_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
      .bind(accountId, project_name, description, brand_tag, commercial_terms, start_date, end_date)
      .run();

    projectId = result.meta.last_row_id as number;
  } catch (e) {
    console.error("Project insert failed:", e);
    return c.json({ ok: false, error: "db_write_failed" }, 500);
  }

  // Автосоздание первого сайта
  const defaultSiteName = site_name || `${project_name} - Main`;
  let siteId: number;
  try {
    const siteResult = await env.DB301.prepare(
      `INSERT INTO sites (project_id, site_name, status, created_at, updated_at)
       VALUES (?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
      .bind(projectId, defaultSiteName)
      .run();

    siteId = siteResult.meta.last_row_id as number;
  } catch (e) {
    console.error("Site insert failed:", e);
    // Откатываем проект
    await env.DB301.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();
    return c.json({ ok: false, error: "site_create_failed" }, 500);
  }

  // Обновляем квоты
  await incrementProjectsUsed(env, accountId);
  await incrementSitesUsed(env, accountId);

  return c.json({
    ok: true,
    project: {
      id: projectId,
      project_name,
      description,
      brand_tag,
    },
    site: {
      id: siteId,
      site_name: defaultSiteName,
      status: "active",
    },
  });
}

// ============================================================
// HANDLERS: UPDATE
// ============================================================

/**
 * PATCH /projects/:id
 * Обновить проект
 */
export async function handleUpdateProject(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const projectId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "editor_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование
  const existing = await env.DB301.prepare(
    "SELECT id FROM projects WHERE id = ? AND account_id = ?"
  )
    .bind(projectId, accountId)
    .first();

  if (!existing) {
    return c.json({ ok: false, error: "project_not_found" }, 404);
  }

  // Parse request
  let body: UpdateProjectRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { project_name, description, brand_tag, commercial_terms, start_date, end_date } = body;

  // Собираем UPDATE
  const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
  const bindings: (string | null)[] = [];

  if (project_name !== undefined) {
    updates.push("project_name = ?");
    bindings.push(project_name);
  }

  if (description !== undefined) {
    updates.push("description = ?");
    bindings.push(description);
  }

  if (brand_tag !== undefined) {
    updates.push("brand_tag = ?");
    bindings.push(brand_tag);
  }

  if (commercial_terms !== undefined) {
    updates.push("commercial_terms = ?");
    bindings.push(commercial_terms);
  }

  if (start_date !== undefined) {
    updates.push("start_date = ?");
    bindings.push(start_date);
  }

  if (end_date !== undefined) {
    updates.push("end_date = ?");
    bindings.push(end_date);
  }

  if (bindings.length === 0) {
    return c.json({ ok: false, error: "no_fields_to_update" }, 400);
  }

  bindings.push(String(projectId));

  await env.DB301.prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...bindings)
    .run();

  return c.json({ ok: true });
}

// ============================================================
// HANDLERS: DELETE
// ============================================================

/**
 * DELETE /projects/:id
 * Удалить проект (каскадно удалятся sites, domains.project_id станет NULL)
 */
export async function handleDeleteProject(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const projectId = parseInt(c.req.param("id"));

  const auth = await requireOwner(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "owner_required" }, 403);
  }

  const { account_id: accountId } = auth;

  // Проверяем существование
  const existing = await env.DB301.prepare(
    "SELECT id FROM projects WHERE id = ? AND account_id = ?"
  )
    .bind(projectId, accountId)
    .first();

  if (!existing) {
    return c.json({ ok: false, error: "project_not_found" }, 404);
  }

  // Считаем сайты для декремента квоты
  const sitesCount = await env.DB301.prepare(
    "SELECT COUNT(*) as count FROM sites WHERE project_id = ?"
  )
    .bind(projectId)
    .first<{ count: number }>();

  // Удаляем проект (каскадно удалит sites, project_integrations)
  await env.DB301.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run();

  // Обнуляем project_id у доменов
  await env.DB301.prepare(
    "UPDATE domains SET project_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?"
  )
    .bind(projectId)
    .run();

  // Декремент квот
  await decrementProjectsUsed(env, accountId);
  
  if (sitesCount && sitesCount.count > 0) {
    await env.DB301.prepare(
      `UPDATE quota_usage 
       SET sites_used = MAX(0, sites_used - ?), updated_at = CURRENT_TIMESTAMP 
       WHERE account_id = ?`
    )
      .bind(sitesCount.count, accountId)
      .run();
  }

  return c.json({ ok: true });
}

// ============================================================
// HANDLERS: INTEGRATIONS
// ============================================================

/**
 * GET /projects/:id/integrations
 * Список интеграций проекта
 */
export async function handleListProjectIntegrations(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const projectId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
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

  // Query param для фильтра
  const provider = c.req.query("provider");

  let query = `
    SELECT 
      pi.id, pi.account_key_id, pi.created_at,
      ak.provider, ak.key_alias, ak.status, ak.external_account_id
    FROM project_integrations pi
    JOIN account_keys ak ON pi.account_key_id = ak.id
    WHERE pi.project_id = ?
  `;
  const bindings: (number | string)[] = [projectId];

  if (provider) {
    query += " AND ak.provider = ?";
    bindings.push(provider);
  }

  query += " ORDER BY pi.created_at DESC";

  const integrations = await env.DB301.prepare(query)
    .bind(...bindings)
    .all<IntegrationRecord>();

  return c.json({
    ok: true,
    integrations: integrations.results,
  });
}

/**
 * POST /projects/:id/integrations
 * Привязать ключ к проекту
 */
export async function handleAddProjectIntegration(c: Context<{ Bindings: Env }>) {
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
  let body: { account_key_id: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  const { account_key_id } = body;

  if (!account_key_id) {
    return c.json({ ok: false, error: "missing_field", field: "account_key_id" }, 400);
  }

  // Проверяем что ключ принадлежит аккаунту
  const key = await env.DB301.prepare(
    "SELECT id, provider, key_alias FROM account_keys WHERE id = ? AND account_id = ?"
  )
    .bind(account_key_id, accountId)
    .first<{ id: number; provider: string; key_alias: string }>();

  if (!key) {
    return c.json({ ok: false, error: "key_not_found" }, 404);
  }

  // Проверяем дубликат
  const existing = await env.DB301.prepare(
    "SELECT id FROM project_integrations WHERE project_id = ? AND account_key_id = ?"
  )
    .bind(projectId, account_key_id)
    .first();

  if (existing) {
    return c.json({ ok: false, error: "integration_already_exists" }, 409);
  }

  // Создаём связь
  const result = await env.DB301.prepare(
    `INSERT INTO project_integrations (project_id, account_key_id, created_at, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
  )
    .bind(projectId, account_key_id)
    .run();

  return c.json({
    ok: true,
    integration: {
      id: result.meta.last_row_id,
      project_id: projectId,
      account_key_id,
      provider: key.provider,
      key_alias: key.key_alias,
    },
  });
}

/**
 * DELETE /projects/:id/integrations/:keyId
 * Отвязать ключ от проекта
 */
export async function handleRemoveProjectIntegration(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const projectId = parseInt(c.req.param("id"));
  const keyId = parseInt(c.req.param("keyId"));

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

  // Удаляем связь
  const result = await env.DB301.prepare(
    "DELETE FROM project_integrations WHERE project_id = ? AND account_key_id = ?"
  )
    .bind(projectId, keyId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ ok: false, error: "integration_not_found" }, 404);
  }

  return c.json({ ok: true });
}
