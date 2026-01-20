-- Safe field updates (example):
-- ALTER TABLE users ADD COLUMN phone TEXT; -- only if not exists
-- Для миграций создавайте отдельные файлы schema/migrations/00X_add_field.sql
-- Cloudflare D1 Safe Schema for 301.st (autonomous / re-apply friendly)

-- ======================================================
-- SQLite / D1 schema (production order)
-- Execute with:
--   npx wrangler d1 execute 301 --remote --file schema/301_d1.sql
-- ======================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER DEFAULT 0,
    password_hash TEXT,
    oauth_provider TEXT,
    oauth_id TEXT,
    phone TEXT,
    tg_id TEXT,
    name TEXT,
    user_type TEXT DEFAULT 'client' CHECK(user_type IN ('admin','client')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    refresh_id TEXT UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    revoked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_name TEXT NOT NULL,
    plan_tier TEXT DEFAULT 'free' CHECK(plan_tier IN ('free','pro','buss')),
    billing_status TEXT DEFAULT 'active' CHECK(billing_status IN ('active','suspended','cancelled')),
    timezone TEXT DEFAULT 'UTC',
    country_code TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    role TEXT CHECK(role IN ('admin','editor','viewer')) NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','expired','revoked')),
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_invitations_account_id ON invitations(account_id);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);

CREATE TABLE IF NOT EXISTS account_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'editor' CHECK(role IN ('owner','editor','viewer')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','removed')),
    invited_by INTEGER,                 -- ID пригласившего (не FK)
    invited_at TEXT DEFAULT CURRENT_TIMESTAMP,
    accepted_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    UNIQUE (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_account_members_account_id ON account_members(account_id);
CREATE INDEX IF NOT EXISTS idx_account_members_user_id ON account_members(user_id);

CREATE TABLE IF NOT EXISTS plan_tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_tier TEXT NOT NULL UNIQUE CHECK(plan_tier IN ('free','pro','buss')),
    name TEXT NOT NULL,
    description TEXT,
    price_usd REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Предзаполнение тарифов
INSERT OR IGNORE INTO plan_tiers (plan_tier, name, description, price_usd) VALUES
('free', 'Free', 'Базовый бесплатный тариф. Только владелец аккаунта.', 0),
('pro', 'Pro', 'Профессиональный тариф для команд до 10 участников.', 50),
('buss', 'Business', 'Бизнес-тариф для крупных команд и организаций.', 100);

CREATE TABLE IF NOT EXISTS quota_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_tier TEXT NOT NULL UNIQUE CHECK(plan_tier IN ('free','pro','buss')),
    max_projects INTEGER DEFAULT 1,
    max_sites INTEGER DEFAULT 3,
    max_domains INTEGER DEFAULT 10,
    max_zones INTEGER DEFAULT 10,
    max_redirect_rules INTEGER DEFAULT 100,
    max_tds_rules INTEGER DEFAULT 10,
    max_team_members INTEGER DEFAULT 1,
    analytics_retention_days INTEGER DEFAULT 30,
    backup_retention_days INTEGER DEFAULT 7,
    api_rate_limit INTEGER DEFAULT 100,
    support_level TEXT DEFAULT 'community',   -- community, email, priority
    custom_workers INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_tier) REFERENCES plan_tiers(plan_tier) ON DELETE CASCADE
);
-- Предзаполнение лимитов
INSERT OR IGNORE INTO quota_limits 
(plan_tier, max_projects, max_sites, max_domains, max_team_members, analytics_retention_days, backup_retention_days, api_rate_limit, support_level)
VALUES
('free', 1, 2, 5, 1, 30, 7, 100, 'community'),
('pro', 10, 50, 200, 10, 180, 14, 1000, 'email'),
('buss', 50, 200, 1000, 25, 365, 30, 5000, 'priority');

CREATE TABLE IF NOT EXISTS quota_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    plan_tier TEXT NOT NULL CHECK(plan_tier IN ('free','pro','buss')),
    projects_used INTEGER DEFAULT 0,
    sites_used INTEGER DEFAULT 0,
    domains_used INTEGER DEFAULT 0,
    zones_used INTEGER DEFAULT 0,
    redirect_rules_used INTEGER DEFAULT 0,
    tds_rules_used INTEGER DEFAULT 0,
    team_members_used INTEGER DEFAULT 0,
    api_calls_minute INTEGER DEFAULT 0,
    last_reset TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_quota_usage_account_id ON quota_usage(account_id);

