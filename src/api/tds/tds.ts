// src/api/tds/tds.ts

/**
 * TDS Rules API
 *
 * CRUD operations for TDS rules.
 * Rules are stored in DB301.tds_rules and mapped to domains via rule_domain_map.
 * Client Workers pull rules via /tds/sync endpoint (see sync.ts).
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireAuth, requireEditor } from "../lib/auth";
import {
  createRuleSchema,
  updateRuleSchema,
  bindDomainsSchema,
  reorderSchema,
  createFromPresetSchema,
} from "./conditions";
import { listTdsPresets, expandTdsPreset } from "./presets";
import { ensureClientEnvironment } from "../client-env/middleware";

// ============================================================
// TYPES
// ============================================================

interface TdsRuleRecord {
  id: number;
  account_id: number;
  rule_name: string;
  tds_type: string;
  logic_json: string;
  priority: number;
  status: string;
  preset_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// HELPERS
// ============================================================

async function verifyRuleOwnership(
  env: Env,
  ruleId: number,
  accountId: number,
): Promise<{ ok: true; rule: TdsRuleRecord } | { ok: false; error: string }> {
  const rule = await env.DB301.prepare(
    "SELECT * FROM tds_rules WHERE id = ? AND account_id = ?",
  )
    .bind(ruleId, accountId)
    .first<TdsRuleRecord>();

  if (!rule) return { ok: false, error: "rule_not_found" };
  return { ok: true, rule };
}

async function verifyDomainOwnership(
  env: Env,
  domainId: number,
  accountId: number,
): Promise<{ ok: true; domain: { id: number; domain_name: string; zone_id: number } } | { ok: false; error: string }> {
  const domain = await env.DB301.prepare(
    "SELECT id, domain_name, zone_id FROM domains WHERE id = ? AND account_id = ?",
  )
    .bind(domainId, accountId)
    .first<{ id: number; domain_name: string; zone_id: number }>();

  if (!domain) return { ok: false, error: "domain_not_found" };
  return { ok: true, domain };
}

function formatRule(r: TdsRuleRecord) {
  return {
    id: r.id,
    rule_name: r.rule_name,
    tds_type: r.tds_type,
    logic_json: JSON.parse(r.logic_json),
    priority: r.priority,
    status: r.status,
    preset_id: r.preset_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ============================================================
// HANDLERS: PRESETS & PARAMS
// ============================================================

/**
 * GET /tds/presets
 * List available TDS presets for UI.
 */
export async function handleListTdsPresets(c: Context<{ Bindings: Env }>) {
  const auth = await requireAuth(c, c.env);
  if (!auth) return c.json({ ok: false, error: "unauthorized" }, 401);

  return c.json({ ok: true, presets: listTdsPresets() });
}

/**
 * GET /tds/params
 * List available TDS parameters from tds_params table.
 */
export async function handleListTdsParams(c: Context<{ Bindings: Env }>) {
  const auth = await requireAuth(c, c.env);
  if (!auth) return c.json({ ok: false, error: "unauthorized" }, 401);

  const rows = await c.env.DB301.prepare(
    "SELECT param_key, category, description FROM tds_params WHERE is_active = 1 ORDER BY category, param_key",
  ).all<{ param_key: string; category: string; description: string }>();

  return c.json({ ok: true, params: rows.results });
}

// ============================================================
// HANDLERS: LIST & GET
// ============================================================

/**
 * GET /tds/rules
 * List all TDS rules for account.
 */
export async function handleListTdsRules(c: Context<{ Bindings: Env }>) {
  const auth = await requireAuth(c, c.env);
  if (!auth) return c.json({ ok: false, error: "unauthorized" }, 401);

  const rules = await c.env.DB301.prepare(
    "SELECT * FROM tds_rules WHERE account_id = ? ORDER BY priority DESC, id",
  )
    .bind(auth.account_id)
    .all<TdsRuleRecord>();

  // Get domain bindings count for each rule
  const ruleIds = rules.results.map((r) => r.id);
  let bindingCounts: Record<number, number> = {};
  if (ruleIds.length > 0) {
    const bindings = await c.env.DB301.prepare(
      `SELECT tds_rule_id, COUNT(*) as count FROM rule_domain_map
       WHERE tds_rule_id IN (${ruleIds.map(() => "?").join(",")})
       AND binding_status != 'removed'
       GROUP BY tds_rule_id`,
    )
      .bind(...ruleIds)
      .all<{ tds_rule_id: number; count: number }>();

    for (const b of bindings.results) {
      bindingCounts[b.tds_rule_id] = b.count;
    }
  }

  return c.json({
    ok: true,
    rules: rules.results.map((r) => ({
      ...formatRule(r),
      domain_count: bindingCounts[r.id] || 0,
    })),
    total: rules.results.length,
  });
}

