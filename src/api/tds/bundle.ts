// src/api/tds/bundle.ts

/**
 * TDS Worker Bundle
 *
 * Pre-bundled JavaScript for TDS Worker deployment via CF API.
 * Core functionality: rule matching, redirects, D1 stats, self-check.
 *
 * Note: This is a simplified version without DO/AE.
 * Stats split into two tables: stats_shield (compact) + stats_link (granular).
 */

export function getTdsWorkerBundle(): string {
  return TDS_WORKER_BUNDLE;
}

const TDS_WORKER_BUNDLE = `
// ============================================================
// 301 TDS Worker (Bundled)
// ============================================================

const CACHE_TTL = 300; // 5 min
let rulesCache = null;
let cacheExpiry = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health" || url.pathname === "/_health") {
      return Response.json({
        ok: true,
        worker: "301-tds",
        timestamp: new Date().toISOString(),
      });
    }

    // Sync trigger (from platform)
    if (url.pathname === "/_sync" && request.method === "POST") {
      rulesCache = null;
      cacheExpiry = 0;
      return Response.json({ ok: true, message: "cache_invalidated" });
    }

    // Stats endpoint
    if (url.pathname === "/_stats") {
      const stats = await getStats(env);
      return Response.json({ ok: true, stats });
    }

    // TDS routing
    if (env.DISABLE_TDS === "true") {
      return fetch(request);
    }

    const host = url.hostname;
    const rctx = buildRequestContext(request, url);

    // Get rules for this domain
    const rules = await getRulesForDomain(env, host);
    if (!rules || rules.length === 0) {
      return fetch(request);
    }

    // Get domain config
    const config = await getDomainConfig(env, host);
    if (config && !config.tds_enabled) {
      return fetch(request);
    }

    // Bot check (always shield)
    if (config && config.smartshield_enabled && rctx.is_bot) {
      if (config.bot_action === "block") {
        ctx.waitUntil(recordShieldStat(env, host, null, "blocks"));
        return new Response("Access denied", { status: 403 });
      }
      if (config.bot_action === "redirect" && config.bot_redirect_url) {
        ctx.waitUntil(recordShieldStat(env, host, null, "blocks"));
        return Response.redirect(config.bot_redirect_url, 302);
      }
    }

    // Match rules
    for (const rule of rules) {
      if (!rule.active) continue;
      if (matchRule(rule, rctx)) {
        return executeAction(rule, rctx, env, ctx, host);
      }
    }

    // Default action (shield — no specific rule)
    if (config && config.default_action === "redirect" && config.default_url) {
      ctx.waitUntil(recordShieldStat(env, host, null, "passes"));
      return Response.redirect(config.default_url, 302);
    }
    if (config && config.default_action === "block") {
      ctx.waitUntil(recordShieldStat(env, host, null, "blocks"));
      return new Response("Blocked", { status: 403 });
    }

    ctx.waitUntil(recordShieldStat(env, host, null, "passes"));
    return fetch(request);
  },

  async scheduled(event, env, ctx) {
    // Self-check on first cron (*/1 * * * *)
    const setupStatus = await env.DB.prepare(
      "SELECT value FROM sync_status WHERE key = 'setup_reported'"
    ).first();

    if (!setupStatus || setupStatus.value === null) {
      ctx.waitUntil(doSelfCheck(env, "301-tds"));
      return;
    }

    // Working cron (0 */6 * * *): sync + push stats + cleanup
    ctx.waitUntil(syncRules(env));
    ctx.waitUntil(pushStats(env));
    ctx.waitUntil(cleanupOldStats(env));
  },
};

// ============================================================
// SELF-CHECK
// ============================================================

async function doSelfCheck(env, workerName) {
  const checks = { d1: false, tables: [], secrets: [] };

  try {
    const tableCheck = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    checks.d1 = true;
    checks.tables = (tableCheck.results || []).map(r => r.name);

    if (env.WORKER_API_KEY) checks.secrets.push("WORKER_API_KEY");
    if (env.ACCOUNT_ID) checks.secrets.push("ACCOUNT_ID");
    if (env.API_URL) checks.secrets.push("API_URL");

    const webhookUrl = env.DEPLOY_WEBHOOK_URL || "https://webhook.301.st/deploy";
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.WORKER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "setup_ok",
        worker_name: workerName,
        account_id: parseInt(env.ACCOUNT_ID),
        checks,
        timestamp: new Date().toISOString(),
      }),
    });

    if (response.ok) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('setup_reported', 'ok', datetime('now'))"
      ).run();
    }
  } catch (err) {
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
          worker_name: workerName,
          account_id: parseInt(env.ACCOUNT_ID),
          error: err.message || "unknown",
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {}
  }
}

// ============================================================
// REQUEST CONTEXT
// ============================================================

function buildRequestContext(request, url) {
  const headers = request.headers;
  const ua = headers.get("user-agent") || "";
  const cf = request.cf || {};

  const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const isBot = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|Googlebot|YandexBot/i.test(ua);

  let os = "unknown";
  if (/Windows/i.test(ua)) os = "windows";
  else if (/Mac OS/i.test(ua)) os = "macos";
  else if (/Linux/i.test(ua)) os = "linux";
  else if (/Android/i.test(ua)) os = "android";
  else if (/iPhone|iPad/i.test(ua)) os = "ios";

  let browser = "unknown";
  if (/Chrome/i.test(ua) && !/Edge|OPR/i.test(ua)) browser = "chrome";
  else if (/Firefox/i.test(ua)) browser = "firefox";
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = "safari";
  else if (/Edge/i.test(ua)) browser = "edge";
  else if (/OPR|Opera/i.test(ua)) browser = "opera";

  return {
    country: (cf.country || "XX").toUpperCase(),
    region: cf.region || "",
    device: isMobile ? "mobile" : "desktop",
    os,
    browser,
    is_bot: isBot,
    ua,
    path: url.pathname,
    host: url.hostname,
    params: Object.fromEntries(url.searchParams),
    referrer: headers.get("referer") || "",
    ip: headers.get("cf-connecting-ip") || "",
  };
}

// ============================================================
// RULE MATCHING
// ============================================================

function matchRule(rule, ctx) {
  const conds = rule.conditions;
  if (!conds || typeof conds !== "object") return true;

  // Geo
  if (conds.geo && conds.geo.length > 0) {
    if (!conds.geo.includes(ctx.country)) return false;
  }
  if (conds.geo_exclude && conds.geo_exclude.length > 0) {
    if (conds.geo_exclude.includes(ctx.country)) return false;
  }

  // Device
  if (conds.device && conds.device !== ctx.device) return false;

  // OS
  if (conds.os && conds.os !== ctx.os) return false;

  // Browser
  if (conds.browser && conds.browser !== ctx.browser) return false;

  // Bot
  if (conds.bot === true && !ctx.is_bot) return false;
  if (conds.bot === false && ctx.is_bot) return false;

  // UTM source
  if (conds.utm_source && conds.utm_source.length > 0) {
    const src = ctx.params.utm_source || "";
    if (!conds.utm_source.includes(src)) return false;
  }

  // UTM campaign
  if (conds.utm_campaign && conds.utm_campaign.length > 0) {
    const camp = ctx.params.utm_campaign || "";
    if (!conds.utm_campaign.includes(camp)) return false;
  }

  // Match params (any of listed params present)
  if (conds.match_params && conds.match_params.length > 0) {
    const hasParam = conds.match_params.some(p => ctx.params[p] !== undefined);
    if (!hasParam) return false;
  }

  // Path regex
  if (conds.path) {
    try {
      const re = new RegExp(conds.path);
      if (!re.test(ctx.path)) return false;
    } catch {
      return false;
    }
  }

  // Referrer regex
  if (conds.referrer) {
    try {
      const re = new RegExp(conds.referrer);
      if (!re.test(ctx.referrer)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

// ============================================================
// ACTIONS
// ============================================================

function executeAction(rule, ctx, env, execCtx, host) {
  const isLink = rule.tds_type === "smartlink";

  if (rule.action === "block") {
    if (isLink) {
      execCtx.waitUntil(recordLinkStat(env, host, rule.id, ctx.country, ctx.device));
    } else {
      execCtx.waitUntil(recordShieldStat(env, host, rule.id, "blocks"));
    }
    return new Response("Blocked", { status: 403 });
  }

  if (rule.action === "pass") {
    if (isLink) {
      execCtx.waitUntil(recordLinkStat(env, host, rule.id, ctx.country, ctx.device));
    } else {
      execCtx.waitUntil(recordShieldStat(env, host, rule.id, "passes"));
    }
    return fetch(ctx.request || new Request("https://" + host + ctx.path));
  }

  if (rule.action === "redirect" && rule.action_url) {
    const url = interpolateUrl(rule.action_url, ctx);
    if (isLink) {
      execCtx.waitUntil(recordLinkStat(env, host, rule.id, ctx.country, ctx.device));
    } else {
      execCtx.waitUntil(recordShieldStat(env, host, rule.id, "passes"));
    }
    return Response.redirect(url, rule.status_code || 302);
  }

  if (rule.action === "mab_redirect" && rule.variants) {
    const variants = typeof rule.variants === "string" ? JSON.parse(rule.variants) : rule.variants;
    if (variants.length > 0) {
      const chosen = selectVariant(variants, rule.algorithm || "thompson_sampling");
      const url = interpolateUrl(chosen.url, ctx);
      execCtx.waitUntil(recordMabImpression(env, rule.id, chosen.url));
      execCtx.waitUntil(recordLinkStat(env, host, rule.id, ctx.country, ctx.device));
      return Response.redirect(url, rule.status_code || 302);
    }
  }

  // Fallback: pass through
  return fetch(new Request("https://" + host + ctx.path));
}

function interpolateUrl(url, ctx) {
  return url
    .replace("{country}", ctx.country)
    .replace("{device}", ctx.device)
    .replace("{os}", ctx.os)
    .replace("{browser}", ctx.browser)
    .replace("{path}", ctx.path)
    .replace("{host}", ctx.host);
}

// ============================================================
// MAB (Thompson Sampling)
// ============================================================

function selectVariant(variants, algorithm) {
  if (algorithm === "epsilon_greedy") {
    if (Math.random() < 0.1) {
      return variants[Math.floor(Math.random() * variants.length)];
    }
    let best = variants[0];
    let bestRate = 0;
    for (const v of variants) {
      const rate = v.impressions > 0 ? v.conversions / v.impressions : 0;
      if (rate > bestRate) { bestRate = rate; best = v; }
    }
    return best;
  }

  if (algorithm === "ucb") {
    const totalImpressions = variants.reduce((s, v) => s + (v.impressions || 0), 0);
    let best = variants[0];
    let bestScore = -1;
    for (const v of variants) {
      const n = v.impressions || 1;
      const rate = v.conversions / n;
      const exploration = Math.sqrt(2 * Math.log(totalImpressions + 1) / n);
      const score = rate + exploration;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }

  // Thompson Sampling (default)
  let best = variants[0];
  let bestSample = -1;
  for (const v of variants) {
    const alpha = (v.alpha || 1) + (v.conversions || 0);
    const beta = (v.beta || 1) + (v.impressions || 0) - (v.conversions || 0);
    const sample = betaSample(alpha, beta);
    if (sample > bestSample) { bestSample = sample; best = v; }
  }
  return best;
}

function betaSample(alpha, beta) {
  const x = gammaSample(alpha);
  const y = gammaSample(beta);
  return x / (x + y);
}

function gammaSample(shape) {
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function randn() {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ============================================================
// DATA ACCESS
// ============================================================

async function getRulesForDomain(env, domain) {
  // Check cache
  if (rulesCache && Date.now() < cacheExpiry) {
    return rulesCache[domain] || [];
  }

  // Reload all rules
  try {
    const result = await env.DB.prepare(
      "SELECT * FROM tds_rules WHERE active = 1 ORDER BY priority DESC"
    ).all();

    const byDomain = {};
    for (const rule of result.results || []) {
      if (typeof rule.conditions === "string") {
        try { rule.conditions = JSON.parse(rule.conditions); } catch { rule.conditions = {}; }
      }
      if (!byDomain[rule.domain_name]) byDomain[rule.domain_name] = [];
      byDomain[rule.domain_name].push(rule);
    }

    rulesCache = byDomain;
    cacheExpiry = Date.now() + (parseInt(env.RULES_CACHE_TTL || "300") * 1000);

    return byDomain[domain] || [];
  } catch (err) {
    console.error("[301-tds] Failed to load rules:", err);
    return [];
  }
}

async function getDomainConfig(env, domain) {
  try {
    return await env.DB.prepare(
      "SELECT * FROM domain_config WHERE domain_name = ?"
    ).bind(domain).first();
  } catch {
    return null;
  }
}

// ============================================================
// STATS (D1) — two tables: shield (compact) + link (granular)
// ============================================================

async function recordShieldStat(env, domain, ruleId, type) {
  const hour = new Date().toISOString().slice(0, 13);
  const col = type; // blocks | passes
  try {
    await env.DB.prepare(\`
      INSERT INTO stats_shield (domain_name, rule_id, hour, hits, \${col})
      VALUES (?, ?, ?, 1, 1)
      ON CONFLICT(domain_name, rule_id, hour)
      DO UPDATE SET hits = hits + 1, \${col} = \${col} + 1
    \`).bind(domain, ruleId, hour).run();
  } catch (err) {
    console.error("[301-tds] Shield stats error:", err);
  }
}

async function recordLinkStat(env, domain, ruleId, country, device) {
  const hour = new Date().toISOString().slice(0, 13);
  try {
    await env.DB.prepare(\`
      INSERT INTO stats_link (domain_name, rule_id, hour, country, device, hits, redirects)
      VALUES (?, ?, ?, ?, ?, 1, 1)
      ON CONFLICT(domain_name, rule_id, hour, country, device)
      DO UPDATE SET hits = hits + 1, redirects = redirects + 1
    \`).bind(domain, ruleId, hour, country || "XX", device || "desktop").run();
  } catch (err) {
    console.error("[301-tds] Link stats error:", err);
  }
}

async function recordMabImpression(env, ruleId, variantUrl) {
  try {
    await env.DB.prepare(\`
      INSERT INTO mab_stats (rule_id, variant_url, impressions, updated_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(rule_id, variant_url)
      DO UPDATE SET impressions = impressions + 1, updated_at = datetime('now')
    \`).bind(ruleId, variantUrl).run();
  } catch (err) {
    console.error("[301-tds] MAB stats error:", err);
  }
}

async function getStats(env) {
  try {
    const shield = await env.DB.prepare(\`
      SELECT domain_name, SUM(hits) as total_hits, SUM(blocks) as total_blocks, SUM(passes) as total_passes
      FROM stats_shield WHERE hour >= datetime('now', '-24 hours')
      GROUP BY domain_name
    \`).all();
    const link = await env.DB.prepare(\`
      SELECT domain_name, rule_id, SUM(hits) as total_hits, SUM(redirects) as total_redirects
      FROM stats_link WHERE hour >= datetime('now', '-24 hours')
      GROUP BY domain_name, rule_id
    \`).all();
    return { shield: shield.results || [], link: link.results || [] };
  } catch {
    return { shield: [], link: [] };
  }
}

// ============================================================
// PUSH STATS (Client D1 → Webhook)
// ============================================================

async function pushStats(env) {
  try {
    const currentHour = new Date().toISOString().slice(0, 13);

    // Collect completed shield stats (hours before current — aggregate by domain)
    const shield = await env.DB.prepare(
      "SELECT domain_name, hour, SUM(hits) as hits, SUM(blocks) as blocks, SUM(passes) as passes FROM stats_shield WHERE hour < ? GROUP BY domain_name, hour"
    ).bind(currentHour).all();

    // Collect completed link stats (full granularity)
    const links = await env.DB.prepare(
      "SELECT domain_name, rule_id, hour, country, device, hits, redirects FROM stats_link WHERE hour < ?"
    ).bind(currentHour).all();

    // Collect mab impressions
    const mab = await env.DB.prepare(
      "SELECT rule_id, variant_url, impressions FROM mab_stats WHERE impressions > 0"
    ).all();

    const shieldRows = shield.results || [];
    const linkRows = links.results || [];
    const mabRows = mab.results || [];

    // Nothing to push
    if (shieldRows.length === 0 && linkRows.length === 0 && mabRows.length === 0) return;

    const webhookUrl = env.TDS_WEBHOOK_URL || "https://webhook.301.st/tds";

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.WORKER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_id: parseInt(env.ACCOUNT_ID),
        timestamp: new Date().toISOString(),
        shield: shieldRows,
        links: linkRows,
        mab: mabRows,
      }),
    });

    if (response.ok) {
      // Delete pushed rows (completed hours only)
      await env.DB.prepare("DELETE FROM stats_shield WHERE hour < ?").bind(currentHour).run();
      await env.DB.prepare("DELETE FROM stats_link WHERE hour < ?").bind(currentHour).run();
      // Reset mab impression counters (pushed to platform)
      await env.DB.prepare("UPDATE mab_stats SET impressions = 0 WHERE impressions > 0").run();
      // Track last push
      await env.DB.prepare(
        "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('last_stats_push', datetime('now'), datetime('now'))"
      ).run();
    } else {
      console.error("[301-tds] Push stats failed:", response.status, await response.text().catch(() => ""));
    }
  } catch (err) {
    console.error("[301-tds] Push stats error:", err);
  }
}

// ============================================================
// CLEANUP (TTL safety net)
// ============================================================

async function cleanupOldStats(env) {
  try {
    const now = Date.now();
    const shield7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13);
    const link30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 13);

    await env.DB.prepare("DELETE FROM stats_shield WHERE hour < ?").bind(shield7d).run();
    await env.DB.prepare("DELETE FROM stats_link WHERE hour < ?").bind(link30d).run();
  } catch (err) {
    console.error("[301-tds] Cleanup error:", err);
  }
}

// ============================================================
// SYNC (Pull from API)
// ============================================================

async function syncRules(env) {
  try {
    const lastSync = await env.DB.prepare(
      "SELECT value FROM sync_status WHERE key = 'last_rules_sync'"
    ).first();

    const response = await fetch(env.API_URL + "/tds/sync", {
      headers: {
        Authorization: "Bearer " + env.WORKER_API_KEY,
        "X-Account-Id": env.ACCOUNT_ID,
      },
    });

    if (!response.ok) return;

    const data = await response.json();
    if (!data.ok) return;

    // Update rules
    if (data.rules && data.rules.length > 0) {
      await env.DB.prepare("DELETE FROM tds_rules").run();
      for (const rule of data.rules) {
        await env.DB.prepare(\`
          INSERT INTO tds_rules (id, domain_name, tds_type, priority, conditions, action, action_url, status_code, variants, algorithm, active, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        \`).bind(
          rule.id, rule.domain_name, rule.tds_type || "traffic_shield", rule.priority,
          JSON.stringify(rule.conditions), rule.action,
          rule.action_url || null, rule.status_code || 302,
          rule.variants ? JSON.stringify(rule.variants) : null,
          rule.algorithm || "thompson_sampling",
          rule.active ? 1 : 0
        ).run();
      }
    }

    // Update configs
    if (data.configs && data.configs.length > 0) {
      for (const cfg of data.configs) {
        await env.DB.prepare(\`
          INSERT OR REPLACE INTO domain_config
          (domain_name, tds_enabled, default_action, default_url, smartshield_enabled, bot_action, bot_redirect_url, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        \`).bind(
          cfg.domain_name, cfg.tds_enabled ? 1 : 0,
          cfg.default_action, cfg.default_url || null,
          cfg.smartshield_enabled ? 1 : 0,
          cfg.bot_action, cfg.bot_redirect_url || null
        ).run();
      }
    }

    // Update sync status
    await env.DB.prepare(
      "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('last_rules_sync', datetime('now'), datetime('now'))"
    ).run();

    // Invalidate cache
    rulesCache = null;
    cacheExpiry = 0;
  } catch (err) {
    console.error("[301-tds] Sync error:", err);
  }
}
`;
