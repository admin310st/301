-- ======================================================
-- Database Schema (Cloudflare D1 SQL version)
-- ======================================================

-- ======================================================
-- I. USERS AND AUTHENTICATION
-- ======================================================
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    email_verified INTEGER DEFAULT 0;
    password_hash TEXT,
    oauth_provider TEXT,
    oauth_id TEXT,
    tg_id TEXT,
    name TEXT,
    user_type TEXT DEFAULT 'client' CHECK(user_type IN ('admin', 'client')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE users IS 'Учётные записи пользователей платформы 301.st.';
COMMENT ON COLUMN users.id IS 'Уникальный идентификатор пользователя.';
COMMENT ON COLUMN users.email IS 'Email пользователя, используется для входа.';
COMMENT ON COLUMN users.email_verified IS 'Верификация Email пользователя .';
COMMENT ON COLUMN users.password_hash IS 'Хеш пароля (bcrypt/scrypt). NULL для OAuth-пользователей.';
COMMENT ON COLUMN users.oauth_provider IS 'Провайдер OAuth (google, github).';
COMMENT ON COLUMN users.oauth_id IS 'Уникальный идентификатор пользователя от OAuth-провайдера. Используется для поиска существующего пользователя при повторном логине.';
COMMENT ON COLUMN users.tg_id IS 'Telegram ID пользователя для уведомлений и рассылок.';
COMMENT ON COLUMN users.name IS 'Имя пользователя или организация.';
COMMENT ON COLUMN users.user_type IS 'Системная роль: admin (администратор платформы 301.st с доступом ко всем аккаунтам), client (обычный пользователь). Роли owner/editor/viewer определяются через связи с аккаунтами.';
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
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

COMMENT ON TABLE sessions IS 'Активные сессии пользователей, применяемые для обновления токенов.';
COMMENT ON COLUMN sessions.id IS 'Уникальный идентификатор сессии.';
COMMENT ON COLUMN sessions.user_id IS 'Ссылка на пользователя (users.id). При мягком удалении пользователя сессии остаются для целей аудита.';
COMMENT ON COLUMN sessions.refresh_id IS 'Идентификатор refresh-токена, хранящегося в KV.';
COMMENT ON COLUMN sessions.ip_address IS 'IP-адрес, с которого произведён вход.';
COMMENT ON COLUMN sessions.user_agent IS 'User-Agent клиента (браузер, устройство).';
COMMENT ON COLUMN sessions.revoked IS 'Флаг отзыва сессии (1 — токен аннулирован).';
COMMENT ON COLUMN sessions.created_at IS 'Дата создания сессии.';
COMMENT ON COLUMN sessions.expires_at IS 'Дата окончания действия токена.';

-- ======================================================
-- II. ACCOUNTS, PLANS AND INTEGRATIONS
-- ======================================================
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_name TEXT NOT NULL,
    plan_tier TEXT DEFAULT 'free' CHECK(plan_tier IN ('free', 'pro', 'buss')),
    billing_status TEXT DEFAULT 'active' CHECK(billing_status IN ('active', 'suspended', 'cancelled')),
    timezone TEXT DEFAULT 'UTC',
    country_code TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'deleted')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

COMMENT ON TABLE accounts IS 'Аккаунты клиентов (тенанты) с параметрами, тарифом и текущим статусом.';
COMMENT ON COLUMN accounts.id IS 'Уникальный идентификатор аккаунта.';
COMMENT ON COLUMN accounts.user_id IS 'Ссылка на владельца аккаунта (users.id). При удалении пользователя аккаунт сохраняется, но статус может быть изменён на deleted.';
COMMENT ON COLUMN accounts.account_name IS 'Название клиента или организации.';
COMMENT ON COLUMN accounts.plan_tier IS 'Тарифный план: free (бесплатный), pro (профессиональный), buss (бизнес).';
COMMENT ON COLUMN accounts.billing_status IS 'Статус биллинга: active, suspended, cancelled.';
COMMENT ON COLUMN accounts.timezone IS 'Часовой пояс аккаунта.';
COMMENT ON COLUMN accounts.country_code IS 'Код страны ISO 3166-1 alpha-2 (RU, US, DE).';
COMMENT ON COLUMN accounts.status IS 'Статус аккаунта: active, suspended, deleted (мягкое удаление без физического удаления данных).';
COMMENT ON COLUMN accounts.created_at IS 'Дата создания аккаунта.';
COMMENT ON COLUMN accounts.updated_at IS 'Дата последнего изменения записи.';

CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    role TEXT CHECK(role IN ('admin', 'editor', 'viewer')) NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'expired', 'revoked')),
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_invitations_account_id ON invitations(account_id);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);

COMMENT ON TABLE invitations IS 'Приглашения пользователей в аккаунты. Содержат краткоживущие токены для активации членства.';
COMMENT ON COLUMN invitations.id IS 'Уникальный идентификатор приглашения.';
COMMENT ON COLUMN invitations.account_id IS 'Ссылка на аккаунт, в который осуществляется приглашение.';
COMMENT ON COLUMN invitations.token IS 'Уникальный токен приглашения (UUID, передаётся в ссылке join).';
COMMENT ON COLUMN invitations.role IS 'Роль, которую получит приглашённый пользователь: admin, editor, viewer.';
COMMENT ON COLUMN invitations.status IS 'Текущее состояние приглашения: pending (ожидает), accepted (принято), expired (просрочено), revoked (отозвано).';
COMMENT ON COLUMN invitations.expires_at IS 'Срок действия приглашения (обычно 10–15 минут).';
COMMENT ON COLUMN invitations.created_at IS 'Дата создания приглашения.';

CREATE TABLE IF NOT EXISTS account_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'editor' CHECK(role IN ('editor', 'viewer')),
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'removed')),
    invited_by INTEGER,  -- ID пользователя, пригласившего участника (не FK)
    invited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_members_account_id ON account_members(account_id);
CREATE INDEX IF NOT EXISTS idx_account_members_user_id ON account_members(user_id);

COMMENT ON TABLE account_members IS 'Связь пользователей с аккаунтами (членство, роль, статус).';
COMMENT ON COLUMN account_members.id IS 'Уникальный идентификатор записи членства.';
COMMENT ON COLUMN account_members.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN account_members.user_id IS 'Ссылка на пользователя (users.id).';
COMMENT ON COLUMN account_members.role IS 'Роль пользователя в аккаунте: owner, admin, editor, viewer.';
COMMENT ON COLUMN account_members.status IS 'Статус участия: active, suspended, removed.';
COMMENT ON COLUMN account_members.invited_by IS 'ID пользователя, который отправил приглашение. Хранится только для справки, без связи с users.';
COMMENT ON COLUMN account_members.invited_at IS 'Дата создания приглашения.';
COMMENT ON COLUMN account_members.accepted_at IS 'Дата принятия приглашения.';
COMMENT ON COLUMN account_members.created_at IS 'Дата создания записи.';
COMMENT ON COLUMN account_members.updated_at IS 'Дата последнего изменения.';

CREATE TABLE IF NOT EXISTS plan_tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_tier TEXT NOT NULL UNIQUE CHECK(plan_tier IN ('free','pro','buss')),
    name TEXT NOT NULL,
    description TEXT,
    price_usd REAL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE plan_tiers IS 'Справочник тарифных планов платформы 301.st.';
COMMENT ON COLUMN plan_tiers.id IS 'Уникальный идентификатор тарифа.';
COMMENT ON COLUMN plan_tiers.plan_tier IS 'Код тарифа: free, pro, buss.';
COMMENT ON COLUMN plan_tiers.name IS 'Название тарифа (для отображения пользователю).';
COMMENT ON COLUMN plan_tiers.description IS 'Описание, ограничения и преимущества тарифа.';
COMMENT ON COLUMN plan_tiers.price_usd IS 'Стоимость тарифа в долларах США.';
COMMENT ON COLUMN plan_tiers.created_at IS 'Дата создания записи.';

INSERT OR IGNORE INTO plan_tiers (plan_tier, name, description, price_usd) VALUES
('free', 'Free', 'Базовый бесплатный тариф. Только владелец аккаунта.', 0),
('pro', 'Pro', 'Профессиональный тариф для команд до 10 участников.', 29),
('buss', 'Business', 'Бизнес-тариф для крупных команд и организаций.', 99);

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
    support_level TEXT DEFAULT 'community',  -- community, email, priority
    custom_workers INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_tier) REFERENCES plan_tiers(plan_tier) ON DELETE CASCADE
);

