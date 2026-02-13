# Redirects API

## Базовый URL

```
https://api.301.st
```

---

## Обзор

Управление HTTP-редиректами (301/302) через Cloudflare Single Redirects API.

**Ключевые концепции:**
- **Template** — шаблон редиректа (T1-T7), определяет CF expression
- **Preset** — набор шаблонов для типовых сценариев (P1-P5)
- **Zone limit** — до 10 правил на зону (Free Plan)
- **Apply** — синхронизация всех правил зоны в CF одним запросом

**Архитектура:**
```
CRUD в D1 (redirects.ts)  →  Apply по зоне (cf-sync.ts)  →  CF API
```

---

## 1. GET /redirects/templates

Список доступных шаблонов редиректов.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/redirects/templates" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "templates": [
    {
      "id": "T1",
      "name": "Domain → Domain",
      "description": "Редирект всего домена на другой домен с сохранением пути",
      "category": "domain",
      "preservePath": true,
      "preserveQuery": true,
      "defaultStatusCode": 301,
      "params": [
        {
          "name": "target_url",
          "type": "url",
          "required": true,
          "description": "URL назначения (https://...)"
        }
      ]
    },
    {
      "id": "T3",
      "name": "non-www → www",
      "description": "SEO canonical: редирект с apex на www",
      "category": "canonical",
      "preservePath": true,
      "preserveQuery": true,
      "defaultStatusCode": 301,
      "params": []
    },
    {
      "id": "T4",
      "name": "www → non-www",
      "description": "SEO canonical: редирект с www на apex",
      "category": "canonical",
      "preservePath": true,
      "preserveQuery": true,
      "defaultStatusCode": 301,
      "params": []
    },
    {
      "id": "T5",
      "name": "Path prefix → Path",
      "description": "Редирект по префиксу пути",
      "category": "path",
      "preservePath": false,
      "preserveQuery": true,
      "defaultStatusCode": 301,
      "params": [
        {
          "name": "source_path",
          "type": "path",
          "required": true,
          "description": "Исходный путь (например /old/)"
        },
        {
          "name": "target_path",
          "type": "path",
          "required": true,
          "description": "Целевой путь (например /new/)"
        }
      ]
    },
    {
      "id": "T6",
      "name": "Exact path → URL",
      "description": "Редирект точного пути на URL",
      "category": "path",
      "preservePath": false,
      "preserveQuery": true,
      "defaultStatusCode": 301,
      "params": [
        {
          "name": "source_path",
          "type": "path",
          "required": true,
          "description": "Точный путь (например /old-page)"
        },
        {
          "name": "target_url",
          "type": "url",
          "required": true,
          "description": "URL назначения"
        }
      ]
    },
    {
      "id": "T7",
      "name": "Maintenance",
      "description": "Временный редирект на страницу обслуживания",
      "category": "temporary",
      "preservePath": false,
      "preserveQuery": false,
      "defaultStatusCode": 302,
      "params": [
        {
          "name": "target_url",
          "type": "url",
          "required": true,
          "description": "URL страницы maintenance"
        }
      ]
    }
  ]
}
```

---

## 2. GET /redirects/presets

Список доступных пресетов (комбинаций шаблонов).

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/redirects/presets" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "presets": [
    {
      "id": "P1",
      "name": "SEO Canonical (www)",
      "description": "Стандартная SEO-настройка для сайтов с www",
      "useCase": "example.com → www.example.com",
      "rulesCount": 1,
      "rules": [
        { "template_id": "T3", "order": 1, "description": "non-www → www" }
      ]
    },
    {
      "id": "P2",
      "name": "SEO Canonical (non-www)",
      "description": "Стандартная SEO-настройка для сайтов без www",
      "useCase": "www.example.com → example.com",
      "rulesCount": 1,
      "rules": [
        { "template_id": "T4", "order": 1, "description": "www → non-www" }
      ]
    },
    {
      "id": "P3",
      "name": "Domain Migration",
      "description": "Миграция старого домена на новый с сохранением SEO",
      "useCase": "old.com → new.com (сохраняя пути и canonical)",
      "rulesCount": 2,
      "rules": [
        { "template_id": "T1", "order": 1, "description": "Domain → Domain" },
        { "template_id": "T3", "order": 2, "description": "non-www → www" }
      ]
    },
    {
      "id": "P4",
      "name": "Maintenance Mode",
      "description": "Временный режим обслуживания",
      "useCase": "Все запросы → страница maintenance",
      "rulesCount": 1,
      "rules": [
        { "template_id": "T7", "order": 1, "description": "Maintenance redirect" }
      ]
    },
    {
      "id": "P5",
      "name": "Full Migration",
      "description": "Полная миграция с изменением структуры URL",
      "useCase": "old.com + path redirects → new.com",
      "rulesCount": "2+N",
      "rules": [
        { "template_id": "T1", "order": 1, "description": "Domain → Domain" },
        { "template_id": "T3", "order": 2, "description": "non-www → www" },
        { "template_id": "T5", "order": "3+", "description": "Path redirects (×N)" }
      ]
    }
  ]
}
```

