-- Rename api_key → api_key_hash (store SHA-256 hash, not plain text)
-- SQLite doesn't support RENAME COLUMN in all versions, so recreate

CREATE TABLE IF NOT EXISTS worker_api_keys_new (
    account_id INTEGER NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    cf_account_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id)
);

INSERT OR IGNORE INTO worker_api_keys_new (account_id, api_key_hash, cf_account_id, created_at)
SELECT account_id, api_key, cf_account_id, created_at FROM worker_api_keys;

DROP TABLE IF EXISTS worker_api_keys;
ALTER TABLE worker_api_keys_new RENAME TO worker_api_keys;

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_api_keys_hash ON worker_api_keys(api_key_hash);
