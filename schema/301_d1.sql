-- Cloudflare D1 schema for 301.st (converted 1:1 from 301.sql)
-- SQLite-compatible DDL
-- Порядок таблиц от независимых к зависимым для корректной инициализации внешних ключей

-- 1. Базовые таблицы без внешних зависимостей
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    google_sub TEXT,
    name TEXT,
    role TEXT DEFAULT 'user',
    user_type TEXT DEFAULT 'client',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2. Таблица аккаунтов (ссылается на users)
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    name TEXT,
    plan TEXT DEFAULT 'free',
    quota INTEGER DEFAULT 100,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 3. Таблицы, зависящие от users и accounts
CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    access_token TEXT,
    refresh_id TEXT,
    ip TEXT,
    user_agent TEXT,
    revoked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE account_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    kv_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- 4. Проекты и домены (зависят от accounts)
CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    registrar TEXT,
    cf_zone_id TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    zone_name TEXT NOT NULL,
    cf_zone_id TEXT,
    proxied INTEGER DEFAULT 1,
    ssl_mode TEXT DEFAULT 'full',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (domain_id) REFERENCES domains(id)
);

-- 5. Таблицы логики редиректов и TDS (зависят от доменов)
CREATE TABLE redirect_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    rule_name TEXT,
    source_url TEXT,
    target_url TEXT,
    type TEXT CHECK(type IN ('301','302')) DEFAULT '301',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (domain_id) REFERENCES domains(id)
);

CREATE TABLE redirect_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    name TEXT,
    template_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tds_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    rule_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 6. Воркеры и шаблоны (используют account_id и domain_id)
CREATE TABLE workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    domain_id INTEGER,
    name TEXT,
    type TEXT CHECK(type IN ('api','edge','job','client')),
    cf_script_id TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE worker_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    code TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 7. Аналитика и логи (зависят от доменов и аккаунтов)
CREATE TABLE redirect_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    url TEXT,
    ip TEXT,
    country TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE analytics_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    domain_id INTEGER,
    date TEXT,
    clicks INTEGER DEFAULT 0,
    uniques INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 8. Служебные таблицы (tasks, audit, backups)
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    type TEXT,
    status TEXT DEFAULT 'pending',
    payload TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    user_id INTEGER,
    action TEXT,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    type TEXT CHECK(type IN ('d1','kv','r2')),
    path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