/**
 * GET /tds/rules/:id
 * Get single TDS rule with domain bindings.
 */
export async function handleGetTdsRule(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const auth = await requireAuth(c, c.env);
  if (!auth) return c.json({ ok: false, error: "unauthorized" }, 401);

  const check = await verifyRuleOwnership(c.env, ruleId, auth.account_id);
  if (!check.ok) return c.json({ ok: false, error: check.error }, 404);

  // Get domain bindings
  const bindings = await c.env.DB301.prepare(
    `SELECT rdm.id, rdm.domain_id, rdm.enabled, rdm.binding_status,
            rdm.last_synced_at, rdm.last_error, rdm.created_at,
            d.domain_name
     FROM rule_domain_map rdm
     JOIN domains d ON rdm.domain_id = d.id
     WHERE rdm.tds_rule_id = ? AND rdm.account_id = ? AND rdm.binding_status != 'removed'
     ORDER BY d.domain_name`,
  )
    .bind(ruleId, auth.account_id)
    .all<{
      id: number;
      domain_id: number;
      enabled: number;
      binding_status: string;
      last_synced_at: string | null;
      last_error: string | null;
      created_at: string;
      domain_name: string;
    }>();

  return c.json({
    ok: true,
    rule: formatRule(check.rule),
    domains: bindings.results.map((b) => ({
      binding_id: b.id,
      domain_id: b.domain_id,
      domain_name: b.domain_name,
      enabled: b.enabled === 1,
      binding_status: b.binding_status,
      last_synced_at: b.last_synced_at,
      last_error: b.last_error,
      created_at: b.created_at,
    })),
  });
}

// ============================================================
// HANDLERS: CREATE
// ============================================================

/**
 * POST /tds/rules
 * Create TDS rule manually.
 */
export async function handleCreateTdsRule(c: Context<{ Bindings: Env }>) {
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  // Ensure client environment (non-blocking: continue even if setup fails)
  const envCheck = await ensureClientEnvironment(c.env, auth.account_id);
  if (!envCheck.ok && envCheck.error !== "cloudflare_integration_required") {
    console.warn("[tds] Client env setup failed:", envCheck.error);
  }

  const body = await c.req.json();
  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: "validation_error",
      details: parsed.error.issues.map((i) => i.message),
    }, 400);
  }

  const { rule_name, tds_type, logic_json, priority } = parsed.data;

  const result = await c.env.DB301.prepare(
    `INSERT INTO tds_rules (account_id, rule_name, tds_type, logic_json, priority, status)
     VALUES (?, ?, ?, ?, ?, 'draft')
     RETURNING id, created_at, updated_at`,
  )
    .bind(
      auth.account_id,
      rule_name,
      tds_type,
      JSON.stringify(logic_json),
      priority,
    )
    .first<{ id: number; created_at: string; updated_at: string }>();

  if (!result) return c.json({ ok: false, error: "create_failed" }, 500);

  return c.json({
    ok: true,
    rule: {
      id: result.id,
      rule_name,
      tds_type,
      logic_json,
      priority,
      status: "draft",
      preset_id: null,
      created_at: result.created_at,
      updated_at: result.updated_at,
    },
  }, 201);
}

/**
 * POST /tds/rules/from-preset
 * Create TDS rule from preset.
 */
export async function handleCreateFromPreset(c: Context<{ Bindings: Env }>) {
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  const body = await c.req.json();
  const parsed = createFromPresetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: "validation_error",
      details: parsed.error.issues.map((i) => i.message),
    }, 400);
  }

  const { preset_id, params, domain_ids, rule_name } = parsed.data;

  // Expand preset
  const expanded = expandTdsPreset(preset_id, {
    ...params as any,
    rule_name,
  });
  if ("error" in expanded) {
    return c.json({ ok: false, error: expanded.error }, 400);
  }

  // Insert rule
  const result = await c.env.DB301.prepare(
    `INSERT INTO tds_rules (account_id, rule_name, tds_type, logic_json, priority, status, preset_id)
     VALUES (?, ?, ?, ?, ?, 'draft', ?)
     RETURNING id, created_at, updated_at`,
  )
    .bind(
      auth.account_id,
      expanded.rule_name,
      expanded.tds_type,
      JSON.stringify(expanded.logic_json),
      expanded.priority,
      expanded.preset_id,
    )
    .first<{ id: number; created_at: string; updated_at: string }>();

  if (!result) return c.json({ ok: false, error: "create_failed" }, 500);

  // Bind domains if provided
  let boundDomains: number[] = [];
  if (domain_ids && domain_ids.length > 0) {
    for (const domainId of domain_ids) {
      const domainCheck = await verifyDomainOwnership(c.env, domainId, auth.account_id);
      if (!domainCheck.ok) continue;

      await c.env.DB301.prepare(
        `INSERT INTO rule_domain_map (account_id, tds_rule_id, domain_id, enabled, binding_status)
         VALUES (?, ?, ?, 1, 'pending')`,
      )
        .bind(auth.account_id, result.id, domainId)
        .run();

      boundDomains.push(domainId);
    }

    // Update status to active if domains bound
    if (boundDomains.length > 0) {
      await c.env.DB301.prepare(
        "UPDATE tds_rules SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(result.id)
        .run();
    }
  }

  return c.json({
    ok: true,
    rule: {
      id: result.id,
      rule_name: expanded.rule_name,
      tds_type: expanded.tds_type,
      logic_json: expanded.logic_json,
      priority: expanded.priority,
      status: boundDomains.length > 0 ? "active" : "draft",
      preset_id: expanded.preset_id,
      created_at: result.created_at,
      updated_at: result.updated_at,
    },
    bound_domains: boundDomains,
  }, 201);
}

