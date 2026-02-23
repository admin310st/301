-- 0013_tds_rules_extend.sql
-- Add status and preset_id columns to tds_rules.

ALTER TABLE tds_rules ADD COLUMN status TEXT CHECK(status IN ('draft', 'active', 'disabled')) DEFAULT 'draft';
ALTER TABLE tds_rules ADD COLUMN preset_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tds_rules_status ON tds_rules(account_id, status);