CREATE TABLE IF NOT EXISTS account_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    provider TEXT NOT NULL, 
    provider_scope TEXT,
    key_alias TEXT,
    kv_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    expires_at TEXT,
    last_used TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    external_account_id TEXT,
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
    start_date TEXT,
    end_date TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_account_id ON projects(account_id);

CREATE TABLE IF NOT EXISTS project_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    account_key_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (account_key_id) REFERENCES account_keys(id) ON DELETE CASCADE,
    UNIQUE (project_id, account_key_id)
);
CREATE INDEX IF NOT EXISTS idx_proj_integrations_project_id ON project_integrations(project_id);
CREATE INDEX IF NOT EXISTS idx_proj_integrations_key_id ON project_integrations(account_key_id);

CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    site_name TEXT NOT NULL,
    site_tag TEXT,
    status TEXT CHECK(status IN ('active','paused','archived')) DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sites_project_id ON sites(project_id);

CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    key_id INTEGER NOT NULL,
    cf_zone_id TEXT UNIQUE,
    status TEXT CHECK(status IN ('active','pending','error','deleted')) DEFAULT 'pending',
    plan TEXT CHECK(plan IN ('free','pro','business','enterprise')) DEFAULT 'free',
    ns_expected TEXT,
    verified INTEGER DEFAULT 0,
    ssl_status TEXT CHECK(ssl_status IN ('none','valid','expired','error')) DEFAULT 'none',
    ssl_mode TEXT CHECK(ssl_mode IN ('off','flexible','full','strict')) DEFAULT 'full',
    ssl_last_checked TEXT,
    auto_https INTEGER DEFAULT 1,
    caching_level TEXT CHECK(caching_level IN ('off','basic','simplified','standard','aggressive')) DEFAULT 'standard',
    waf_mode TEXT CHECK(waf_mode IN ('off','low','medium','high')) DEFAULT 'medium',
    dns_records TEXT,
    last_sync_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (key_id) REFERENCES account_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zones_account_id ON zones(account_id);
CREATE INDEX IF NOT EXISTS idx_zones_key_id ON zones(key_id);


CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    project_id INTEGER,
    site_id INTEGER,
    zone_id INTEGER,
    key_id INTEGER,
    parent_id INTEGER,
    domain_name TEXT NOT NULL UNIQUE,
    role TEXT CHECK(role IN ('acceptor','donor','reserve')) DEFAULT 'reserve',
    ns TEXT,
    ns_verified INTEGER DEFAULT 0,
    proxied INTEGER DEFAULT 1,
    blocked INTEGER DEFAULT 0 CHECK(blocked IN (0,1)),
    blocked_reason TEXT CHECK(blocked_reason IN (
        'unavailable','ad_network','hosting_registrar','government','manual'
    )),
    ssl_status TEXT CHECK(ssl_status IN ('none','valid','expired','error')) DEFAULT 'none',
    expired_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL,
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL,
    FOREIGN KEY (key_id) REFERENCES account_keys(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_id) REFERENCES domains(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_domains_account_id ON domains(account_id);
CREATE INDEX IF NOT EXISTS idx_domains_project_id ON domains(project_id);
CREATE INDEX IF NOT EXISTS idx_domains_site_id ON domains(site_id);
CREATE INDEX IF NOT EXISTS idx_domains_zone_id ON domains(zone_id);
CREATE INDEX IF NOT EXISTS idx_domains_key_id ON domains(key_id);
CREATE INDEX IF NOT EXISTS idx_domains_parent_id ON domains(parent_id);
CREATE INDEX IF NOT EXISTS idx_domains_blocked ON domains(blocked);

CREATE TABLE IF NOT EXISTS redirect_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    rule_name TEXT NOT NULL,
    redirect_type TEXT CHECK(redirect_type IN (
        'domain_to_domain',
        'all_to_root',
        'path_to_path',
        'wildcard_path',
        'zone_to_root',
        'conditional'
    )) DEFAULT 'domain_to_domain',
    rule_json TEXT NOT NULL,
    status_code INTEGER CHECK(status_code IN (301,302,307)) DEFAULT 301,
    priority INTEGER DEFAULT 100,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_redirect_rules_account ON redirect_rules(account_id, priority);
CREATE INDEX IF NOT EXISTS idx_redirect_rules_name ON redirect_rules(rule_name);

CREATE TABLE IF NOT EXISTS tds_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    param_key TEXT NOT NULL UNIQUE,
    category TEXT CHECK(category IN (
        'utm_standard',
        'utm_extended',
        'click_id',
        'partner_custom'
    )) DEFAULT 'utm_standard',
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tds_params_category ON tds_params(category);
INSERT INTO tds_params (param_key, category, description) VALUES
('utm_source',   'utm_standard',  'Источник трафика (google, facebook, tiktok)'),
('utm_medium',   'utm_standard',  'Канал трафика (cpc, email, social)'),
('utm_campaign', 'utm_standard',  'Название кампании (summer_sale, black_friday)'),
('utm_term',     'utm_standard',  'Ключевое слово'),
('utm_content',  'utm_standard',  'Вариант контента (баннер, кнопка и т.п.)'),
('utm_id',       'utm_extended',  'ID кампании в трекере'),
('click_id',     'utm_extended',  'ID клика от трекера'),
('clickid',      'utm_extended',  'ID клика (альтернативное написание)'),
('sub_id',       'utm_extended',  'Sub-ID от трекера'),
('subid',        'utm_extended',  'Sub-ID (альтернативное написание)'),
('sub1',         'utm_extended',  'Дополнительный Sub параметр 1'),
('sub2',         'utm_extended',  'Дополнительный Sub параметр 2'),
('sub3',         'utm_extended',  'Дополнительный Sub параметр 3'),
('sub4',         'utm_extended',  'Дополнительный Sub параметр 4'),
('sub5',         'utm_extended',  'Дополнительный Sub параметр 5'),
('fbclid',       'click_id',      'Facebook Click ID'),
('gclid',        'click_id',      'Google Click ID'),
('ttclid',       'click_id',      'TikTok Click ID'),
('yclid',        'click_id',      'Yandex Click ID');

CREATE TABLE IF NOT EXISTS tds_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    rule_name TEXT NOT NULL,
    tds_type TEXT CHECK(tds_type IN (
        'smartlink',
        'traffic_shield'
    )) DEFAULT 'smartlink',
    logic_json TEXT NOT NULL,
    priority INTEGER DEFAULT 100,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tds_rules_account ON tds_rules(account_id, priority);
CREATE INDEX IF NOT EXISTS idx_tds_rules_name ON tds_rules(rule_name);

CREATE TABLE IF NOT EXISTS rule_domain_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    redirect_rule_id INTEGER,
    tds_rule_id INTEGER,
    domain_id INTEGER NOT NULL,
    enabled INTEGER DEFAULT 1,
    binding_status TEXT CHECK(binding_status IN (
        'pending','applying','applied','failed','retired','removed'
    )) DEFAULT 'pending',
    schedule_start TEXT,
    schedule_end TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    replaced_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (redirect_rule_id) REFERENCES redirect_rules(id) ON DELETE CASCADE,
    FOREIGN KEY (tds_rule_id) REFERENCES tds_rules(id) ON DELETE CASCADE,
    FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
    FOREIGN KEY (replaced_by) REFERENCES rule_domain_map(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_rdm_account_status ON rule_domain_map(account_id, binding_status);
CREATE INDEX IF NOT EXISTS idx_rdm_domain_enabled ON rule_domain_map(domain_id, enabled);
CREATE INDEX IF NOT EXISTS idx_rdm_redirect ON rule_domain_map(redirect_rule_id);
CREATE INDEX IF NOT EXISTS idx_rdm_tds ON rule_domain_map(tds_rule_id);

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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS analytics_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    redirects_count INTEGER DEFAULT 0,
    unique_visitors INTEGER DEFAULT 0,
    top_country TEXT,
    top_device TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_summary_site_date ON analytics_summary(site_id, date);

CREATE TABLE IF NOT EXISTS domain_replacement_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    site_id INTEGER,
    old_domain_id INTEGER NOT NULL,
    new_domain_id INTEGER,
    reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_domain_replacement_log_site_id ON domain_replacement_log(site_id);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    task_type TEXT CHECK(task_type IN ('deploy','backup','rotate','sync','analytics','manual')),
    status TEXT CHECK(status IN ('queued','running','done','error')) DEFAULT 'queued',
    details TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    backup_type TEXT DEFAULT 'full',
    r2_path TEXT,
    size_mb REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_backups_account_id ON backups(account_id);
CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at);

CREATE TABLE IF NOT EXISTS jwt_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kid TEXT UNIQUE NOT NULL,
    secret_encrypted TEXT NOT NULL,
    status TEXT CHECK(status IN ('active','deprecated','revoked')) DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jwt_keys_status ON jwt_keys(status);

