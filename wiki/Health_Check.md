# Domain Health Check System

## Цель

Информирование клиента о проблемах с трафиком и минимальных угрозах для принятия решений о ротации.

**301.st = управление доменами, не система мониторинга.**

> **API endpoints:** см. [API_Health](API_Health)
> **Клиентское окружение:** см. [API_ClientEnvironment](API_ClientEnvironment)

---

## Архитектура (Push Model)

```mermaid
flowchart TB
    subgraph "301.st Backend"
        POLL[Cron 1x/сутки]
        WH[Webhook receiver]
        DOM[(domains<br>blocked, blocked_reason)]
        THR[(domain_threats<br>VT/Intel оценки)]

        POLL -->|GraphQL redirects| DOM
        POLL -->|anomaly?| ZONES_CHECK[Check zones phishing]
        ZONES_CHECK --> DOM
        WH -->|Verify API key| PROCESS[Process data]
        PROCESS --> DOM
        PROCESS --> THR
    end

    subgraph "CF Account Client (автономно)"
        DT[(domain_threats<br>VT results)]
        Q[(threat_check_queue)]
        W[Worker]
        CR[Cron 2x+/сутки]

        CR --> W
        W --> Q
        W -->|VT API| DT
        W -->|POST /health| WH
    end

    subgraph "External APIs"
        GQL[CF GraphQL]
        VT[VirusTotal API]
        ZONES[CF Zones API]
    end

    POLL -->|1x/сутки| GQL
    ZONES_CHECK --> ZONES
    W -->|по очереди| VT
    W -->|по триггеру| ZONES
```

### Push Model — аутентификация через API key

```
Client Worker                              301.st Webhook
     │                                           │
     │  POST /health                             │
     │  Authorization: Bearer <WORKER_API_KEY>   │
     │  Body: { zones, threats }    ───────────► │
     │                                           │ SHA-256(key) → DB301 lookup
     │                                           │ → account_id
     │                                           │ Process data
     │  ◄─────────────────────────────────────── │
     │  { ok: true, result: {...} }              │
     │                                           │
```

**Безопасность:**
- API key генерируется при setup (nanoid 32)
- В DB301 хранится только SHA-256 хэш
- Plain key — только в CF Secrets на клиентском аккаунте
- API key бессрочный (не протухает как JWT)
- Shared auth для всех webhook: `src/webhook/auth.ts`

---

## Разделение ответственности

| Где | Действие | Частота |
|-----|----------|---------|
| **301.st** | Poll GraphQL redirects | 1x/сутки |
| **301.st** | Проверить zones phishing | По триггеру (anomaly) |
| **301.st** | Принять webhook данные | По событию |
| **301.st** | Хранить итоговые данные | — |
| **Клиент** | Проверить zones phishing | По триггеру (anomaly) |
| **Клиент** | Запросить VT | По очереди (cron) |
| **Клиент** | Отправить данные в webhook | После проверок |

**301.st и Client работают автономно.** Нет взаимных триггеров.

---

## Источники данных

| # | Источник | Тип | Где выполняется |
|---|----------|-----|-----------------|
| 1 | CF Phishing | ФАКТ | 301.st + Client |
| 2 | Traffic Anomaly | СИГНАЛ | 301.st (cron `updateRedirectStats`) |
| 3 | VirusTotal | ОЦЕНКА | Client |
| 4 | HostTracker | ДОСТУПНОСТЬ | Future |

---

## Redirect Stats Pipeline → Health

Данные для оценки здоровья доменов по трафику поступают из pipeline сбора статистики редиректов.

### Расписание

Крон `updateRedirectStats` запускается ежедневно в **02:00 UTC** (`src/api/jobs/redirect-stats.ts`).

### Как работает pipeline

