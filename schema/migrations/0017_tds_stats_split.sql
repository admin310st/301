-- 0017_tds_stats_split.sql
-- Split tds_stats into two tables: shield (compact) + link (granular).
-- Old tds_stats was unused (pull model removed, replaced by webhook push).

-- Drop old unified table
DROP TABLE IF EXISTS tds_stats;
DROP INDEX IF EXISTS idx_tds_stats_account_hour;
DROP INDEX IF EXISTS idx_tds_stats_domain;

-- Shield stats: compact, per-domain per-hour aggregate. TTL: 7 days.
CREATE TABLE IF NOT EXISTS tds_stats_shield (
    account_id INTEGER NOT NULL,
    domain_name TEXT NOT NULL,
    hour TEXT NOT NULL,
    hits INTEGER DEFAULT 0,
    blocks INTEGER DEFAULT 0,
    passes INTEGER DEFAULT 0,
    collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, domain_name, hour),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tds_stats_shield_account_hour
ON tds_stats_shield(account_id, hour DESC);

-- Link stats: granular, per-rule per-country per-device. TTL: 30 days.
CREATE TABLE IF NOT EXISTS tds_stats_link (
    account_id INTEGER NOT NULL,
    domain_name TEXT NOT NULL,
    rule_id INTEGER NOT NULL,
    hour TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'XX',
    device TEXT NOT NULL DEFAULT 'desktop',
    hits INTEGER DEFAULT 0,
    redirects INTEGER DEFAULT 0,
    collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, domain_name, rule_id, hour, country, device),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tds_stats_link_account_hour
ON tds_stats_link(account_id, hour DESC);

CREATE INDEX IF NOT EXISTS idx_tds_stats_link_rule
ON tds_stats_link(rule_id, hour DESC);
