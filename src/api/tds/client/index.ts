// src/api/tds/client/index.ts

/**
 * 301 TDS Worker
 *
 * Traffic Distribution System worker.
 * Handles redirect rules based on:
 * - Geo (country, region)
 * - Device (mobile/desktop)
 * - User-Agent (bots, browsers)
 * - URL parameters (UTM, etc.)
 *
 * Rules are cached locally and synced from 301.st API.
 */

// ============================================================
// TYPES
// ============================================================

export interface Env {
  DB: D1Database;
  JWT_TOKEN: string;        // JWT for API auth
  ACCOUNT_ID: string;
  API_URL: string;          // 301.st API URL
  RULES_CACHE_TTL?: string; // Cache TTL in seconds (default: 300)
  ENABLE_LOGGING?: string;  // Enable request logging (default: false)
}

interface TDSRule {
  id: number;
  domain_name: string;
  priority: number;
  conditions: RuleConditions;
  action: "redirect" | "block" | "pass";
  action_url: string | null;
  status_code: number;
  active: boolean;
}

interface RuleConditions {
  geo?: string[];          // Country codes: ["RU", "US"]
  geo_exclude?: string[];  // Exclude countries
  device?: "mobile" | "desktop" | "any";
  os?: string[];           // ["Android", "iOS", "Windows"]
  browser?: string[];      // ["Chrome", "Safari"]
  bot?: boolean;           // Is bot?
  utm_source?: string[];   // UTM source values
  utm_campaign?: string[]; // UTM campaign values
  path?: string;           // Path regex
  referrer?: string;       // Referrer regex
}

interface DomainConfig {
  domain_name: string;
  tds_enabled: boolean;
  default_action: "redirect" | "block" | "pass";
  default_url: string | null;
  smartshield_enabled: boolean;
  bot_action: "block" | "pass" | "redirect";
  bot_redirect_url: string | null;
}

interface RequestContext {
  url: URL;
  hostname: string;
  path: string;
  country: string;
  device: "mobile" | "desktop";
  os: string;
  browser: string;
  isBot: boolean;
  ip: string;
  userAgent: string;
  params: URLSearchParams;
  referrer: string | null;
}

// ============================================================
// WORKER ENTRY
// ============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/_health") {
      return new Response(JSON.stringify({ ok: true, worker: "301-tds" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Manual sync endpoint (protected)
    if (url.pathname === "/_sync" && request.method === "POST") {
      return handleManualSync(env);
    }

    // Stats endpoint
    if (url.pathname === "/_stats") {
      return handleStats(env);
    }

    // Process TDS rules
    return handleTDSRequest(request, env, ctx);
  },
};

// ============================================================
// TDS REQUEST HANDLER
// ============================================================

async function handleTDSRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const context = parseRequestContext(request);

  // Get domain config
  const config = await getDomainConfig(env, context.hostname);

  if (!config || !config.tds_enabled) {
    // TDS not enabled for this domain, pass through
    return fetch(request);
  }

  // SmartShield: check for bots first
  if (config.smartshield_enabled && context.isBot) {
    if (config.bot_action === "block") {
      return new Response("Access Denied", { status: 403 });
    }
    if (config.bot_action === "redirect" && config.bot_redirect_url) {
      return Response.redirect(config.bot_redirect_url, 302);
    }
    // pass through
  }

  // Get rules for domain
  const rules = await getRulesForDomain(env, context.hostname);

  // Find matching rule (first match wins)
  for (const rule of rules) {
    if (matchRule(rule, context)) {
      // Log request if enabled
      if (env.ENABLE_LOGGING === "true") {
        ctx.waitUntil(logRequest(env, context, rule));
      }

      return executeAction(rule, context);
    }
  }

  // No rule matched, use default action
  if (config.default_action === "redirect" && config.default_url) {
    return Response.redirect(config.default_url, 302);
  }

  if (config.default_action === "block") {
    return new Response("Access Denied", { status: 403 });
  }

  // Pass through to origin
  return fetch(request);
}

// ============================================================
// REQUEST CONTEXT PARSING
// ============================================================

