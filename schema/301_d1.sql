-- Safe field updates (example):
-- ALTER TABLE users ADD COLUMN phone TEXT; -- only if not exists
-- Для миграций создавайте отдельные файлы schema/migrations/00X_add_field.sql
-- Cloudflare D1 Safe Schema for 301.st (autonomous / re-apply friendly)

PRAGMA foreign_keys = ON;

-- ======================================================
-- SQLite / D1 schema (production order)
-- Execute with:
--   npx wrangler d1 execute 301 --remote --file=301.sql
-- ======================================================

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    google_sub TEXT,
    name TEXT,
    role TEXT DEFAULT 'user',
    user_type TEXT DEFAULT 'client',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    refresh_id TEXT UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    revoked INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_name TEXT NOT NULL,
    cf_account_id TEXT,
    plan TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

CREATE TABLE IF NOT EXISTS account_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_scope TEXT,
    key_alias TEXT,
    kv_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    expires_at TIMESTAMP,
    last_used TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_account_keys_account_id ON account_keys(account_id);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    description TEXT,
    brand_tag TEXT,
    commercial_terms TEXT,
    start_date DATE,
    end_date DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_account_id ON projects(account_id);

CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    site_name TEXT NOT NULL,
    lang_code TEXT,
    primary_zone_id INTEGER,
    primary_domain_id INTEGER,
    status TEXT CHECK(status IN ('active','paused','archived')) DEFAULT 'active',
    tds_enabled INTEGER DEFAULT 1,
    monitoring_enabled INTEGER DEFAULT 1,
    integrations_json TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sites_project_id ON sites(project_id);

CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    site_id INTEGER,
    cf_zone_id TEXT NOT NULL UNIQUE,
    ssl_mode TEXT CHECK(ssl_mode IN ('off','flexible','full','strict')) DEFAULT 'full',
    proxied INTEGER DEFAULT 1,
    plan TEXT,
    cf_status TEXT,
    auto_https INTEGER DEFAULT 1,
    caching_level TEXT DEFAULT 'standard',
    waf_mode TEXT DEFAULT 'medium',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_zones_site_id ON zones(site_id);
CREATE INDEX IF NOT EXISTS idx_zones_account_id ON zones(account_id);

CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    project_id INTEGER,
    site_id INTEGER,
    zone_id INTEGER NOT NULL,
    domain_name TEXT NOT NULL UNIQUE,
    registrar TEXT,
    ns_required TEXT,
    ns_status TEXT CHECK(ns_status IN ('pending','verified','error')) DEFAULT 'pending',
    ns_verified_at TIMESTAMP,
    domain_role TEXT CHECK(domain_role IN ('primary','donor')) DEFAULT 'donor',
    target_type TEXT CHECK(target_type IN ('ip','cname','worker','redirect')) DEFAULT 'redirect',
    target_value TEXT,
    status TEXT CHECK(status IN ('new','active','blocked')) DEFAULT 'new',
    blocked_reason TEXT,
    blocked_details TEXT,
    blocked_at TIMESTAMP,
    replaced_by INTEGER,
    tds_allowed INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL,
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE,
    FOREIGN KEY (replaced_by) REFERENCES domains(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_domains_account_id ON domains(account_id);
CREATE INDEX IF NOT EXISTS idx_domains_site_id ON domains(site_id);
CREATE INDEX IF NOT EXISTS idx_domains_zone_id ON domains(zone_id);

CREATE TABLE IF NOT EXISTS redirect_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    template_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS redirect_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    source_url TEXT NOT NULL,
    target_url TEXT NOT NULL,
    status_code INTEGER DEFAULT 301,
    conditions_json TEXT,
    priority INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_redirect_rules_account_id ON redirect_rules(account_id);
CREATE INDEX IF NOT EXISTS idx_redirect_rules_site_id ON redirect_rules(site_id);

CREATE TABLE IF NOT EXISTS tds_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    rule_name TEXT NOT NULL,
    logic_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tds_rules_account_id ON tds_rules(account_id);
CREATE INDEX IF NOT EXISTS idx_tds_rules_site_id ON tds_rules(site_id);

CREATE TABLE IF NOT EXISTS worker_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    code_template TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    site_id INTEGER,
    template_id INTEGER,
    version TEXT,
    status TEXT CHECK(status IN ('active','disabled','error')) DEFAULT 'active',
    last_deploy TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL,
    FOREIGN KEY (template_id) REFERENCES worker_templates(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workers_account_id ON workers(account_id);
CREATE INDEX IF NOT EXISTS idx_workers_site_id ON workers(site_id);

CREATE TABLE IF NOT EXISTS redirect_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    source_url TEXT,
    target_url TEXT,
    status_code INTEGER,
    ip TEXT,
    country TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_redirect_logs_site_id ON redirect_logs(site_id);
CREATE INDEX IF NOT EXISTS idx_redirect_logs_created_at ON redirect_logs(created_at);

CREATE TABLE IF NOT EXISTS analytics_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    date DATE NOT NULL,
    redirects_count INTEGER DEFAULT 0,
    unique_visitors INTEGER DEFAULT 0,
    top_country TEXT,
    top_device TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_summary_site_date ON analytics_summary(site_id, date);

CREATE TABLE IF NOT EXISTS domain_replacement_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    old_domain_id INTEGER NOT NULL,
    new_domain_id INTEGER,
    account_id INTEGER NOT NULL,
    site_id INTEGER,
    reason TEXT,
    initiated_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_domain_replacement_log_site_id ON domain_replacement_log(site_id);
CREATE TRIGGER limit_domain_log AFTER INSERT ON domain_replacement_log
BEGIN
    DELETE FROM domain_replacement_log
    WHERE site_id = NEW.site_id
      AND id NOT IN (
          SELECT id FROM domain_replacement_log
          WHERE site_id = NEW.site_id
          ORDER BY created_at DESC, id DESC
          LIMIT 10
      );
END;

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    user_id INTEGER,
    event_type TEXT CHECK(event_type IN (
        'register','login','logout','refresh',
        'create','update','delete','deploy','revoke','billing'
    )) NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    details TEXT,
    role TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE TRIGGER limit_audit_log AFTER INSERT ON audit_log
BEGIN
    DELETE FROM audit_log
    WHERE user_id = NEW.user_id
      AND id NOT IN (
          SELECT id FROM audit_log
          WHERE user_id = NEW.user_id
          ORDER BY created_at DESC, id DESC
          LIMIT 10
      );
END;

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    task_type TEXT NOT NULL,
    payload_json TEXT,
    status TEXT DEFAULT 'pending',
    approved_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    backup_type TEXT DEFAULT 'full',
    r2_path TEXT,
    size_mb REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_backups_account_id ON backups(account_id);
CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at);

CREATE TABLE IF NOT EXISTS jwt_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    kid TEXT UNIQUE NOT NULL,
    secret_encrypted TEXT NOT NULL,
    status TEXT CHECK(status IN ('active','deprecated','revoked')) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jwt_keys_account_id ON jwt_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_jwt_keys_status ON jwt_keys(status);

