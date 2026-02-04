// src/api/redirects/cf-sync.ts

/**
 * Cloudflare Redirect Rules Sync
 *
 * Синхронизация redirect_rules из D1 → CF Redirect Rules API
 * 
 * Стратегия: Sync по зоне (не по правилу)
 * - 1 зона = 1 ruleset (phase: http_request_dynamic_redirect)
 * - PUT заменяет все правила зоны разом
 * - Кэшируем cf_ruleset_id в zones.cf_ruleset_id
 * 
 * CF вызовов:
 * - Первый apply: 2 (GET rulesets + POST ruleset)
 * - Повторный apply: 1 (PUT ruleset)
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireEditor } from "../lib/auth";
import { getDecryptedKey } from "../integrations/keys/storage";
import { buildExpression, buildTarget, getTemplate } from "./templates";

// ============================================================
// TYPES
// ============================================================

interface CFApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface CFRuleset {
  id: string;
  name: string;
  kind: string;
  phase: string;
  rules: CFRule[];
}

interface CFRule {
  id?: string;
  expression: string;
  action: "redirect";
  action_parameters: {
    from_value: {
      status_code: number;
      target_url: {
        expression: string;
      };
      preserve_query_string: boolean;
    };
  };
  description?: string;
  enabled: boolean;
}

interface RedirectRuleRecord {
  id: number;
  domain_id: number;
  template_id: string;
  rule_name: string;
  params: string;
  status_code: number;
  enabled: number;
  cf_rule_id: string | null;
  // Joined
  domain_name: string;
}

interface ZoneRecord {
  id: number;
  cf_zone_id: string;
  cf_ruleset_id: string | null;
  key_id: number;
}

interface ApplyResult {
  zone_id: number;
  cf_zone_id: string;
  rules_applied: number;
  cf_ruleset_id: string;
  synced_rules: Array<{ id: number; cf_rule_id: string }>;
  errors: string[];
}

// ============================================================
// CONSTANTS
// ============================================================

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const REDIRECT_PHASE = "http_request_dynamic_redirect";

// ============================================================
// CF API HELPERS
// ============================================================

/**
 * GET /zones/{zone_id}/rulesets — получить все rulesets зоны
 */
async function cfGetRulesets(
  cfZoneId: string,
  token: string
): Promise<{ ok: true; rulesets: CFRuleset[] } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/rulesets`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as CFApiResponse<CFRuleset[]>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to get rulesets" };
    }

    return { ok: true, rulesets: data.result || [] };
  } catch (e) {
    return { ok: false, error: `CF API request failed: ${e}` };
  }
}

/**
 * POST /zones/{zone_id}/rulesets — создать новый ruleset
 */
async function cfCreateRuleset(
  cfZoneId: string,
  rules: CFRule[],
  token: string
): Promise<{ ok: true; ruleset: CFRuleset } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/rulesets`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "301.st Redirects",
          kind: "zone",
          phase: REDIRECT_PHASE,
          rules,
        }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFRuleset>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to create ruleset" };
    }

    return { ok: true, ruleset: data.result };
  } catch (e) {
    return { ok: false, error: `CF API request failed: ${e}` };
  }
}

/**
 * PUT /zones/{zone_id}/rulesets/{ruleset_id} — заменить все правила ruleset
 */
