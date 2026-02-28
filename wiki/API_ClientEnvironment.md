# Client Environment — развёртывание на CF аккаунте клиента

## Концепция

Единый модуль развёртывания клиентского окружения на CF аккаунте. Создаёт все ресурсы за один вызов. Кто первый — тот инициатор (redirect apply, TDS setup, health setup). Проверка по DB301 — моментальная.

**Принцип**: all or nothing. Либо всё создано, либо откат.

---

## Ресурсы на клиентском CF аккаунте

| # | Ресурс | Имя | Назначение |
|---|--------|-----|------------|
| 1 | D1 | `301-client` | Shared DB: domain_list, traffic_stats, threats, TDS rules, stats |
| 2 | KV | `301-keys` | Ключи интеграций (VT_API_KEY и т.д.) |
| 3 | Worker | `301-health` | Мониторинг доменов: VT + phishing + статистика редиректов |
| 4 | Worker | `301-tds` | TDS: маршрутизация по geo/device/utm/bot, MAB |

**НЕ является окружением** (создаётся отдельно):
- CF Redirect Rules (push через CF Rules API, per zone)
- DNS A-records (auto при www-redirect)
- Worker Routes (динамические, per domain)

---

## Архитектура

### Два воркера, одна инфраструктура

```
D1 (301-client) ──shared──┬── 301-health (cron: 0 */12 * * *)
                           │     └─ VT checks, traffic anomalies, phishing
KV (301-keys)  ──shared───┤          └─ POST webhook.301.st/health
                           │
                           └── 301-tds (request-triggered + cron)
                                 └─ geo/device/utm routing, MAB, bot shield
                                      └─ POST webhook.301.st/tds
```

- D1 общая — одна schema, shared таблицы (domain_list, traffic_stats)
- KV общая — ключи интеграций
- Воркеры раздельные — разные шаблоны, разная полезная нагрузка

### Auth: API key (не JWT)

Машинная аутентификация между клиентскими воркерами и webhook.301.st:

```
setupClientEnvironment()
  │
  ├─ nanoid(32) → plain API key
  ├─ SHA-256(key) → hash в DB301.worker_api_keys
  └─ plain key → WORKER_API_KEY secret на оба воркера

Client Worker                         webhook.301.st
     │                                      │
     │  POST /deploy (или /health, /tds)    │
     │  Authorization: Bearer <plain_key>   │
     │  ──────────────────────────────────► │
     │                                      │ SHA-256(key) → lookup в DB301
     │                                      │ → account_id, cf_account_id
     │  ◄────────────────────────────────── │
     │  { ok: true }                        │
```

**Почему не JWT:** JWT протухает (365d TTL), воркер не может обновить свой собственный секрет. API key бессрочный.

**Безопасность:** Plain key хранится ТОЛЬКО в CF Secrets. В DB301 — только SHA-256 хэш.

### Self-check через двойной cron

При деплое worker получает два cron:
```json
["*/1 * * * *", "0 */12 * * *"]
```

1. ≤60 сек — первый trigger от `*/1`
2. Worker проверяет `sync_status.setup_reported` в client D1
3. Если NULL → self-check (D1? KV? secrets?) → `POST webhook.301.st/deploy`
4. Webhook подтверждает → worker записывает `setup_reported = 'ok'` в D1
5. На следующих cron `*/1` — видит `'ok'`, пропускает (no-op)

Self-check проверяет ВСЕ bindings:
- D1: доступ + список таблиц
- KV: запись + чтение + удаление
- Secrets: WORKER_API_KEY, ACCOUNT_ID

---

## Middleware: ensureClientEnvironment

### Логика

```
ensureClientEnvironment(env, accountId, cfAccountId, cfToken)
  │
  ├─ SELECT client_env FROM account_keys WHERE account_id = ? AND status = 'active'
  │
  ├─ client_env.ready === true? ─── YES ──→ return OK (моментально)
  │
  └─ NO ──→ setupClientEnvironment()
             ├─ 1. CREATE D1 (301-client) + schema (IF NOT EXISTS)
             ├─ 2. CREATE KV (301-keys)
             ├─ 3. Generate API key (nanoid 32) → SHA-256 hash → DB301
             ├─ 4. DEPLOY 301-health + secrets + crons [*/1, 0 */12]
             ├─ 5. DEPLOY 301-tds + secrets
             ├─ 6. Initial sync: domains → D1.domain_list
             ├─ 7. UPDATE account_keys SET client_env = {..., ready: true}
             └─ return OK

             Любой шаг fail → откат всего, return ERROR
```

### Где вызывается

| Entry point | Когда |
|-------------|-------|
| `POST /integrations/cloudflare/init` | При создании CF интеграции (основной путь) |
| `POST /zones/:id/apply-redirects` | Первый apply редиректов (fallback для старых аккаунтов) |
| `POST /tds/rules` | Первое создание TDS правила |
| `POST /health/client/setup` | Ручной setup здоровья |

### Проверка — моментальная

