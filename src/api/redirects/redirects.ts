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
    `SELECT r.*, d.domain_name, z.zone_name
     FROM redirect_rules r
     JOIN domains d ON r.domain_id = d.id
     LEFT JOIN zones z ON r.zone_id = z.id
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
 * Список редиректов для Site с zone limits
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

  // Получаем редиректы через domains, привязанные к site
  const redirects = await env.DB301.prepare(
    `SELECT r.*, d.domain_name, z.zone_name
     FROM redirect_rules r
     JOIN domains d ON r.domain_id = d.id
     LEFT JOIN zones z ON r.zone_id = z.id
     WHERE d.site_id = ? AND r.account_id = ?
     ORDER BY d.domain_name, r.preset_order, r.id`
  )
    .bind(siteId, auth.account_id)
    .all<RedirectRecord>();

  // Получаем zone limits для всех зон в site
  const zoneLimits = await env.DB301.prepare(
    `SELECT z.id as zone_id, z.zone_name,
            COUNT(r.id) as used
     FROM zones z
     JOIN domains d ON d.zone_id = z.id
     LEFT JOIN redirect_rules r ON r.zone_id = z.id AND r.enabled = 1
     WHERE d.site_id = ? AND z.account_id = ?
     GROUP BY z.id`
  )
    .bind(siteId, auth.account_id)
    .all<{ zone_id: number; zone_name: string; used: number }>();

  // Форматируем ответ
  const formatted = (redirects.results || []).map((r) => ({
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
    clicks_total: r.clicks_total,
    clicks_today: r.clicks_today,
    clicks_yesterday: r.clicks_yesterday,
    trend: calculateTrend(r.clicks_today, r.clicks_yesterday),
    created_at: r.created_at,
    updated_at: r.updated_at,
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
    redirects: formatted,
    zone_limits: limits,
    total: formatted.length,
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
    `SELECT r.*, d.domain_name, z.zone_name
     FROM redirect_rules r
     JOIN domains d ON r.domain_id = d.id
     LEFT JOIN zones z ON r.zone_id = z.id
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
    }
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

  await env.DB301.prepare(
    `DELETE FROM redirect_rules WHERE id = ? AND account_id = ?`
  )
    .bind(redirectId, auth.account_id)
    .run();

  return c.json({
    ok: true,
    deleted_id: redirectId,
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

  // Проверяем что зона принадлежит аккаунту
  const zone = await env.DB301.prepare(
    `SELECT id, zone_name FROM zones WHERE id = ? AND account_id = ?`
  )
    .bind(zoneId, auth.account_id)
    .first<{ id: number; zone_name: string }>();

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

