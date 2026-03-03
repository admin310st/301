# TDS API

## Базовый URL

```
https://api.301.st
```

---

## Обзор

Управление Traffic Distribution System (TDS) — правила перенаправления трафика на edge (Cloudflare Workers).

**Ключевые концепции:**
- **Rule** — правило TDS с условиями и действием, привязанное к сайту (`site_id`)
- **Preset** — шаблон для быстрого создания правил (S1-S5, L1-L3)
- **Site Binding** — правило привязано к сайту через `site_id` FK; целевой домен определяется неявно: `sites → domains(role='acceptor')`. См. [ADR-001](decisions/ADR-001-tds-site-scoped-rules.md)
- **Sync** — Client Worker тянет правила через `/tds/sync` (pull model)
- **MAB** — Multi-Armed Bandits: A/B-тест с автоматической оптимизацией

**Архитектура:**
```
CRUD в D1 (tds.ts)  →  Sync по запросу Client Worker (sync.ts)  →  Edge execution
```

**Два типа TDS:**
| tds_type | Назначение |
|----------|------------|
| `traffic_shield` | Защита трафика: боты, гео-фильтры, device routing |
| `smartlink` | Smart-ссылки: UTM split, источники трафика, MAB |

---

## 1. GET /tds/presets

Список доступных пресетов для быстрого создания правил.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/tds/presets" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "presets": [
    {
      "id": "S1",
      "name": "Bot Shield",
      "description": "Блокировка или редирект ботов",
      "category": "smartshield",
      "tds_type": "traffic_shield",
      "params": [
        {
          "key": "action",
          "label": "Действие",
          "type": "select",
          "required": true,
          "options": ["redirect", "block"]
        },
        {
          "key": "action_url",
          "label": "URL редиректа",
          "type": "url",
          "required": false,
          "placeholder": "https://safe-page.com"
        }
      ],
      "defaultPriority": 10
    }
  ]
}
```

**Доступные пресеты:**

### SmartShield (traffic_shield)

| ID | Название | Описание | Params | Priority |
|----|----------|----------|--------|----------|
| S1 | Bot Shield | Блокировка/редирект ботов | `action`, `action_url` | 10 |
| S2 | Geo Filter | Гео-таргетинг | `geo[]`, `action_url` | 50 |
| S3 | Mobile Redirect | Редирект мобильных | `action_url` | 40 |
| S4 | Desktop Redirect | Редирект десктопа | `action_url` | 40 |
| S5 | Geo + Mobile | Гео + мобильные | `geo[]`, `action_url` | 30 |

### SmartLink (smartlink)

| ID | Название | Описание | Params | Priority |
|----|----------|----------|--------|----------|
| L1 | UTM Split | Сплит по utm_source | `utm_source[]`, `action_url` | 50 |
| L2 | Facebook Traffic | Facebook/Meta трафик (utm OR fbclid) | `action_url` | 40 |
| L3 | Google Traffic | Google Ads трафик (utm OR gclid) | `action_url` | 40 |

---

## 2. GET /tds/params

Список доступных параметров условий (для UI: справочник полей).

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/tds/params" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "params": [
    {
      "param_key": "geo",
      "category": "conditions",
      "description": "Country code (ISO 3166-1 alpha-2)"
    },
    {
      "param_key": "device",
      "category": "conditions",
      "description": "Device type: mobile, desktop, any"
    }
  ]
}
```

---

## 3. GET /tds/rules

Список всех TDS-правил аккаунта.

**Требует:** `Authorization: Bearer <access_token>`

