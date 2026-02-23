// src/api/tds/sync.ts

/**
 * TDS Sync & Postback endpoints.
 *
 * GET /tds/sync — Client Worker pulls rules (version-based delta).
 * POST /tds/postback — MAB conversion tracking.
 */

import type { Context } from "hono";
import type { Env } from "../types/worker";
import { verifyJWT } from "../lib/jwt";
import { postbackSchema } from "./conditions";

// ============================================================
// SYNC ENDPOINT
// ============================================================

/**
 * GET /tds/sync?version={hash}
 *
 * Called by Client Worker to pull rules.
 * Auth: JWT_TOKEN (service token, no fingerprint).
 * Returns 304 if version matches (no changes).
 */
export async function handleTdsSync(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // Auth via service JWT (no fingerprint — it's a worker-to-worker call)
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, env);
  if (!payload?.account_id) {
    return c.json({ ok: false, error: "invalid_token" }, 401);
  }

  const accountId = payload.account_id as number;

  // Also check X-Account-ID for extra verification
  const headerAccountId = c.req.header("X-Account-ID");
  if (headerAccountId && parseInt(headerAccountId) !== accountId) {
    return c.json({ ok: false, error: "account_mismatch" }, 403);
  }

  // Compute current version hash
  const currentVersion = await computeVersionHash(env, accountId);

  // Check if client already has this version
  const clientVersion = c.req.query("version");
  if (clientVersion && clientVersion === currentVersion) {
    return new Response(null, { status: 304 });
  }

  // Fetch rules with domain bindings
  const rules = await env.DB301.prepare(`
    SELECT
      tr.id,
      d.domain_name,
      tr.priority,
      tr.logic_json,
      tr.tds_type,
      rdm.enabled
    FROM tds_rules tr
    JOIN rule_domain_map rdm ON rdm.tds_rule_id = tr.id
    JOIN domains d ON rdm.domain_id = d.id
    WHERE tr.account_id = ?
      AND tr.status = 'active'
      AND rdm.binding_status NOT IN ('removed')
      AND rdm.enabled = 1
    ORDER BY d.domain_name, tr.priority DESC
  `)
    .bind(accountId)
    .all<{
      id: number;
      domain_name: string;
      priority: number;
      logic_json: string;
      tds_type: string;
      enabled: number;
    }>();

  // Parse logic_json and flatten into Client Worker format
  const syncRules = rules.results.map((r) => {
    const logic = JSON.parse(r.logic_json);
    return {
      id: r.id,
      domain_name: r.domain_name,
      priority: r.priority,
      conditions: logic.conditions || {},
      action: logic.action || "pass",
      action_url: logic.action_url || null,
      status_code: logic.status_code || 302,
      active: true,
    };
  });

  // Fetch domain configs (from domain_config concept — derived from domain settings)
  // For now, generate configs from domain data + site settings
  const domainNames = [...new Set(syncRules.map((r) => r.domain_name))];
  const configs = domainNames.map((dn) => ({
    domain_name: dn,
    tds_enabled: true,
    default_action: "pass" as const,
    default_url: null,
    smartshield_enabled: true,
    bot_action: "pass" as const,
    bot_redirect_url: null,
  }));

  // Update binding_status to applied
  if (rules.results.length > 0) {
    const ruleIds = [...new Set(rules.results.map((r) => r.id))];
    for (const ruleId of ruleIds) {
      await env.DB301.prepare(
        `UPDATE rule_domain_map
         SET binding_status = 'applied', last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE tds_rule_id = ? AND account_id = ? AND binding_status = 'pending'`,
      )
        .bind(ruleId, accountId)
        .run();
    }
  }

  return c.json({
    version: currentVersion,
    rules: syncRules,
    configs,
  });
}

/**
 * Compute version hash from account's active TDS rules.
 * Simple hash based on rule IDs + updated_at timestamps.
 */
async function computeVersionHash(env: Env, accountId: number): Promise<string> {
  const rows = await env.DB301.prepare(
    `SELECT tr.id, tr.updated_at, rdm.updated_at as binding_updated
     FROM tds_rules tr
     JOIN rule_domain_map rdm ON rdm.tds_rule_id = tr.id
     WHERE tr.account_id = ? AND tr.status = 'active' AND rdm.binding_status NOT IN ('removed')
     ORDER BY tr.id`,
  )
    .bind(accountId)
    .all<{ id: number; updated_at: string; binding_updated: string }>();

  if (rows.results.length === 0) return "empty";

  const payload = rows.results
    .map((r) => `${r.id}:${r.updated_at}:${r.binding_updated}`)
    .join("|");

  // Simple hash using Web Crypto
  const data = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================
// POSTBACK ENDPOINT
// ============================================================

/**
 * POST /tds/postback
 * Record MAB conversion. Updates alpha/beta in tds_rules.logic_json.
 *
 * Query params: rule_id, variant_url, converted, revenue
 * (Also accepts JSON body)
 */
export async function handleTdsPostback(c: Context<{ Bindings: Env }>) {
  const env = c.env;

  // Parse from query string or body
  let input: Record<string, unknown>;
  if (c.req.header("Content-Type")?.includes("json")) {
    input = await c.req.json();
  } else {
    const q = c.req.query();
    input = {
      rule_id: q.rule_id ? parseInt(q.rule_id) : undefined,
      variant_url: q.variant_url,
      converted: q.converted ? parseInt(q.converted) : 1,
      revenue: q.revenue ? parseFloat(q.revenue) : 0,
    };
  }

  const parsed = postbackSchema.safeParse(input);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: "validation_error",
      details: parsed.error.issues.map((i) => i.message),
    }, 400);
  }

  const { rule_id, variant_url, converted, revenue } = parsed.data;

  // Get rule
  const rule = await env.DB301.prepare(
    "SELECT id, logic_json FROM tds_rules WHERE id = ?",
  )
    .bind(rule_id)
    .first<{ id: number; logic_json: string }>();

  if (!rule) {
    return c.json({ ok: false, error: "rule_not_found" }, 404);
  }

  // Update alpha/beta for the variant
  try {
    const logic = JSON.parse(rule.logic_json);
    if (logic.variants && Array.isArray(logic.variants)) {
      const variant = logic.variants.find((v: any) => v.url === variant_url);
      if (variant && converted) {
        variant.alpha = (variant.alpha || 1) + 1;
      } else if (variant) {
        variant.beta = (variant.beta || 1) + 1;
      }

      await env.DB301.prepare(
        "UPDATE tds_rules SET logic_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(JSON.stringify(logic), rule_id)
        .run();
    }
  } catch {
    return c.json({ ok: false, error: "update_failed" }, 500);
  }

  return c.json({
    ok: true,
    rule_id,
    variant_url,
    converted,
    revenue,
  });
}