async function cfUpdateRuleset(
  cfZoneId: string,
  rulesetId: string,
  rules: CFRule[],
  token: string
): Promise<{ ok: true; ruleset: CFRuleset } | { ok: false; error: string }> {
  try {
    const response = await fetch(
      `${CF_API_BASE}/zones/${cfZoneId}/rulesets/${rulesetId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rules,
        }),
      }
    );

    const data = (await response.json()) as CFApiResponse<CFRuleset>;

    if (!response.ok || !data.success) {
      return { ok: false, error: data.errors?.[0]?.message || "Failed to update ruleset" };
    }

    return { ok: true, ruleset: data.result };
  } catch (e) {
    return { ok: false, error: `CF API request failed: ${e}` };
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Найти redirect ruleset в списке rulesets
 */
function findRedirectRuleset(rulesets: CFRuleset[]): CFRuleset | null {
  return rulesets.find((r) => r.phase === REDIRECT_PHASE) || null;
}

/**
 * Преобразовать наше правило в CF Rule
 */
function toСFRule(rule: RedirectRuleRecord): CFRule | null {
  const template = getTemplate(rule.template_id);
  if (!template) return null;

  const params = JSON.parse(rule.params || "{}");
  params.source_domain = rule.domain_name;

  const expression = buildExpression(rule.template_id, params);
  const target = buildTarget(rule.template_id, params);

  if (!expression || !target) return null;

  return {
    expression,
    action: "redirect",
    action_parameters: {
      from_value: {
        status_code: rule.status_code,
        target_url: {
          expression: target,
        },
        preserve_query_string: template.preserveQuery,
      },
    },
    description: rule.rule_name,
    enabled: rule.enabled === 1,
  };
}

/**
 * Получить зону с токеном
 */
async function getZoneWithToken(
  env: Env,
  zoneId: number,
  accountId: number
): Promise<{ ok: true; zone: ZoneRecord; token: string } | { ok: false; error: string }> {
  const zone = await env.DB301.prepare(
    `SELECT id, cf_zone_id, cf_ruleset_id, key_id
     FROM zones
     WHERE id = ? AND account_id = ?`
  )
    .bind(zoneId, accountId)
    .first<ZoneRecord>();

  if (!zone) {
    return { ok: false, error: "zone_not_found" };
  }

  if (!zone.cf_zone_id) {
    return { ok: false, error: "zone_not_activated" };
  }

  if (!zone.key_id) {
    return { ok: false, error: "zone_no_key" };
  }

  let keyData;
  try {
    keyData = await getDecryptedKey(env, zone.key_id);
  } catch (e: any) {
    return { ok: false, error: e.message || "key_decrypt_failed" };
  }

  if (!keyData) {
    return { ok: false, error: "key_invalid" };
  }

  return { ok: true, zone, token: keyData.secrets.token };
}

// ============================================================
// CORE: APPLY ZONE REDIRECTS
// ============================================================

/**
 * Применить все redirect rules зоны в CF
 */
async function applyZoneRedirects(
  env: Env,
  zoneId: number,
  accountId: number
): Promise<ApplyResult> {
  const result: ApplyResult = {
    zone_id: zoneId,
    cf_zone_id: "",
    rules_applied: 0,
    cf_ruleset_id: "",
    synced_rules: [],
    errors: [],
  };

  // 1. Получаем зону и токен
  const zoneData = await getZoneWithToken(env, zoneId, accountId);
  if (!zoneData.ok) {
    result.errors.push(zoneData.error);
    return result;
  }

  const { zone, token } = zoneData;
  result.cf_zone_id = zone.cf_zone_id;

  // 2. Получаем все enabled правила зоны
  const rules = await env.DB301.prepare(
    `SELECT r.id, r.domain_id, r.template_id, r.rule_name, r.params, 
            r.status_code, r.enabled, r.cf_rule_id, d.domain_name
     FROM redirect_rules r
     JOIN domains d ON r.domain_id = d.id
     WHERE r.zone_id = ? AND r.account_id = ? AND r.enabled = 1
     ORDER BY r.id`
  )
    .bind(zoneId, accountId)
    .all<RedirectRuleRecord>();

  // 3. Преобразуем в CF формат
  const cfRules: CFRule[] = [];
  const ruleMapping: Map<number, number> = new Map(); // index → rule.id

  for (const rule of rules.results || []) {
    const cfRule = toСFRule(rule);
    if (cfRule) {
      ruleMapping.set(cfRules.length, rule.id);
      cfRules.push(cfRule);
    } else {
      result.errors.push(`Failed to build CF rule for redirect_rule.id=${rule.id}`);
    }
  }

  // 4. Применяем в CF
  let cfRuleset: CFRuleset | null = null;

  // Если нет enabled правил и нет существующего ruleset — нечего применять
  if (cfRules.length === 0 && !zone.cf_ruleset_id) {
    // Помечаем disabled правила как synced
    await env.DB301.prepare(
      `UPDATE redirect_rules
       SET sync_status = 'synced', last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE zone_id = ? AND account_id = ? AND enabled = 0 AND sync_status = 'pending'`
    )
      .bind(zoneId, accountId)
      .run();

    return result; // Success, nothing to apply
  }

  if (zone.cf_ruleset_id) {
    // Обновляем существующий ruleset (1 CF вызов)
    const updateResult = await cfUpdateRuleset(zone.cf_zone_id, zone.cf_ruleset_id, cfRules, token);
    
    if (updateResult.ok) {
      cfRuleset = updateResult.ruleset;
    } else {
      // Ruleset мог быть удалён — пробуем создать новый
      result.errors.push(`Update failed: ${updateResult.error}, trying to create new`);
      zone.cf_ruleset_id = null;
    }
  }

  if (!zone.cf_ruleset_id) {
    // Ищем существующий ruleset или создаём новый (2 CF вызова)
    const listResult = await cfGetRulesets(zone.cf_zone_id, token);
    
    if (!listResult.ok) {
      result.errors.push(`Failed to list rulesets: ${listResult.error}`);
      return result;
    }

    const existingRuleset = findRedirectRuleset(listResult.rulesets);

    if (existingRuleset) {
      // Обновляем найденный
      const updateResult = await cfUpdateRuleset(zone.cf_zone_id, existingRuleset.id, cfRules, token);
      
      if (updateResult.ok) {
        cfRuleset = updateResult.ruleset;
      } else {
        result.errors.push(`Failed to update existing ruleset: ${updateResult.error}`);
        return result;
      }
    } else {
      // Создаём новый
      const createResult = await cfCreateRuleset(zone.cf_zone_id, cfRules, token);
      
      if (createResult.ok) {
        cfRuleset = createResult.ruleset;
      } else {
        result.errors.push(`Failed to create ruleset: ${createResult.error}`);
        return result;
      }
    }
  }

  if (!cfRuleset) {
    result.errors.push("No ruleset after apply");
    return result;
  }

  result.cf_ruleset_id = cfRuleset.id;
  result.rules_applied = cfRuleset.rules.length;

  // 5. Обновляем cf_ruleset_id в zones (кэш)
  if (zone.cf_ruleset_id !== cfRuleset.id) {
    await env.DB301.prepare(
      `UPDATE zones SET cf_ruleset_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(cfRuleset.id, zoneId)
      .run();
  }

  // 6. Обновляем cf_rule_id и sync_status в redirect_rules
  for (let i = 0; i < cfRuleset.rules.length; i++) {
    const cfRule = cfRuleset.rules[i];
    const ruleId = ruleMapping.get(i);

    if (ruleId && cfRule.id) {
      await env.DB301.prepare(
        `UPDATE redirect_rules 
         SET cf_rule_id = ?, cf_ruleset_id = ?, sync_status = 'synced', 
             last_synced_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
        .bind(cfRule.id, cfRuleset.id, ruleId)
        .run();

      result.synced_rules.push({ id: ruleId, cf_rule_id: cfRule.id });
    }
  }

  // 7. Помечаем disabled правила как synced (они не в CF)
  await env.DB301.prepare(
    `UPDATE redirect_rules 
     SET sync_status = 'synced', last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE zone_id = ? AND account_id = ? AND enabled = 0 AND sync_status = 'pending'`
  )
    .bind(zoneId, accountId)
    .run();

  return result;
}

// ============================================================
// HANDLERS
// ============================================================

/**
 * POST /zones/:id/apply-redirects
 * Применить все redirect rules зоны в CF
 */
export async function handleApplyZoneRedirects(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  const result = await applyZoneRedirects(env, zoneId, auth.account_id);

  if (result.errors.length > 0 && result.rules_applied === 0) {
    return c.json({
      ok: false,
      error: "apply_failed",
      details: result.errors,
    }, 500);
  }

  return c.json({
    ok: true,
    zone_id: result.zone_id,
    cf_zone_id: result.cf_zone_id,
    cf_ruleset_id: result.cf_ruleset_id,
    rules_applied: result.rules_applied,
    synced_rules: result.synced_rules,
    warnings: result.errors.length > 0 ? result.errors : undefined,
  });
}

/**
 * GET /zones/:id/redirect-status
 * Статус синхронизации редиректов зоны
 */
export async function handleGetZoneRedirectStatus(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const zoneId = parseInt(c.req.param("id"));

  const auth = await requireEditor(c, env);
  if (!auth) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }

  // Получаем зону
  const zone = await env.DB301.prepare(
    `SELECT id, cf_zone_id, cf_ruleset_id FROM zones WHERE id = ? AND account_id = ?`
  )
    .bind(zoneId, auth.account_id)
    .first<{ id: number; cf_zone_id: string; cf_ruleset_id: string | null }>();

  if (!zone) {
    return c.json({ ok: false, error: "zone_not_found" }, 404);
  }

  // Считаем статусы правил
  const stats = await env.DB301.prepare(
    `SELECT 
       sync_status,
       COUNT(*) as count
     FROM redirect_rules
     WHERE zone_id = ? AND account_id = ?
     GROUP BY sync_status`
  )
    .bind(zoneId, auth.account_id)
    .all<{ sync_status: string; count: number }>();

  const statusCounts: Record<string, number> = {
    pending: 0,
    synced: 0,
    error: 0,
  };

  for (const row of stats.results || []) {
    statusCounts[row.sync_status] = row.count;
  }

  const total = statusCounts.pending + statusCounts.synced + statusCounts.error;

  return c.json({
    ok: true,
    zone_id: zoneId,
    cf_zone_id: zone.cf_zone_id,
    cf_ruleset_id: zone.cf_ruleset_id,
    has_ruleset: !!zone.cf_ruleset_id,
    rules: {
      total,
      pending: statusCounts.pending,
      synced: statusCounts.synced,
      error: statusCounts.error,
    },
    needs_apply: statusCounts.pending > 0,
  });
}

