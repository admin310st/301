// src/api/tds/client/index.ts

/**
 * 301 TDS Worker
 *
 * Traffic Distribution System worker deployed to customer Cloudflare accounts.
 * Handles redirect rules based on:
 * - Geo (country, region)
 * - Device (mobile/desktop) via Client Hints + UA fallback
 * - User-Agent (bots, browsers, OS)
 * - URL parameters (UTM, click IDs via match_params)
 * - Path / Referrer regex
 *
 * Rules are cached locally in D1 and synced from 301.st API (pull model).
 *
 * Three-channel statistics: AE (fire-and-forget) → DO (primary) → D1 (fallback)
 */

// ============================================================
// TYPES
// ============================================================

export interface Env {
  DB: D1Database;
  JWT_TOKEN: string;
  ACCOUNT_ID: string;
  API_URL: string;
  RULES_CACHE_TTL?: string;    // Cache TTL in seconds (default: 300)
  DISABLE_TDS?: string;        // Kill switch: "true" to bypass all TDS
  TDS_COUNTER: DurableObjectNamespace;
  TDS_ANALYTICS: AnalyticsEngineDataset;
}

type MABAlgorithm = "thompson_sampling" | "ucb" | "epsilon_greedy";

interface MABVariant {
  url: string;
  weight?: number;
  alpha: number;
  beta: number;
  impressions: number;
  conversions: number;
}

interface TDSRule {
  id: number;
  domain_name: string;
  priority: number;
  conditions: RuleConditions;
  action: "redirect" | "block" | "pass" | "mab_redirect";
  action_url: string | null;
  status_code: number;
  active: boolean;
  variants?: MABVariant[] | null;
  algorithm?: MABAlgorithm;
}

interface RuleConditions {
  geo?: string[];
  geo_exclude?: string[];
  device?: "mobile" | "desktop" | "any";
  os?: string[];
  browser?: string[];
  bot?: boolean;
  utm_source?: string[];
  utm_campaign?: string[];
  match_params?: string[];     // OR-logic: match if ANY param present in URL
  path?: string;
  referrer?: string;
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

interface TdsEvent {
  domain: string;
  rule_id: number | null;
  action: string;
  country: string;
  device: string;
  variant_url?: string;
}

// ============================================================
// CONSTANTS
// ============================================================

const BOT_UA = /\b(?:adsbot-google|mediapartners-google|feedfetcher-google|googlebot(?:[-_ ]?(?:image|video|news))?|google(?: web)?preview|bingbot|msnbot|bingpreview|yandex(?:bot|images|direct|video|mobilebot)?|baiduspider|slurp|duckduckbot|mail\.ru_bot|applebot|facebookexternalhit|twitterbot|discordbot|telegrambot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterest|slackbot|vkShare|W3C_Validator|HeadlessChrome|python-requests|curl|wget|scrapy|PhantomJS|Selenium)\b/i;

const MOBILE_UA = /\b(android|iphone|ipod|windows phone|opera mini|opera mobi|blackberry|bb10|silk\/|kindle|webos|iemobile)\b/i;

const STATIC_EXT = /\.(css|js|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)$/i;

const FLUSH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// ============================================================
// WORKER ENTRY
// ============================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Kill switch — instant bypass
    if (env.DISABLE_TDS === "true") {
      return fetch(request);
    }

    const url = new URL(request.url);

    // Anti-loop: if _tdspass marker present, pass through
    if (url.searchParams.has("_tdspass")) {
      return fetch(request);
    }

    // Bypass static resources — save Worker invocations
    if (STATIC_EXT.test(url.pathname)) {
      return passthrough(request);
    }

