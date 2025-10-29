-- ======================================================
-- 301.st — Cloudflare Redirect Management Platform
-- Database Schema (Cloudflare D1 SQL version)
-- ======================================================

-- ======================================================
-- I. USERS AND AUTHENTICATION
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

COMMENT ON TABLE users IS 'Учётные записи пользователей платформы 301.st: администраторы, операторы и клиенты.';
COMMENT ON COLUMN users.id IS 'Уникальный идентификатор пользователя.';
COMMENT ON COLUMN users.email IS 'Email пользователя, используется для входа.';
COMMENT ON COLUMN users.password_hash IS 'Хэш пароля (bcrypt/scrypt).';
COMMENT ON COLUMN users.google_sub IS 'Идентификатор пользователя в Google OAuth.';
COMMENT ON COLUMN users.name IS 'Имя пользователя или организация.';
COMMENT ON COLUMN users.role IS 'Роль (user, admin) — внутренняя системная категория.';
COMMENT ON COLUMN users.user_type IS 'Тип пользователя: admin, operator, client.';
COMMENT ON COLUMN users.created_at IS 'Дата создания записи.';
COMMENT ON COLUMN users.updated_at IS 'Дата последнего обновления записи.';

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

COMMENT ON TABLE sessions IS 'Активные сессии пользователей, применяемые для обновления токенов.';
COMMENT ON COLUMN sessions.id IS 'Уникальный идентификатор сессии.';
COMMENT ON COLUMN sessions.user_id IS 'Ссылка на пользователя (users.id).';
COMMENT ON COLUMN sessions.refresh_id IS 'Идентификатор refresh-токена, хранящегося в KV.';
COMMENT ON COLUMN sessions.ip_address IS 'IP-адрес, с которого произведён вход.';
COMMENT ON COLUMN sessions.user_agent IS 'User-Agent клиента (браузер, устройство).';
COMMENT ON COLUMN sessions.revoked IS 'Флаг отзыва сессии (1 — токен аннулирован).';
COMMENT ON COLUMN sessions.created_at IS 'Дата создания сессии.';
COMMENT ON COLUMN sessions.expires_at IS 'Дата окончания действия токена.';

-- ======================================================
-- II. ACCOUNTS AND INTEGRATIONS
-- ======================================================
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

COMMENT ON TABLE accounts IS 'Аккаунты клиентов (тенанты) с параметрами, тарифом и текущим статусом.';
COMMENT ON COLUMN accounts.id IS 'Уникальный идентификатор аккаунта.';
COMMENT ON COLUMN accounts.user_id IS 'Ссылка на владельца аккаунта (users.id).';
COMMENT ON COLUMN accounts.account_name IS 'Название клиента или организации.';
COMMENT ON COLUMN accounts.cf_account_id IS 'ID аккаунта Cloudflare, связанного с клиентом.';
COMMENT ON COLUMN accounts.plan IS 'Тарифный план (free, pro, enterprise).';
COMMENT ON COLUMN accounts.status IS 'Статус аккаунта (active, suspended, overdue, deleted). Используется для блокировки при неуплате.';
COMMENT ON COLUMN accounts.created_at IS 'Дата создания аккаунта.';
COMMENT ON COLUMN accounts.updated_at IS 'Дата последнего изменения записи.';

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

COMMENT ON TABLE account_keys IS 'Зашифрованные API-ключи внешних сервисов, хранящиеся в KV. Метаданные записаны в D1.';
COMMENT ON COLUMN account_keys.id IS 'Уникальный идентификатор ключа.';
COMMENT ON COLUMN account_keys.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN account_keys.provider IS 'Провайдер: cloudflare, namecheap, hosttracker, analytics.';
COMMENT ON COLUMN account_keys.provider_scope IS 'Область действия ключа (zones, dns, workers и т.п.).';
COMMENT ON COLUMN account_keys.key_alias IS 'Псевдоним ключа, указанный пользователем.';
COMMENT ON COLUMN account_keys.kv_key IS 'Ключ записи в KV с зашифрованным значением.';
COMMENT ON COLUMN account_keys.status IS 'Статус ключа (active, revoked).';
COMMENT ON COLUMN account_keys.expires_at IS 'Срок действия ключа.';
COMMENT ON COLUMN account_keys.last_used IS 'Дата последнего использования ключа.';
COMMENT ON COLUMN account_keys.created_at IS 'Дата добавления ключа.';

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    role TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_account_created ON audit_log(account_id, created_at DESC);

