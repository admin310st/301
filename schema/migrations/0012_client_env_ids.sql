-- Migration: Add client_env field to account_keys
-- Stores client environment IDs (D1, KV, Workers) created on client's CF account
-- Execute:
-- npx wrangler d1 execute DB301 --remote --file schema/migrations/0012_client_env_ids.sql

-- Add client_env JSON field
-- Format: {"d1_id": "...", "kv_id": "...", "health_worker": true, "tds_worker": false}
ALTER TABLE account_keys ADD COLUMN client_env TEXT;

-- Comment: client_env stores IDs of resources created on client's CF account
-- - d1_id: Client D1 database ID (301-client)
-- - kv_id: Client KV namespace ID (301-keys)
-- - health_worker: Whether health worker is deployed
-- - tds_worker: Whether TDS worker is deployed
