// src/api/tds/tds.ts

/**
 * TDS Rules API
 *
 * CRUD operations for TDS rules.
 * Rules are stored in DB301.tds_rules with site_id FK (site-scoped).
 * Client Workers pull rules via /tds/sync endpoint (see sync.ts).
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { requireAuth, requireEditor } from "../lib/auth";
import {
  createRuleSchema,
  updateRuleSchema,
  reorderSchema,
  createFromPresetSchema,
} from "./conditions";
import { listTdsPresetsLocalized, expandTdsPreset } from "./presets";
import { detectLang } from "../lib/messaging/i18n";
import { ensureClientEnvironment } from "../client-env/middleware";
import { listKeys } from "../integrations/keys/storage";
import {
  getClientSyncInfo,
  syncTDSRules,
  syncDomainConfig,
  type TDSRule,
  type DomainConfig,
} from "../integrations/providers/cloudflare/d1-sync";

// ============================================================
// TYPES
// ============================================================

interface TdsRuleRecord {
  id: number;
  account_id: number;
  site_id: number | null;
  rule_name: string;
  tds_type: string;
  logic_json: string;
  priority: number;
  status: string;
  sync_status: string;
  last_synced_at: string | null;
  last_error: string | null;
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

function formatRule(r: TdsRuleRecord) {
  return {
    id: r.id,
    site_id: r.site_id,
    rule_name: r.rule_name,
    tds_type: r.tds_type,
    logic_json: JSON.parse(r.logic_json),
    priority: r.priority,
    status: r.status,
    sync_status: r.sync_status,
    last_synced_at: r.last_synced_at,
    last_error: r.last_error,
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

  const lang = detectLang(c.req.header("Accept-Language"));
  return c.json({ ok: true, presets: listTdsPresetsLocalized(lang) });
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
 * Optional query param: site_id — filter by site.
 */
export async function handleListTdsRules(c: Context<{ Bindings: Env }>) {
  const auth = await requireAuth(c, c.env);
  if (!auth) return c.json({ ok: false, error: "unauthorized" }, 401);

  const siteIdParam = c.req.query("site_id");

  let sql = `SELECT tr.*,
    s.site_name,
    (SELECT d.domain_name FROM domains d WHERE d.site_id = tr.site_id AND d.role = 'acceptor' AND d.blocked = 0 LIMIT 1) as acceptor_domain
  FROM tds_rules tr
  LEFT JOIN sites s ON tr.site_id = s.id
  WHERE tr.account_id = ?`;

  const binds: (string | number)[] = [auth.account_id];

  if (siteIdParam) {
    sql += " AND tr.site_id = ?";
    binds.push(parseInt(siteIdParam));
  }

  sql += " ORDER BY tr.priority DESC, tr.id";

  const rules = await c.env.DB301.prepare(sql)
    .bind(...binds)
    .all<TdsRuleRecord & { site_name: string | null; acceptor_domain: string | null }>();

  return c.json({
    ok: true,
    rules: rules.results.map((r) => ({
      ...formatRule(r),
      site_name: r.site_name,
      acceptor_domain: r.acceptor_domain,
    })),
    total: rules.results.length,
  });
}

/**
 * GET /tds/rules/:id
 * Get single TDS rule with site info.
 */
