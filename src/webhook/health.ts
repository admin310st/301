/**
 * Health Webhook Handler (Push Model)
 *
 * POST /health
 * Receives health data from 301-health client worker.
 * Verifies worker identity via API key (SHA-256 hash in DB301).
 */

import type { Context } from "hono";
import type { Env } from "./index";
import { verifyApiKey } from "./auth";

// ============================================================
// TYPES
// ============================================================

interface WebhookPayload {
  account_id: string;
  timestamp: string;
  zones: Array<{
    zone_id: string;
    phishing_detected: boolean;
    checked_at: string;
  }>;
  threats: Array<{
    domain_name: string;
    threat_score: number;
    categories: string[];
    reputation: number;
    source: string;
    checked_at: string;
  }>;
}

interface WebhookResult {
  zones_processed: number;
  domains_blocked: number;
  threats_upserted: number;
  errors: string[];
}

// ============================================================
// HANDLER
// ============================================================

/**
 * POST /health
 *
 * 1. Verify API key (SHA-256 hash lookup)
 * 2. Parse payload
 * 3. Process zones → UPDATE domains
 * 4. Process threats → UPSERT domain_threats
 * 5. Return result
 */
export async function handleHealthWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // 1. Verify API key
  const auth = await verifyApiKey(c);
  if (auth instanceof Response) return auth;

  const accountId = auth.account_id;

  // 2. Parse payload
  let payload: WebhookPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "invalid_json" }, 400);
  }

  // 3. Validate payload account_id matches API key
  if (payload.account_id && String(payload.account_id) !== String(accountId)) {
    return c.json({ ok: false, error: "account_id_mismatch" }, 403);
  }

  // 4. Process data
  const result = await processHealthData(env, accountId, payload);

  return c.json({
    ok: true,
    result,
  });
}

// ============================================================
// DATA PROCESSING
// ============================================================

/**
 * Process health data from client
 */
async function processHealthData(
  env: Env,
  accountId: number,
  data: WebhookPayload
): Promise<WebhookResult> {
  const result: WebhookResult = {
    zones_processed: 0,
    domains_blocked: 0,
    threats_upserted: 0,
    errors: [],
  };

  // Process zones (phishing)
  if (data.zones && data.zones.length > 0) {
    for (const zone of data.zones) {
      try {
        const zoneResult = await processZonePhishing(env, accountId, zone);
        result.zones_processed++;
        result.domains_blocked += zoneResult.blocked;
      } catch (err) {
        result.errors.push(`zone ${zone.zone_id}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
  }

  // Process threats (VT/Intel)
  if (data.threats && data.threats.length > 0) {
    for (const threat of data.threats) {
      try {
        await processThreat(env, accountId, threat);
        result.threats_upserted++;
      } catch (err) {
        result.errors.push(`threat ${threat.domain_name}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
  }

  return result;
}

/**
 * Process zone phishing status
 */
async function processZonePhishing(
  env: Env,
  accountId: number,
  zone: { zone_id: string; phishing_detected: boolean; checked_at: string }
): Promise<{ blocked: number }> {
  // Find zone in our DB by cf_zone_id
  const dbZone = await env.DB301.prepare(`
    SELECT id FROM zones
    WHERE cf_zone_id = ? AND account_id = ?
  `).bind(zone.zone_id, accountId).first<{ id: number }>();

  if (!dbZone) {
    throw new Error("zone_not_found");
  }

  let blocked = 0;

  if (zone.phishing_detected) {
    // Block all domains in zone
    const res = await env.DB301.prepare(`
      UPDATE domains
      SET blocked = 1, blocked_reason = 'phishing', updated_at = CURRENT_TIMESTAMP
      WHERE zone_id = ? AND account_id = ?
    `).bind(dbZone.id, accountId).run();

    blocked = res.meta.changes;
  } else {
    // Unblock domains that were blocked for phishing
    await env.DB301.prepare(`
      UPDATE domains
      SET blocked = 0, blocked_reason = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE zone_id = ? AND account_id = ? AND blocked_reason = 'phishing'
    `).bind(dbZone.id, accountId).run();
  }

  return { blocked };
}

/**
 * Process threat data (upsert domain_threats)
 */
async function processThreat(
  env: Env,
  accountId: number,
  threat: {
    domain_name: string;
    threat_score: number;
    categories: string[];
    reputation: number;
    source: string;
    checked_at: string;
  }
): Promise<void> {
  // Find domain in our DB
  const domain = await env.DB301.prepare(`
    SELECT id FROM domains
    WHERE domain_name = ? AND account_id = ?
  `).bind(threat.domain_name, accountId).first<{ id: number }>();

  if (!domain) {
    // Domain not found - skip silently (might be deleted)
    return;
  }

  // Upsert domain_threats
  await env.DB301.prepare(`
    INSERT INTO domain_threats (domain_id, threat_score, categories, reputation, source, checked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(domain_id) DO UPDATE SET
      threat_score = excluded.threat_score,
      categories = excluded.categories,
      reputation = excluded.reputation,
      source = excluded.source,
      checked_at = excluded.checked_at,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    domain.id,
    threat.threat_score,
    JSON.stringify(threat.categories),
    threat.reputation,
    threat.source,
    threat.checked_at
  ).run();
}