---

## 3. GET /sites/:siteId/redirects

Список редиректов для сайта с информацией о лимитах зон.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/sites/10/redirects" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "site_id": 10,
  "site_name": "Main Landing",
  "redirects": [
    {
      "id": 1,
      "domain_id": 45,
      "domain_name": "cryptoboss.pics",
      "zone_id": 12,
      "zone_name": "cryptoboss.pics",
      "template_id": "T1",
      "preset_id": null,
      "preset_order": null,
      "rule_name": "Domain → Domain: cryptoboss.pics",
      "params": {
        "target_url": "https://cryptoboss.com"
      },
      "status_code": 301,
      "enabled": true,
      "sync_status": "synced",
      "cf_rule_id": "abc123def456",
      "clicks_total": 12847,
      "clicks_today": 142,
      "clicks_yesterday": 128,
      "trend": "up",
      "created_at": "2025-01-10T08:00:00Z",
      "updated_at": "2025-01-12T10:00:00Z"
    },
    {
      "id": 2,
      "domain_id": 46,
      "domain_name": "promo.cryptoboss.pics",
      "zone_id": 12,
      "zone_name": "cryptoboss.pics",
      "template_id": "T3",
      "preset_id": "P1",
      "preset_order": 1,
      "rule_name": "SEO Canonical (www)",
      "params": {},
      "status_code": 301,
      "enabled": true,
      "sync_status": "pending",
      "cf_rule_id": null,
      "clicks_total": 0,
      "clicks_today": 0,
      "clicks_yesterday": 0,
      "trend": "neutral",
      "created_at": "2025-01-12T14:00:00Z",
      "updated_at": "2025-01-12T14:00:00Z"
    }
  ],
  "zone_limits": [
    {
      "zone_id": 12,
      "zone_name": "cryptoboss.pics",
      "used": 2,
      "max": 10
    }
  ],
  "total": 2
}
```

---

## 4. GET /domains/:domainId/redirects

Список редиректов для конкретного домена.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/domains/45/redirects" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "domain_id": 45,
  "domain_name": "cryptoboss.pics",
  "zone_id": 12,
  "zone_limit": {
    "used": 2,
    "max": 10
  },
  "redirects": [
    {
      "id": 1,
      "template_id": "T1",
      "preset_id": null,
      "preset_order": null,
      "rule_name": "Domain → Domain: cryptoboss.pics",
      "params": {
        "target_url": "https://cryptoboss.com"
      },
      "status_code": 301,
      "enabled": true,
      "sync_status": "synced",
      "clicks_total": 12847,
      "clicks_today": 142,
      "trend": "up",
      "created_at": "2025-01-10T08:00:00Z"
    }
  ],
  "total": 1
}
```

**Ошибки:**

```json
// Домен не найден
{
  "ok": false,
  "error": "domain_not_found"
}

// Домен без зоны
{
  "ok": false,
  "error": "domain_no_zone"
}
```

---

## 5. GET /redirects/:id