export async function handleGetTdsRule(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const auth = await requireAuth(c, c.env);
  if (!auth) return c.json({ ok: false, error: "unauthorized" }, 401);

  const row = await c.env.DB301.prepare(
    `SELECT tr.*,
      s.site_name,
      (SELECT d.domain_name FROM domains d WHERE d.site_id = tr.site_id AND d.role = 'acceptor' AND d.blocked = 0 LIMIT 1) as acceptor_domain
    FROM tds_rules tr
    LEFT JOIN sites s ON tr.site_id = s.id
    WHERE tr.id = ? AND tr.account_id = ?`,
  )
    .bind(ruleId, auth.account_id)
    .first<TdsRuleRecord & { site_name: string | null; acceptor_domain: string | null }>();

  if (!row) return c.json({ ok: false, error: "rule_not_found" }, 404);

  return c.json({
    ok: true,
    rule: {
      ...formatRule(row),
      site_name: row.site_name,
      acceptor_domain: row.acceptor_domain,
    },
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

  const { rule_name, tds_type, logic_json, site_id, priority } = parsed.data;

  const result = await c.env.DB301.prepare(
    `INSERT INTO tds_rules (account_id, site_id, rule_name, tds_type, logic_json, priority, status, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'pending')
     RETURNING id, created_at, updated_at`,
  )
    .bind(
      auth.account_id,
      site_id,
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
      site_id,
      rule_name,
      tds_type,
      logic_json,
      priority,
      status: "active",
      sync_status: "pending",
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

  const { preset_id, params, site_id, rule_name } = parsed.data;

  // Expand preset
  const expanded = expandTdsPreset(preset_id, {
    ...params as any,
    rule_name,
  });
  if ("error" in expanded) {
    return c.json({ ok: false, error: expanded.error }, 400);
  }

  // Insert rule with site_id, auto-activate
  const result = await c.env.DB301.prepare(
    `INSERT INTO tds_rules (account_id, site_id, rule_name, tds_type, logic_json, priority, status, sync_status, preset_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'pending', ?)
     RETURNING id, created_at, updated_at`,
  )
    .bind(
      auth.account_id,
      site_id,
      expanded.rule_name,
      expanded.tds_type,
      JSON.stringify(expanded.logic_json),
      expanded.priority,
      expanded.preset_id,
    )
    .first<{ id: number; created_at: string; updated_at: string }>();

  if (!result) return c.json({ ok: false, error: "create_failed" }, 500);

  return c.json({
    ok: true,
    rule: {
      id: result.id,
      site_id,
      rule_name: expanded.rule_name,
      tds_type: expanded.tds_type,
      logic_json: expanded.logic_json,
      priority: expanded.priority,
      status: "active",
      sync_status: "pending",
      preset_id: expanded.preset_id,
      created_at: result.created_at,
      updated_at: result.updated_at,
    },
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
  let needsResync = false;

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
    needsResync = true;
  }
  if (parsed.data.site_id !== undefined) {
    updates.push("site_id = ?");
    bindings.push(parsed.data.site_id);
    needsResync = true;
  }
  if (parsed.data.priority !== undefined) {
    updates.push("priority = ?");
    bindings.push(parsed.data.priority);
    needsResync = true;
  }
  if (parsed.data.status !== undefined) {
    updates.push("status = ?");
    bindings.push(parsed.data.status);
  }

  if (updates.length === 0) {
    return c.json({ ok: false, error: "no_updates" }, 400);
  }

  // Mark rule as pending re-sync if logic/priority/site changed
  if (needsResync) {
    updates.push("sync_status = 'pending'");
  }

  updates.push("updated_at = CURRENT_TIMESTAMP");
  bindings.push(ruleId);

  await c.env.DB301.prepare(
    `UPDATE tds_rules SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...bindings)
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
      "UPDATE tds_rules SET priority = ?, sync_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND account_id = ?",
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
 * Delete TDS rule.
 */
export async function handleDeleteTdsRule(c: Context<{ Bindings: Env }>) {
  const ruleId = parseInt(c.req.param("id"));
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  const check = await verifyRuleOwnership(c.env, ruleId, auth.account_id);
  if (!check.ok) return c.json({ ok: false, error: check.error }, 404);

  // Delete rule
  await c.env.DB301.prepare(
    "DELETE FROM tds_rules WHERE id = ? AND account_id = ?",
  )
    .bind(ruleId, auth.account_id)
    .run();

  return c.json({ ok: true, deleted_id: ruleId });
}

// ============================================================
// HANDLERS: APPLY (push to client D1)
// ============================================================

/**
 * POST /tds/apply
 * Push active TDS rules + domain configs to client D1.
 */
export async function handleApplyTdsRules(c: Context<{ Bindings: Env }>) {
  // 1. Auth
  const auth = await requireEditor(c, c.env);
  if (!auth) return c.json({ ok: false, error: "forbidden" }, 403);

  // 2. Find active CF key
  const keys = await listKeys(c.env, auth.account_id, "cloudflare");
  const activeCfKey = keys.find(k => k.status === "active");
  if (!activeCfKey) {
    return c.json({ ok: false, error: "cloudflare_integration_required" }, 400);
  }

  // 3. Get client sync info
  const syncInfo = await getClientSyncInfo(c.env, activeCfKey.id);
  if (!syncInfo.ok) {
    return c.json({ ok: false, error: syncInfo.error }, 400);
  }
  const { cfAccountId, cfToken, clientD1Id } = syncInfo.info;

  // 4. SELECT active rules that need sync + acceptor domain via site
  const rows = await c.env.DB301.prepare(`
    SELECT tr.id, tr.tds_type, tr.logic_json, tr.priority,
           d.domain_name
    FROM tds_rules tr
    JOIN sites s ON tr.site_id = s.id
    JOIN domains d ON d.site_id = s.id AND d.role = 'acceptor' AND d.blocked = 0
    WHERE tr.account_id = ? AND tr.status = 'active'
      AND tr.sync_status != 'applied'
  `).bind(auth.account_id).all<{
    id: number;
    tds_type: string;
    logic_json: string;
    priority: number;
    domain_name: string;
  }>();

  if (!rows.results || rows.results.length === 0) {
    return c.json({ ok: true, rules_synced: 0, domains_synced: 0, message: "no_pending_rules" });
  }

  // 5. Transform → TDSRule[] (parse logic_json)
  const tdsRules: TDSRule[] = rows.results.map(r => {
    const logic = JSON.parse(r.logic_json) as {
      conditions: Record<string, unknown>;
      action: string;
      action_url?: string;
      status_code?: number;
    };
    return {
      id: r.id,
      domain_name: r.domain_name,
      priority: r.priority,
      conditions: logic.conditions,
      action: (logic.action === "mab_redirect" ? "redirect" : logic.action) as "redirect" | "block" | "pass",
      action_url: logic.action_url ?? undefined,
      status_code: logic.status_code ?? 302,
      active: true,
    };
  });

  // 6. Sync TDS rules to client D1
  const rulesResult = await syncTDSRules(cfAccountId, clientD1Id, cfToken, tdsRules);
  if (!rulesResult.ok) {
    return c.json({ ok: false, error: "sync_rules_failed", details: rulesResult.error }, 500);
  }

  // 7. Generate DomainConfig[] and sync
  const uniqueDomains = [...new Set(tdsRules.map(r => r.domain_name))];
  const domainConfigs: DomainConfig[] = uniqueDomains.map(domain => ({
    domain_name: domain,
    tds_enabled: true,
    default_action: "pass" as const,
    smartshield_enabled: false,
    bot_action: "pass" as const,
  }));

  const configResult = await syncDomainConfig(cfAccountId, clientD1Id, cfToken, domainConfigs);

  // 8. UPDATE tds_rules → sync_status='applied'
  const ruleIds = [...new Set(rows.results.map(r => r.id))];
  if (ruleIds.length > 0) {
    const stmts = ruleIds.map(id =>
      c.env.DB301.prepare(
        `UPDATE tds_rules SET sync_status = 'applied', last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(id)
    );
    await c.env.DB301.batch(stmts);
  }

  // 9. Return result
  return c.json({
    ok: true,
    rules_synced: rulesResult.synced,
    domains_synced: configResult.ok ? configResult.synced : 0,
  });
}
