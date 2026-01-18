// src/api/redirects/redirects.ts

/**
 * Redirects API
 *
 * CRUD операции с redirect_rules.
 * Правила привязаны к домену, деплоятся в CF Redirect Rules API.
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireAuth, requireEditor } from "../lib/auth";
import {
  getTemplate,
  validateTemplateParams,
  listTemplates,
  type TemplateParams,
} from "./templates";
import { getPreset, expandPreset, listPresets, type PresetParams } from "./presets";

// ============================================================
// TYPES
// ============================================================

interface RedirectRecord {
  id: number;
  account_id: number;
  domain_id: number;
  zone_id: number;
  template_id: string;
  preset_id: string | null;
  preset_order: number | null;
  rule_name: string;
  params: string;
  status_code: number;
  enabled: number;
  sync_status: string;
  cf_rule_id: string | null;
  cf_ruleset_id: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  clicks_total: number;
  clicks_yesterday: number;
  clicks_today: number;
  last_counted_date: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  domain_name?: string;
  zone_name?: string;
  site_id?: number | null;
}

interface CreateRedirectRequest {
  template_id: string;
  rule_name: string;
  params: Record<string, unknown>;
  status_code?: number;
}

interface CreatePresetRequest {
  preset_id: string;
  params: PresetParams;
}

interface UpdateRedirectRequest {
  rule_name?: string;
  params?: Record<string, unknown>;
  status_code?: number;
  enabled?: boolean;
}

interface ZoneLimitInfo {
  zone_id: number;
  zone_name: string;
  used: number;
  max: number;
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_FREE_PLAN_LIMIT = 10;

// Шаблоны, которые меняют роль домена на 'donor'
// T3/T4 (www canonical) — НЕ меняют роль, т.к. это нормализация того же домена
const DONOR_TEMPLATES = new Set(["T1", "T5", "T6", "T7"]);

// ============================================================
// HELPERS
// ============================================================

/**
 * Подсчёт trend на основе clicks
 */
function calculateTrend(today: number, yesterday: number): "up" | "down" | "neutral" {
  if (yesterday === 0) return today > 0 ? "up" : "neutral";
  if (today > yesterday * 1.1) return "up";
  if (today < yesterday * 0.9) return "down";
  return "neutral";
}

/**
 * Проверка владения доменом
 */
async function verifyDomainOwnership(
  env: Env,
  domainId: number,
  accountId: number
): Promise<{ ok: true; domain: { id: number; domain_name: string; zone_id: number; site_id: number | null } } | { ok: false; error: string }> {
  const domain = await env.DB301.prepare(
    `SELECT id, domain_name, zone_id, site_id 
     FROM domains 
     WHERE id = ? AND account_id = ?`
  )
    .bind(domainId, accountId)
    .first<{ id: number; domain_name: string; zone_id: number; site_id: number | null }>();

  if (!domain) {
    return { ok: false, error: "domain_not_found" };
  }

  if (!domain.zone_id) {
    return { ok: false, error: "domain_no_zone" };
  }

  return { ok: true, domain };
}

/**
 * Проверка владения редиректом
 */
async function verifyRedirectOwnership(
  env: Env,
  redirectId: number,
  accountId: number
): Promise<{ ok: true; redirect: RedirectRecord } | { ok: false; error: string }> {
  const redirect = await env.DB301.prepare(
    `SELECT r.*, d.domain_name,
            (SELECT domain_name FROM domains WHERE zone_id = r.zone_id AND parent_id IS NULL LIMIT 1) as zone_name
     FROM redirect_rules r
     JOIN domains d ON r.domain_id = d.id
     WHERE r.id = ? AND r.account_id = ?`
  )
    .bind(redirectId, accountId)
    .first<RedirectRecord>();

  if (!redirect) {
    return { ok: false, error: "redirect_not_found" };
  }

  return { ok: true, redirect };
}

/**
 * Проверка лимита зоны
 */
