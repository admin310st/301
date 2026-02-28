-- ============================================================
-- 301 TDS Client D1 Schema
-- ============================================================
-- Local cache for TDS rules and config.
-- Synced from 301.st API (pull model).
-- Stats: shield (compact) + link (granular) — two tables.
-- ============================================================

-- TDS Rules Cache
-- Cached rules fetched from 301.st API
CREATE TABLE IF NOT EXISTS tds_rules (
    id INTEGER PRIMARY KEY,
    domain_name TEXT NOT NULL,
    tds_type TEXT NOT NULL DEFAULT 'traffic_shield', -- traffic_shield | smartlink

    -- Rule definition
    priority INTEGER DEFAULT 0,
    conditions TEXT NOT NULL,     -- JSON: {"geo": ["RU"], "device": "mobile", "match_params": ["fbclid"]}
    action TEXT NOT NULL,         -- redirect | block | pass | mab_redirect
    action_url TEXT,              -- Redirect URL (supports {country}, {device}, {path}, {host})
    status_code INTEGER DEFAULT 302,
    variants TEXT,                 -- JSON: [{"url":"...","alpha":1,"beta":1,"impressions":0,"conversions":0}]
    algorithm TEXT DEFAULT 'thompson_sampling',  -- thompson_sampling | ucb | epsilon_greedy

    -- Metadata
    active INTEGER DEFAULT 1,

    -- Sync
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tds_rules_domain
ON tds_rules(domain_name, active, priority DESC);

-- Domain Config Cache
-- Domain-level TDS settings
CREATE TABLE IF NOT EXISTS domain_config (
    domain_name TEXT PRIMARY KEY,

    -- TDS settings
    tds_enabled INTEGER DEFAULT 1,
    default_action TEXT DEFAULT 'pass',   -- What to do if no rule matches
    default_url TEXT,                      -- Default redirect URL

    -- SmartShield settings
    smartshield_enabled INTEGER DEFAULT 0,
    bot_action TEXT DEFAULT 'pass',       -- block | pass | redirect
    bot_redirect_url TEXT,

    -- Sync
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Shield Stats (SmartShield / traffic_shield)
-- Compact: per-domain, per-rule, per-hour. TTL: 7 days.
CREATE TABLE IF NOT EXISTS stats_shield (
    domain_name TEXT NOT NULL,
    rule_id INTEGER,
    hour TEXT NOT NULL,
    hits INTEGER DEFAULT 0,
    blocks INTEGER DEFAULT 0,
    passes INTEGER DEFAULT 0,
    UNIQUE(domain_name, rule_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_stats_shield_hour
ON stats_shield(hour, rule_id);

-- Link Stats (SmartLink)
-- Granular: per-domain, per-rule, per-hour, per-country, per-device. TTL: 30 days.
CREATE TABLE IF NOT EXISTS stats_link (
    domain_name TEXT NOT NULL,
    rule_id INTEGER NOT NULL,
    hour TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'XX',
    device TEXT NOT NULL DEFAULT 'desktop',
    hits INTEGER DEFAULT 0,
    redirects INTEGER DEFAULT 0,
    UNIQUE(domain_name, rule_id, hour, country, device)
);

CREATE INDEX IF NOT EXISTS idx_stats_link_hour
ON stats_link(hour, rule_id, country, device);

-- MAB Stats (Multi-Armed Bandits)
-- Impressions/conversions per rule variant
CREATE TABLE IF NOT EXISTS mab_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    variant_url TEXT NOT NULL,
    impressions INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rule_id, variant_url)
);

-- Sync Status
-- Track version hash and last sync time
CREATE TABLE IF NOT EXISTS sync_status (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Initialize sync status
INSERT OR IGNORE INTO sync_status (key, value) VALUES ('version', NULL);
INSERT OR IGNORE INTO sync_status (key, value) VALUES ('last_rules_sync', NULL);
