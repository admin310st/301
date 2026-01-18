-- Migration: client_worker_configs
-- Stores wrangler.toml configurations for client workers (Health, TDS)

CREATE TABLE IF NOT EXISTS client_worker_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,

    -- Worker identification
    worker_type TEXT NOT NULL CHECK(worker_type IN ('health', 'tds')),
    worker_name TEXT NOT NULL,

    -- D1 Database (created during setup)
    d1_database_id TEXT,
    d1_database_name TEXT,

    -- Full config as TOML (for download)
    config_toml TEXT,

    -- Secrets status (names only, not values)
    secrets_configured TEXT DEFAULT '[]',  -- JSON array: ["JWT_TOKEN", "ACCOUNT_ID"]

    -- Routes for TDS worker
    routes TEXT DEFAULT '[]',  -- JSON array: [{"pattern": "example.com/*", "zone_id": "xxx"}]

    -- Cron schedule
    cron_schedule TEXT DEFAULT '0 */12 * * *',

    -- Status
    deployed INTEGER DEFAULT 0,
    last_deployed_at TEXT,

    -- Timestamps
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE(account_id, worker_type)
);

CREATE INDEX IF NOT EXISTS idx_worker_configs_account
ON client_worker_configs(account_id);