function parseRequestContext(request: Request): RequestContext {
  const url = new URL(request.url);
  const userAgent = request.headers.get("User-Agent") || "";
  const cf = (request as any).cf || {};

  return {
    url,
    hostname: url.hostname,
    path: url.pathname,
    country: cf.country || "XX",
    device: detectDevice(userAgent),
    os: detectOS(userAgent),
    browser: detectBrowser(userAgent),
    isBot: detectBot(userAgent),
    ip: request.headers.get("CF-Connecting-IP") || "",
    userAgent,
    params: url.searchParams,
    referrer: request.headers.get("Referer"),
  };
}

function detectDevice(ua: string): "mobile" | "desktop" {
  const mobilePatterns = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|Opera Mini|IEMobile/i;
  return mobilePatterns.test(ua) ? "mobile" : "desktop";
}

function detectOS(ua: string): string {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

function detectBrowser(ua: string): string {
  if (/Chrome/i.test(ua) && !/Chromium|Edge/i.test(ua)) return "Chrome";
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
  if (/Firefox/i.test(ua)) return "Firefox";
  if (/Edge/i.test(ua)) return "Edge";
  if (/Opera|OPR/i.test(ua)) return "Opera";
  return "Unknown";
}

function detectBot(ua: string): boolean {
  const botPatterns = /Googlebot|bingbot|YandexBot|Baiduspider|facebookexternalhit|Twitterbot|rogerbot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterest|slackbot|vkShare|W3C_Validator|HeadlessChrome|python-requests|curl|wget|scrapy|PhantomJS|Selenium/i;
  return botPatterns.test(ua);
}

// ============================================================
// RULE MATCHING
// ============================================================

function matchRule(rule: TDSRule, ctx: RequestContext): boolean {
  const c = rule.conditions;

  // Geo check
  if (c.geo && c.geo.length > 0) {
    if (!c.geo.includes(ctx.country)) return false;
  }

  // Geo exclude
  if (c.geo_exclude && c.geo_exclude.length > 0) {
    if (c.geo_exclude.includes(ctx.country)) return false;
  }

  // Device check
  if (c.device && c.device !== "any") {
    if (c.device !== ctx.device) return false;
  }

  // OS check
  if (c.os && c.os.length > 0) {
    if (!c.os.includes(ctx.os)) return false;
  }

  // Browser check
  if (c.browser && c.browser.length > 0) {
    if (!c.browser.includes(ctx.browser)) return false;
  }

  // Bot check
  if (c.bot !== undefined) {
    if (c.bot !== ctx.isBot) return false;
  }

  // UTM source
  if (c.utm_source && c.utm_source.length > 0) {
    const source = ctx.params.get("utm_source");
    if (!source || !c.utm_source.includes(source)) return false;
  }

  // UTM campaign
  if (c.utm_campaign && c.utm_campaign.length > 0) {
    const campaign = ctx.params.get("utm_campaign");
    if (!campaign || !c.utm_campaign.includes(campaign)) return false;
  }

  // Path regex
  if (c.path) {
    try {
      const regex = new RegExp(c.path);
      if (!regex.test(ctx.path)) return false;
    } catch {
      // Invalid regex, skip
    }
  }

  // Referrer regex
  if (c.referrer && ctx.referrer) {
    try {
      const regex = new RegExp(c.referrer);
      if (!regex.test(ctx.referrer)) return false;
    } catch {
      // Invalid regex, skip
    }
  }

  return true;
}

// ============================================================
// ACTION EXECUTION
// ============================================================

function executeAction(rule: TDSRule, ctx: RequestContext): Response {
  switch (rule.action) {
    case "redirect":
      if (rule.action_url) {
        // Support variable substitution in URL
        const url = substituteVariables(rule.action_url, ctx);
        return Response.redirect(url, rule.status_code || 302);
      }
      return fetch(ctx.url.toString());

    case "block":
      return new Response("Access Denied", { status: 403 });

    case "pass":
    default:
      return fetch(ctx.url.toString());
  }
}

function substituteVariables(url: string, ctx: RequestContext): string {
  return url
    .replace("{country}", ctx.country)
    .replace("{device}", ctx.device)
    .replace("{path}", ctx.path)
    .replace("{host}", ctx.hostname);
}

// ============================================================
// DATABASE OPERATIONS
// ============================================================

async function getDomainConfig(env: Env, hostname: string): Promise<DomainConfig | null> {
  const row = await env.DB.prepare(`
    SELECT * FROM domain_config WHERE domain_name = ?
  `).bind(hostname).first<{
    domain_name: string;
    tds_enabled: number;
    default_action: string;
    default_url: string | null;
    smartshield_enabled: number;
    bot_action: string;
    bot_redirect_url: string | null;
  }>();

  if (!row) return null;

  return {
    domain_name: row.domain_name,
    tds_enabled: row.tds_enabled === 1,
    default_action: row.default_action as "redirect" | "block" | "pass",
    default_url: row.default_url,
    smartshield_enabled: row.smartshield_enabled === 1,
    bot_action: row.bot_action as "block" | "pass" | "redirect",
    bot_redirect_url: row.bot_redirect_url,
  };
}

async function getRulesForDomain(env: Env, hostname: string): Promise<TDSRule[]> {
  const rows = await env.DB.prepare(`
    SELECT * FROM tds_rules
    WHERE domain_name = ? AND active = 1
    ORDER BY priority DESC
  `).bind(hostname).all<{
    id: number;
    domain_name: string;
    priority: number;
    conditions: string;
    action: string;
    action_url: string | null;
    status_code: number;
    active: number;
  }>();

  return rows.results.map(row => ({
    id: row.id,
    domain_name: row.domain_name,
    priority: row.priority,
    conditions: JSON.parse(row.conditions),
    action: row.action as "redirect" | "block" | "pass",
    action_url: row.action_url,
    status_code: row.status_code,
    active: row.active === 1,
  }));
}

async function logRequest(
  env: Env,
  ctx: RequestContext,
  rule: TDSRule | null
): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO request_log (domain_name, path, country, device, user_agent, ip, rule_id, action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      ctx.hostname,
      ctx.path,
      ctx.country,
      ctx.device,
      ctx.userAgent.substring(0, 255),
      ctx.ip,
      rule?.id || null,
      rule?.action || "pass"
    ).run();
  } catch (err) {
    console.error("Failed to log request:", err);
  }
}