async function checkZoneLimit(
  env: Env,
  zoneId: number,
  accountId: number
): Promise<{ ok: true; used: number; max: number } | { ok: false; error: string; used: number; max: number }> {
  const count = await env.DB301.prepare(
    `SELECT COUNT(*) as count 
     FROM redirect_rules 
     WHERE zone_id = ? AND account_id = ? AND enabled = 1`
  )
    .bind(zoneId, accountId)
    .first<{ count: number }>();

  const used = count?.count || 0;
  const max = CF_FREE_PLAN_LIMIT;

  if (used >= max) {
    return { ok: false, error: "zone_limit_reached", used, max };
  }

  return { ok: true, used, max };
}

/**
 * Проверка уникальности template на домене
 */
async function checkTemplateUnique(
  env: Env,
  domainId: number,
  templateId: string,
  excludeId?: number
): Promise<boolean> {
  let query = `SELECT id FROM redirect_rules 
               WHERE domain_id = ? AND template_id = ? AND enabled = 1`;
  const bindings: (number | string)[] = [domainId, templateId];

  if (excludeId) {
    query += " AND id != ?";
    bindings.push(excludeId);
  }

  const existing = await env.DB301.prepare(query)
    .bind(...bindings)
    .first();

  return !existing;
}

// ============================================================
// HANDLERS: TEMPLATES & PRESETS (public)
// ============================================================

/**
 * GET /redirects/templates
 * Список доступных шаблонов
 */
export async function handleListTemplates(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  return c.json({
    ok: true,
    templates: listTemplates(),
  });
}

/**
 * GET /redirects/presets
 * Список доступных пресетов
 */
export async function handleListPresets(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  return c.json({
    ok: true,
    presets: listPresets(),
  });
}

// ============================================================
// HANDLERS: LIST
// ============================================================

/**
 * GET /sites/:siteId/redirects
 * Список всех доменов сайта с редиректами и zone limits
 *
 * Возвращает ВСЕ домены сайта (с редиректами и без) для UI
 */