// ============================================================
// HANDLERS: UPDATE
// ============================================================

/**
 * PATCH /tds/rules/:id
 * Update TDS rule.
 */
export async function handleUpdateTdsRule(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  const check = await verifyRuleOwnership(c.env, ruleId, auth.account_id);
  if (!check.ok) return c.json({ ok: false, error: check.error }, 404);

  const body = await c.req.json();
  const parsed = updateRuleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: "validation_error",
      details: parsed.error.issues.map((i) => i.message),
    }, 400);
  }

  const updates: string[] = [];
  const bindings: (string | number)[] = [];

  if (parsed.data.rule_name !== undefined) {
    updates.push("rule_name = ?");
    bindings.push(parsed.data.rule_name);
  }
  if (parsed.data.tds_type !== undefined) {
    updates.push("tds_type = ?");
    bindings.push(parsed.data.tds_type);
  }
  if (parsed.data.logic_json !== undefined) {
    updates.push("logic_json = ?");
    bindings.push(JSON.stringify(parsed.data.logic_json));
  }
  if (parsed.data.priority !== undefined) {
    updates.push("priority = ?");
    bindings.push(parsed.data.priority);
  }
  if (parsed.data.status !== undefined) {
    updates.push("status = ?");
    bindings.push(parsed.data.status);
  }

  if (updates.length === 0) {
    return c.json({ ok: false, error: "no_updates" }, 400);
  }

  updates.push("updated_at = CURRENT_TIMESTAMP");
  bindings.push(ruleId);

  await c.env.DB301.prepare(
    `UPDATE tds_rules SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...bindings)
    .run();

  // Mark bindings as pending re-sync
  await c.env.DB301.prepare(
    `UPDATE rule_domain_map SET binding_status = 'pending', updated_at = CURRENT_TIMESTAMP
     WHERE tds_rule_id = ? AND binding_status = 'applied'`,
  )
    .bind(ruleId)
    .run();

  return c.json({ ok: true, rule_id: ruleId });
}

/**
 * PATCH /tds/rules/reorder
 * Bulk update priorities.
 */
export async function handleReorderTdsRules(c: Context<{ Bindings: Env }>) {
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  const body = await c.req.json();
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: "validation_error",
      details: parsed.error.issues.map((i) => i.message),
    }, 400);
  }

  const stmts = parsed.data.rules.map((r) =>
    c.env.DB301.prepare(
      "UPDATE tds_rules SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
    ).bind(r.priority, r.id, auth.account_id),
  );

  await c.env.DB301.batch(stmts);

  return c.json({ ok: true, updated: parsed.data.rules.length });
}

// ============================================================
// HANDLERS: DELETE
// ============================================================

/**
 * DELETE /tds/rules/:id
 * Delete TDS rule and cascade rule_domain_map.
 */
export async function handleDeleteTdsRule(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  const check = await verifyRuleOwnership(c.env, ruleId, auth.account_id);
  if (!check.ok) return c.json({ ok: false, error: check.error }, 404);

  // Mark bindings as removed (FK cascade will also handle, but explicit is better)
  await c.env.DB301.prepare(
    "UPDATE rule_domain_map SET binding_status = 'removed', updated_at = CURRENT_TIMESTAMP WHERE tds_rule_id = ?",
  )
    .bind(ruleId)
    .run();

  // Delete rule
  await c.env.DB301.prepare(
    "DELETE FROM tds_rules WHERE id = ? AND account_id = ?",
  )
    .bind(ruleId, auth.account_id)
    .run();

  return c.json({ ok: true, deleted_id: ruleId });
}

// ============================================================
// HANDLERS: DOMAIN BINDINGS
// ============================================================

/**
 * POST /tds/rules/:id/domains
 * Bind rule to domains.
 */
export async function handleBindDomains(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  const check = await verifyRuleOwnership(c.env, ruleId, auth.account_id);
  if (!check.ok) return c.json({ ok: false, error: check.error }, 404);

  const body = await c.req.json();
  const parsed = bindDomainsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: "validation_error",
      details: parsed.error.issues.map((i) => i.message),
    }, 400);
  }

  const bound: number[] = [];
  const errors: Array<{ domain_id: number; error: string }> = [];

  for (const domainId of parsed.data.domain_ids) {
    const domainCheck = await verifyDomainOwnership(c.env, domainId, auth.account_id);
    if (!domainCheck.ok) {
      errors.push({ domain_id: domainId, error: domainCheck.error });
      continue;
    }

    // Check if binding already exists
    const existing = await c.env.DB301.prepare(
      `SELECT id FROM rule_domain_map
       WHERE tds_rule_id = ? AND domain_id = ? AND binding_status != 'removed'`,
    )
      .bind(ruleId, domainId)
      .first();

    if (existing) {
      errors.push({ domain_id: domainId, error: "already_bound" });
      continue;
    }

    await c.env.DB301.prepare(
      `INSERT INTO rule_domain_map (account_id, tds_rule_id, domain_id, enabled, binding_status)
       VALUES (?, ?, ?, 1, 'pending')`,
    )
      .bind(auth.account_id, ruleId, domainId)
      .run();

    bound.push(domainId);
  }

  // Activate rule if it was draft and now has bindings
  if (bound.length > 0 && check.rule.status === "draft") {
    await c.env.DB301.prepare(
      "UPDATE tds_rules SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(ruleId)
      .run();
  }

  return c.json({
    ok: true,
    bound: bound,
    errors: errors.length > 0 ? errors : undefined,
  }, 201);
}

/**
 * DELETE /tds/rules/:id/domains/:domainId
 * Unbind rule from domain.
 */
export async function handleUnbindDomain(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const domainId = parseInt(c.req.param("domainId"));
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  const check = await verifyRuleOwnership(c.env, ruleId, auth.account_id);
  if (!check.ok) return c.json({ ok: false, error: check.error }, 404);

  await c.env.DB301.prepare(
    `UPDATE rule_domain_map SET binding_status = 'removed', updated_at = CURRENT_TIMESTAMP
     WHERE tds_rule_id = ? AND domain_id = ? AND account_id = ?`,
  )
    .bind(ruleId, domainId, auth.account_id)
    .run();

  return c.json({ ok: true, rule_id: ruleId, domain_id: domainId });
}

/**
 * GET /tds/rules/:id/domains
 * List domain bindings for a rule.
 */
export async function handleListRuleDomains(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const auth = await requireAuth(c, c.env);
  if (!auth) return c.json({ ok: false, error: "unauthorized" }, 401);

  const check = await verifyRuleOwnership(c.env, ruleId, auth.account_id);
  if (!check.ok) return c.json({ ok: false, error: check.error }, 404);

  const bindings = await c.env.DB301.prepare(
    `SELECT rdm.id, rdm.domain_id, rdm.enabled, rdm.binding_status,
            rdm.schedule_start, rdm.schedule_end,
            rdm.last_synced_at, rdm.last_error, rdm.created_at,
            d.domain_name
     FROM rule_domain_map rdm
     JOIN domains d ON rdm.domain_id = d.id
     WHERE rdm.tds_rule_id = ? AND rdm.account_id = ? AND rdm.binding_status != 'removed'
     ORDER BY d.domain_name`,
  )
    .bind(ruleId, auth.account_id)
    .all<{
      id: number;
      domain_id: number;
      enabled: number;
      binding_status: string;
      schedule_start: string | null;
      schedule_end: string | null;
      last_synced_at: string | null;
      last_error: string | null;
      created_at: string;
      domain_name: string;
    }>();

  return c.json({
    ok: true,
    rule_id: ruleId,
    domains: bindings.results.map((b) => ({
      binding_id: b.id,
      domain_id: b.domain_id,
      domain_name: b.domain_name,
      enabled: b.enabled === 1,
      binding_status: b.binding_status,
      schedule_start: b.schedule_start,
      schedule_end: b.schedule_end,
      last_synced_at: b.last_synced_at,
      last_error: b.last_error,
      created_at: b.created_at,
    })),
    total: bindings.results.length,
  });
}