1. Получает все зоны с активными редиректами (JOIN `zones` + `redirect_rules`)
2. Для каждой зоны расшифровывает CF token через `getDecryptedKey(env, key_id)`
3. Вызывает CF GraphQL API `httpRequestsAdaptiveGroups` за вчерашний день (полные сутки 00:00–23:59 UTC)
4. Фильтр: `edgeResponseStatus_in: [301, 302, 307, 308]`, группировка по `clientRequestHTTPHost`
5. Маппит host → domain_id через таблицу `domains`
6. Обновляет `redirect_rules`: `clicks_total += count`, `clicks_yesterday = clicks_today`, `clicks_today = count`
7. Для доменов без данных — ротация: `clicks_yesterday = clicks_today`, `clicks_today = 0`
8. Проверяет аномалии: `detectAnomaly(clicks_today_old, new_count)` — сравнивает N-2 vs N-1
9. При серьёзной аномалии (`drop_90`, `zero_traffic`) — проверка phishing через CF Zone API

### Семантика полей в redirect_rules

| Поле | Описание |
|------|----------|
| `clicks_total` | Накопительный счётчик (всегда растёт) |
| `clicks_today` | Данные за **последний обработанный день** (N-1), НЕ за текущий день |
| `clicks_yesterday` | Данные за **позавчера** (N-2), для сравнения с clicks_today |
| `last_counted_date` | Дата последнего обновления (idempotency guard) |

### Как health использует эти данные

`GET /domains/:id/health` (`src/api/domains/health.ts`) читает `clicks_yesterday` и `clicks_today` из `redirect_rules` и вызывает `detectAnomaly(yesterday, today)`:

| Аномалия | Условие | Действие |
|----------|---------|----------|
| `zero_traffic` | today = 0, yesterday >= 20 | Health status = warning, phishing check |
| `drop_90` | today < yesterday * 0.1 | Health status = warning, phishing check |
| `drop_50` | today < yesterday * 0.5 | Health status = warning (без phishing check) |

`shouldCheckPhishing(anomaly)` возвращает `true` для `zero_traffic` и `drop_90` — при этих аномалиях pipeline автоматически вызывает `checkZonePhishing()` через CF Zone API. Если phishing подтверждён — все домены зоны блокируются (`blocked = 1, blocked_reason = 'phishing'`).

### Светофор: computeDomainHealthStatus

Функция `computeDomainHealthStatus()` определяет цвет индикатора в списке доменов:

| Приоритет | Условие | Результат |
|-----------|---------|-----------|
| 1 | `blocked = 1` | `blocked` (красный) |
| 2 | `threat_score > 0` | `warning` (жёлтый) |
| 3 | `drop_90` или `zero_traffic` | `warning` (жёлтый) |
| 4 | `threat_score !== null` | `healthy` (зелёный) |
| 5 | нет данных | `unknown` (серый) |

### GraphQL: требуемые permissions

Для запроса статистики необходимо permission **Analytics Read** (zone scope, id: `9c88f9c5bce24ce7af9a958ba9c504db`). Без этого permission GraphQL вернёт ошибку авторизации. Permission входит в обязательный набор (34 шт.) рабочего токена.

---

## Cron Flow (Client Worker)

```mermaid
flowchart TB
    A[Cron trigger] --> B[Get active domains]
    B --> C[Detect traffic anomalies]
    C --> D{Anomaly?}
    D -->|drop_90/zero| E[Check CF Phishing]
    D -->|No| F[Continue]
    E --> F
    F --> G[Add domains to VT queue]
    G --> H[Process VT queue]
    H --> I[Send webhook to 301.st]
    I --> J[Mark threats as synced]
```

---

## Схема БД

### 301.st — domain_threats

```sql
CREATE TABLE domain_threats (
    domain_id INTEGER PRIMARY KEY,
    threat_score INTEGER,
    categories TEXT,        -- JSON: ["gambling", "spam"]
    reputation INTEGER,     -- -100 to +100
    source TEXT,            -- 'virustotal' | 'cloudflare_intel'
    checked_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);
```

### Client D1

```sql
-- VT results
CREATE TABLE domain_threats (
    domain_name TEXT PRIMARY KEY,
    threat_score INTEGER,
    categories TEXT,
    reputation INTEGER,
    source TEXT,
    checked_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT
);

-- Queue
CREATE TABLE threat_check_queue (
    domain_name TEXT PRIMARY KEY,
    priority INTEGER DEFAULT 0,
    source TEXT DEFAULT 'virustotal',
    added_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'
);
```

