-- Worker API Keys for client worker → webhook authentication
-- Replaces JWT-based auth (JWT expires, API key doesn't)

CREATE TABLE IF NOT EXISTS worker_api_keys (
    account_id INTEGER NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    cf_account_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_api_keys_key ON worker_api_keys(api_key);
