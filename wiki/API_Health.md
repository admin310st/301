# Health API

## Базовый URL

```
https://api.301.st
```

> **Концепция и архитектура:** см. [Health_Check](Health_Check)
> **Клиентское окружение:** см. [API_ClientEnvironment](API_ClientEnvironment)

---

## Обзор

API для системы мониторинга здоровья доменов. Три уровня:

1. **301.st API** — endpoints для UI (JWT auth)
2. **Webhook** (`webhook.301.st`) — приём данных от Client Worker (API key auth)
3. **Client Worker** — локальные endpoints на клиентском CF аккаунте

---

## 1. 301.st API Endpoints

### GET /domains

Список доменов с `health.status` в ответе.

**Auth:** `Authorization: Bearer <access_token>`

Поле `health` в каждом домене содержит светофор:

| Значение | Условие |
|----------|---------|
| `danger` | `blocked = 1` |
| `warning` | `threat_score > 0` OR traffic anomaly |
| `ok` | Всё в порядке |
| `unknown` | Нет данных |

---

### GET /domains/:id/health

Детальная информация о здоровье домена.

**Auth:** `Authorization: Bearer <access_token>`

**Ответ:**

```json
{
  "status": "warning",
  "blocked": false,
  "blocked_reason": null,
  "ssl_status": "active",
  "threats": {
    "score": 3,
    "categories": ["gambling"],
    "reputation": -15,
    "source": "virustotal",
    "checked_at": "2025-01-15T09:55:00Z"
  },
  "traffic": {
    "yesterday": 150,
    "today": 45,
    "change_percent": -70,
    "anomaly": true,
    "anomaly_type": "drop_90"
  },
  "phishing_status": "clean",
  "phishing_checked_at": "2025-01-15T02:00:00Z"
}
```

**Поля:**

| Поле | Тип | Описание |
|------|-----|----------|
| `status` | `blocked\|warning\|healthy\|unknown` | Общий статус здоровья |
| `blocked` | `boolean` | Домен заблокирован |
| `blocked_reason` | `string\|null` | Причина блокировки (`phishing`, etc.) |
| `ssl_status` | `string\|null` | Статус SSL сертификата из CF |
| `threats` | `object\|null` | Данные об угрозах (VT/CF Intel), `null` если нет VT key |
| `traffic.yesterday` | `number` | Клики за вчера (сумма по redirect_rules домена) |
| `traffic.today` | `number` | Клики за сегодня |
| `traffic.change_percent` | `number` | Изменение в % (today vs yesterday) |
| `traffic.anomaly` | `boolean` | Обнаружена аномалия трафика |
| `traffic.anomaly_type` | `drop_50\|drop_90\|zero_traffic\|null` | Тип аномалии |
| `phishing_status` | `clean\|detected\|null` | Результат phishing-проверки (`null` = never checked) |
| `phishing_checked_at` | `string\|null` | Время последней phishing-проверки (ISO 8601) |

**Источники данных трафика:**

Статистика собирается кроном из CF GraphQL Analytics API (`httpRequestsAdaptiveGroups`, фильтр `edgeResponseStatus_in: [301,302,307,308]`, группировка по `clientRequestHTTPHost`). Данные записываются в `redirect_rules.clicks_yesterday/clicks_today`, суммируются по домену в health endpoint.

**Phishing-проверка:**

