-- 0020_tds_site_scoped.sql
-- ADR-001: TDS rules become site-scoped, rule_domain_map removed.
--
-- 1. Add site_id FK + sync tracking to tds_rules
-- 2. Backfill site_id from rule_domain_map → domains → sites
-- 3. Backfill sync_status from rule_domain_map
-- 4. Drop rule_domain_map (no longer used by redirects or TDS)

-- Step 1: New columns
ALTER TABLE tds_rules ADD COLUMN site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL;
ALTER TABLE tds_rules ADD COLUMN sync_status TEXT CHECK(sync_status IN ('pending','applying','applied','failed')) DEFAULT 'pending';
ALTER TABLE tds_rules ADD COLUMN last_synced_at TEXT;
ALTER TABLE tds_rules ADD COLUMN last_error TEXT;

-- Step 2: Backfill site_id from existing bindings
-- rule_domain_map.tds_rule_id → domains.id → domains.site_id
UPDATE tds_rules SET site_id = (
  SELECT d.site_id FROM rule_domain_map rdm
  JOIN domains d ON rdm.domain_id = d.id
  WHERE rdm.tds_rule_id = tds_rules.id
    AND rdm.binding_status != 'removed'
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.binding_status != 'removed'
);

-- Step 3: Backfill sync_status from binding_status
UPDATE tds_rules SET sync_status = (
  SELECT CASE rdm.binding_status
    WHEN 'applied' THEN 'applied'
    WHEN 'applying' THEN 'applying'
    WHEN 'failed' THEN 'failed'
    ELSE 'pending'
  END
  FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.binding_status != 'removed'
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.binding_status != 'removed'
);

-- Step 4: Backfill last_synced_at
UPDATE tds_rules SET last_synced_at = (
  SELECT rdm.last_synced_at FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.binding_status != 'removed' AND rdm.last_synced_at IS NOT NULL
  ORDER BY rdm.last_synced_at DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.last_synced_at IS NOT NULL
);

-- Step 5: Index for site-scoped queries
CREATE INDEX IF NOT EXISTS idx_tds_rules_site ON tds_rules(site_id, priority);

-- Step 6: Drop rule_domain_map (dead for redirects since 0007, replaced for TDS by site_id)
DROP TABLE IF EXISTS rule_domain_map;