Получить детали редиректа.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/redirects/1" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "redirect": {
    "id": 1,
    "domain_id": 45,
    "domain_name": "cryptoboss.pics",
    "zone_id": 12,
    "zone_name": "cryptoboss.pics",
    "template_id": "T1",
    "preset_id": null,
    "preset_order": null,
    "rule_name": "Domain → Domain: cryptoboss.pics",
    "params": {
      "target_url": "https://cryptoboss.com"
    },
    "status_code": 301,
    "enabled": true,
    "sync_status": "synced",
    "cf_rule_id": "abc123def456",
    "cf_ruleset_id": "xyz789ghi012",
    "last_synced_at": "2025-01-12T10:00:00Z",
    "last_error": null,
    "clicks_total": 12847,
    "clicks_today": 142,
    "clicks_yesterday": 128,
    "trend": "up",
    "created_at": "2025-01-10T08:00:00Z",
    "updated_at": "2025-01-12T10:00:00Z"
  }
}
```

**Ошибки:**

```json
{
  "ok": false,
  "error": "redirect_not_found"
}
```

---

## 6. POST /domains/:domainId/redirects

Создать редирект из шаблона.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Параметры запроса:**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `template_id` | string | да | ID шаблона (T1-T7) |
| `rule_name` | string | нет | Название правила (auto-generated если пусто) |
| `params` | object | зависит | Параметры шаблона |
| `status_code` | number | нет | 301 или 302 (default из шаблона) |

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/domains/45/redirects" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "template_id": "T1",
    "rule_name": "Main redirect to new domain",
    "params": {
      "target_url": "https://cryptoboss.com"
    },
    "status_code": 301
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "redirect": {
    "id": 3,
    "domain_id": 45,
    "domain_name": "cryptoboss.pics",
    "zone_id": 12,
    "template_id": "T1",
    "rule_name": "Main redirect to new domain",
    "params": {
      "target_url": "https://cryptoboss.com"
    },
    "status_code": 301,
    "enabled": true,
    "sync_status": "pending",
    "created_at": "2025-01-13T15:00:00Z"
  },
  "zone_limit": {
    "used": 3,
    "max": 10
  },
  "www_dns_created": true,
  "domain_role": "donor"
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `www_dns_created` | boolean/undefined | `true` если создана DNS A-record для `www.{apex}` (только для T3/T4) |
| `domain_role` | string/undefined | Новая роль домена, если изменилась (`"donor"` для T1/T5/T6/T7) |

> **Автоматическое создание www DNS:** При создании T3 или T4 redirect API автоматически создаёт DNS A-record `www.{apex} → 192.0.2.1` (proxied) в Cloudflare, если запись ещё не существует. Без этой записи CF не может обработать запросы к `www.` субдомену и redirect rule не сработает.

**Ошибки:**

```json
// Неверный шаблон
{
  "ok": false,
  "error": "invalid_template",
  "template_id": "T99"
}

// Невалидные параметры
{
  "ok": false,
  "error": "invalid_params",
  "details": ["target_url is required", "target_url must start with https://"]
}

// Лимит зоны достигнут
{
  "ok": false,
  "error": "zone_limit_reached",
  "zone_limit": {
    "used": 10,
    "max": 10
  }
}

// Шаблон уже существует для домена
{
  "ok": false,
  "error": "template_already_exists",
  "template_id": "T1"
}

// Домен без зоны
{
  "ok": false,
  "error": "domain_no_zone"
}
```

---

## 7. POST /domains/:domainId/redirects/preset

Создать редиректы из пресета (несколько правил за раз).

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Параметры запроса:**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `preset_id` | string | да | ID пресета (P1-P5) |
| `params` | object | зависит | Параметры пресета |

**Пример запроса (P3 — Domain Migration):**

```bash
curl -X POST "https://api.301.st/domains/45/redirects/preset" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "P3",
    "params": {
      "target_url": "https://newdomain.com"
    }
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "preset_id": "P3",
  "preset_name": "Domain Migration",
  "created_count": 2,
  "redirect_ids": [4, 5],
  "zone_limit": {
    "used": 5,
    "max": 10
  },
  "www_dns_created": true,
  "domain_role": "donor"
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `www_dns_created` | boolean/undefined | `true` если создана DNS A-record для `www.{apex}` (пресеты с T3/T4) |
| `domain_role` | string/undefined | Новая роль домена, если изменилась (`"donor"` для пресетов с T1/T5/T6/T7) |

> **Автоматическое создание www DNS:** Если пресет содержит T3 или T4, API автоматически создаёт DNS A-record `www.{apex} → 192.0.2.1` (proxied). Подробнее — см. секцию 6.

**Пример запроса (P5 — Full Migration с path redirects):**

```bash
curl -X POST "https://api.301.st/domains/45/redirects/preset" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "preset_id": "P5",
    "params": {
      "target_url": "https://newdomain.com",
      "source_paths": [
        { "source": "/old/", "target": "/new/" },
        { "source": "/blog/", "target": "/articles/" }
      ]
    }
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "preset_id": "P5",
  "preset_name": "Full Migration",
  "created_count": 4,
  "redirect_ids": [6, 7, 8, 9],
  "zone_limit": {
    "used": 7,
    "max": 10
  },
  "www_dns_created": true,
  "domain_role": "donor"
}
```

**Ошибки:**

```json
// Лимит будет превышен
{
  "ok": false,
  "error": "zone_limit_exceeded",
  "zone_limit": {
    "used": 8,
    "max": 10,
    "needed": 4
  }
}

// Неверный пресет
{
  "ok": false,
  "error": "invalid_preset",
  "preset_id": "P99"
}
```

---

## 8. PATCH /redirects/:id

Обновить редирект.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Параметры запроса:**

