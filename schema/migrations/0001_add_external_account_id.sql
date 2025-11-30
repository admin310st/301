-- Migration: 001_add_external_account_id
-- Description: Добавляет поле external_account_id в account_keys
--              для хранения ID аккаунта у внешнего провайдера
-- Date: 2025-11-30
 
-- Применение:
--   npx wrangler d1 execute DB301 --remote --file schema/migrations/001_add_external_account_id.sql

-- Откат:
--   SQLite не поддерживает DROP COLUMN напрямую
--   Требуется пересоздание таблицы (см. rollback в конце файла)

-- Добавляем поле external_account_id
-- Хранит ID аккаунта у провайдера:
--   - Cloudflare: CF Account ID (например, "7ldfjghoierr77236313433189")
--   - Namecheap: Username (API привязан к username)
--   - Namesilo: не требуется (API Key глобальный)
--   - HostTracker: Account ID
ALTER TABLE account_keys ADD COLUMN external_account_id TEXT;

-- Индекс для быстрого поиска по провайдеру + внешнему аккаунту
-- Позволяет эффективно находить все ключи для конкретного CF аккаунта
CREATE INDEX IF NOT EXISTS idx_account_keys_provider_external 
ON account_keys(provider, external_account_id);

