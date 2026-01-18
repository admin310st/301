-- Client Worker Schema
-- Таблицы для D1 на CF аккаунте клиента
--
-- Deploy:
-- npx wrangler d1 execute CLIENT_DB --remote --file src/api/health/client/client.sql

-- ============================================================
-- domain_threats
-- Результаты проверок VT / CF Intel
-- Структура идентична 301.st (кроме PK: domain_name вместо domain_id)
-- ============================================================

CREATE TABLE IF NOT EXISTS domain_threats (
    domain_name TEXT PRIMARY KEY,
    threat_score INTEGER,           -- VT malicious count / CF security score
    categories TEXT,                -- JSON: ["gambling", "spam"]
    reputation INTEGER,             -- -100 to +100
    source TEXT,                    -- 'virustotal' | 'cloudflare_intel'
    checked_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT                  -- когда отправлено в 301.st
);

-- ============================================================
-- threat_check_queue
-- Очередь доменов для проверки
-- ============================================================

CREATE TABLE IF NOT EXISTS threat_check_queue (
    domain_name TEXT PRIMARY KEY,
    priority INTEGER DEFAULT 0,     -- 1 = high (anomaly trigger), 0 = normal (cron)
    source TEXT DEFAULT 'virustotal', -- 'virustotal' | 'cloudflare_intel' | 'all'
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'   -- 'pending' | 'processing' | 'done' | 'error'
);

-- Index for queue processing
CREATE INDEX IF NOT EXISTS idx_queue_status_priority
ON threat_check_queue(status, priority DESC, added_at);

-- ============================================================
-- domain_list (optional)
-- Локальная копия списка доменов для проверки
-- Заполняется через syncDomainList() из API 301.st
-- ============================================================

CREATE TABLE IF NOT EXISTS domain_list (
    domain_name TEXT PRIMARY KEY,
    role TEXT,                      -- 'acceptor' | 'donor'
    zone_id TEXT,
    active INTEGER DEFAULT 1,
    synced_at TEXT
);

-- ============================================================
-- traffic_stats (optional)
-- Статистика трафика для детекции аномалий
-- Заполняется отдельным процессом (CF GraphQL)
-- ============================================================

CREATE TABLE IF NOT EXISTS traffic_stats (
    domain_name TEXT PRIMARY KEY,
    zone_id TEXT,
    clicks_yesterday INTEGER DEFAULT 0,
    clicks_today INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
