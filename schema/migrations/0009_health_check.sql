-- Migration: Health Check System
-- Добавляет поддержку domain health check (CF Phishing, VT threats)
-- Execute:
-- npx wrangler d1 execute DB301 --remote --file schema/migrations/0009_health_check.sql


-- Таблица domain_threats для хранения результатов проверок VT/CF Intel
CREATE TABLE IF NOT EXISTS domain_threats (
    domain_id INTEGER PRIMARY KEY,
    threat_score INTEGER,           -- VT malicious count / CF security score
    categories TEXT,                -- JSON: ["gambling", "spam"]
    reputation INTEGER,             -- -100 to +100
    source TEXT,                    -- 'virustotal' | 'cloudflare_intel'
    checked_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);

-- Примечание: для добавления 'phishing' в blocked_reason
-- SQLite требует пересоздания таблицы domains.
-- В D1 это делается через изменение основной схемы 301.sql
-- и пересоздание базы при деплое.
--
-- Если нужна миграция существующей базы без пересоздания:
-- 1. Создать новую таблицу domains_new с обновлённым CHECK constraint
-- 2. INSERT INTO domains_new SELECT * FROM domains
-- 3. DROP TABLE domains
-- 4. ALTER TABLE domains_new RENAME TO domains
-- 5. Воссоздать индексы и FK
