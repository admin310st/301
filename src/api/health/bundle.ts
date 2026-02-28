// src/api/integrations/providers/cloudflare/bundles/health.ts

/**
 * Health Worker Bundle
 *
 * Pre-bundled JavaScript code for the Health Worker.
 * Deployed to client's CF account during environment setup.
 *
 * Note: This is a simplified version. In production, use esbuild
 * to bundle the full TypeScript source from src/api/health/client/
 */

/**
 * Get the bundled Health Worker script
 */
export function getHealthWorkerBundle(): string {
  return HEALTH_WORKER_BUNDLE;
}

/**
 * Bundled Health Worker code
 *
 * Features:
 * - HTTP endpoints: /health, /run, /stats
 * - Cron handler for scheduled execution
 * - VT queue processing
 * - Webhook to 301.st
 */
const HEALTH_WORKER_BUNDLE = `
// ============================================================
// 301 Health Worker (Bundled)
// ============================================================

// VT Rate Limits
const VT_REQUESTS_PER_MIN = 4;
const VT_BATCH_SIZE = 20;

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check (public)
    if (url.pathname === "/health" || url.pathname === "/_health") {
      return Response.json({
        ok: true,
        worker: "301-health",
        timestamp: new Date().toISOString(),
      });
    }

    // Manual run
    if (url.pathname === "/run" && request.method === "POST") {
      ctx.waitUntil(runFullCycle(env));
      return Response.json({ ok: true, message: "full_cycle_started" });
    }

    // Queue stats
    if (url.pathname === "/stats") {
      const stats = await getQueueStats(env);
      return Response.json({ ok: true, stats });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Check if self-check already confirmed
    const setupStatus = await env.DB.prepare(
      "SELECT value FROM sync_status WHERE key = 'setup_reported'"
    ).first().catch(() => null);

    const isInitCron = event.cron === "*/1 * * * *";

    if (isInitCron) {
      // Init cron: only self-check, nothing else
      if (!setupStatus || setupStatus.value === null) {
        ctx.waitUntil(doSelfCheck(env));
      }
      return;
    }

    // Working cron (0 */12): run full cycle
    console.log("[301-health] Cron triggered:", event.cron);
    ctx.waitUntil(runFullCycle(env));
  },
};

// ============================================================
// SELF-CHECK (deploy verification)
// ============================================================

async function doSelfCheck(env) {
  const checks = { d1: false, kv: false, tables: [], secrets: [] };

  try {
    // Check D1 access
    const tableCheck = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    checks.d1 = true;
    checks.tables = (tableCheck.results || []).map(r => r.name);

    // Check KV access
    try {
      await env.KV.put("_selfcheck", "1");
      const val = await env.KV.get("_selfcheck");
      if (val === "1") checks.kv = true;
      await env.KV.delete("_selfcheck");
    } catch {}

    // Check secrets
    if (env.WORKER_API_KEY) checks.secrets.push("WORKER_API_KEY");
    if (env.ACCOUNT_ID) checks.secrets.push("ACCOUNT_ID");

    // Send deploy webhook
    const webhookUrl = env.DEPLOY_WEBHOOK_URL || "https://webhook.301.st/deploy";
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.WORKER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "setup_ok",
        worker_name: "301-health",
        account_id: parseInt(env.ACCOUNT_ID),
        checks,
        timestamp: new Date().toISOString(),
      }),
    });

    if (response.ok) {
      const result = await response.json().catch(() => ({}));
      if (result.ok) {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('setup_reported', 'ok', datetime('now'))"
        ).run();
        console.log("[301-health] Self-check confirmed by webhook");
      }
    }
  } catch (err) {
    // Send error webhook
    try {
      const webhookUrl = env.DEPLOY_WEBHOOK_URL || "https://webhook.301.st/deploy";
      await fetch(webhookUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.WORKER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "setup_error",
          worker_name: "301-health",
          account_id: parseInt(env.ACCOUNT_ID),
          error: err.message || "unknown",
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {}
  }
}

// ============================================================
// FULL CYCLE
// ============================================================

async function runFullCycle(env) {
  console.log("[301-health] Starting full cycle...");
  const startTime = Date.now();

  const zones = [];
  const threats = [];

  try {
    // 1. Get active domains
    const domains = await getActiveDomains(env);
    console.log("[301-health] Active domains:", domains.length);

    if (domains.length === 0) {
      console.log("[301-health] No domains to check");
      return;
    }

    // 2. Check traffic anomalies → phishing (if CF_API_TOKEN available)
    const cfToken = await getKVValue(env, "CF_API_TOKEN");
    if (cfToken) {
      const anomalies = await detectTrafficAnomalies(env);

      for (const anomaly of anomalies) {
        if (anomaly.type === "drop_90" || anomaly.type === "zero_traffic") {
          try {
            const result = await checkZonePhishing(anomaly.zone_id, cfToken);
            if (result.ok) {
              zones.push({
                zone_id: anomaly.zone_id,
                phishing_detected: result.phishing_detected,
                checked_at: new Date().toISOString(),
              });
            }
          } catch (err) {
            console.error("[301-health] Phishing check failed:", err);
          }
        }
      }
    }

    // 3. Add to VT queue
    await addDomainsToQueue(env, domains);

    // 4. Process VT queue
    const vtApiKey = await getKVValue(env, "VT_API_KEY");
    if (vtApiKey) {
      const vtResults = await processVTQueue(env, vtApiKey);
      console.log("[301-health] VT processed:", vtResults.processed);
      threats.push(...vtResults.threats);
    }

    // 5. Send webhook
    if (zones.length > 0 || threats.length > 0) {
      const result = await sendHealthWebhook(env, { zones, threats });
      if (result.ok) {
        await markThreatsSynced(env, threats.map(t => t.domain_name));
        console.log("[301-health] Webhook sent:", zones.length, "zones,", threats.length, "threats");
      } else {
        console.error("[301-health] Webhook failed:", result.error);
      }
    }

    console.log("[301-health] Cycle completed in", Date.now() - startTime, "ms");
  } catch (err) {
    console.error("[301-health] Cycle error:", err);
  }
}

// ============================================================
// DOMAINS
// ============================================================

async function getActiveDomains(env) {
  const result = await env.DB.prepare(
    "SELECT domain_name, zone_id FROM domain_list WHERE active = 1"
  ).all();
  return result.results || [];
}

async function detectTrafficAnomalies(env) {
  const result = await env.DB.prepare(\`
    SELECT domain_name, zone_id, clicks_yesterday, clicks_today
    FROM traffic_stats
    WHERE clicks_yesterday >= 20
  \`).all();

  const anomalies = [];
  for (const row of result.results || []) {
    if (row.clicks_today === 0) {
      anomalies.push({ ...row, type: "zero_traffic" });
    } else if (row.clicks_today < row.clicks_yesterday * 0.1) {
      anomalies.push({ ...row, type: "drop_90" });
    }
  }
  return anomalies;
}

// ============================================================
// VT QUEUE
// ============================================================

async function addDomainsToQueue(env, domains) {
  for (const domain of domains) {
    await env.DB.prepare(\`
      INSERT OR IGNORE INTO threat_check_queue (domain_name, status, added_at)
      VALUES (?, 'pending', datetime('now'))
    \`).bind(domain.domain_name).run();
  }
}

async function processVTQueue(env, vtApiKey) {
  const result = { processed: 0, errors: 0, threats: [] };

  // Get pending items
  const queue = await env.DB.prepare(\`
    SELECT domain_name FROM threat_check_queue
    WHERE status = 'pending'
    ORDER BY priority DESC, added_at ASC
    LIMIT ?
  \`).bind(VT_BATCH_SIZE).all();

  for (const item of queue.results || []) {
    try {
      // Check VT
      const vtResult = await checkVirusTotal(item.domain_name, vtApiKey);

      if (vtResult.ok) {
        // Save to domain_threats
        await env.DB.prepare(\`
          INSERT OR REPLACE INTO domain_threats
          (domain_name, threat_score, categories, reputation, source, checked_at, updated_at)
          VALUES (?, ?, ?, ?, 'virustotal', datetime('now'), datetime('now'))
        \`).bind(
          item.domain_name,
          vtResult.threat_score,
          JSON.stringify(vtResult.categories),
          vtResult.reputation
        ).run();

        result.threats.push({
          domain_name: item.domain_name,
          threat_score: vtResult.threat_score,
          categories: vtResult.categories,
          reputation: vtResult.reputation,
          source: "virustotal",
          checked_at: new Date().toISOString(),
        });

        // Mark as done
        await env.DB.prepare(
          "UPDATE threat_check_queue SET status = 'done' WHERE domain_name = ?"
        ).bind(item.domain_name).run();

        result.processed++;
      } else {
        // Mark as error
        await env.DB.prepare(
          "UPDATE threat_check_queue SET status = 'error' WHERE domain_name = ?"
        ).bind(item.domain_name).run();

        result.errors++;
      }

      // Rate limit: wait between requests
      await sleep(60000 / VT_REQUESTS_PER_MIN);
    } catch (err) {
      console.error("[301-health] VT check error:", err);
      result.errors++;
    }
  }

  return result;
}

async function checkVirusTotal(domain, apiKey) {
  try {
    const response = await fetch(
      \`https://www.virustotal.com/api/v3/domains/\${domain}\`,
      {
        headers: { "x-apikey": apiKey },
      }
    );

    if (!response.ok) {
      return { ok: false, error: "VT API error: " + response.status };
    }

    const data = await response.json();
    const attrs = data.data?.attributes || {};

    const stats = attrs.last_analysis_stats || {};
    const threatScore = (stats.malicious || 0) + (stats.suspicious || 0);

    const categories = [];
    for (const [, value] of Object.entries(attrs.categories || {})) {
      if (!categories.includes(value)) categories.push(value);
    }

    return {
      ok: true,
      threat_score: threatScore,
      categories,
      reputation: attrs.reputation || 0,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// PHISHING CHECK
// ============================================================

async function checkZonePhishing(zoneId, cfToken) {
  try {
    const response = await fetch(
      \`https://api.cloudflare.com/client/v4/zones/\${zoneId}\`,
      {
        headers: {
          Authorization: \`Bearer \${cfToken}\`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!data.success) {
      return { ok: false, error: data.errors?.[0]?.message };
    }

    return {
      ok: true,
      phishing_detected: data.result?.meta?.phishing_detected || false,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================
// WEBHOOK
// ============================================================

async function sendHealthWebhook(env, data) {
  try {
    const response = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${env.WORKER_API_KEY}\`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_id: env.ACCOUNT_ID,
        timestamp: new Date().toISOString(),
        zones: data.zones,
        threats: data.threats,
      }),
    });

    const result = await response.json();
    return { ok: result.ok, result: result.result, error: result.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function markThreatsSynced(env, domains) {
  for (const domain of domains) {
    await env.DB.prepare(
      "UPDATE domain_threats SET synced_at = datetime('now') WHERE domain_name = ?"
    ).bind(domain).run();
  }
}

// ============================================================
// HELPERS
// ============================================================

async function getKVValue(env, key) {
  try {
    return await env.KV.get(key);
  } catch {
    return null;
  }
}

async function getQueueStats(env) {
  const result = await env.DB.prepare(\`
    SELECT status, COUNT(*) as count
    FROM threat_check_queue
    GROUP BY status
  \`).all();

  const stats = { pending: 0, processing: 0, done: 0, error: 0 };
  for (const row of result.results || []) {
    stats[row.status] = row.count;
  }
  return stats;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
`;