COMMENT ON TABLE audit_log IS 'Журнал действий пользователей и администраторов системы.';
COMMENT ON COLUMN audit_log.id IS 'Уникальный идентификатор записи аудита.';
COMMENT ON COLUMN audit_log.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN audit_log.user_id IS 'Ссылка на пользователя (users.id).';
COMMENT ON COLUMN audit_log.action IS 'Тип действия (login, create, deploy, revoke, billing, etc).';
COMMENT ON COLUMN audit_log.details IS 'Дополнительные данные о событии.';
COMMENT ON COLUMN audit_log.role IS 'Роль пользователя в момент выполнения действия.';
COMMENT ON COLUMN audit_log.created_at IS 'Дата и время фиксации события.';


-- ======================================================
-- III-A. PROJECTS
-- ======================================================

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

COMMENT ON TABLE projects IS 'Проекты клиента — логические контейнеры для сайтов и доменов в рамках одной кампании.';
COMMENT ON COLUMN projects.id IS 'Уникальный идентификатор проекта.';
COMMENT ON COLUMN projects.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN projects.project_name IS 'Название проекта (например, кампания или бренд).';
COMMENT ON COLUMN projects.description IS 'Описание назначения проекта.';
COMMENT ON COLUMN projects.brand_tag IS 'Краткий тег бренда или направления.';
COMMENT ON COLUMN projects.commercial_terms IS 'Коммерческие условия сотрудничества (RS, CPA, фикс и т.п.).';
COMMENT ON COLUMN projects.start_date IS 'Дата начала кампании.';
COMMENT ON COLUMN projects.end_date IS 'Дата окончания или ревью проекта.';
COMMENT ON COLUMN projects.created_at IS 'Дата создания записи.';
COMMENT ON COLUMN projects.updated_at IS 'Дата последнего изменения.';

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

COMMENT ON TABLE sites IS 'Сайты — функциональные точки приёма трафика. Объединяют активный домен, TDS и мониторинг.';
COMMENT ON COLUMN sites.id IS 'Уникальный идентификатор сайта.';
COMMENT ON COLUMN sites.project_id IS 'Ссылка на проект (projects.id).';
COMMENT ON COLUMN sites.site_name IS 'Название сайта (например, brand_ru, brand_en).';
COMMENT ON COLUMN sites.lang_code IS 'Язык версии сайта (ISO-639, например ru, en, fr).';
COMMENT ON COLUMN sites.primary_zone_id IS 'Ссылка на основную зону Cloudflare (для быстрого доступа).';
COMMENT ON COLUMN sites.primary_domain_id IS 'Ссылка на основной домен сайта (денормализация для быстрого доступа).';
COMMENT ON COLUMN sites.status IS 'Текущее состояние сайта (active, paused, archived).';
COMMENT ON COLUMN sites.tds_enabled IS 'Флаг активности TDS-правил.';
COMMENT ON COLUMN sites.monitoring_enabled IS 'Флаг активности мониторинга сайта.';
COMMENT ON COLUMN sites.integrations_json IS 'JSON-список подключённых интеграций (GA, YM, HostTracker и др.).';
COMMENT ON COLUMN sites.created_at IS 'Дата создания сайта.';
COMMENT ON COLUMN sites.updated_at IS 'Дата последнего изменения записи.';

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_zones_cf_zone_id ON zones(cf_zone_id);

COMMENT ON TABLE zones IS 'Зоны Cloudflare. Принцип: 1 зона = 1 сайт. При удалении сайта зона освобождается (site_id=NULL)';
COMMENT ON COLUMN zones.id IS 'Уникальный идентификатор зоны.';
COMMENT ON COLUMN zones.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN zones.site_id IS 'Ссылка на сайт (sites.id). NULL = осиротевшая зона (можно переиспользовать).';
COMMENT ON COLUMN zones.cf_zone_id IS 'Идентификатор зоны в Cloudflare API (уникальный).';
COMMENT ON COLUMN zones.ssl_mode IS 'Режим SSL (off, flexible, full, strict).';
COMMENT ON COLUMN zones.proxied IS 'Флаг использования Cloudflare Proxy (1=включено).';
COMMENT ON COLUMN zones.plan IS 'Тариф Cloudflare для зоны.';
COMMENT ON COLUMN zones.cf_status IS 'Текущий статус зоны в Cloudflare (active, pending и т.п.).';
COMMENT ON COLUMN zones.auto_https IS 'Флаг включения автоматического HTTPS (Always Use HTTPS).';
COMMENT ON COLUMN zones.caching_level IS 'Режим кеширования (basic, standard, aggressive).';
COMMENT ON COLUMN zones.waf_mode IS 'Уровень защиты WAF (off, low, medium, high).';
COMMENT ON COLUMN zones.created_at IS 'Дата создания записи зоны.';
COMMENT ON COLUMN zones.updated_at IS 'Дата последнего обновления записи зоны.';

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
    blocked_reason TEXT CHECK(blocked_reason IN (
        'unavailable',      -- технически недоступен
        'ad_network',       -- бан рекламной сети
        'hosting_registrar',-- проблемы с хостингом/регистратором
        'government',       -- государственная блокировка
        'manual'            -- ручное управление
    )),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_name ON domains(domain_name);