```sql
SELECT client_env FROM account_keys
WHERE account_id = ? AND provider = 'cloudflare' AND status = 'active'
```

`client_env` — JSON поле, уже есть в таблице. Содержит:
```json
{
  "d1_id": "uuid",
  "kv_id": "uuid",
  "health_worker": true,
  "tds_worker": true,
  "ready": true
}
```

Если `ready: true` — middleware пропускает. Один SELECT, ~1ms.

---

## API Endpoints (api.301.st)

| Method | Path | Назначение |
|--------|------|------------|
| POST | `/client-env/setup` | Ручное создание окружения |
| DELETE | `/client-env` | Удаление окружения (все ресурсы на CF клиента) |
| GET | `/client-env/status` | Статус окружения (`?live=true` — проверка на CF) |

---

## Webhook Endpoints (webhook.301.st)

Три раздельных endpoint'а, единая auth через API key:

| # | Method | Path | От кого | Назначение |
|---|--------|------|---------|------------|
| 1 | POST | `/deploy` | оба воркера | Self-check после деплоя |
| 2 | POST | `/health` | 301-health | Статистика редиректов + VT threats + phishing |
| 3 | POST | `/tds` | 301-tds | Статистика TDS (stats_hourly, mab_stats) |

### Auth (общая для всех)

```
Authorization: Bearer <WORKER_API_KEY>
```

Webhook:
1. Извлекает key из заголовка
2. SHA-256 hash
3. Lookup в `DB301.worker_api_keys` → `account_id`, `cf_account_id`
4. Валидация `account_id` из payload

Реализация: `src/webhook/auth.ts` → `verifyApiKey()`

### POST /deploy

```json
// Request
{
  "type": "setup_ok",
  "worker_name": "301-health",
  "account_id": 19,
  "checks": {
    "d1": true,
    "kv": true,
    "tables": ["domain_list", "traffic_stats", "domain_threats", "tds_rules"],
    "secrets": ["WORKER_API_KEY", "ACCOUNT_ID"]
  },
  "timestamp": "2026-02-26T12:00:00Z"
}

// Response
{ "ok": true, "status": "acknowledged" }
```

### POST /health

```json
// Request
{
  "account_id": "19",
  "timestamp": "2026-02-26T12:00:00Z",
  "zones": [
    { "zone_id": "abc123", "phishing_detected": true, "checked_at": "..." }
  ],
  "threats": [
    {
      "domain_name": "example.com",
      "threat_score": 3,
      "categories": ["gambling", "spam"],
      "reputation": -15,
      "source": "virustotal",
      "checked_at": "..."
    }
  ]
}

// Response
{
  "ok": true,
  "result": {
    "zones_processed": 1,
    "domains_blocked": 5,
    "threats_upserted": 10,
    "errors": []
  }
}
```

### POST /tds (TODO)

Приём статистики TDS от 301-tds worker. Структура — TBD.

---

## Откат (all or nothing)

| Шаг упал | Откат |
|----------|-------|
| D1 create | Ничего не создано, return error |
| KV create | Удалить D1 |
| Health deploy | Удалить KV, D1 |
| TDS deploy | Удалить Health worker, KV, D1 |
| Domain sync | НЕ откатывает (non-fatal) |
| DB write | Удалить всё на CF, return error |

---

## Единый источник правды

Все константы: `src/api/client-env/setup.ts`

| Параметр | Значение |
|----------|----------|
| Health worker name | `301-health` |
| TDS worker name | `301-tds` |
| D1 name | `301-client` |
| KV name | `301-keys` |
| Health WEBHOOK_URL | `https://webhook.301.st/health` |
| Deploy WEBHOOK_URL | `https://webhook.301.st/deploy` |
| TDS API_URL | `https://api.301.st` |
| Health cron (рабочий) | `0 */12 * * *` |
| Health cron (init) | `*/1 * * * *` |
| API key length | 32 (nanoid) |

---

## Структура кода

### Файлы (api.301.st)

| Файл | Содержание |
|------|------------|
| `src/api/client-env/setup.ts` | `setupClientEnvironment()` — полный setup (all-or-nothing) |
| `src/api/client-env/teardown.ts` | `teardownClientEnvironment()` — удаление всех ресурсов |
| `src/api/client-env/status.ts` | `getClientEnvStatus()` — проверка состояния |
| `src/api/client-env/middleware.ts` | `ensureClientEnvironment()` — fast check + setup |
| `src/api/client-env/index.ts` | Router: POST /setup, DELETE /, GET /status |
| `src/api/health/bundle.ts` | Bundled JS для 301-health worker |
| `src/api/tds/bundle.ts` | Bundled JS для 301-tds worker |

### Файлы (webhook.301.st)

| Файл | Содержание |
|------|------------|
| `src/webhook/auth.ts` | `verifyApiKey()` — shared auth (SHA-256 + DB301 lookup) |
| `src/webhook/deploy.ts` | POST /deploy — self-check от воркеров |
| `src/webhook/health.ts` | POST /health — VT threats + phishing zones |
| `src/webhook/index.ts` | Hono router |