**Query-параметры (опциональные):**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `site_id` | number | Фильтр по сайту |

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/tds/rules?site_id=5" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "rules": [
    {
      "id": 1,
      "rule_name": "Bot Shield",
      "tds_type": "traffic_shield",
      "logic_json": {
        "conditions": { "bot": true },
        "action": "block",
        "action_url": null,
        "status_code": 302,
        "algorithm": "thompson_sampling",
        "variants": null
      },
      "priority": 10,
      "status": "active",
      "preset_id": "S1",
      "site_id": 5,
      "site_name": "My Offer Site",
      "acceptor_domain": "example.com",
      "sync_status": "applied",
      "created_at": "2026-01-15T10:30:00Z",
      "updated_at": "2026-01-15T10:30:00Z"
    }
  ],
  "total": 5
}
```

> **Сортировка:** `priority DESC`, затем `id ASC`.
> **site_name** — название сайта, к которому привязано правило.
> **acceptor_domain** — домен-акцептор сайта (`domains.role='acceptor'`).
> **sync_status** — статус синхронизации правила: `pending`, `applying`, `applied`, `failed`.

---

## 4. GET /tds/rules/:id

Детали правила.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/tds/rules/1" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "rule": {
    "id": 1,
    "rule_name": "Bot Shield",
    "tds_type": "traffic_shield",
    "logic_json": {
      "conditions": { "bot": true },
      "action": "block",
      "action_url": null,
      "status_code": 302,
      "algorithm": "thompson_sampling",
      "variants": null
    },
    "priority": 10,
    "status": "active",
    "preset_id": "S1",
    "site_id": 5,
    "site_name": "My Offer Site",
    "acceptor_domain": "example.com",
    "sync_status": "applied",
    "last_synced_at": "2026-01-15T11:00:00Z",
    "last_error": null,
    "created_at": "2026-01-15T10:30:00Z",
    "updated_at": "2026-01-15T10:30:00Z"
  }
}
```

> **site_name** и **acceptor_domain** получаются через JOIN: `sites → domains(role='acceptor')`.
> **sync_status** / **last_synced_at** / **last_error** — поля синхронизации, хранятся непосредственно в `tds_rules`.

**Ошибки:**

```json
{ "ok": false, "error": "rule_not_found" }
```

---

## 5. POST /tds/rules

Создать правило вручную.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Параметры запроса:**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `rule_name` | string | да | Название (1-255 символов) |
| `tds_type` | string | да | `"smartlink"` или `"traffic_shield"` |
| `logic_json` | object | да | Условия + действие (см. [LogicJson](#13-logicjson-schema)) |
| `site_id` | number | да | ID сайта (FK на `sites`) |
| `priority` | number | нет | 0-1000 (default: 100) |

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/tds/rules" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "rule_name": "Geo Redirect RU",
    "tds_type": "traffic_shield",
    "site_id": 5,
    "logic_json": {
      "conditions": { "geo": ["RU", "BY"] },
      "action": "redirect",
      "action_url": "https://local.example.com",
      "status_code": 302
    },
    "priority": 50
  }'
```

**Успешный ответ (201):**

```json
{
  "ok": true,
  "rule": {
    "id": 42,
    "rule_name": "Geo Redirect RU",
    "tds_type": "traffic_shield",
    "logic_json": { "..." },
    "priority": 50,
    "status": "active",
    "site_id": 5,
    "sync_status": "pending",
    "preset_id": null,
    "created_at": "2026-01-15T12:00:00Z",
    "updated_at": "2026-01-15T12:00:00Z"
  }
}
```

> **Автоматическая активация:** правило сразу получает `status: "active"` и `sync_status: "pending"`, т.к. привязка к сайту задаётся при создании (см. [ADR-001](decisions/ADR-001-tds-site-scoped-rules.md)).

**Ошибки:**

```json
{ "ok": false, "error": "validation_error", "details": ["..."] }
```
```json
{ "ok": false, "error": "create_failed" }
```

---

## 6. POST /tds/rules/from-preset

Создать правило из пресета с привязкой к сайту.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Параметры запроса:**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `preset_id` | string | да | ID пресета (S1-S5, L1-L3) |
| `params` | object | да | Параметры пресета |
| `site_id` | number | да | ID сайта (FK на `sites`) |
| `rule_name` | string | нет | Название (auto-generated если пусто) |

**Пример запроса (S2 — Geo Filter):**

```bash
curl -X POST "https://api.301.st/tds/rules/from-preset" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "S2",
    "params": {
      "geo": ["RU", "BY", "KZ"],
      "action_url": "https://local.example.com"
    },
    "site_id": 5,
    "rule_name": "CIS Geo Filter"
  }'