// ============================================================
// SYNC & STATS HANDLERS
// ============================================================

async function handleManualSync(env: Env): Promise<Response> {
  try {
    const response = await fetch(`${env.API_URL}/tds/rules`, {
      headers: {
        Authorization: `Bearer ${env.JWT_TOKEN}`,
        "X-Account-ID": env.ACCOUNT_ID,
      },
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ ok: false, error: "sync_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await response.json() as { rules: any[]; configs: any[] };

    // Clear and re-insert rules
    await env.DB.prepare("DELETE FROM tds_rules").run();
    await env.DB.prepare("DELETE FROM domain_config").run();

    for (const rule of data.rules || []) {
      await env.DB.prepare(`
        INSERT INTO tds_rules (id, domain_name, priority, conditions, action, action_url, status_code, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        rule.id,
        rule.domain_name,
        rule.priority || 0,
        JSON.stringify(rule.conditions),
        rule.action,
        rule.action_url,
        rule.status_code || 302,
        rule.active ? 1 : 0
      ).run();
    }

    for (const config of data.configs || []) {
      await env.DB.prepare(`
        INSERT INTO domain_config (domain_name, tds_enabled, default_action, default_url, smartshield_enabled, bot_action, bot_redirect_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        config.domain_name,
        config.tds_enabled ? 1 : 0,
        config.default_action || "pass",
        config.default_url,
        config.smartshield_enabled ? 1 : 0,
        config.bot_action || "pass",
        config.bot_redirect_url
      ).run();
    }

    // Update sync status
    await env.DB.prepare(`
      UPDATE sync_status SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'last_rules_sync'
    `).bind(new Date().toISOString()).run();

    return new Response(JSON.stringify({
      ok: true,
      rules_synced: data.rules?.length || 0,
      configs_synced: data.configs?.length || 0,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : "sync_error",
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleStats(env: Env): Promise<Response> {
  const rulesCount = await env.DB.prepare("SELECT COUNT(*) as count FROM tds_rules").first<{ count: number }>();
  const configsCount = await env.DB.prepare("SELECT COUNT(*) as count FROM domain_config").first<{ count: number }>();
  const lastSync = await env.DB.prepare("SELECT value FROM sync_status WHERE key = 'last_rules_sync'").first<{ value: string | null }>();

  return new Response(JSON.stringify({
    ok: true,
    stats: {
      rules: rulesCount?.count || 0,
      configs: configsCount?.count || 0,
      last_sync: lastSync?.value,
    },
  }), {
    headers: { "Content-Type": "application/json" },
  });
}
