-- 0014_tds_stats.sql
-- Platform-side TDS statistics collected from Client Workers.

CREATE TABLE IF NOT EXISTS tds_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    domain_name TEXT NOT NULL,
    rule_id INTEGER,
    hour TEXT NOT NULL,              -- '2026-02-22T14' (ISO hour)
    hits INTEGER DEFAULT 0,
    redirects INTEGER DEFAULT 0,
    blocks INTEGER DEFAULT 0,
    passes INTEGER DEFAULT 0,
    by_country TEXT,                 -- JSON: {"RU":150,"US":30}
    by_device TEXT,                  -- JSON: {"mobile":120,"desktop":60}
    collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, domain_name, rule_id, hour),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tds_stats_account_hour ON tds_stats(account_id, hour DESC);
CREATE INDEX IF NOT EXISTS idx_tds_stats_domain ON tds_stats(domain_name, hour DESC);
