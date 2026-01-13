-- ======================================================
-- Migration: 0008_zones_cf_ruleset_id.sql
-- Date: 2025-01-13
-- Description: Добавляет cf_ruleset_id в zones для кэширования
--              ID ruleset редиректов (phase: http_request_dynamic_redirect)
--
-- 1 зона = 1 ruleset = 1 cf_ruleset_id
-- Внутри ruleset до 10 rules (Free Plan)
--
-- Execute:
--   npx wrangler d1 execute DB301 --remote --file schema/migrations/0008_zones_cf_ruleset_id.sql
-- ======================================================

ALTER TABLE zones ADD COLUMN cf_ruleset_id TEXT;