CREATE INDEX IF NOT EXISTS idx_domains_account_id ON domains(account_id);
CREATE INDEX IF NOT EXISTS idx_domains_site_id ON domains(site_id);
CREATE INDEX IF NOT EXISTS idx_domains_zone_id ON domains(zone_id);
CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status);
CREATE INDEX IF NOT EXISTS idx_domains_role ON domains(domain_role);

COMMENT ON TABLE domains IS 'Доменные имена клиента — технические активы. При удалении сайта домены освобождаются (site_id=NULL) для переиспользования. При удалении зоны домены удаляются безвозвратно.';
COMMENT ON COLUMN domains.id IS 'Уникальный идентификатор домена.';
COMMENT ON COLUMN domains.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN domains.project_id IS 'Ссылка на проект (projects.id). NULL = осиротевший домен.';
COMMENT ON COLUMN domains.site_id IS 'Ссылка на сайт (sites.id). NULL = осиротевший домен (можно переиспользовать).';
COMMENT ON COLUMN domains.zone_id IS 'Ссылка на зону Cloudflare (zones.id). Обязательно для работы домена.';
COMMENT ON COLUMN domains.domain_name IS 'Полное доменное имя (FQDN). Уникально в системе.';
COMMENT ON COLUMN domains.registrar IS 'Регистратор, у которого приобретён домен.';
COMMENT ON COLUMN domains.ns_required IS 'NS-серверы CF (JSON или через запятую), требуемые Cloudflare.';
COMMENT ON COLUMN domains.ns_status IS 'Текущий статус NS-записей (pending, verified, error).';
COMMENT ON COLUMN domains.ns_verified_at IS 'Дата последней успешной проверки NS.';
COMMENT ON COLUMN domains.domain_role IS 'Роль домена: primary (основной с TDS) или donor (донор для рекламы с редиректом).';
COMMENT ON COLUMN domains.target_type IS 'Тип маршрутизации: ip (A-запись), cname (CNAME), worker (CF Worker), redirect (301/302).';
COMMENT ON COLUMN domains.target_value IS 'Адрес назначения: IP-адрес, CNAME, имя воркера или URL редиректа.';
COMMENT ON COLUMN domains.status IS 'Статус домена: new, active или blocked.';
COMMENT ON COLUMN domains.blocked_reason IS 'Причина блокировки (опционально, если доступна).';
COMMENT ON COLUMN domains.blocked_details IS 'Детальное описание блокировки: текст жалобы, ID кабинета, ссылка на уведомление (не хранить пароли!).';
COMMENT ON COLUMN domains.blocked_at IS 'Дата блокировки домена.';
COMMENT ON COLUMN domains.replaced_by IS 'Ссылка на новый домен, если выполнена замена.';
COMMENT ON COLUMN domains.tds_allowed IS 'Флаг разрешения TDS при soft-block.';
COMMENT ON COLUMN domains.created_at IS 'Дата добавления домена в систему.';
COMMENT ON COLUMN domains.updated_at IS 'Дата последнего изменения записи.';

-- ======================================================
-- IV. REDIRECTS AND TDS RULES
-- ======================================================

CREATE TABLE IF NOT EXISTS redirect_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    template_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE redirect_templates IS 'Системные шаблоны редиректов, доступные пользователям для копирования.';
COMMENT ON COLUMN redirect_templates.id IS 'Уникальный идентификатор шаблона.';
COMMENT ON COLUMN redirect_templates.name IS 'Название шаблона редиректа.';
COMMENT ON COLUMN redirect_templates.description IS 'Описание назначения шаблона.';
COMMENT ON COLUMN redirect_templates.template_json IS 'JSON-конфигурация шаблона правил.';
COMMENT ON COLUMN redirect_templates.created_at IS 'Дата создания шаблона.';

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