| Поле | Тип | Описание |
|------|-----|----------|
| `rule_name` | string | Новое название |
| `params` | object | Новые параметры |
| `status_code` | number | 301 или 302 |
| `enabled` | boolean | Включить/выключить |

**Пример запроса:**

```bash
curl -X PATCH "https://api.301.st/redirects/1" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "target_url": "https://newsite.com"
    },
    "enabled": false
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "redirect_id": 1,
  "sync_status": "pending"
}
```

> **Примечание:** После обновления `sync_status` становится `pending`. Нужно вызвать `POST /zones/:id/apply-redirects` для применения изменений в CF.

**Ошибки:**

```json
// Невалидные параметры
{
  "ok": false,
  "error": "invalid_params",
  "details": ["target_url must start with https://"]
}

// Неверный status_code
{
  "ok": false,
  "error": "invalid_status_code"
}

// Нет изменений
{
  "ok": false,
  "error": "no_updates"
}
```

---

## 9. DELETE /redirects/:id

Удалить редирект. Если редирект является частью пресета — удаляются **все правила пресета** для этого домена.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Пример запроса:**

```bash
curl -X DELETE "https://api.301.st/redirects/1" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ (одиночное правило):**

```json
{
  "ok": true,
  "deleted_ids": [1],
  "domain_id": 45,
  "domain_role": "reserve"
}
```

**Успешный ответ (правило из пресета — каскадное удаление):**

```json
{
  "ok": true,
  "deleted_ids": [4, 5],
  "domain_id": 45,
  "domain_role": "reserve"
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `deleted_ids` | number[] | Массив ID удалённых правил (1 для одиночного, N для пресета) |
| `domain_id` | number | ID домена |
| `domain_role` | string/undefined | Новая роль, если изменилась. Только для `donor` → `reserve` |

> **Каскадное удаление пресетов:** Если удаляемое правило имеет `preset_id`, API удаляет **все** правила с тем же `preset_id` и `domain_id`. Это гарантирует атомарность — нельзя оставить "осиротевшие" части пресета.

> **Управление ролью домена:**
> - Роль `donor` сбрасывается в `reserve` только когда не остаётся ни одного правила T1/T5/T6/T7 для домена
> - Роли `primary` и `acceptor` **не затрагиваются** при удалении редиректов
> - При сбросе роли в `reserve` автоматически удаляются осиротевшие T3/T4 (canonical) правила домена

> **Примечание:** Правила удаляются из D1. Для удаления из CF нужно вызвать `POST /zones/:id/apply-redirects`.

**Ошибки:**

```json
{
  "ok": false,
  "error": "redirect_not_found"
}
```

---

## 10. GET /zones/:id/redirect-limits

Получить лимиты редиректов для зоны.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/zones/12/redirect-limits" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zone_id": 12,
  "zone_name": "cryptoboss.pics",
  "used": 3,
  "max": 10,
  "available": 7
}
```

---

## 11. POST /zones/:id/apply-redirects

Применить все редиректы зоны в Cloudflare.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

> **Важно:** Это основной endpoint для синхронизации с CF. Заменяет весь ruleset зоны.

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/zones/12/apply-redirects" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zone_id": 12,
  "cf_zone_id": "abc123def456789",
  "cf_ruleset_id": "xyz789ghi012345",
  "rules_applied": 3,
  "synced_rules": [
    { "id": 1, "cf_rule_id": "rule_abc123" },
    { "id": 2, "cf_rule_id": "rule_def456" },
    { "id": 3, "cf_rule_id": "rule_ghi789" }
  ]
}
```

**Ответ с предупреждениями (partial success):**

```json
{
  "ok": true,
  "zone_id": 12,
  "cf_zone_id": "abc123def456789",
  "cf_ruleset_id": "xyz789ghi012345",
  "rules_applied": 2,
  "synced_rules": [
    { "id": 1, "cf_rule_id": "rule_abc123" },
    { "id": 2, "cf_rule_id": "rule_def456" }
  ],
  "warnings": [
    "Failed to build CF rule for redirect_rule.id=3"
  ]
}
```

**Ошибки:**

```json
// Зона не найдена
{
  "ok": false,
  "error": "zone_not_found"
}

// Зона не активирована в CF
{
  "ok": false,
  "error": "zone_not_activated"
}

// Ошибка CF API
{
  "ok": false,
  "error": "apply_failed",
  "details": ["Failed to create ruleset: rate limited"]
}

// Невалидный ключ CF
{
  "ok": false,
  "error": "key_invalid"
}
```

---

## 12. GET /zones/:id/redirect-status

