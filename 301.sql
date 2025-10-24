-- ======================================================
-- 301.st — Cloudflare Redirect Management Platform
-- Database Schema (Cloudflare D1 SQL version)
-- ======================================================

-- ======================================================
-- I. USERS AND AUTHENTICATION
-- ======================================================
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    google_sub TEXT,
    name TEXT,
    role TEXT DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE users IS 'Таблица учётных записей пользователей платформы 301.st (Classic и OAuth).';
COMMENT ON COLUMN users.id IS 'Уникальный идентификатор пользователя.';
COMMENT ON COLUMN users.email IS 'Email пользователя, используется для входа.';
COMMENT ON COLUMN users.password_hash IS 'Хэш пароля, если используется Classic Auth.';
COMMENT ON COLUMN users.google_sub IS 'Идентификатор пользователя в Google OAuth (sub).';
COMMENT ON COLUMN users.name IS 'Имя пользователя или название организации.';
COMMENT ON COLUMN users.role IS 'Роль в системе (user, admin).';
COMMENT ON COLUMN users.created_at IS 'Дата создания учётной записи.';
COMMENT ON COLUMN users.updated_at IS 'Дата последнего обновления записи.';

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    refresh_id TEXT UNIQUE,
    ip_address TEXT,
    user_agent TEXT,
    revoked INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);
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
CREATE TABLE accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_name TEXT NOT NULL,
    cf_account_id TEXT,
    plan TEXT DEFAULT 'free',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE accounts IS 'Учётные записи клиентов (тенанты) с параметрами и тарифным планом.';
COMMENT ON COLUMN accounts.id IS 'Уникальный идентификатор аккаунта.';
COMMENT ON COLUMN accounts.user_id IS 'Ссылка на владельца аккаунта (users.id).';
COMMENT ON COLUMN accounts.account_name IS 'Название клиента или организации.';
COMMENT ON COLUMN accounts.cf_account_id IS 'ID аккаунта Cloudflare, связанного с этим клиентом.';
COMMENT ON COLUMN accounts.plan IS 'Тарифный план (free, pro, enterprise).';
COMMENT ON COLUMN accounts.created_at IS 'Дата создания аккаунта.';
COMMENT ON COLUMN accounts.updated_at IS 'Дата последнего обновления записи.';

CREATE TABLE account_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    key_alias TEXT,
    kv_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    expires_at TIMESTAMP,
    last_used TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE account_keys IS 'API-ключи пользователей (Cloudflare, Namecheap, HostTracker и др.), зашифрованные и сохранённые в KV.';
COMMENT ON COLUMN account_keys.id IS 'Уникальный идентификатор ключа.';
COMMENT ON COLUMN account_keys.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN account_keys.provider IS 'Провайдер (cloudflare, namecheap, hosttracker и др.).';
COMMENT ON COLUMN account_keys.key_alias IS 'Псевдоним ключа, заданный пользователем.';
COMMENT ON COLUMN account_keys.kv_key IS 'Ключ записи в KV-хранилище с зашифрованным значением.';
COMMENT ON COLUMN account_keys.status IS 'Статус ключа (active, revoked).';
COMMENT ON COLUMN account_keys.expires_at IS 'Срок действия ключа, если ограничен.';
COMMENT ON COLUMN account_keys.last_used IS 'Дата последнего использования ключа.';
COMMENT ON COLUMN account_keys.created_at IS 'Дата добавления ключа в систему.';

-- ======================================================
-- III. PROJECTS AND DOMAINS
-- ======================================================
CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE projects IS 'Проекты клиента — логические контейнеры для доменов и редиректов.';
COMMENT ON COLUMN projects.id IS 'Уникальный идентификатор проекта.';
COMMENT ON COLUMN projects.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN projects.project_name IS 'Название проекта, отображаемое в UI.';
COMMENT ON COLUMN projects.description IS 'Описание проекта или его назначения.';
COMMENT ON COLUMN projects.created_at IS 'Дата создания проекта.';
COMMENT ON COLUMN projects.updated_at IS 'Дата последнего изменения.';

CREATE TABLE domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    project_id INTEGER,
    domain_name TEXT NOT NULL,
    registrar TEXT,
    cf_zone_id TEXT,
    ns_required TEXT,
    ns_status TEXT DEFAULT 'pending',
    ns_verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE domains IS 'Список доменов клиента с привязкой к Cloudflare и статусом NS.';
COMMENT ON COLUMN domains.id IS 'Уникальный идентификатор домена.';
COMMENT ON COLUMN domains.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN domains.project_id IS 'Ссылка на проект (projects.id).';
COMMENT ON COLUMN domains.domain_name IS 'Полное доменное имя (FQDN).';
COMMENT ON COLUMN domains.registrar IS 'Регистратор, у которого приобретён домен.';
COMMENT ON COLUMN domains.cf_zone_id IS 'ID зоны Cloudflare, созданной для домена.';
COMMENT ON COLUMN domains.ns_required IS 'Список NS-записей, требуемых Cloudflare.';
COMMENT ON COLUMN domains.ns_status IS 'Текущий статус NS-записей (pending, verified, error).';
COMMENT ON COLUMN domains.ns_verified_at IS 'Дата последней успешной проверки NS.';
COMMENT ON COLUMN domains.created_at IS 'Дата добавления домена в систему.';

CREATE TABLE zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    domain_id INTEGER NOT NULL,
    zone_id TEXT NOT NULL,
    ssl_mode TEXT DEFAULT 'full',
    proxied INTEGER DEFAULT 1,
    plan TEXT,
    cf_status TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE zones IS 'Зоны Cloudflare, связанные с доменами, включая SSL и proxy-настройки.';
COMMENT ON COLUMN zones.id IS 'Уникальный идентификатор зоны.';
COMMENT ON COLUMN zones.account_id IS 'Ссылка на аккаунт (accounts.id).';
COMMENT ON COLUMN zones.domain_id IS 'Ссылка на домен (domains.id).';
COMMENT ON COLUMN zones.zone_id IS 'Идентификатор зоны в Cloudflare API.';
COMMENT ON COLUMN zones.ssl_mode IS 'Режим SSL (off, flexible, full, strict).';
COMMENT ON COLUMN zones.proxied IS 'Флаг использования Cloudflare Proxy (1=включено).';
COMMENT ON COLUMN zones.plan IS 'Тариф Cloudflare для зоны.';
COMMENT ON COLUMN zones.cf_status IS 'Текущий статус зоны в Cloudflare (active, pending и т.п.).';
COMMENT ON COLUMN zones.created_at IS 'Дата создания записи зоны.';

CREATE TABLE zone_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id INTEGER NOT NULL,
    auto_https INTEGER DEFAULT 1,
    caching_level TEXT DEFAULT 'standard',
    waf_mode TEXT DEFAULT 'medium',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE zone_settings IS 'Индивидуальные настройки зон Cloudflare (HTTPS, кеширование, WAF).';
COMMENT ON COLUMN zone_settings.id IS 'Уникальный идентификатор записи настроек.';
COMMENT ON COLUMN zone_settings.zone_id IS 'Ссылка на зону (zones.id).';
COMMENT ON COLUMN zone_settings.auto_https IS 'Флаг включения автоматического HTTPS (Always Use HTTPS).';
COMMENT ON COLUMN zone_settings.caching_level IS 'Режим кеширования (basic, standard, aggressive).';
COMMENT ON COLUMN zone_settings.waf_mode IS 'Уровень защиты WAF (off, low, medium, high).';
COMMENT ON COLUMN zone_settings.updated_at IS 'Дата последнего изменения настроек.';