export async function handleListSiteRedirects(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const siteId = parseInt(c.req.param("siteId"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  // Проверяем что site принадлежит аккаунту
  const site = await env.DB301.prepare(
    `SELECT s.id, s.site_name, p.account_id
     FROM sites s
     JOIN projects p ON s.project_id = p.id
     WHERE s.id = ? AND p.account_id = ?`
  )
    .bind(siteId, auth.account_id)
    .first<{ id: number; site_name: string; account_id: number }>();

  if (!site) {
    return c.json({ ok: false, error: "site_not_found" }, 404);
  }

  // Получаем ВСЕ домены сайта с LEFT JOIN на redirect_rules
  const domainsWithRedirects = await env.DB301.prepare(
    `SELECT
       d.id as domain_id,
       d.domain_name,
       d.role as domain_role,
       d.zone_id,
       (SELECT domain_name FROM domains WHERE zone_id = d.zone_id AND parent_id IS NULL LIMIT 1) as zone_name,
       r.id as redirect_id,
       r.template_id,
       r.preset_id,
       r.preset_order,
       r.rule_name,
       r.params,
       r.status_code,
       r.enabled,
       r.sync_status,
       r.cf_rule_id,
       r.clicks_total,
       r.clicks_today,
       r.clicks_yesterday,
       r.created_at,
       r.updated_at
     FROM domains d
     LEFT JOIN redirect_rules r ON r.domain_id = d.id
     WHERE d.site_id = ? AND d.account_id = ?
     ORDER BY d.role DESC, d.domain_name, r.preset_order, r.id`
  )
    .bind(siteId, auth.account_id)
    .all<{
      domain_id: number;
      domain_name: string;
      domain_role: string;
      zone_id: number | null;
      zone_name: string | null;
      redirect_id: number | null;
      template_id: string | null;
      preset_id: string | null;
      preset_order: number | null;
      rule_name: string | null;
      params: string | null;
      status_code: number | null;
      enabled: number | null;
      sync_status: string | null;
      cf_rule_id: string | null;
      clicks_total: number | null;
      clicks_today: number | null;
      clicks_yesterday: number | null;
      created_at: string | null;
      updated_at: string | null;
    }>();

  // Получаем zone limits для всех зон в site
  const zoneLimits = await env.DB301.prepare(
    `SELECT z.id as zone_id,
            (SELECT domain_name FROM domains WHERE zone_id = z.id AND parent_id IS NULL LIMIT 1) as zone_name,
            COUNT(r.id) as used
     FROM zones z
     JOIN domains d ON d.zone_id = z.id
     LEFT JOIN redirect_rules r ON r.zone_id = z.id AND r.enabled = 1
     WHERE d.site_id = ? AND z.account_id = ?
     GROUP BY z.id`
  )
    .bind(siteId, auth.account_id)
    .all<{ zone_id: number; zone_name: string; used: number }>();

  // Форматируем ответ: группируем по доменам
  const formatted = (domainsWithRedirects.results || []).map((row) => ({
    domain_id: row.domain_id,
    domain_name: row.domain_name,
    domain_role: row.domain_role,
    zone_id: row.zone_id,
    zone_name: row.zone_name,
    redirect: row.redirect_id
      ? {
          id: row.redirect_id,
          template_id: row.template_id,
          preset_id: row.preset_id,
          preset_order: row.preset_order,
          rule_name: row.rule_name,
          params: JSON.parse(row.params || "{}"),
          status_code: row.status_code,
          enabled: row.enabled === 1,
          sync_status: row.sync_status || "never",
          cf_rule_id: row.cf_rule_id,
          clicks_total: row.clicks_total || 0,
          clicks_today: row.clicks_today || 0,
          clicks_yesterday: row.clicks_yesterday || 0,
          trend: calculateTrend(row.clicks_today || 0, row.clicks_yesterday || 0),
          created_at: row.created_at,
          updated_at: row.updated_at,
        }
      : null,
  }));

  const limits = (zoneLimits.results || []).map((z) => ({
    zone_id: z.zone_id,
    zone_name: z.zone_name,
    used: z.used,
    max: CF_FREE_PLAN_LIMIT,
  }));

  return c.json({
    ok: true,
    site_id: siteId,
    site_name: site.site_name,
    domains: formatted,
    zone_limits: limits,
    total_domains: new Set(formatted.map((d) => d.domain_id)).size,
    total_redirects: formatted.filter((d) => d.redirect !== null).length,
  });
}

/**
 * GET /domains/:domainId/redirects
 * Список редиректов для Domain
 */
export async function handleListDomainRedirects(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("domainId"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const domainCheck = await verifyDomainOwnership(env, domainId, auth.account_id);
  if (!domainCheck.ok) {
    return c.json({ ok: false, error: domainCheck.error }, 404);
  }

  const redirects = await env.DB301.prepare(
    `SELECT r.*, d.domain_name
     FROM redirect_rules r
     JOIN domains d ON r.domain_id = d.id
     WHERE r.domain_id = ? AND r.account_id = ?
     ORDER BY r.preset_order, r.id`
  )
    .bind(domainId, auth.account_id)
    .all<RedirectRecord>();

  // Zone limit
  const limitCheck = await checkZoneLimit(env, domainCheck.domain.zone_id, auth.account_id);

  const formatted = (redirects.results || []).map((r) => ({
    id: r.id,
    template_id: r.template_id,
    preset_id: r.preset_id,
    preset_order: r.preset_order,
    rule_name: r.rule_name,
    params: JSON.parse(r.params || "{}"),
    status_code: r.status_code,
    enabled: r.enabled === 1,
    sync_status: r.sync_status,
    clicks_total: r.clicks_total,
    clicks_today: r.clicks_today,
    trend: calculateTrend(r.clicks_today, r.clicks_yesterday),
    created_at: r.created_at,
  }));

  return c.json({
    ok: true,
    domain_id: domainId,
    domain_name: domainCheck.domain.domain_name,
    zone_id: domainCheck.domain.zone_id,
    zone_limit: {
      used: limitCheck.used,
      max: limitCheck.max,
    },
    redirects: formatted,
    total: formatted.length,
  });
}

// ============================================================
// HANDLERS: GET
// ============================================================

/**
 * GET /redirects/:id
 * Получить редирект по ID
 */
export async function handleGetRedirect(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const redirectId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const check = await verifyRedirectOwnership(env, redirectId, auth.account_id);
  if (!check.ok) {
    return c.json({ ok: false, error: check.error }, 404);
  }

  const r = check.redirect;

  return c.json({
    ok: true,
    redirect: {
      id: r.id,
      domain_id: r.domain_id,
      domain_name: r.domain_name,
      zone_id: r.zone_id,
      zone_name: r.zone_name,
      template_id: r.template_id,
      preset_id: r.preset_id,
      preset_order: r.preset_order,
      rule_name: r.rule_name,
      params: JSON.parse(r.params || "{}"),
      status_code: r.status_code,
      enabled: r.enabled === 1,
      sync_status: r.sync_status,
      cf_rule_id: r.cf_rule_id,
      cf_ruleset_id: r.cf_ruleset_id,
      last_synced_at: r.last_synced_at,
      last_error: r.last_error,
      clicks_total: r.clicks_total,
      clicks_today: r.clicks_today,
      clicks_yesterday: r.clicks_yesterday,
      trend: calculateTrend(r.clicks_today, r.clicks_yesterday),
      created_at: r.created_at,
      updated_at: r.updated_at,
    },
  });
}

// ============================================================
// HANDLERS: CREATE
// ============================================================

/**
 * POST /domains/:domainId/redirects
 * Создать редирект для домена
 */
export async function handleCreateRedirect(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("domainId"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  // Проверяем домен
  const domainCheck = await verifyDomainOwnership(env, domainId, auth.account_id);
  if (!domainCheck.ok) {
    return c.json({ ok: false, error: domainCheck.error }, 404);
  }

  const body = await c.req.json<CreateRedirectRequest>();
  const { template_id, rule_name, params, status_code } = body;

  // Валидация template
  const template = getTemplate(template_id);
  if (!template) {
    return c.json({ ok: false, error: "invalid_template", template_id }, 400);
  }

  // Валидация params
  const templateParams: TemplateParams = {
    source_domain: domainCheck.domain.domain_name,
    ...params,
  };

  const validation = validateTemplateParams(template_id, templateParams);
  if (!validation.valid) {
    return c.json({ ok: false, error: "invalid_params", details: validation.errors }, 400);
  }

  // Проверяем лимит зоны
  const limitCheck = await checkZoneLimit(env, domainCheck.domain.zone_id, auth.account_id);
  if (!limitCheck.ok) {
    return c.json({
      ok: false,
      error: limitCheck.error,
      zone_limit: { used: limitCheck.used, max: limitCheck.max },
    }, 400);
  }

  // Проверяем уникальность template на домене
  const isUnique = await checkTemplateUnique(env, domainId, template_id);
  if (!isUnique) {
    return c.json({ ok: false, error: "template_already_exists", template_id }, 400);
  }

  // Создаём запись
  const finalStatusCode = status_code || template.defaultStatusCode;

  const result = await env.DB301.prepare(
    `INSERT INTO redirect_rules 
     (account_id, domain_id, zone_id, template_id, rule_name, params, status_code, enabled, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending')
     RETURNING id, created_at`
  )
    .bind(
      auth.account_id,
      domainId,
      domainCheck.domain.zone_id,
      template_id,
      rule_name || `${template.name}: ${domainCheck.domain.domain_name}`,
      JSON.stringify(params || {}),
      finalStatusCode
    )
    .first<{ id: number; created_at: string }>();

  if (!result) {
    return c.json({ ok: false, error: "create_failed" }, 500);
  }

  // Обновляем роль домена на 'donor' только для шаблонов, меняющих трафик
  // T3/T4 (www canonical) не меняют роль
  let newDomainRole: string | undefined;
  if (DONOR_TEMPLATES.has(template_id)) {
    await env.DB301.prepare(
      `UPDATE domains SET role = 'donor', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(domainId)
      .run();
    newDomainRole = "donor";
  }

  return c.json({
    ok: true,
    redirect: {
      id: result.id,
      domain_id: domainId,
      domain_name: domainCheck.domain.domain_name,
      zone_id: domainCheck.domain.zone_id,
      template_id,
      rule_name: rule_name || `${template.name}: ${domainCheck.domain.domain_name}`,
      params,
      status_code: finalStatusCode,
      enabled: true,
      sync_status: "pending",
      created_at: result.created_at,
    },
    zone_limit: {
      used: limitCheck.used + 1,
      max: limitCheck.max,
    },
    domain_role: newDomainRole,
  }, 201);
}

/**
 * POST /domains/:domainId/redirects/preset
 * Создать редиректы из пресета
 */
export async function handleCreatePreset(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const domainId = parseInt(c.req.param("domainId"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  const domainCheck = await verifyDomainOwnership(env, domainId, auth.account_id);
  if (!domainCheck.ok) {
    return c.json({ ok: false, error: domainCheck.error }, 404);
  }

  const body = await c.req.json<CreatePresetRequest>();
  const { preset_id, params } = body;

  // Валидация preset
  const preset = getPreset(preset_id);
  if (!preset) {
    return c.json({ ok: false, error: "invalid_preset", preset_id }, 400);
  }

  // Разворачиваем пресет в правила
  const expandedRules = expandPreset(preset_id, domainCheck.domain.domain_name, params);
  if (!expandedRules || expandedRules.length === 0) {
    return c.json({ ok: false, error: "preset_expand_failed" }, 400);
  }

  // Проверяем лимит зоны
  const limitCheck = await checkZoneLimit(env, domainCheck.domain.zone_id, auth.account_id);
  if (limitCheck.used + expandedRules.length > limitCheck.max) {
    return c.json({
      ok: false,
      error: "zone_limit_exceeded",
      zone_limit: { used: limitCheck.used, max: limitCheck.max, needed: expandedRules.length },
    }, 400);
  }

  // Создаём все правила
  const createdIds: number[] = [];
  let hasDonorTemplate = false;

  for (const rule of expandedRules) {
    const template = getTemplate(rule.template_id);
    if (!template) continue;

    const result = await env.DB301.prepare(
      `INSERT INTO redirect_rules
       (account_id, domain_id, zone_id, template_id, preset_id, preset_order, rule_name, params, status_code, enabled, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending')
       RETURNING id`
    )
      .bind(
        auth.account_id,
        domainId,
        domainCheck.domain.zone_id,
        rule.template_id,
        preset_id,
        rule.order,
        rule.rule_name,
        JSON.stringify(rule.params),
        template.defaultStatusCode
      )
      .first<{ id: number }>();

    if (result) {
      createdIds.push(result.id);
      if (DONOR_TEMPLATES.has(rule.template_id)) {
        hasDonorTemplate = true;
      }
    }
  }

  // Обновляем роль домена на 'donor' только если есть шаблоны, меняющие трафик
  // T3/T4 (www canonical) не меняют роль
  let newDomainRole: string | undefined;
  if (hasDonorTemplate) {
    await env.DB301.prepare(
      `UPDATE domains SET role = 'donor', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(domainId)
      .run();
    newDomainRole = "donor";
  }

  return c.json({
    ok: true,
    preset_id,
    preset_name: preset.name,
    created_count: createdIds.length,
    redirect_ids: createdIds,
    zone_limit: {
      used: limitCheck.used + createdIds.length,
      max: limitCheck.max,
    },
    domain_role: newDomainRole,
  }, 201);
}

// ============================================================
// HANDLERS: UPDATE
// ============================================================

/**
 * PATCH /redirects/:id
 * Обновить редирект
 */
export async function handleUpdateRedirect(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const redirectId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  const check = await verifyRedirectOwnership(env, redirectId, auth.account_id);
  if (!check.ok) {
    return c.json({ ok: false, error: check.error }, 404);
  }

  const body = await c.req.json<UpdateRedirectRequest>();
  const updates: string[] = [];
  const bindings: (string | number)[] = [];

  if (body.rule_name !== undefined) {
    updates.push("rule_name = ?");
    bindings.push(body.rule_name);
  }

  if (body.params !== undefined) {
    // Валидация params
    const templateParams: TemplateParams = {
      source_domain: check.redirect.domain_name || "",
      ...body.params,
    };

    const validation = validateTemplateParams(check.redirect.template_id, templateParams);
    if (!validation.valid) {
      return c.json({ ok: false, error: "invalid_params", details: validation.errors }, 400);
    }

    updates.push("params = ?");
    bindings.push(JSON.stringify(body.params));
  }

  if (body.status_code !== undefined) {
    if (body.status_code !== 301 && body.status_code !== 302) {
      return c.json({ ok: false, error: "invalid_status_code" }, 400);
    }
    updates.push("status_code = ?");
    bindings.push(body.status_code);
  }

  if (body.enabled !== undefined) {
    updates.push("enabled = ?");
    bindings.push(body.enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    return c.json({ ok: false, error: "no_updates" }, 400);
  }

  // Помечаем как pending для пересинхронизации
  updates.push("sync_status = 'pending'");
  updates.push("updated_at = CURRENT_TIMESTAMP");

  bindings.push(redirectId);

  await env.DB301.prepare(
    `UPDATE redirect_rules SET ${updates.join(", ")} WHERE id = ?`
  )
    .bind(...bindings)
    .run();

  return c.json({
    ok: true,
    redirect_id: redirectId,
    sync_status: "pending",
  });
}

// ============================================================
// HANDLERS: DELETE
// ============================================================

/**
 * DELETE /redirects/:id
 * Удалить редирект
 */
export async function handleDeleteRedirect(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const redirectId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  const check = await verifyRedirectOwnership(env, redirectId, auth.account_id);
  if (!check.ok) {
    return c.json({ ok: false, error: check.error }, 404);
  }

  const domainId = check.redirect.domain_id;

  await env.DB301.prepare(
    `DELETE FROM redirect_rules WHERE id = ? AND account_id = ?`
  )
    .bind(redirectId, auth.account_id)
    .run();

  // Проверяем остались ли donor-редиректы у домена (T1, T5, T6, T7)
  // T3/T4 (www canonical) не влияют на роль
  const remainingDonor = await env.DB301.prepare(
    `SELECT COUNT(*) as count FROM redirect_rules
     WHERE domain_id = ? AND template_id IN ('T1', 'T5', 'T6', 'T7')`
  )
    .bind(domainId)
    .first<{ count: number }>();

  let newRole: string | undefined;

  // Если donor-редиректов больше нет — возвращаем роль в 'reserve'
  if (!remainingDonor || remainingDonor.count === 0) {
    await env.DB301.prepare(
      `UPDATE domains SET role = 'reserve', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(domainId)
      .run();
    newRole = "reserve";
  }

  return c.json({
    ok: true,
    deleted_id: redirectId,
    domain_id: domainId,
    domain_role: newRole,
  });
}

// ============================================================
// HANDLERS: ZONE LIMITS
// ============================================================

/**
 * GET /zones/:id/redirect-limits
 * Получить лимиты редиректов для зоны
 */
export async function handleGetZoneRedirectLimits(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireAuth(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  // Проверяем что зона принадлежит аккаунту и получаем root domain name
  const zone = await env.DB301.prepare(
    `SELECT z.id,
            (SELECT domain_name FROM domains WHERE zone_id = z.id AND parent_id IS NULL LIMIT 1) as zone_name
     FROM zones z
     WHERE z.id = ? AND z.account_id = ?`
  )
    .bind(zoneId, auth.account_id)
    .first<{ id: number; zone_name: string | null }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  const count = await env.DB301.prepare(
    `SELECT COUNT(*) as count FROM redirect_rules 
     WHERE zone_id = ? AND account_id = ? AND enabled = 1`
  )
    .bind(zoneId, auth.account_id)
    .first<{ count: number }>();

  return c.json({
    ok: true,
    zone_id: zoneId,
    zone_name: zone.zone_name,
    used: count?.count || 0,
    max: CF_FREE_PLAN_LIMIT,
    available: CF_FREE_PLAN_LIMIT - (count?.count || 0),
  });
}