```

**Успешный ответ (201):**

```json
{
  "ok": true,
  "rule": {
    "id": 43,
    "rule_name": "CIS Geo Filter",
    "tds_type": "traffic_shield",
    "logic_json": {
      "conditions": { "geo": ["RU", "BY", "KZ"] },
      "action": "redirect",
      "action_url": "https://local.example.com",
      "status_code": 302,
      "algorithm": "thompson_sampling"
    },
    "priority": 50,
    "status": "active",
    "site_id": 5,
    "sync_status": "pending",
    "preset_id": "S2",
    "created_at": "2026-01-15T12:00:00Z",
    "updated_at": "2026-01-15T12:00:00Z"
  }
}
```

> **Автоматическая активация:** правило сразу `status: "active"`, т.к. `site_id` задаётся при создании.

**Ошибки:**

```json
{ "ok": false, "error": "invalid_preset" }
```
```json
{ "ok": false, "error": "validation_error", "details": ["..."] }
```

---

## 7. PATCH /tds/rules/:id

Обновить правило.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Параметры запроса (все опциональные):**

| Поле | Тип | Описание |
|------|-----|----------|
| `rule_name` | string | Новое название |
| `tds_type` | string | `"smartlink"` или `"traffic_shield"` |
| `logic_json` | object | Новые условия/действие |
| `priority` | number | 0-1000 |
| `status` | string | `"draft"`, `"active"`, `"disabled"` |
| `site_id` | number | Переназначить правило на другой сайт |

**Пример запроса:**

```bash
curl -X PATCH "https://api.301.st/tds/rules/1" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "logic_json": {
      "conditions": { "bot": true },
      "action": "redirect",
      "action_url": "https://safe.example.com",
      "status_code": 302
    }
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "rule_id": 1
}
```

> **Re-sync:** после обновления `sync_status` правила переводится в `"pending"` для повторной синхронизации.

**Ошибки:**

```json
{ "ok": false, "error": "rule_not_found" }
```
```json
{ "ok": false, "error": "no_updates" }
```
```json
{ "ok": false, "error": "validation_error", "details": ["..."] }
```

---

## 8. PATCH /tds/rules/reorder

Массовое обновление приоритетов правил.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Параметры запроса:**

| Поле | Тип | Описание |
|------|-----|----------|
| `rules` | array | Массив `{ id, priority }` (1-100 элементов) |

**Пример запроса:**

```bash
curl -X PATCH "https://api.301.st/tds/rules/reorder" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [
      { "id": 1, "priority": 100 },
      { "id": 2, "priority": 50 },
      { "id": 3, "priority": 25 }
    ]
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "updated": 3
}
```

---

## 9. DELETE /tds/rules/:id

Удалить правило.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Пример запроса:**

```bash
curl -X DELETE "https://api.301.st/tds/rules/1" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "deleted_id": 1
}
```

> **Каскад:** правило удаляется из `tds_rules`. При следующем sync Client Worker перестанет получать это правило.

**Ошибки:**

```json
{ "ok": false, "error": "rule_not_found" }
```

---

## 10-12. Endpoints привязки доменов (УДАЛЕНЫ)

> **Удалены в [ADR-001](decisions/ADR-001-tds-site-scoped-rules.md).** Таблица `rule_domain_map` больше не существует.
>
> Привязка правила к домену теперь неявная через `site_id`:
> - Правило привязано к сайту (`tds_rules.site_id`)
> - Целевой домен определяется как `domains(site_id, role='acceptor')`
>
> **Удалённые endpoints:**
> - ~~`POST /tds/rules/:id/domains`~~ -- привязка через `site_id` при создании/обновлении правила
> - ~~`GET /tds/rules/:id/domains`~~ -- информация о домене доступна в `GET /tds/rules/:id` (поле `acceptor_domain`)
> - ~~`DELETE /tds/rules/:id/domains/:domainId`~~ -- для переназначения используйте `PATCH /tds/rules/:id` с новым `site_id`

### Sync Status (вместо Binding Status)

Статус синхронизации хранится в `tds_rules.sync_status`:

| Статус | Описание |
|--------|----------|
| `pending` | Ожидает синхронизации |
| `applying` | В процессе применения |
| `applied` | Синхронизировано |
| `failed` | Ошибка синхронизации (см. `last_error`) |

---

## 13. LogicJson Schema

Структура `logic_json` — определяет условия и действие правила.

### Формат

```json
{
  "conditions": { ... },
  "action": "redirect",
  "action_url": "https://example.com",
  "status_code": 302,
  "algorithm": "thompson_sampling",
  "variants": [...]
}
```

### Conditions (условия)

| Поле | Тип | Описание |
|------|-----|----------|
| `geo` | string[] | ISO 3166-1 alpha-2 коды стран (include) |
| `geo_exclude` | string[] | Исключить страны |
| `device` | string | `"mobile"`, `"desktop"`, `"any"` |
| `os` | string[] | Android, iOS, Windows, macOS, Linux |
| `browser` | string[] | Chrome, Safari, Firefox, Edge, Opera |
| `bot` | boolean | true = только боты, false = только люди |
| `utm_source` | string[] | Значения utm_source |
| `utm_campaign` | string[] | Значения utm_campaign |
| `match_params` | string[] | OR-логика: если ЛЮБОЙ параметр в URL — match |
| `path` | string | Regex для пути |
| `referrer` | string | Regex для referrer |

> **match_params + utm_source:** Если `match_params` сработал, проверка `utm_source` пропускается. Используется в L2/L3 пресетах (fbclid/gclid OR utm_source).

### Actions (действия)

| action | Описание | Требует |
|--------|----------|---------|
| `redirect` | HTTP-редирект | `action_url` |
| `block` | 403 Access Denied | — |
| `pass` | Пропустить запрос | — |
| `mab_redirect` | MAB A/B-тест | `variants` (≥2), `algorithm` |

### Status Code

`301`, `302` или `307` (default: `302`).

### MAB поля (action = mab_redirect)

| Поле | Тип | Описание |
|------|-----|----------|
| `algorithm` | string | `"thompson_sampling"` (default), `"ucb"`, `"epsilon_greedy"` |
| `variants` | array | Массив вариантов (min 2, max 20) |

**Variant:**

```json
{
  "url": "https://offer-a.com",
  "weight": 0.5,
  "alpha": 1,
  "beta": 1,
  "impressions": 0,
  "conversions": 0
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `url` | string | URL варианта (обязательный) |
| `weight` | number | Начальный вес 0-1 (опционально) |
| `alpha` | number | Успехи + prior (default: 1, Thompson Sampling) |
| `beta` | number | Неудачи + prior (default: 1, Thompson Sampling) |
| `impressions` | number | Показы (default: 0, UCB / Epsilon-Greedy) |
| `conversions` | number | Конверсии (default: 0, UCB / Epsilon-Greedy) |

### Алгоритмы MAB

| Алгоритм | Описание | Параметры |
|----------|----------|-----------|
| `thompson_sampling` | Байесовский подход (Beta-распределение) | `alpha`, `beta` |
| `ucb` | Upper Confidence Bound (детерминированный) | `impressions`, `conversions` |
| `epsilon_greedy` | ε-жадный (10% exploration) | `impressions`, `conversions` |

---

## 14. POST /tds/postback

Трекинг конверсий MAB (публичный endpoint).

**Требует:** Нет аутентификации

**Параметры (JSON body или query string):**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `rule_id` | number | да | ID правила |
| `variant_url` | string | да | URL варианта |
| `converted` | number | нет | 0 или 1 (default: 1) |
| `revenue` | number | нет | Сумма (default: 0) |

**Пример запроса (query string):**

```
POST /tds/postback?rule_id=42&variant_url=https://offer-a.com&converted=1&revenue=25.50
```

**Пример запроса (JSON):**

```bash
curl -X POST "https://api.301.st/tds/postback" \
  -H "Content-Type: application/json" \
  -d '{
    "rule_id": 42,
    "variant_url": "https://offer-a.com",
    "converted": 1,
    "revenue": 25.50
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "rule_id": 42,
  "variant_url": "https://offer-a.com",
  "converted": 1,
  "revenue": 25.50
}
```

> **Побочные эффекты:**
> - `converted=1` → `variant.alpha += 1` (Thompson Sampling)
> - `converted=0` → `variant.beta += 1`
> - Обновляет `logic_json` в `tds_rules`

**Ошибки:**

```json
{ "ok": false, "error": "validation_error", "details": ["..."] }
```
```json
{ "ok": false, "error": "rule_not_found" }
```
```json
{ "ok": false, "error": "update_failed" }
```

---

## 15. TDS Статистика

### Архитектура сбора

```
Edge request → Client D1 (stats_shield / stats_link / mab_stats)
                  │  cron: 0 */6 * * *
                  ↓
              POST webhook.301.st/tds  ← API key auth (SHA-256)
                  │
                  ↓
              DB301 (tds_stats_shield / tds_stats_link / tds_rules.logic_json)
```

Статистика разделена на два потока по `tds_type` правила:

| | SmartShield (`traffic_shield`) | SmartLink (`smartlink`) |
|---|---|---|
| Таблица (client) | `stats_shield` | `stats_link` |
| Таблица (DB301) | `tds_stats_shield` | `tds_stats_link` |
| Гранулярность | Per-domain, per-hour | Per-rule, per-hour, per-country, per-device |
| Поля | hits, blocks, passes | hits, redirects |
| TTL (client) | 7 дней | 30 дней |

### Webhook: POST webhook.301.st/tds

Приём статистики от Client Worker. **Не API endpoint** — вызывается cron'ом воркера, не UI.

**Auth:** `Authorization: Bearer <WORKER_API_KEY>` → SHA-256 hash lookup в `DB301.worker_api_keys`

**Payload:**

```json
{
  "account_id": 19,
  "timestamp": "2026-02-26T12:00:00Z",
  "shield": [
    {
      "domain_name": "example.com",
      "hour": "2026-02-26T06",
      "hits": 150,
      "blocks": 30,
      "passes": 120
    }
  ],
  "links": [
    {
      "domain_name": "offer.com",
      "rule_id": 42,
      "hour": "2026-02-26T06",
      "country": "US",
      "device": "mobile",
      "hits": 80,
      "redirects": 80
    }
  ],
  "mab": [
    {
      "rule_id": 42,
      "variant_url": "https://v1.com",
      "impressions": 50
    }
  ]
}
```

**Ответ:**

```json
{
  "ok": true,
  "result": {
    "shield_upserted": 1,
    "links_upserted": 1,
    "mab_updated": 1,
    "errors": []
  }
}
```

**Обработка:**
- `shield[]` → UPSERT `DB301.tds_stats_shield` (additive: `hits = hits + excluded.hits`)
- `links[]` → UPSERT `DB301.tds_stats_link` (additive)
- `mab[]` → UPDATE `tds_rules.logic_json.variants[].impressions`

### DB301 таблицы

**tds_stats_shield** — агрегат по домену:
```sql
UNIQUE(account_id, domain_name, hour)
-- hits, blocks, passes, collected_at
```

**tds_stats_link** — полная гранулярность:
```sql
UNIQUE(account_id, domain_name, rule_id, hour, country, device)
-- hits, redirects, collected_at
```

> **Для UI:** API endpoints для чтения статистики (GET /tds/stats/shield, GET /tds/stats/link) — TODO. Данные доступны в DB301 после push от Client Worker.

---

## 16. Таблица endpoints

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/tds/presets` | GET | JWT | Список пресетов |
| `/tds/params` | GET | JWT | Справочник параметров |
| `/tds/rules` | GET | JWT | Список правил аккаунта (фильтр `?site_id=X`) |
| `/tds/rules/:id` | GET | JWT | Детали правила (site_name, acceptor_domain, sync_status) |
| `/tds/rules` | POST | editor | Создать правило (обязательный `site_id`) |
| `/tds/rules/from-preset` | POST | editor | Создать из пресета (обязательный `site_id`) |
| `/tds/rules/:id` | PATCH | editor | Обновить правило (можно изменить `site_id`) |
| `/tds/rules/reorder` | PATCH | editor | Массовое обновление приоритетов |
| `/tds/rules/:id` | DELETE | editor | Удалить правило |
| ~~`/tds/rules/:id/domains`~~ | ~~POST~~ | — | ~~Удалён ([ADR-001](decisions/ADR-001-tds-site-scoped-rules.md))~~ |
| ~~`/tds/rules/:id/domains`~~ | ~~GET~~ | — | ~~Удалён ([ADR-001](decisions/ADR-001-tds-site-scoped-rules.md))~~ |
| ~~`/tds/rules/:id/domains/:domainId`~~ | ~~DELETE~~ | — | ~~Удалён ([ADR-001](decisions/ADR-001-tds-site-scoped-rules.md))~~ |
| `/tds/sync` | GET | API key | Sync для Client Worker |
| `/tds/postback` | POST | public | MAB конверсии |
| `webhook.301.st/tds` | POST | API key | Webhook: приём статистики от Client Worker |

---

## 17. Rule Status

| Статус | Описание | UI Badge |
|--------|----------|----------|
| `draft` | Создано без `site_id` (осиротевшее правило) | Draft |
| `active` | Активно, привязано к сайту | Active |
| `disabled` | Отключено вручную | Disabled |

---

## 18. Типичный flow для UI

### Создание правила из пресета

```
1. GET /tds/presets                        → показать список пресетов
2. Пользователь выбирает пресет, заполняет params
3. POST /tds/rules/from-preset             → создать правило с site_id
   { preset_id, params, site_id }
4. Правило создано: status="active", sync_status="pending"
5. Client Worker подтянет правило при следующем sync
```

### Создание правила вручную

```
1. POST /tds/rules                         → создать правило с site_id
   { rule_name, tds_type, logic_json, site_id }
2. Правило сразу active (привязка к сайту задана при создании)
3. Client Worker подтянет правило при следующем sync
```

### MAB A/B-тест

```
1. POST /tds/rules
   { action: "mab_redirect", algorithm: "thompson_sampling", variants: [...], site_id: N }
2. Edge worker выбирает вариант по алгоритму
3. Postback URL отправляет конверсии:
   POST /tds/postback?rule_id=X&variant_url=Y&converted=1
4. Alpha/beta обновляются, алгоритм адаптируется
```

### Переназначение правила на другой сайт

```
1. PATCH /tds/rules/:id
   { site_id: <new_site_id> }
2. sync_status → "pending", правило будет синхронизировано для нового домена
```

### Обновление приоритетов (drag & drop)

```
1. Пользователь перетаскивает правила в UI
2. PATCH /tds/rules/reorder
   { rules: [{ id: 1, priority: 100 }, { id: 2, priority: 50 }] }
```