Запускается автоматически кроном при обнаружении серьёзной аномалии трафика (`drop_90` или `zero_traffic`). Вызывает CF API `meta.phishing_detected` для зоны. Результат записывается в `domains.phishing_status` и `domains.phishing_checked_at`.
```

---

### POST /health/client/setup

Ручной setup Client Health Worker.

**Auth:** `Authorization: Bearer <access_token>` (editor/owner)

> Обычно вызывается автоматически через `ensureClientEnvironment()`.
> См. [API_ClientEnvironment](API_ClientEnvironment) для полного описания setup flow.

---

### GET /health/client/status

Статус настройки клиентского окружения для health.

**Auth:** `Authorization: Bearer <access_token>`

---

### POST /integrations/virustotal/init

Сохранить VT API key в клиентском KV.

**Auth:** `Authorization: Bearer <access_token>` (editor/owner)

---

### GET /integrations/virustotal/quota

Проверить текущее использование VT квоты.

**Auth:** `Authorization: Bearer <access_token>`

---

## 2. Webhook Endpoints (webhook.301.st)

Приём данных от Client Worker. Auth через API key (SHA-256 hash lookup в DB301).

### POST /health

Данные мониторинга: VT threats.

**Auth:** `Authorization: Bearer <WORKER_API_KEY>`

**Request:**

```json
{
  "account_id": "19",
  "timestamp": "2025-01-15T10:00:00Z",
  "threats": [
    {
      "domain_name": "example.com",
      "threat_score": 3,
      "categories": ["gambling", "spam"],
      "reputation": -15,
      "source": "virustotal",
      "checked_at": "2025-01-15T09:55:00Z"
    }
  ]
}
```

**Response:**

```json
{
  "ok": true,
  "result": {
    "threats_upserted": 10,
    "errors": []
  }
}
```

**Обработка:**

```mermaid
flowchart TB
    A[POST /health] --> B[SHA-256 hash API key]
    B --> C[Lookup hash in DB301]
    C --> D{Found?}
    D -->|No| E[401 invalid_api_key]
    D -->|Yes| F[account_id from DB]
    F --> G[Validate account_id match]
    G --> H[Process threats → UPSERT domain_threats]
    I --> J[Return result]
```

### POST /deploy

Self-check после деплоя воркера.

**Auth:** `Authorization: Bearer <WORKER_API_KEY>`

> Подробности: см. [API_ClientEnvironment](API_ClientEnvironment#post-deploy)

---

## 3. Client Worker API (301-health)

Endpoints на клиентском CF аккаунте. Доступны по URL воркера `301-health`.

### GET /health

Health check (public). Проверяет, что воркер работает.

### POST /run

Manual trigger проверок (VT + phishing).

### GET /stats

Статистика очереди проверок.

---

## 4. Bindings (Client Worker)

| Тип | Имя | Назначение |
|-----|-----|------------|
| Secret | `WORKER_API_KEY` | Auth для webhook → 301.st (nanoid 32, бессрочный) |
| Env Var | `ACCOUNT_ID` | ID аккаунта в 301.st |
| Env Var | `WEBHOOK_URL` | `https://webhook.301.st/health` |
| Env Var | `DEPLOY_WEBHOOK_URL` | `https://webhook.301.st/deploy` |
| D1 | `DB` | Client D1 database (301-client) |
| KV | `KV` | Integration keys (VT_API_KEY, etc.) (301-keys) |

---

## 5. UI: Проверка статуса клиентского окружения

**Health Check работает ТОЛЬКО если клиентское окружение настроено.**

UI проверяет поле `client_env` в ключах CF перед отображением health-функций.

### Проверка готовности

```mermaid
flowchart TB
    A[UI загружает ключи] --> B{CF ключ есть?}
    B -->|Нет| C[Показать: Добавьте CF ключ]
    B -->|Да| D{client_env заполнен?}
    D -->|Нет| E[Показать: Окружение не настроено]
    D -->|Да| F{health_worker = true?}
    F -->|Нет| G[Показать: Health Worker не задеплоен]
    F -->|Да| H[Health Check активен]
```

### GET /integrations/keys — поле client_env

```json
{
  "id": 18,
  "provider": "cloudflare",
  "client_env": "{\"d1_id\":\"xxx\",\"kv_id\":\"yyy\",\"health_worker\":true}"
}
```

### Зависимости функций от client_env

| Функция | Требует client_env | Без client_env |
|---------|-------------------|----------------|
| GET /domains | Нет | Работает |
| GET /domains/:id/health | Да | Частичные данные (только blocked) |
| Webhook /health | Да | 401/403 |
| VT проверки | Да (kv_id для VT key) | Не работают |
| Traffic anomaly detection | Да | Не работает |

---

## 6. Таблица endpoints

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/domains` | GET | JWT | Список доменов с health.status |
| `/domains/:id/health` | GET | JWT | Детальная информация |
| `/health/client/setup` | POST | editor | Setup Client Worker |
| `/health/client/status` | GET | JWT | Статус настройки |
| `/integrations/virustotal/init` | POST | editor | Сохранить VT ключ |
| `/integrations/virustotal/quota` | GET | JWT | VT квота |
| `webhook.301.st/health` | POST | API key | Данные от Health Worker |
| `webhook.301.st/deploy` | POST | API key | Self-check результат |
| Client: `/health` | GET | public | Health check воркера |
| Client: `/run` | POST | — | Manual trigger |
| Client: `/stats` | GET | — | Queue statistics |