COMMENT ON TABLE quota_limits IS 'Технические ограничения и лимиты для каждого тарифного плана.';
COMMENT ON COLUMN quota_limits.id IS 'Уникальный идентификатор записи (служебный ключ).';
COMMENT ON COLUMN quota_limits.plan_tier IS 'Код тарифа: free, pro, buss. Используется для связи с plan_tiers и accounts.';
COMMENT ON COLUMN quota_limits.max_projects IS 'Максимальное количество проектов, которые может создать аккаунт.';
COMMENT ON COLUMN quota_limits.max_sites IS 'Максимальное количество сайтов, доступных в тарифе.';
COMMENT ON COLUMN quota_limits.max_domains IS 'Максимальное количество доменов, которые можно добавить.';
COMMENT ON COLUMN quota_limits.max_zones IS 'Максимальное количество DNS-зон (Cloudflare-зон).';
COMMENT ON COLUMN quota_limits.max_redirect_rules IS 'Максимальное количество правил редиректов (301, TDS и т.п.).';
COMMENT ON COLUMN quota_limits.max_tds_rules IS 'Максимальное количество TDS-правил маршрутизации.';
COMMENT ON COLUMN quota_limits.max_team_members IS 'Максимальное количество участников команды, кроме владельца.';
COMMENT ON COLUMN quota_limits.analytics_retention_days IS 'Количество дней хранения аналитики (логи, статистика, отчёты).';
COMMENT ON COLUMN quota_limits.backup_retention_days IS 'Количество дней хранения резервных копий (в R2/Nextcloud).';
COMMENT ON COLUMN quota_limits.api_rate_limit IS 'Ограничение по числу API-запросов в минуту.';
COMMENT ON COLUMN quota_limits.support_level IS 'Уровень поддержки: community (форум), email (почта), priority (приоритетная).';
COMMENT ON COLUMN quota_limits.custom_workers IS 'Количество пользовательских воркеров Cloudflare, доступных аккаунту.';
COMMENT ON COLUMN quota_limits.created_at IS 'Дата создания записи лимитов.';

-- Предзаполнение тарифов
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
    last_reset TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quota_usage_account_id ON quota_usage(account_id);

COMMENT ON TABLE quota_usage IS 'Учёт текущего использования квот и лимитов по каждому аккаунту.';
COMMENT ON COLUMN quota_usage.id IS 'Уникальный идентификатор записи (служебный ключ).';
COMMENT ON COLUMN quota_usage.account_id IS 'Ссылка на аккаунт (accounts.id), для которого ведётся учёт ресурсов.';
COMMENT ON COLUMN quota_usage.plan_tier IS 'Код активного тарифа аккаунта: free, pro, buss. Копируется из accounts.plan_tier.';
COMMENT ON COLUMN quota_usage.projects_used IS 'Количество созданных проектов в рамках аккаунта.';
COMMENT ON COLUMN quota_usage.sites_used IS 'Количество сайтов, зарегистрированных в аккаунте.';
COMMENT ON COLUMN quota_usage.domains_used IS 'Количество доменов, подключённых к аккаунту.';
COMMENT ON COLUMN quota_usage.zones_used IS 'Количество DNS-зон (Cloudflare-зон), привязанных к аккаунту.';
COMMENT ON COLUMN quota_usage.redirect_rules_used IS 'Количество активных правил редиректов, созданных аккаунтом.';
COMMENT ON COLUMN quota_usage.tds_rules_used IS 'Количество активных TDS-правил маршрутизации.';
COMMENT ON COLUMN quota_usage.team_members_used IS 'Количество участников команды (из account_members).';
COMMENT ON COLUMN quota_usage.api_calls_minute IS 'Количество API-запросов, выполненных в текущую минуту. Используется для rate limiting.';
COMMENT ON COLUMN quota_usage.last_reset IS 'Время последнего сброса счётчиков использования (API и лимитов).';
COMMENT ON COLUMN quota_usage.updated_at IS 'Дата и время последнего обновления записи.';

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

-- ======================================================
-- III. PROJECTS
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

CREATE TABLE IF NOT EXISTS project_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    account_key_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (account_key_id) REFERENCES account_keys(id) ON DELETE CASCADE,
    UNIQUE (project_id, account_key_id)
);

CREATE INDEX IF NOT EXISTS idx_proj_integrations_project_id ON project_integrations(project_id);
CREATE INDEX IF NOT EXISTS idx_proj_integrations_key_id ON project_integrations(account_key_id);

COMMENT ON TABLE project_integrations IS 'Связи проектов с ключами интеграций (account_keys).'; 
COMMENT ON COLUMN project_integrations.id IS 'Уникальный идентификатор записи связи.';
COMMENT ON COLUMN project_integrations.project_id IS 'Ссылка на проект (projects.id), к которому подключён ключ.';
COMMENT ON COLUMN project_integrations.account_key_id IS 'Ссылка на ключ интеграции (account_keys.id). Провайдер и статус берутся из account_keys.';
COMMENT ON COLUMN project_integrations.created_at IS 'Дата создания связи проекта с ключом.';
COMMENT ON COLUMN project_integrations.updated_at IS 'Дата последнего изменения связи.';

CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    site_name TEXT NOT NULL,
    site_tag TEXT,
    status TEXT CHECK(status IN ('active','paused','archived')) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sites_project_id ON sites(project_id);

COMMENT ON TABLE sites IS 'Сайты проекта — функциональные единицы приёма трафика.';
COMMENT ON COLUMN sites.id IS 'Уникальный идентификатор сайта.';
COMMENT ON COLUMN sites.project_id IS 'Ссылка на проект (projects.id).';
COMMENT ON COLUMN sites.site_name IS 'Имя сайта (внутреннее обозначение или кампания).';
COMMENT ON COLUMN sites.site_tag IS 'Краткий тег для внутренней идентификации сайта.';
COMMENT ON COLUMN sites.status IS 'Статус сайта: active, paused, archived.';
COMMENT ON COLUMN sites.created_at IS 'Дата создания записи.';
COMMENT ON COLUMN sites.updated_at IS 'Дата последнего изменения записи.';

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
    ssl_last_checked TIMESTAMP,
    auto_https INTEGER DEFAULT 1,
    caching_level TEXT CHECK(caching_level IN ('off','basic','simplified','standard','aggressive')) DEFAULT 'standard',
    waf_mode TEXT CHECK(waf_mode IN ('off','low','medium','high')) DEFAULT 'medium',
    dns_records TEXT,
    last_sync_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (key_id) REFERENCES account_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_zones_account_id ON zones(account_id);
CREATE INDEX IF NOT EXISTS idx_zones_key_id ON zones(key_id);

COMMENT ON TABLE zones IS 'Служебные DNS-зоны Cloudflare, создаваемые автоматически при добавлении доменов 2-го уровня.';
COMMENT ON COLUMN zones.id IS 'Уникальный идентификатор зоны.';
COMMENT ON COLUMN zones.account_id IS 'Ссылка на аккаунт (accounts.id), которому принадлежит зона.';
COMMENT ON COLUMN zones.key_id IS 'Ссылка на ключ интеграции Cloudflare (account_keys.id).';
COMMENT ON COLUMN zones.cf_zone_id IS 'Уникальный идентификатор зоны в Cloudflare (UUID).';
COMMENT ON COLUMN zones.status IS 'Состояние зоны: active, pending, error, deleted.';
COMMENT ON COLUMN zones.plan IS 'Тарифный план зоны в Cloudflare: free, pro, business, enterprise.';
COMMENT ON COLUMN zones.ns_expected IS 'Ожидаемые NS-записи, выданные Cloudflare.';
COMMENT ON COLUMN zones.verified IS 'Флаг подтверждения делегирования зоны (1 — NS совпадают).';
COMMENT ON COLUMN zones.ssl_status IS 'Текущее состояние SSL-сертификата зоны: none, valid, expired, error.';
COMMENT ON COLUMN zones.ssl_mode IS 'Режим SSL в Cloudflare: off, flexible, full, strict.';
COMMENT ON COLUMN zones.ssl_last_checked IS 'Дата последней проверки SSL-состояния зоны.';
COMMENT ON COLUMN zones.auto_https IS 'Автоматическое перенаправление HTTP → HTTPS (1 — включено).';
COMMENT ON COLUMN zones.caching_level IS 'Уровень кэширования контента Cloudflare: off, basic, simplified, standard, aggressive.';
COMMENT ON COLUMN zones.waf_mode IS 'Режим WAF (Web Application Firewall): off, low, medium, high.';
COMMENT ON COLUMN zones.dns_records IS 'JSON-кеш DNS-записей зоны (служебное хранение).';
COMMENT ON COLUMN zones.last_sync_at IS 'Дата последней синхронизации с Cloudflare API.';
COMMENT ON COLUMN zones.created_at IS 'Дата создания записи.';
COMMENT ON COLUMN zones.updated_at IS 'Дата последнего обновления.';

CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,                         -- владелец домена (tenant)
    site_id INTEGER,                                     -- ссылка на сайт, если домен используется
    zone_id INTEGER,                                     -- служебная зона (Cloudflare)
    key_id INTEGER,                                      -- ссылка на ключ интеграции (account_keys.id)
    parent_id INTEGER,                                   -- родительский домен (2-го или 3-го уровня)
    domain_name TEXT NOT NULL UNIQUE,                    -- полное доменное имя (FQDN)
    role TEXT CHECK(role IN ('acceptor','donor','reserve')) DEFAULT 'reserve',  -- назначение домена
    ns TEXT,                                             -- фактические NS-записи (через запятую или JSON)
    ns_verified INTEGER DEFAULT 0,                       -- 1 — делегирование подтверждено
    proxied INTEGER DEFAULT 1,
    blocked INTEGER DEFAULT 0 CHECK(blocked IN (0,1)),   -- флаг блокировки домена
    blocked_reason TEXT CHECK(blocked_reason IN (        -- причина блокировки
        'unavailable', 'ad_network', 'hosting_registrar', 'government', 'manual'
    )),
    ssl_status TEXT CHECK(ssl_status IN ('none','valid','expired','error')) DEFAULT 'none',
    expired_at TIMESTAMP,                                -- дата окончания регистрации у регистратора
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL,
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE SET NULL,
    FOREIGN KEY (key_id) REFERENCES account_keys(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_id) REFERENCES domains(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_domains_account_id ON domains(account_id);
CREATE INDEX IF NOT EXISTS idx_domains_site_id ON domains(site_id);
CREATE INDEX IF NOT EXISTS idx_domains_zone_id ON domains(zone_id);
CREATE INDEX IF NOT EXISTS idx_domains_key_id ON domains(key_id);
CREATE INDEX IF NOT EXISTS idx_domains_parent_id ON domains(parent_id);
CREATE INDEX IF NOT EXISTS idx_domains_blocked ON domains(blocked);

COMMENT ON TABLE domains IS 'Домены всех уровней в системе 301.st: акцепторы (acceptor), доноры (donor) и свободные (reserve).';
COMMENT ON COLUMN domains.id IS 'Уникальный идентификатор домена.';
COMMENT ON COLUMN domains.account_id IS 'Ссылка на аккаунт (accounts.id), которому принадлежит домен.';
COMMENT ON COLUMN domains.site_id IS 'Ссылка на сайт (sites.id), если домен используется сайтом.';
COMMENT ON COLUMN domains.zone_id IS 'Ссылка на служебную зону Cloudflare (zones.id), скрытую от пользователя.';
COMMENT ON COLUMN domains.key_id IS 'Ссылка на ключ интеграции (account_keys.id), через который управляется домен.';
COMMENT ON COLUMN domains.parent_id IS 'Родительский домен (для 3-го и 4-го уровней). Позволяет формировать иерархию.';
COMMENT ON COLUMN domains.domain_name IS 'Полное доменное имя (FQDN), включая поддомены.';
COMMENT ON COLUMN domains.role IS 'Роль домена: acceptor (акцептор, принимает трафик), donor (редирект), reserve (свободный).';
COMMENT ON COLUMN domains.ns IS 'Фактические NS-записи, полученные при последней проверке (WHOIS/API).';
COMMENT ON COLUMN domains.ns_verified IS 'Флаг подтверждения делегирования NS (1 — подтверждено).';
COMMENT ON COLUMN domains.proxied IS 'Флаг проксирования через Cloudflare (1 — включено, 0 — только DNS).';
COMMENT ON COLUMN domains.blocked IS 'Флаг блокировки домена (1 — домен заблокирован системой или вручную).';
COMMENT ON COLUMN domains.blocked_reason IS 'Причина блокировки: unavailable, ad_network, hosting_registrar, government, manual.';
COMMENT ON COLUMN domains.ssl_status IS 'Статус SSL-сертификата: none, valid, expired, error.';
COMMENT ON COLUMN domains.expired_at IS 'Дата окончания регистрации домена у регистратора.';
COMMENT ON COLUMN domains.created_at IS 'Дата добавления домена в систему.';
COMMENT ON COLUMN domains.updated_at IS 'Дата последнего обновления записи.';


-- ======================================================
-- IV. REDIRECTS AND TDS RULES
-- ======================================================

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_redirect_rules_account ON redirect_rules(account_id, priority);
CREATE INDEX IF NOT EXISTS idx_redirect_rules_name ON redirect_rules(rule_name);

COMMENT ON TABLE redirect_rules IS 'Универсальные правила редиректов, хранящиеся в виде единого JSON. Определяют тип и логику перенаправления.';
COMMENT ON COLUMN redirect_rules.id IS 'Уникальный идентификатор правила редиректа.';
COMMENT ON COLUMN redirect_rules.account_id IS 'Ссылка на аккаунт клиента (accounts.id), владелец правила.';
COMMENT ON COLUMN redirect_rules.rule_name IS 'Человекочитаемое имя правила для интерфейса и API.';
COMMENT ON COLUMN redirect_rules.redirect_type IS 'Тип редиректа: domain_to_domain (домен→домен), all_to_root (все пути на корень), path_to_path (путь→путь), wildcard_path (шаблон пути), zone_to_root (зона→домен), conditional (условный редирект по GEO, device, utm и т.п.).';
COMMENT ON COLUMN redirect_rules.rule_json IS 'JSON-конфигурация редиректа: source/target, preserve_path, preserve_query, conditions и другие параметры.';
COMMENT ON COLUMN redirect_rules.status_code IS 'HTTP-код перенаправления: 301 (Permanent), 302 или 307 (Temporary).';
COMMENT ON COLUMN redirect_rules.priority IS 'Приоритет применения. Меньшее значение — более высокий приоритет.';
COMMENT ON COLUMN redirect_rules.created_at IS 'Дата и время создания правила.';
COMMENT ON COLUMN redirect_rules.updated_at IS 'Дата и время последнего обновления записи.';

CREATE TABLE IF NOT EXISTS tds_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    param_key TEXT NOT NULL UNIQUE,
    category TEXT CHECK(category IN (
        'utm_standard',     -- стандартный UTM (Google)
        'utm_extended',     -- арбитражные utm/sub*
        'click_id',         -- идентификаторы кликов (fbclid, gclid, ttclid, yclid)
        'partner_custom'    -- партнёрские или внутренние ID
    )) DEFAULT 'utm_standard',
    description TEXT,                          -- человекочитаемое описание
    is_active INTEGER DEFAULT 1,               -- возможность использовать в правилах
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tds_params_category ON tds_params(category);

COMMENT ON TABLE tds_params IS 'Справочник поддерживаемых параметров (UTM, SUB, CLICK_ID, partner) для построения логики TDS.';
COMMENT ON COLUMN tds_params.id IS 'Уникальный идентификатор записи.';
COMMENT ON COLUMN tds_params.param_key IS 'Ключ параметра, который может использоваться в логике маршрутизации (например, utm_source, sub1, fbclid).';
COMMENT ON COLUMN tds_params.category IS 'Категория параметра: utm_standard, utm_extended, click_id, partner_custom.';
COMMENT ON COLUMN tds_params.description IS 'Описание назначения параметра (источник, ключевое слово, ID клика и т.д.).';
COMMENT ON COLUMN tds_params.is_active IS 'Флаг активности: 1 — параметр доступен для использования в логике, 0 — исключён.';
COMMENT ON COLUMN tds_params.created_at IS 'Дата добавления параметра в систему.';

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tds_rules_account ON tds_rules(account_id, priority);
CREATE INDEX IF NOT EXISTS idx_tds_rules_name ON tds_rules(rule_name);

COMMENT ON TABLE tds_rules IS 'Правила Traffic Distribution System (TDS): SmartLink и Traffic Shield. Хранятся в виде единого JSON, используемого при сборке воркера.';
COMMENT ON COLUMN tds_rules.id IS 'Уникальный идентификатор TDS-правила.';
COMMENT ON COLUMN tds_rules.account_id IS 'Ссылка на аккаунт клиента (accounts.id), владелец сценария.';
COMMENT ON COLUMN tds_rules.rule_name IS 'Название сценария TDS для отображения в интерфейсе.';
COMMENT ON COLUMN tds_rules.tds_type IS 'Тип логики: smartlink — параметрический (UTM/Sub), traffic_shield — защитный (метаданные Cloudflare).';
COMMENT ON COLUMN tds_rules.logic_json IS 'Полная JSON-конфигурация сценария: условия (utm, geo, device, asn и др.), распределение (split), fallback и действия (redirect, block, cloak).';
COMMENT ON COLUMN tds_rules.priority IS 'Приоритет выполнения правила. Меньшее значение — более высокий приоритет.';
COMMENT ON COLUMN tds_rules.created_at IS 'Дата и время создания записи.';
COMMENT ON COLUMN tds_rules.updated_at IS 'Дата и время последнего изменения записи.';

-- ======================================================
-- V. RULES, WORKERS AND DEPLOY MANAGEMENT
-- ======================================================
CREATE TABLE IF NOT EXISTS rule_domain_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    account_id INTEGER NOT NULL,                 -- владелец (tenant)
    redirect_rule_id INTEGER,                    -- ссылка на redirect_rules.id
    tds_rule_id INTEGER,                         -- ссылка на tds_rules.id
    domain_id INTEGER NOT NULL,                  -- домен, к которому применяется правило

    enabled INTEGER DEFAULT 1,                   -- 1=активно, 0=отключено
    binding_status TEXT CHECK(binding_status IN (
        'pending','applying','applied','failed','retired','removed'
    )) DEFAULT 'pending',

    schedule_start TIMESTAMP,                    -- плановое включение
    schedule_end   TIMESTAMP,                    -- плановое отключение

    last_synced_at TIMESTAMP,                    -- последняя успешная синхронизация
    last_error TEXT,                             -- последняя ошибка при деплое
    replaced_by INTEGER,                         -- id новой привязки (при миграции на новый домен)

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (account_id)       REFERENCES accounts(id)        ON DELETE CASCADE,
    FOREIGN KEY (redirect_rule_id) REFERENCES redirect_rules(id)  ON DELETE CASCADE,
    FOREIGN KEY (tds_rule_id)      REFERENCES tds_rules(id)       ON DELETE CASCADE,
    FOREIGN KEY (domain_id)        REFERENCES domains(id)         ON DELETE CASCADE,
    FOREIGN KEY (replaced_by)      REFERENCES rule_domain_map(id) ON DELETE SET NULL,

    CHECK (
      (redirect_rule_id IS NOT NULL AND tds_rule_id IS NULL)
      OR
      (tds_rule_id IS NOT NULL AND redirect_rule_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_rdm_account_status ON rule_domain_map(account_id, binding_status);
CREATE INDEX IF NOT EXISTS idx_rdm_domain_enabled ON rule_domain_map(domain_id, enabled);
CREATE INDEX IF NOT EXISTS idx_rdm_redirect ON rule_domain_map(redirect_rule_id);
CREATE INDEX IF NOT EXISTS idx_rdm_tds ON rule_domain_map(tds_rule_id);

COMMENT ON TABLE rule_domain_map IS 'Привязки redirect_rules и tds_rules к доменам. Отражает текущее состояние связей и миграции без логов действий.';
COMMENT ON COLUMN rule_domain_map.id IS 'Уникальный идентификатор привязки.';
COMMENT ON COLUMN rule_domain_map.account_id IS 'Tenant (владелец привязки), совпадает с аккаунтом правила и домена.';
COMMENT ON COLUMN rule_domain_map.redirect_rule_id IS 'Ссылка на redirect_rules.id (если используется редирект).';
COMMENT ON COLUMN rule_domain_map.tds_rule_id IS 'Ссылка на tds_rules.id (если используется TDS).';
COMMENT ON COLUMN rule_domain_map.domain_id IS 'Ссылка на домен (domains.id), к которому применяется правило.';
COMMENT ON COLUMN rule_domain_map.enabled IS 'Флаг активности привязки без удаления записи.';
COMMENT ON COLUMN rule_domain_map.binding_status IS 'Текущее состояние жизненного цикла: pending, applying, applied, failed, retired, removed.';
COMMENT ON COLUMN rule_domain_map.schedule_start IS 'Не активировать привязку ранее указанного времени.';
COMMENT ON COLUMN rule_domain_map.schedule_end IS 'Автоматически снять привязку после указанного времени.';
COMMENT ON COLUMN rule_domain_map.last_synced_at IS 'Дата последней успешной синхронизации с Cloudflare.';
COMMENT ON COLUMN rule_domain_map.last_error IS 'Текст последней ошибки при деплое или синхронизации.';
COMMENT ON COLUMN rule_domain_map.replaced_by IS 'Если домен заменён новым — ссылка на новую запись привязки (история миграций).';
COMMENT ON COLUMN rule_domain_map.created_at IS 'Дата создания привязки.';
COMMENT ON COLUMN rule_domain_map.updated_at IS 'Дата последнего обновления записи.';

-- ======================================================
-- VI. ANALYTICS, AUDIT, TASKS
-- ======================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    user_id INTEGER,
    event_type TEXT CHECK(event_type IN (
        'register', 'login', 'logout', 'refresh',
        'create', 'update', 'delete', 'deploy', 'revoke', 'billing'
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

COMMENT ON TABLE audit_log IS 'Единый журнал действий и авторизаций пользователей системы.';
COMMENT ON COLUMN audit_log.id IS 'Уникальный идентификатор записи.';
COMMENT ON COLUMN audit_log.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN audit_log.user_id IS 'Ссылка на пользователя (users.id).';
COMMENT ON COLUMN audit_log.event_type IS 'Тип события: register, login, logout, refresh, create, update, delete, deploy, revoke, billing.';
COMMENT ON COLUMN audit_log.ip_address IS 'IP-адрес клиента.';
COMMENT ON COLUMN audit_log.user_agent IS 'User-Agent клиента.';
COMMENT ON COLUMN audit_log.details IS 'Дополнительные сведения (JSON: параметры, контекст, ошибки).';
COMMENT ON COLUMN audit_log.role IS 'Роль пользователя в момент выполнения действия.';
COMMENT ON COLUMN audit_log.created_at IS 'Дата и время фиксации события.';

DROP TRIGGER IF EXISTS limit_audit_log;

CREATE TRIGGER limit_audit_log
AFTER INSERT ON audit_log
BEGIN
    DELETE FROM audit_log
    WHERE user_id = NEW.user_id
      AND id NOT IN (
          SELECT id
          FROM audit_log
          WHERE user_id = NEW.user_id
          ORDER BY id DESC
          LIMIT 10
      );
END;

COMMENT ON TRIGGER limit_audit_log IS 'Сохраняет не более 10 последних событий на пользователя.';

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
    account_id INTEGER NOT NULL,
    site_id INTEGER,
    old_domain_id INTEGER NOT NULL,
    new_domain_id INTEGER,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_domain_replacement_log_site_id ON domain_replacement_log(site_id);

COMMENT ON TABLE domain_replacement_log IS 'Журнал замен и блокировок доменов. Фиксирует переходы и причины на уровне сайтов.';
COMMENT ON COLUMN domain_replacement_log.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN domain_replacement_log.site_id IS 'Ссылка на сайт (sites.id), в котором произведена замена домена.';
COMMENT ON COLUMN domain_replacement_log.id IS 'Уникальный идентификатор записи.';
COMMENT ON COLUMN domain_replacement_log.old_domain_id IS 'ID старого (заблокированного) домена.';
COMMENT ON COLUMN domain_replacement_log.new_domain_id IS 'ID нового домена, созданного взамен.';
COMMENT ON COLUMN domain_replacement_log.reason IS 'Причина замены или блокировки (manual, blocked, expired, auto-rotate и т.п.).';
COMMENT ON COLUMN domain_replacement_log.created_at IS 'Дата и время фиксации события.';

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
    task_type TEXT CHECK(task_type IN ('deploy','backup','rotate','sync','analytics','manual')),
    status TEXT CHECK(status IN ('queued','running','done','error')) DEFAULT 'queued',
    details TEXT,                       -- краткое описание действия или ошибки
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_account_id ON tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

COMMENT ON TABLE tasks IS 'Журнал фоновых операций и системных действий (деплой, бэкап, аналитика).';
COMMENT ON COLUMN tasks.task_type IS 'Тип задачи (deploy, backup, rotate, sync, analytics, manual).';
COMMENT ON COLUMN tasks.status IS 'Статус выполнения (queued, running, done, error).';
COMMENT ON COLUMN tasks.details IS 'Описание задачи или сообщение об ошибке.';
COMMENT ON COLUMN tasks.finished_at IS 'Время завершения операции.';

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

-- ======================================================
-- VII. JWT KEYS AND VERSIONING
-- ======================================================

CREATE TABLE IF NOT EXISTS jwt_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kid TEXT UNIQUE NOT NULL,              -- v1-2025-01
    secret_encrypted TEXT NOT NULL,        -- AES-GCM(secret, MASTER_SECRET)
    status TEXT CHECK(status IN ('active','deprecated','revoked')) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jwt_keys_status ON jwt_keys(status);

COMMENT ON TABLE jwt_keys IS 'Версионированные ключи подписи JWT, общие для всей платформы (глобальные).';
COMMENT ON COLUMN jwt_keys.id IS 'Уникальный идентификатор записи ключа.';
COMMENT ON COLUMN jwt_keys.kid IS 'Идентификатор версии ключа (например v1-2025-01).';
COMMENT ON COLUMN jwt_keys.secret_encrypted IS 'Зашифрованный секрет JWT (AES-GCM с MASTER_SECRET).';
COMMENT ON COLUMN jwt_keys.status IS 'Статус ключа: active, deprecated, revoked.';
COMMENT ON COLUMN jwt_keys.created_at IS 'Дата создания ключа.';
COMMENT ON COLUMN jwt_keys.expires_at IS 'Дата окончания срока действия ключа.';


