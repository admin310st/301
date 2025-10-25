-- Cloudflare D1 Safe Schema for 301.st (autonomous / re-apply friendly)

-- 1. Базовые таблицы без внешних зависимостей
CREATE TABLE IF NOT EXISTS users (
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
CREATE TABLE IF NOT EXISTS accounts (
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
CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS account_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    kv_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- 4. Проекты и домены (зависят от accounts)
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS domains (
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

CREATE TABLE IF NOT EXISTS zones (
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
CREATE TABLE IF NOT EXISTS redirect_rules (
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

CREATE TABLE IF NOT EXISTS redirect_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    name TEXT,
    template_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tds_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    rule_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 6. Воркеры и шаблоны (используют account_id и domain_id)
CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    domain_id INTEGER,
    name TEXT,
    type TEXT CHECK(type IN ('api','edge','job','client')),
    cf_script_id TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS worker_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    code TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 7. Аналитика и логи (зависят от доменов и аккаунтов)
CREATE TABLE IF NOT EXISTS redirect_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL,
    url TEXT,
    ip TEXT,
    country TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analytics_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    domain_id INTEGER,
    date TEXT,
    clicks INTEGER DEFAULT 0,
    uniques INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 8. Служебные таблицы (tasks, audit, backups)
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    type TEXT,
    status TEXT DEFAULT 'pending',
    payload TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    user_id INTEGER,
    action TEXT,
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    type TEXT CHECK(type IN ('d1','kv','r2')),
    path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 9. Индексы 
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_domains_account_id ON domains(account_id);
CREATE INDEX IF NOT EXISTS idx_redirect_rules_domain_id ON redirect_rules(domain_id);
CREATE INDEX IF NOT EXISTS idx_tds_rules_domain_id ON tds_rules(domain_id);
CREATE INDEX IF NOT EXISTS idx_redirect_logs_domain_id ON redirect_logs(domain_id);



-- Safe field updates (example):
-- ALTER TABLE users ADD COLUMN phone TEXT; -- only if not exists
-- Для миграций создавайте отдельные файлы schema/migrations/00X_add_field.sql
