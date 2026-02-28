/**
 * TDS Webhook Handler (Push Model)
 *
 * POST /tds
 * Receives TDS statistics from 301-tds client worker.
 * Two-table model: shield (compact) + link (granular) + mab impressions.
 * Auth: API key (SHA-256 hash in DB301).
 */

import type { Context } from "hono";
import type { Env } from "./index";
import { verifyApiKey } from "./auth";

// ============================================================
// TYPES
// ============================================================

interface ShieldStat {
  domain_name: string;
  hour: string;
  hits: number;
  blocks: number;
  passes: number;
}

interface LinkStat {
  domain_name: string;
  rule_id: number;
  hour: string;
  country: string;
  device: string;
  hits: number;
  redirects: number;
}

interface MabStat {
  rule_id: number;
  variant_url: string;
  impressions: number;
}

interface TdsWebhookPayload {
  account_id: number;
  timestamp: string;
  shield?: ShieldStat[];
  links?: LinkStat[];
  mab?: MabStat[];
}

interface TdsWebhookResult {
  shield_upserted: number;
  links_upserted: number;
  mab_updated: number;
  errors: string[];
}

// ============================================================
// HANDLER
// ============================================================

/**
 * POST /tds
 *
 * 1. Verify API key
 * 2. Parse payload
 * 3. UPSERT shield → DB301.tds_stats_shield
 * 4. UPSERT links → DB301.tds_stats_link
 * 5. Update mab impressions → DB301.tds_rules.logic_json
 * 6. Return result
 */
export async function handleTdsWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  // 1. Verify API key
  const auth = await verifyApiKey(c);
  if (auth instanceof Response) return auth;

  const accountId = auth.account_id;

  // 2. Parse payload
  let payload: TdsWebhookPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  // Validate account_id matches
  if (payload.account_id && payload.account_id !== accountId) {
    return c.json({ ok: false, error: "account_id_mismatch" }, 403);
  }

  // 3. Process
  const result = await processTdsData(c.env, accountId, payload);

  return c.json({ ok: true, result });
}

// ============================================================
// DATA PROCESSING
// ============================================================

async function processTdsData(
  env: Env,
  accountId: number,
  data: TdsWebhookPayload,
): Promise<TdsWebhookResult> {
  const result: TdsWebhookResult = {
    shield_upserted: 0,
    links_upserted: 0,
    mab_updated: 0,
    errors: [],
  };

  // Shield stats
  if (data.shield && data.shield.length > 0) {
    for (const row of data.shield) {
      try {
        await env.DB301.prepare(`
          INSERT INTO tds_stats_shield (account_id, domain_name, hour, hits, blocks, passes)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, domain_name, hour) DO UPDATE SET
            hits = hits + excluded.hits,
            blocks = blocks + excluded.blocks,
            passes = passes + excluded.passes,
            collected_at = CURRENT_TIMESTAMP
        `).bind(
          accountId,
          row.domain_name,
          row.hour,
          row.hits || 0,
          row.blocks || 0,
          row.passes || 0,
        ).run();
        result.shield_upserted++;
      } catch (err) {
        result.errors.push(`shield ${row.domain_name}/${row.hour}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
  }

  // Link stats
  if (data.links && data.links.length > 0) {
    for (const row of data.links) {
      try {
        await env.DB301.prepare(`
          INSERT INTO tds_stats_link (account_id, domain_name, rule_id, hour, country, device, hits, redirects)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, domain_name, rule_id, hour, country, device) DO UPDATE SET
            hits = hits + excluded.hits,
            redirects = redirects + excluded.redirects,
            collected_at = CURRENT_TIMESTAMP
        `).bind(
          accountId,
          row.domain_name,
          row.rule_id,
          row.hour,
          row.country || "XX",
          row.device || "desktop",
          row.hits || 0,
          row.redirects || 0,
        ).run();
        result.links_upserted++;
      } catch (err) {
        result.errors.push(`link ${row.domain_name}/r${row.rule_id}/${row.hour}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
  }

  // MAB impressions → update tds_rules.logic_json.variants
  if (data.mab && data.mab.length > 0) {
    for (const row of data.mab) {
      try {
        await updateMabImpressions(env, row.rule_id, row.variant_url, row.impressions);
        result.mab_updated++;
      } catch (err) {
        result.errors.push(`mab r${row.rule_id}/${row.variant_url}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
  }

  return result;
}

// ============================================================
// MAB
// ============================================================

/**
 * Update impressions count in tds_rules.logic_json.variants
 * for a specific variant URL. Does NOT update alpha/beta
 * (that's done via POST /tds/postback on conversions).
 */
async function updateMabImpressions(
  env: Env,
  ruleId: number,
  variantUrl: string,
  impressions: number,
): Promise<void> {
  const rule = await env.DB301.prepare(
    "SELECT logic_json FROM tds_rules WHERE id = ?"
  ).bind(ruleId).first<{ logic_json: string }>();

  if (!rule) return;

  const logic = JSON.parse(rule.logic_json);
  if (!logic.variants || !Array.isArray(logic.variants)) return;

  const variant = logic.variants.find((v: { url: string }) => v.url === variantUrl);
  if (!variant) return;

  variant.impressions = (variant.impressions || 0) + impressions;

  await env.DB301.prepare(
    "UPDATE tds_rules SET logic_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(JSON.stringify(logic), ruleId).run();
}