---

## VirusTotal Integration

### Rate Limits (Free Tier)

| Лимит | Значение |
|-------|----------|
| Requests/min | 4 |
| Requests/day | 500 |

### VT API Response

```json
{
  "last_analysis_stats": {
    "malicious": 3,
    "suspicious": 1,
    "harmless": 65
  },
  "categories": {
    "Forcepoint": "gambling",
    "Sophos": "spam"
  },
  "reputation": -15
}
```

---

## Data Sync (Push Model)

### Initial Sync

При `POST /integrations/cloudflare/init`:
1. Создаётся client environment (D1, KV, Worker)
2. Все домены аккаунта синхронизируются в client D1

### Auto-Sync

| Событие | Sync действие |
|---------|---------------|
| Создание домена | `syncDomainToClient()` |
| Batch создание | `syncDomainToClient()` для каждого |
| Изменение role/blocked | `syncDomainToClient()` |
| Удаление домена | `deleteDomainFromClient()` |

### Client D1 Schema (domain_list)

```sql
CREATE TABLE domain_list (
    domain_name TEXT PRIMARY KEY,
    role TEXT,
    zone_id TEXT,
    active INTEGER DEFAULT 1,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

---

## UI: Светофор

### Таблица доменов

| Цвет | Условие |
|------|---------|
| 🔴 | `blocked = 1` |
| 🟡 | `threat_score > 0` OR traffic anomaly |
| 🟢 | Всё OK |
| ⚪ | Нет данных |

### Пример ответа GET /domains/:id/health

```json
{
  "status": "warning",
  "blocked": false,
  "blocked_reason": null,
  "threats": {
    "score": 3,
    "categories": ["gambling"],
    "source": "virustotal",
    "checked_at": "2025-01-15T09:55:00Z"
  },
  "traffic": {
    "yesterday": 150,
    "today": 45,
    "change_percent": -70,
    "anomaly": true
  }
}
```

---

## Будущее развитие

### Cloudflare Intel

Структура `domain_threats` готова для CF Intel:

| Поле | VT | CF Intel |
|------|-----|----------|
| `threat_score` | malicious count | security_categories count |
| `categories` | VT categories | content_categories |
| `reputation` | VT reputation | popularity_rank |
| `source` | 'virustotal' | 'cloudflare_intel' |

### Дополнительные источники

- **HostTracker** — мониторинг доступности доменов (ping, HTTP check)
- **CF Security Events** — WAF events, DDoS incidents
- **Domain Expiry** — предупреждение об истечении срока регистрации
- **SSL/TLS** — статус сертификатов, expiry warnings

---

## Реализованные файлы

| Файл | Назначение |
|------|------------|
| `schema/migrations/0009_health_check.sql` | Миграция: таблица `domain_threats` |
| `schema/migrations/0015_worker_api_keys.sql` | Миграция: таблица `worker_api_keys` |
| `schema/migrations/0016_hash_worker_api_keys.sql` | Миграция: `api_key` → `api_key_hash` |
| `src/api/domains/health.ts` | GET /domains/:id/health |
| `src/api/integrations/providers/cloudflare/d1.ts` | D1 API для клиента |
| `src/api/integrations/providers/cloudflare/d1-sync.ts` | Domain sync to client |
| `src/api/integrations/providers/virustotal/initkey.ts` | VT key init |
| `src/api/health/setup.ts` | POST /health/client/setup |
| `src/api/health/bundle.ts` | Bundled JS для 301-health worker |
| `src/api/jobs/redirect-stats.ts` | Anomaly detection |
| `src/api/client-env/setup.ts` | setupClientEnvironment() |
| `src/webhook/auth.ts` | Shared auth: API key → SHA-256 → DB301 |
| `src/webhook/health.ts` | POST /health handler |
| `src/webhook/deploy.ts` | POST /deploy handler |