COMMENT ON TABLE redirect_rules IS 'Пользовательские правила редиректов (source → target, условия и приоритет) на уровне сайта.';
COMMENT ON COLUMN redirect_rules.id IS 'Уникальный идентификатор правила редиректа.';
COMMENT ON COLUMN redirect_rules.account_id IS 'Ссылка на аккаунт клиента (accounts.id).';
COMMENT ON COLUMN redirect_rules.site_id IS 'Ссылка на сайт (sites.id), для которого применяется правило.';
COMMENT ON COLUMN redirect_rules.source_url IS 'Исходный URL для перенаправления.';
COMMENT ON COLUMN redirect_rules.target_url IS 'Целевой URL для перенаправления.';
COMMENT ON COLUMN redirect_rules.status_code IS 'HTTP-код ответа (301, 302).';
COMMENT ON COLUMN redirect_rules.conditions_json IS 'JSON с условиями выполнения (geo, device, query и т.п.).';
COMMENT ON COLUMN redirect_rules.priority IS 'Приоритет выполнения правила (0 — низкий, выше — раньше).';
COMMENT ON COLUMN redirect_rules.is_active IS 'Флаг активности правила (1 — активно).';
COMMENT ON COLUMN redirect_rules.created_at IS 'Дата создания правила.';
COMMENT ON COLUMN redirect_rules.updated_at IS 'Дата последнего изменения правила.';

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

COMMENT ON TABLE tds_rules IS 'Набор правил распределения трафика (Traffic Distribution System) на уровне сайта.';
COMMENT ON COLUMN tds_rules.id IS 'Уникальный идентификатор TDS-правила.';
COMMENT ON COLUMN tds_rules.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN tds_rules.site_id IS 'Ссылка на сайт (sites.id), к которому относится правило.';
COMMENT ON COLUMN tds_rules.rule_name IS 'Название TDS-правила.';
COMMENT ON COLUMN tds_rules.logic_json IS 'JSON-описание логики маршрутизации (geo, weight, utm и т.д.).';
COMMENT ON COLUMN tds_rules.created_at IS 'Дата создания правила.';
COMMENT ON COLUMN tds_rules.updated_at IS 'Дата последнего изменения правила.';

-- ======================================================
-- V. WORKERS AND DEPLOY MANAGEMENT
-- ======================================================

CREATE TABLE IF NOT EXISTS worker_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    code_template TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE worker_templates IS 'Системные шаблоны воркеров (core, edge, client) для деплоя в CF.';
COMMENT ON COLUMN worker_templates.id IS 'Уникальный идентификатор шаблона воркера.';
COMMENT ON COLUMN worker_templates.name IS 'Название шаблона воркера.';
COMMENT ON COLUMN worker_templates.description IS 'Описание назначения воркера.';
COMMENT ON COLUMN worker_templates.code_template IS 'Исходный код шаблона (TypeScript/JS).';
COMMENT ON COLUMN worker_templates.created_at IS 'Дата создания шаблона.';
COMMENT ON COLUMN worker_templates.updated_at IS 'Дата последнего изменения шаблона.';

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
CREATE INDEX IF NOT EXISTS idx_workers_template_id ON workers(template_id);

COMMENT ON TABLE workers IS 'Экземпляры воркеров (развёрнутых у клиентов или в ядре 301.st), связанных с конкретным сайтом.';
COMMENT ON COLUMN workers.id IS 'Уникальный идентификатор воркера.';
COMMENT ON COLUMN workers.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN workers.site_id IS 'Ссылка на сайт (sites.id), для которого развёрнут воркер.';
COMMENT ON COLUMN workers.template_id IS 'Ссылка на шаблон воркера (worker_templates.id).';
COMMENT ON COLUMN workers.version IS 'Версия кода воркера.';
COMMENT ON COLUMN workers.status IS 'Текущий статус воркера (active, disabled, error).';
COMMENT ON COLUMN workers.last_deploy IS 'Дата последнего деплоя воркера.';
COMMENT ON COLUMN workers.created_at IS 'Дата создания воркера.';
COMMENT ON COLUMN workers.updated_at IS 'Дата последнего изменения записи.';

-- ======================================================
-- VI. ANALYTICS, AUDIT, TASKS
-- ======================================================

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

COMMENT ON TABLE redirect_logs IS 'Сырые логи переходов по редиректам (для аналитики и статистики) на уровне сайтов.';
COMMENT ON COLUMN redirect_logs.id IS 'Уникальный идентификатор записи лога.';
COMMENT ON COLUMN redirect_logs.site_id IS 'Ссылка на сайт (sites.id), к которому относится переход.';
COMMENT ON COLUMN redirect_logs.source_url IS 'URL источника запроса.';
COMMENT ON COLUMN redirect_logs.target_url IS 'Целевой URL редиректа.';
COMMENT ON COLUMN redirect_logs.status_code IS 'HTTP-код редиректа (301, 302).';
COMMENT ON COLUMN redirect_logs.ip IS 'IP-адрес посетителя.';
COMMENT ON COLUMN redirect_logs.country IS 'Страна посетителя (по GeoIP).';
COMMENT ON COLUMN redirect_logs.user_agent IS 'User-Agent клиента (браузер, устройство).';
COMMENT ON COLUMN redirect_logs.created_at IS 'Дата и время редиректа.';

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