Статус синхронизации редиректов зоны.

**Требует:** `Authorization: Bearer <access_token>` (editor или owner)

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/zones/12/redirect-status" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zone_id": 12,
  "cf_zone_id": "abc123def456789",
  "cf_ruleset_id": "xyz789ghi012345",
  "has_ruleset": true,
  "rules": {
    "total": 5,
    "pending": 2,
    "synced": 3,
    "error": 0
  },
  "needs_apply": true
}
```

**Поля ответа:**

| Поле | Тип | Описание |
|------|-----|----------|
| `has_ruleset` | boolean | Есть ли ruleset в CF |
| `rules.pending` | number | Ожидают синхронизации |
| `rules.synced` | number | Синхронизированы |
| `rules.error` | number | С ошибками |
| `needs_apply` | boolean | Нужен ли вызов apply-redirects |

---

## 13. Таблица endpoints

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/redirects/templates` | GET | JWT | Список шаблонов |
| `/redirects/presets` | GET | JWT | Список пресетов |
| `/sites/:siteId/redirects` | GET | JWT | Редиректы сайта |
| `/domains/:domainId/redirects` | GET | JWT | Редиректы домена |
| `/redirects/:id` | GET | JWT | Детали редиректа |
| `/domains/:domainId/redirects` | POST | editor | Создать из шаблона |
| `/domains/:domainId/redirects/preset` | POST | editor | Создать из пресета |
| `/redirects/:id` | PATCH | editor | Обновить |
| `/redirects/:id` | DELETE | editor | Удалить |
| `/zones/:id/redirect-limits` | GET | JWT | Лимиты зоны |
| `/zones/:id/apply-redirects` | POST | editor | Apply в CF |
| `/zones/:id/redirect-status` | GET | editor | Статус sync |

---

## 14. Sync Status

| Статус | Описание | UI Badge |
|--------|----------|----------|
| `pending` | Ожидает apply | ⏳ Pending |
| `synced` | Синхронизировано с CF | ✅ Synced |
| `error` | Ошибка синхронизации | ❌ Error |

---

## 15. Шаблоны (Templates)

| ID | Название | Категория | Params | Default Code | Роль домена |
|----|----------|-----------|--------|--------------|-------------|
| T1 | Domain → Domain | domain | `target_url` | 301 | → `donor` |
| T3 | non-www → www | canonical | — | 301 | без изменений |
| T4 | www → non-www | canonical | — | 301 | без изменений |
| T5 | Path prefix → Path | path | `source_path`, `target_path` | 301 | → `donor` |
| T6 | Exact path → URL | path | `source_path`, `target_url` | 301 | → `donor` |
| T7 | Maintenance | temporary | `target_url` | 302 | → `donor` |

> **Влияние на роль домена:**
> - **T1, T5, T6, T7** — устанавливают роль `donor` (перенаправляют трафик)
> - **T3, T4** — не меняют роль (canonical-редиректы для www-нормализации)
> - При удалении всех редиректов T1/T5/T6/T7 роль возвращается в `reserve`, а осиротевшие T3/T4 удаляются автоматически

> **Автоматическое создание www DNS (T3, T4):**
> - При создании T3 или T4 API автоматически создаёт DNS A-record `www.{apex} → 192.0.2.1` (proxied) в Cloudflare
> - Без этой записи CF не может обработать запросы к `www.` субдомену и redirect rule не сработает
> - Если запись уже существует — пропускается без ошибки
> - В ответе возвращается поле `www_dns_created: true/false`

---

## 16. Пресеты (Presets)

| ID | Название | Шаблоны | Rules | Use Case |
|----|----------|---------|-------|----------|
| P1 | SEO Canonical (www) | T3 | 1 | example.com → www |
| P2 | SEO Canonical (non-www) | T4 | 1 | www → example.com |
| P3 | Domain Migration | T1, T3 | 2 | old.com → new.com |
| P4 | Maintenance Mode | T7 | 1 | All → maintenance page |
| P5 | Full Migration | T1, T3, T5×N | 2+N | old.com + paths → new.com |

---

## 17. Лимиты

| План | Rules per Zone |
|------|----------------|
| Free | 10 |
| Pro | 25 |
| Business | 50 |
| Enterprise | 300 |

---

## 18. CF API вызовы

| Операция | CF вызовов |
|----------|------------|
| Первый apply (нет кэша) | 2 |
| Повторный apply (есть кэш) | 1 |
| N правил в 1 зоне | 1-2 |
| 50 правил в 5 зонах | 5-10 |

> **Оптимизация:** `cf_ruleset_id` кэшируется в `zones` таблице.