    // Health check
    if (url.pathname === "/health" || url.pathname === "/_health") {
      return new Response(JSON.stringify({ ok: true, worker: "301-tds" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Manual sync endpoint
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
// PASSTHROUGH WITH ACCEPT-CH
// ============================================================

async function passthrough(request: Request): Promise<Response> {
  const resp = await fetch(request);
  const h = new Headers(resp.headers);
  h.set("Accept-CH", "Sec-CH-UA-Mobile");
  return new Response(resp.body, { status: resp.status, headers: h });
}

// ============================================================
// TDS REQUEST HANDLER
// ============================================================

async function handleTDSRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const context = parseRequestContext(request);

  // Auto-sync if TTL expired
  ctx.waitUntil(autoSync(env));

  const config = await getDomainConfig(env, context.hostname);

  if (!config || !config.tds_enabled) {
    return passthrough(request);
  }

  // SmartShield: check for bots first
  if (config.smartshield_enabled && context.isBot) {
    const event: TdsEvent = {
      domain: context.hostname,
      rule_id: null,
      action: config.bot_action,
      country: context.country,
      device: context.device,
    };
    ctx.waitUntil(emitEvent(env, ctx, event));

    if (config.bot_action === "block") {
      return new Response("Access Denied", { status: 403 });
    }
    if (config.bot_action === "redirect" && config.bot_redirect_url) {
      return buildRedirect(config.bot_redirect_url, 302, "smartshield:bot", false);
    }
    // pass through for bots
  }

  const rules = await getRulesForDomain(env, context.hostname);

  // Find matching rule (first match wins)
  for (const rule of rules) {
    if (matchRule(rule, context)) {
      const event: TdsEvent = {
        domain: context.hostname,
        rule_id: rule.id,
        action: rule.action,
        country: context.country,
        device: context.device,
      };

      // MAB redirect: select variant, track impression, emit with variant_url
      if (rule.action === "mab_redirect" && rule.variants && rule.variants.length >= 2) {
        const selected = selectVariant(rule.variants, rule.algorithm || "thompson_sampling");
        event.variant_url = selected.url;
        ctx.waitUntil(emitEvent(env, ctx, event));
        ctx.waitUntil(upsertMabStat(env, rule.id, selected.url));
        const url = substituteVariables(selected.url, context);
        return buildRedirect(url, rule.status_code || 302, `tds:${rule.id}:mab`, false);
      }

      ctx.waitUntil(emitEvent(env, ctx, event));
      return executeAction(rule, context);
    }
  }

  // No rule matched — emit event for default action
  const event: TdsEvent = {
    domain: context.hostname,
    rule_id: null,
    action: config.default_action,
    country: context.country,
    device: context.device,
  };
  ctx.waitUntil(emitEvent(env, ctx, event));

  if (config.default_action === "redirect" && config.default_url) {
    return buildRedirect(config.default_url, 302, "default", false);
  }

  if (config.default_action === "block") {
    return new Response("Access Denied", { status: 403 });
  }

  return passthrough(request);
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
    country: (cf.country || "XX").toUpperCase(),
    device: detectDevice(request.headers, userAgent),
    os: detectOS(userAgent),
    browser: detectBrowser(userAgent),
    isBot: BOT_UA.test(userAgent),
    ip: request.headers.get("CF-Connecting-IP") || "",
    userAgent,
    params: url.searchParams,
    referrer: request.headers.get("Referer"),
  };
}

/**
 * Device detection: Client Hints first, UA fallback.
 * iPad excluded from mobile (treated as desktop in TDS context).
 */
function detectDevice(headers: Headers, ua: string): "mobile" | "desktop" {
  const chMobile = headers.get("Sec-CH-UA-Mobile");
  if (chMobile === "?1") return "mobile";
  if (chMobile === "?0") return "desktop";
  // UA fallback — iPad is desktop
  if (MOBILE_UA.test(ua) && !/iPad/i.test(ua)) return "mobile";
  return "desktop";
}

function detectOS(ua: string): string {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPod/i.test(ua)) return "iOS";
  if (/iPad/i.test(ua)) return "iPadOS";
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

// ============================================================
// RULE MATCHING
// ============================================================

function matchRule(rule: TDSRule, ctx: RequestContext): boolean {
  const c = rule.conditions;

  // Geo include
  if (c.geo && c.geo.length > 0) {
    if (!c.geo.includes(ctx.country)) return false;
  }

  // Geo exclude
  if (c.geo_exclude && c.geo_exclude.length > 0) {
    if (c.geo_exclude.includes(ctx.country)) return false;
  }

  // Device
  if (c.device && c.device !== "any") {
    if (c.device !== ctx.device) return false;
  }

  // OS
  if (c.os && c.os.length > 0) {
    if (!c.os.includes(ctx.os)) return false;
  }

  // Browser
  if (c.browser && c.browser.length > 0) {
    if (!c.browser.includes(ctx.browser)) return false;
  }

  // Bot
  if (c.bot !== undefined) {
    if (c.bot !== ctx.isBot) return false;
  }

  // match_params: OR-logic — if ANY of these params present in URL, condition met.
  // When match_params matches, skip utm_source check (used by L2/L3 presets).
  let matchParamsHit = false;
  if (c.match_params && c.match_params.length > 0) {
    matchParamsHit = c.match_params.some((p) => ctx.params.has(p));
  }

  // UTM source — skip if match_params already matched
  if (!matchParamsHit && c.utm_source && c.utm_source.length > 0) {
    const source = ctx.params.get("utm_source");
    if (!source || !c.utm_source.includes(source)) return false;
  }

  // If match_params defined but none matched AND no utm_source matched
  if (c.match_params && c.match_params.length > 0 && !matchParamsHit) {
    if (c.utm_source && c.utm_source.length > 0) {
      // utm_source was already checked above and passed — OK
    } else {
      return false;
    }
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

/**
 * Determine if a rule's redirect can be cached at CF edge.
 * Cacheable only when conditions depend solely on URL (not geo/device/UA).
 */
function isRuleCacheable(rule: TDSRule): boolean {
  const c = rule.conditions;
  if (c.geo && c.geo.length > 0) return false;
  if (c.geo_exclude && c.geo_exclude.length > 0) return false;
  if (c.device && c.device !== "any") return false;
  if (c.os && c.os.length > 0) return false;
  if (c.browser && c.browser.length > 0) return false;
  if (c.bot !== undefined) return false;
  if (rule.action === "mab_redirect") return false;
  return true;
}

async function executeAction(rule: TDSRule, ctx: RequestContext): Promise<Response> {
  switch (rule.action) {
    case "redirect":
      if (rule.action_url) {
        const url = substituteVariables(rule.action_url, ctx);
        const cacheable = isRuleCacheable(rule);
        return buildRedirect(url, rule.status_code || 302, `tds:${rule.id}`, cacheable);
      }
      return passthrough(new Request(ctx.url.toString()));

    case "block":
      return new Response("Access Denied", {
        status: 403,
        headers: { "X-Edge-Redirect": `tds:${rule.id}:block` },
      });

    case "pass":
    default:
      return passthrough(new Request(ctx.url.toString()));
  }
}

/**
 * Build redirect response with Cache-Control and anti-loop protection.
 */
function buildRedirect(
  targetUrl: string,
  statusCode: number,
  debugLabel: string,
  cacheable: boolean,
): Response {
  // Anti-loop: add _tdspass if target doesn't already have it
  try {
    const target = new URL(targetUrl);
    if (!target.searchParams.has("_tdspass")) {
      target.searchParams.set("_tdspass", "1");
    }
    targetUrl = target.toString();
  } catch {
    // If URL parsing fails, use as-is
  }

  return new Response("Redirect\n", {
    status: statusCode,
    headers: {
      Location: targetUrl,
      "Cache-Control": cacheable ? "public, max-age=300" : "private, no-cache",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Edge-Redirect": debugLabel,
      Connection: "close",
    },
  });
}

function substituteVariables(url: string, ctx: RequestContext): string {
  return url
    .replace(/\{country\}/g, ctx.country)
    .replace(/\{device\}/g, ctx.device)
    .replace(/\{path\}/g, ctx.path)
    .replace(/\{host\}/g, ctx.hostname);
}

// ============================================================
// MAB ALGORITHMS
// ============================================================

function selectVariant(variants: MABVariant[], algorithm: MABAlgorithm): MABVariant {
  switch (algorithm) {
    case "thompson_sampling": return selectThompsonSampling(variants);
    case "ucb":               return selectUCB(variants);
    case "epsilon_greedy":    return selectEpsilonGreedy(variants);
    default:                  return selectThompsonSampling(variants);
  }
}

function selectThompsonSampling(variants: MABVariant[]): MABVariant {
  let bestVariant = variants[0];
  let maxTheta = -1;

  for (const variant of variants) {
    const theta = randomBeta(variant.alpha || 1, variant.beta || 1);
    if (theta > maxTheta) {
      maxTheta = theta;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

function selectUCB(variants: MABVariant[]): MABVariant {
  const totalImpressions = variants.reduce((sum, v) => sum + (v.impressions || 0), 0);

  let bestVariant = variants[0];
  let maxUCB = -Infinity;

  for (const variant of variants) {
    if (!variant.impressions || variant.impressions === 0) {
      return variant; // Priority to unexplored
    }

    const mean = (variant.conversions || 0) / variant.impressions;
    const exploration = Math.sqrt((2 * Math.log(totalImpressions)) / variant.impressions);
    const ucb = mean + exploration;

    if (ucb > maxUCB) {
      maxUCB = ucb;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

function selectEpsilonGreedy(variants: MABVariant[], epsilon = 0.1): MABVariant {
  // Exploration: random choice
  if (Math.random() < epsilon) {
    return variants[Math.floor(Math.random() * variants.length)];
  }

  // Exploitation: best by conversion rate
  let bestVariant = variants[0];
  let maxMean = -1;

  for (const variant of variants) {
    if (!variant.impressions || variant.impressions === 0) {
      return variant; // Priority to unexplored
    }

    const mean = (variant.conversions || 0) / variant.impressions;
    if (mean > maxMean) {
      maxMean = mean;
      bestVariant = variant;
    }
  }

  return bestVariant;
}

// --- Math helpers (Marsaglia-Tsang method for Gamma → Beta) ---

function randomBeta(alpha: number, beta: number): number {
  const x = randomGamma(alpha, 1);
  const y = randomGamma(beta, 1);
  return x / (x + y);
}

function randomGamma(alpha: number, _beta: number): number {
  if (alpha < 1) {
    return randomGamma(alpha + 1, _beta) * Math.pow(Math.random(), 1 / alpha);
  }

  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number;
    let v: number;
    do {
      x = randomNormal();
      v = Math.pow(1 + c * x, 3);
    } while (v <= 0);

    const u = Math.random();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) {
      return d * v;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

function randomNormal(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// --- MAB Stats ---

async function upsertMabStat(env: Env, ruleId: number, variantUrl: string): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO mab_stats (rule_id, variant_url, impressions, updated_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(rule_id, variant_url) DO UPDATE SET
        impressions = impressions + 1,
        updated_at = CURRENT_TIMESTAMP
    `).bind(ruleId, variantUrl).run();
  } catch {
    // Best effort — don't block on stats failure
  }
}

// ============================================================
// THREE-CHANNEL STATISTICS
// ============================================================

function writeToAnalyticsEngine(env: Env, event: TdsEvent): void {
  try {
    env.TDS_ANALYTICS.writeDataPoint({
      indexes: [event.domain],
      blobs: [
        event.domain,
        String(event.rule_id || 0),
        event.action,
        event.country || "",
        event.device || "",
        event.variant_url || "",
      ],
      doubles: [1],
    });
  } catch {
    // AE is fire-and-forget, never block on failure
  }
}

async function emitEvent(env: Env, ctx: ExecutionContext, event: TdsEvent): Promise<void> {
  // 1. Analytics Engine — fire-and-forget, parallel, never blocks
  writeToAnalyticsEngine(env, event);

  // 2. DO — primary aggregation path
  try {
    const id = env.TDS_COUNTER.idFromName("global");
    const stub = env.TDS_COUNTER.get(id);
    const resp = await stub.fetch(new Request("https://do/event", {
      method: "POST",
      body: JSON.stringify(event),
    }));
    if (!resp.ok) throw new Error(`DO returned ${resp.status}`);
  } catch {
    // 3. D1 fallback — when DO unavailable (limit exceeded)
    ctx.waitUntil(upsertStatsHourly(env.DB, event));
  }
}

function hourKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

async function upsertStatsHourly(db: D1Database, event: TdsEvent): Promise<void> {
  try {
    const hour = hourKey();
    const actionCol = event.action === "redirect" || event.action === "mab_redirect"
      ? "redirects"
      : event.action === "block" ? "blocks" : "passes";

    await db.prepare(`
      INSERT INTO stats_hourly (domain_name, rule_id, hour, hits, ${actionCol}, by_country, by_device)
      VALUES (?, ?, ?, 1, 1, ?, ?)
      ON CONFLICT(domain_name, rule_id, hour) DO UPDATE SET
        hits = hits + 1,
        ${actionCol} = ${actionCol} + 1
    `).bind(
      event.domain,
      event.rule_id,
      hour,
      JSON.stringify(event.country ? { [event.country]: 1 } : {}),
      JSON.stringify(event.device ? { [event.device]: 1 } : {}),
    ).run();
  } catch {
    // D1 fallback — best effort
  }
}

// ============================================================
// DURABLE OBJECT: TdsCounter
// ============================================================

interface HourlyBucket {
  domain: string;
  rule_id: number | null;
  hour: string;
  hits: number;
  redirects: number;
  blocks: number;
  passes: number;
  by_country: Record<string, number>;
  by_device: Record<string, number>;
}

export class TdsCounter implements DurableObject {
  private counters: Map<string, HourlyBucket>;
  private env: Env;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.counters = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const event = await request.json<TdsEvent>();
      const hour = hourKey();
      const key = `${event.domain}:${event.rule_id ?? "null"}:${hour}`;

      let bucket = this.counters.get(key);
      if (!bucket) {
        bucket = {
          domain: event.domain,
          rule_id: event.rule_id,
          hour,
          hits: 0,
          redirects: 0,
          blocks: 0,
          passes: 0,
          by_country: {},
          by_device: {},
        };
      }

      bucket.hits++;
      if (event.action === "redirect" || event.action === "mab_redirect") {
        bucket.redirects++;
      } else if (event.action === "block") {
        bucket.blocks++;
      } else {
        bucket.passes++;
      }
      if (event.country) {
        bucket.by_country[event.country] = (bucket.by_country[event.country] || 0) + 1;
      }
      if (event.device) {
        bucket.by_device[event.device] = (bucket.by_device[event.device] || 0) + 1;
      }
      this.counters.set(key, bucket);

      // Set alarm if not already set
      const alarm = await this.state.storage.getAlarm();
      if (!alarm) {
        await this.state.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS);
      }

      return new Response("ok");
    } catch {
      return new Response("error", { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    if (this.counters.size === 0) return;

    const stmts: D1PreparedStatement[] = [];
    for (const bucket of this.counters.values()) {
      stmts.push(
        this.env.DB.prepare(`
          INSERT INTO stats_hourly (domain_name, rule_id, hour, hits, redirects, blocks, passes, by_country, by_device)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(domain_name, rule_id, hour) DO UPDATE SET
            hits = hits + excluded.hits,
            redirects = redirects + excluded.redirects,
            blocks = blocks + excluded.blocks,
            passes = passes + excluded.passes
        `).bind(
          bucket.domain,
          bucket.rule_id,
          bucket.hour,
          bucket.hits,
          bucket.redirects,
          bucket.blocks,
          bucket.passes,
          JSON.stringify(bucket.by_country),
          JSON.stringify(bucket.by_device),
        ),
      );
    }

    try {
      await this.env.DB.batch(stmts);
      this.counters.clear();
    } catch {
      // Keep counters for next alarm attempt
      await this.state.storage.setAlarm(Date.now() + 60_000); // Retry in 1 min
    }
  }
}

// ============================================================
// AUTO SYNC
// ============================================================

let lastSyncCheck = 0;

async function autoSync(env: Env): Promise<void> {
  const ttl = parseInt(env.RULES_CACHE_TTL || "300") * 1000;
  const now = Date.now();
  if (now - lastSyncCheck < ttl) return;
  lastSyncCheck = now;

  try {
    // Get stored version
    const stored = await env.DB.prepare(
      "SELECT value FROM sync_status WHERE key = 'version'",
    ).first<{ value: string | null }>();
    const currentVersion = stored?.value || "";

    const url = `${env.API_URL}/tds/sync?version=${encodeURIComponent(currentVersion)}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.JWT_TOKEN}`,
        "X-Account-ID": env.ACCOUNT_ID,
      },
    });

    if (resp.status === 304) return; // No changes
    if (!resp.ok) return;

    const data = await resp.json() as {
      version: string;
      rules: any[];
      configs: any[];
    };

    // Full replace
    await env.DB.prepare("DELETE FROM tds_rules").run();
    await env.DB.prepare("DELETE FROM domain_config").run();

    const ruleStmts: D1PreparedStatement[] = [];
    for (const rule of data.rules || []) {
      ruleStmts.push(
        env.DB.prepare(`
          INSERT INTO tds_rules (id, domain_name, priority, conditions, action, action_url, status_code, variants, algorithm, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          rule.id,
          rule.domain_name,
          rule.priority || 0,
          JSON.stringify(rule.conditions),
          rule.action,
          rule.action_url,
          rule.status_code || 302,
          rule.variants ? JSON.stringify(rule.variants) : null,
          rule.algorithm || "thompson_sampling",
          rule.active ? 1 : 0,
        ),
      );
    }
    if (ruleStmts.length > 0) {
      await env.DB.batch(ruleStmts);
    }

    const configStmts: D1PreparedStatement[] = [];
    for (const config of data.configs || []) {
      configStmts.push(
        env.DB.prepare(`
          INSERT INTO domain_config (domain_name, tds_enabled, default_action, default_url, smartshield_enabled, bot_action, bot_redirect_url)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          config.domain_name,
          config.tds_enabled ? 1 : 0,
          config.default_action || "pass",
          config.default_url,
          config.smartshield_enabled ? 1 : 0,
          config.bot_action || "pass",
          config.bot_redirect_url,
        ),
      );
    }
    if (configStmts.length > 0) {
      await env.DB.batch(configStmts);
    }

    // Update version + timestamp
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('version', ?, CURRENT_TIMESTAMP)",
      ).bind(data.version),
      env.DB.prepare(
        "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('last_rules_sync', ?, CURRENT_TIMESTAMP)",
      ).bind(new Date().toISOString()),
    ]);
  } catch {
    // Sync failure is non-fatal — use cached rules
  }
}

// ============================================================
// MANUAL SYNC & STATS HANDLERS
// ============================================================

async function handleManualSync(env: Env): Promise<Response> {
  try {
    const response = await fetch(`${env.API_URL}/tds/sync`, {
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

    const data = await response.json() as { version: string; rules: any[]; configs: any[] };

    await env.DB.prepare("DELETE FROM tds_rules").run();
    await env.DB.prepare("DELETE FROM domain_config").run();

    for (const rule of data.rules || []) {
      await env.DB.prepare(`
        INSERT INTO tds_rules (id, domain_name, priority, conditions, action, action_url, status_code, variants, algorithm, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        rule.id,
        rule.domain_name,
        rule.priority || 0,
        JSON.stringify(rule.conditions),
        rule.action,
        rule.action_url,
        rule.status_code || 302,
        rule.variants ? JSON.stringify(rule.variants) : null,
        rule.algorithm || "thompson_sampling",
        rule.active ? 1 : 0,
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
        config.bot_redirect_url,
      ).run();
    }

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('version', ?, CURRENT_TIMESTAMP)",
      ).bind(data.version || ""),
      env.DB.prepare(
        "INSERT OR REPLACE INTO sync_status (key, value, updated_at) VALUES ('last_rules_sync', ?, CURRENT_TIMESTAMP)",
      ).bind(new Date().toISOString()),
    ]);

    return new Response(JSON.stringify({
      ok: true,
      rules_synced: data.rules?.length || 0,
      configs_synced: data.configs?.length || 0,
      version: data.version,
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
  const version = await env.DB.prepare("SELECT value FROM sync_status WHERE key = 'version'").first<{ value: string | null }>();

  return new Response(JSON.stringify({
    ok: true,
    stats: {
      rules: rulesCount?.count || 0,
      configs: configsCount?.count || 0,
      last_sync: lastSync?.value,
      version: version?.value,
    },
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================
// DATABASE OPERATIONS
// ============================================================

async function getDomainConfig(env: Env, hostname: string): Promise<DomainConfig | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM domain_config WHERE domain_name = ?",
  ).bind(hostname).first<{
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
    variants: string | null;
    algorithm: string | null;
    active: number;
  }>();

  return rows.results.map((row) => ({
    id: row.id,
    domain_name: row.domain_name,
    priority: row.priority,
    conditions: JSON.parse(row.conditions),
    action: row.action as "redirect" | "block" | "pass" | "mab_redirect",
    action_url: row.action_url,
    status_code: row.status_code,
    variants: row.variants ? JSON.parse(row.variants) : null,
    algorithm: (row.algorithm as MABAlgorithm) || "thompson_sampling",
    active: row.active === 1,
  }));
}