COMMENT ON TABLE analytics_summary IS 'Агрегированные данные аналитики по сайтам и дням.';
COMMENT ON COLUMN analytics_summary.id IS 'Уникальный идентификатор записи статистики.';
COMMENT ON COLUMN analytics_summary.site_id IS 'Ссылка на сайт (sites.id), к которому относится статистика.';
COMMENT ON COLUMN analytics_summary.date IS 'Дата сбора данных.';
COMMENT ON COLUMN analytics_summary.redirects_count IS 'Количество редиректов за день.';
COMMENT ON COLUMN analytics_summary.unique_visitors IS 'Количество уникальных посетителей за день.';
COMMENT ON COLUMN analytics_summary.top_country IS 'Страна с наибольшим трафиком.';
COMMENT ON COLUMN analytics_summary.top_device IS 'Тип устройства с наибольшей долей (desktop/mobile).';
COMMENT ON COLUMN analytics_summary.created_at IS 'Дата формирования записи.';
COMMENT ON COLUMN analytics_summary.updated_at IS 'Дата последнего обновления записи.';

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

COMMENT ON TABLE domain_replacement_log IS 'Журнал замен и блокировок доменов. Фиксирует переходы и причины на уровне сайтов.';
COMMENT ON COLUMN domain_replacement_log.id IS 'Уникальный идентификатор записи.';
COMMENT ON COLUMN domain_replacement_log.old_domain_id IS 'ID старого (заблокированного) домена.';
COMMENT ON COLUMN domain_replacement_log.new_domain_id IS 'ID нового домена, созданного взамен.';
COMMENT ON COLUMN domain_replacement_log.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN domain_replacement_log.site_id IS 'Ссылка на сайт (sites.id), в котором произведена замена домена.';
COMMENT ON COLUMN domain_replacement_log.reason IS 'Причина замены или блокировки (manual, blocked, expired, auto-rotate и т.п.).';
COMMENT ON COLUMN domain_replacement_log.initiated_by IS 'ID пользователя (users.id), инициировавшего действие.';
COMMENT ON COLUMN domain_replacement_log.created_at IS 'Дата и время фиксации события.';

-- Удаляем старые записи, сохраняя максимум 10 последних для каждого site_id
DROP TRIGGER IF EXISTS limit_domain_log;

CREATE TRIGGER limit_domain_log
AFTER INSERT ON domain_replacement_log
BEGIN
    DELETE FROM domain_replacement_log
    WHERE site_id = NEW.site_id
      AND id NOT IN (
          SELECT id
          FROM domain_replacement_log
          WHERE site_id = NEW.site_id
          ORDER BY created_at DESC, id DESC
          LIMIT 10
      );
END;

COMMENT ON TRIGGER limit_domain_log IS 'Поддерживает не более 10 последних записей истории замен для каждого сайта.';

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

COMMENT ON TABLE tasks IS 'Очередь задач и акцептов действий пользователей (деплои, обновления).';
COMMENT ON COLUMN tasks.id IS 'Уникальный идентификатор задачи.';
COMMENT ON COLUMN tasks.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN tasks.task_type IS 'Тип задачи (deploy, sync, revoke, backup).';
COMMENT ON COLUMN tasks.payload_json IS 'JSON-полезная нагрузка (параметры операции).';
COMMENT ON COLUMN tasks.status IS 'Статус выполнения задачи (pending, processing, completed, error).';
COMMENT ON COLUMN tasks.approved_by IS 'ID пользователя, подтвердившего задачу.';
COMMENT ON COLUMN tasks.created_at IS 'Дата создания задачи.';
COMMENT ON COLUMN tasks.updated_at IS 'Дата последнего изменения записи.';

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

COMMENT ON TABLE backups IS 'Регистр резервных копий D1/KV/R2.';
COMMENT ON COLUMN backups.id IS 'Уникальный идентификатор резервной копии.';
COMMENT ON COLUMN backups.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN backups.backup_type IS 'Тип резервной копии (full, kv, analytics).';
COMMENT ON COLUMN backups.r2_path IS 'Путь к архиву в R2.';
COMMENT ON COLUMN backups.size_mb IS 'Размер архива в мегабайтах.';
COMMENT ON COLUMN backups.created_at IS 'Дата создания резервной копии.';

