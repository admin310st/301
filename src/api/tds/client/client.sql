-- ============================================================
-- 301 TDS Client D1 Schema
-- ============================================================
-- Local cache for TDS rules and config.
-- Synced from 301.st API.
-- ============================================================

-- TDS Rules Cache
-- Cached rules fetched from 301.st API
CREATE TABLE IF NOT EXISTS tds_rules (
    id INTEGER PRIMARY KEY,
    domain_name TEXT NOT NULL,

    -- Rule definition
    priority INTEGER DEFAULT 0,
    conditions TEXT NOT NULL,     -- JSON: {"geo": ["RU"], "device": "mobile"}
    action TEXT NOT NULL,         -- redirect | block | pass
    action_url TEXT,              -- Redirect URL
    status_code INTEGER DEFAULT 302,

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

-- Request Log (optional, for analytics)
-- Enable via ENABLE_LOGGING=true
CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_name TEXT NOT NULL,

    -- Request info
    path TEXT,
    country TEXT,
    device TEXT,
    user_agent TEXT,
    ip TEXT,

    -- Result
    rule_id INTEGER,
    action TEXT,

    -- Timestamp
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_request_log_domain_time
ON request_log(domain_name, created_at DESC);

-- Sync Status
-- Track last sync time for cache invalidation
CREATE TABLE IF NOT EXISTS sync_status (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Initialize sync status
INSERT OR IGNORE INTO sync_status (key, value) VALUES ('last_rules_sync', NULL);
INSERT OR IGNORE INTO sync_status (key, value) VALUES ('last_config_sync', NULL);
