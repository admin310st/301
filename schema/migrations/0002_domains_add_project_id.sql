-- Migration: 002_domains_add_project_id
-- Description: Добавляет project_id в domains для привязки домена к проекту.
--              Поле parent_id помечается как deprecated (оставлено для совместимости).
-- Date: 2025-12-24

-- Применение:
--   npx wrangler d1 execute DB301 --remote --file schema/migrations/0002_domains_add_project_id.sql

-- ============================================================
-- ИЗМЕНЕНИЯ
-- ============================================================

-- 1. Добавляем project_id в domains
-- Домен теперь привязывается к проекту напрямую.
-- site_id остаётся как "тег" — указывает на точку приёма трафика.
ALTER TABLE domains ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;

-- 2. Индекс для быстрой выборки доменов проекта
CREATE INDEX IF NOT EXISTS idx_domains_project_id ON domains(project_id);

-- ============================================================
-- КОММЕНТАРИИ К АРХИТЕКТУРЕ
-- ============================================================

-- НОВАЯ ЛОГИКА:
--   Project (логическая группа)
--     ├── Sites (теги = точки приёма трафика)
--     │     └── status: active/paused/archived
--     └── Domains (привязаны к проекту)
--           ├── role: acceptor (принимает трафик, имеет site_id)
--           ├── role: donor (редиректит на acceptor)
--           └── role: reserve (запас)
--
-- ПОВЕДЕНИЕ ПРИ БЛОКИРОВКЕ:
--   1. Домен acceptor получает soft-блок
--   2. Тег site перевешивается на резервный домен
--   3. Заблокированный становится donor → редиректит на новый acceptor
--
-- DEPRECATED:
--   parent_id — больше не используется для связи root-subdomain.
--   Оставлен для обратной совместимости, будет удалён в будущих версиях.
--   Группировка по root domain теперь определяется через zone_id.

-- ============================================================
-- МИГРАЦИЯ СУЩЕСТВУЮЩИХ ДАННЫХ (опционально)
-- ============================================================

-- Если нужно заполнить project_id на основе site_id:
-- UPDATE domains 
-- SET project_id = (SELECT project_id FROM sites WHERE sites.id = domains.site_id)
-- WHERE site_id IS NOT NULL AND project_id IS NULL;

-- ============================================================
-- ROLLBACK (если нужно откатить)
-- ============================================================

-- SQLite не поддерживает DROP COLUMN напрямую.
-- Для отката требуется пересоздание таблицы:
--
-- 1. CREATE TABLE domains_backup AS SELECT 
--      id, account_id, site_id, zone_id, key_id, parent_id, domain_name,
--      role, ns, ns_verified, proxied, blocked, blocked_reason,
--      ssl_status, expired_at, created_at, updated_at
--    FROM domains;
--
-- 2. DROP TABLE domains;
--
-- 3. CREATE TABLE domains (...без project_id...);
--
-- 4. INSERT INTO domains SELECT * FROM domains_backup;
--
-- 5. DROP TABLE domains_backup;
--
-- 6. Пересоздать индексы и FK
