# API — Cloudflare Integration

Техническое API для работы с Cloudflare: зоны, DNS, SSL, Cache, WAF.

> **Примечание:** Это внутреннее/техническое API. Пользователи работают с доменами через [API_Domains.md](API_Domains.md).

## Базовый URL

```
https://api.301.st
```

---

## 1. Zones API

Управление DNS-зонами Cloudflare.

### 1.1 GET /zones

Список всех зон аккаунта.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/zones" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zones": [
    {
      "id": 1,
      "cf_zone_id": "abc123def456",
      "status": "active",
      "plan": "free",
      "ns_expected": "ns1.cloudflare.com,ns2.cloudflare.com",
      "verified": 1,
      "ssl_status": "valid",
      "ssl_mode": "full",
      "auto_https": 1,
      "caching_level": "standard",
      "waf_mode": "medium",
      "last_sync_at": "2025-01-15T10:00:00Z",
      "created_at": "2025-01-10T08:00:00Z",
      "root_domain": "example.com"
    }
  ]
}
```

---

### 1.2 GET /zones/:id

Детали зоны с доменами.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/zones/1" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zone": {
    "id": 1,
    "account_id": 1,
    "key_id": 42,
    "cf_zone_id": "abc123def456",
    "status": "active",
    "plan": "free",
    "ns_expected": "ns1.cloudflare.com,ns2.cloudflare.com",
    "verified": 1,
    "ssl_status": "valid",
    "ssl_mode": "full",
    "auto_https": 1,
    "caching_level": "standard",
    "waf_mode": "medium",
    "last_sync_at": "2025-01-15T10:00:00Z",
    "created_at": "2025-01-10T08:00:00Z",
    "key_name": "Main CF Account"
  },
  "domains": [
    {
      "id": 1,
      "domain_name": "example.com",
      "role": "acceptor",
      "ns": "ns1.cloudflare.com,ns2.cloudflare.com",
      "ns_verified": 1,
      "proxied": 1,
      "blocked": 0,
      "blocked_reason": null,
      "ssl_status": "valid"
    },
    {
      "id": 2,
      "domain_name": "api.example.com",
      "role": "acceptor",
      "ns": "ns1.cloudflare.com,ns2.cloudflare.com",
      "ns_verified": 1,
      "proxied": 1,
      "blocked": 0,
      "blocked_reason": null,
      "ssl_status": "valid"
    }
  ]
}
```

**Ошибки:**

```json
{
  "ok": false,
  "error": "zone_not_found"
}
```

---

### 1.3 POST /zones

Создать зону в Cloudflare и D1.

**Требует:** `Authorization: Bearer <access_token>` (owner)

**Параметры запроса:**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `domain` | string | да | Доменное имя (2-го уровня) |
| `account_key_id` | number | да | ID ключа Cloudflare |

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/zones" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "newbrand.com",
    "account_key_id": 42
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zone": {
    "id": 5,
    "cf_zone_id": "xyz789new123",
    "domain": "newbrand.com",
    "status": "pending",
    "plan": "free",
    "name_servers": ["ns1.cloudflare.com", "ns2.cloudflare.com"]
  }
}
```

**Ошибки:**

```json
// Превышена квота зон
{
  "ok": false,
  "error": "quota_zones_exceeded"
}

// Ключ не найден
{
  "ok": false,
  "error": "key_not_found"
}

// Ошибка создания в CF
{
  "ok": false,
  "error": "cf_create_failed",
  "message": "Zone already exists"
}
```

---

### 1.4 DELETE /zones/:id

Удалить зону из Cloudflare и D1.

**Требует:** `Authorization: Bearer <access_token>` (owner)

> **Важно:** Удаляет все домены зоны!

**Пример запроса:**

```bash
curl -X DELETE "https://api.301.st/zones/5" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true
}
```

**Ошибки:**

```json
{
  "ok": false,
  "error": "zone_not_found"
}
```

---

### 1.5 POST /zones/sync

Синхронизация всех зон из Cloudflare в D1.

**Требует:** `Authorization: Bearer <access_token>` (owner)

**Параметры запроса:**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `account_key_id` | number | да | ID ключа Cloudflare |

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/zones/sync" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "account_key_id": 42
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zones_synced": 5,
  "domains_synced": 5,
  "errors": []
}
```

---

### 1.6 POST /zones/:id/sync

Синхронизация одной зоны (обновление статуса, NS).

**Требует:** `Authorization: Bearer <access_token>` (owner)

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/zones/1/sync" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "zone": {
    "id": 1,
    "cf_zone_id": "abc123def456",
    "name": "example.com",
    "status": "active",
    "plan": "free",
    "ns_expected": "ns1.cloudflare.com,ns2.cloudflare.com",
    "verified": 1,
    "original_registrar": "namecheap.com",
    "activated_on": "2025-01-11T12:00:00Z"
  },
  "domains_updated": 3
}
```

---

### 1.7 POST /zones/:id/check-activation

Проверить активацию NS записей зоны.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/zones/1/check-activation" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "status": "active",
  "verified": true,
  "cf_status": "active",
  "name_servers": ["ns1.cloudflare.com", "ns2.cloudflare.com"],
  "domains_updated": 3
}
```

---

## 2. Zone Config API

Управление настройками зоны: DNS, SSL, Cache, WAF.

### 2.1 GET /zones/:id/dns

Список DNS записей зоны.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/zones/1/dns" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "records": [
    {
      "id": "rec123",
      "zone_id": "abc123def456",
      "zone_name": "example.com",
      "name": "example.com",
      "type": "A",
      "content": "192.168.1.1",
      "proxied": true,
      "ttl": 1,
      "created_on": "2025-01-10T08:00:00Z",
      "modified_on": "2025-01-10T08:00:00Z"
    },
    {
      "id": "rec124",
      "zone_id": "abc123def456",
      "zone_name": "example.com",
      "name": "api.example.com",
      "type": "A",
      "content": "192.168.1.2",
      "proxied": true,
      "ttl": 1,
      "created_on": "2025-01-11T09:00:00Z",
      "modified_on": "2025-01-11T09:00:00Z"
    }
  ],
  "cached": false
}
```

---

### 2.2 POST /zones/:id/dns/batch

Пакетные операции с DNS (create/update/delete).

**Требует:** `Authorization: Bearer <access_token>` (owner/editor)

**Параметры запроса:**

| Поле | Тип | Описание |
|------|-----|----------|
| `create` | array | Записи для создания |
| `update` | array | Записи для обновления (с id) |
| `delete` | array | ID записей для удаления |

> **Лимит:** максимум 100 операций за запрос.

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/zones/1/dns/batch" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "create": [
      {
        "type": "A",
        "name": "new.example.com",
        "content": "192.168.1.10",
        "proxied": true
      }
    ],
    "update": [
      {
        "id": "rec123",
        "content": "192.168.1.100"
      }
    ],
    "delete": ["rec999"]
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "results": {
    "created": [
      {
        "id": "rec125",
        "name": "new.example.com",
        "type": "A",
        "content": "192.168.1.10",
        "proxied": true,
        "ttl": 1
      }
    ],
    "updated": [
      {
        "id": "rec123",
        "name": "example.com",
        "type": "A",
        "content": "192.168.1.100",
        "proxied": true,
        "ttl": 1
      }
    ],
    "deleted": ["rec999"],
    "errors": []
  }
}
```

**Частичный успех:**

```json
{
  "ok": false,
  "results": {
    "created": [],
    "updated": [],
    "deleted": [],
    "errors": [
      {
        "operation": "create",
        "error": "Record already exists"
      },
      {
        "operation": "delete",
        "id": "rec999",
        "error": "Record not found"
      }
    ]
  }
}
```

---

### 2.3 GET /zones/:id/settings

Получить все настройки зоны (SSL, Cache, Security).

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/zones/1/settings" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "settings": {
    "ssl_mode": "full",
    "cache_level": "standard",
    "browser_ttl": 14400,
    "development_mode": false,
    "security_level": "medium",
    "waf_enabled": true,
    "browser_check": true,
    "always_use_https": true,
    "min_tls_version": "1.2"
  }
}
```

---

### 2.4 PATCH /zones/:id/settings

Обновить настройки зоны.

**Требует:** `Authorization: Bearer <access_token>` (owner/editor)

**Параметры запроса:**

| Поле | Тип | Описание |
|------|-----|----------|
| `ssl_mode` | string | `off`, `flexible`, `full`, `strict` |
| `cache_level` | string | `off`, `basic`, `simplified`, `standard`, `aggressive` |
| `browser_ttl` | number | TTL кэша браузера (секунды) |
| `development_mode` | boolean | Режим разработки |
| `security_level` | string | `off`, `essentially_off`, `low`, `medium`, `high`, `under_attack` |
| `waf_enabled` | boolean | WAF включён |
| `browser_check` | boolean | Browser Integrity Check |

**Пример запроса:**

```bash
curl -X PATCH "https://api.301.st/zones/1/settings" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "ssl_mode": "strict",
    "cache_level": "aggressive",
    "security_level": "high"
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "results": {
    "updated": ["ssl", "cache_level", "security_level"],
    "errors": []
  }
}
```

---

### 2.5 POST /zones/:id/purge-cache

Очистить кэш зоны.

**Требует:** `Authorization: Bearer <access_token>` (owner/editor)

**Параметры запроса:**

| Поле | Тип | Описание |
|------|-----|----------|
| `files` | array | Список URL для очистки (опционально) |

> Если `files` не указан — очищается весь кэш.

**Пример запроса (весь кэш):**

```bash
curl -X POST "https://api.301.st/zones/1/purge-cache" \
  -H "Authorization: Bearer <access_token>"
```

**Пример запроса (выборочно):**

```bash
curl -X POST "https://api.301.st/zones/1/purge-cache" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      "https://example.com/styles.css",
      "https://example.com/script.js"
    ]
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "purged": "all"
}
```

```json
{
  "ok": true,
  "purged": 2
}
```

---

## 3. Статусы зон

| Статус | Описание |
|--------|----------|
| `active` | Зона активна, NS настроены |
| `pending` | Ожидает настройки NS |
| `error` | Ошибка (moved, deactivated) |
| `deleted` | Удалена |

---

## 4. SSL режимы

| Режим | Описание |
|-------|----------|
| `off` | Без SSL |
| `flexible` | SSL только до Cloudflare |
| `full` | SSL до origin (без проверки сертификата) |
| `strict` | SSL до origin (с проверкой сертификата) |

---

## 5. Уровни кэширования

| Уровень | Описание |
|---------|----------|
| `off` | Кэширование отключено |
| `basic` | Только статические файлы с query string |
| `simplified` | Игнорировать query string |
| `standard` | Стандартное (рекомендуется) |
| `aggressive` | Агрессивное кэширование |

---

## 6. Уровни безопасности

| Уровень | Описание |
|---------|----------|
| `off` | Отключено |
| `essentially_off` | Минимальная защита |
| `low` | Низкий уровень |
| `medium` | Средний (рекомендуется) |
| `high` | Высокий уровень |
| `under_attack` | Режим "Под атакой" |

---

## 7. Таблица endpoints

### Zones

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/zones` | GET | ✅ JWT | Список зон |
| `/zones/:id` | GET | ✅ JWT | Детали зоны |
| `/zones` | POST | ✅ JWT (owner) | Создать зону |
| `/zones/:id` | DELETE | ✅ JWT (owner) | Удалить зону |
| `/zones/sync` | POST | ✅ JWT (owner) | Sync всех зон |
| `/zones/:id/sync` | POST | ✅ JWT (owner) | Sync одной зоны |
| `/zones/:id/check-activation` | POST | ✅ JWT | Проверить NS |

### Zone Config

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/zones/:id/dns` | GET | ✅ JWT | Список DNS |
| `/zones/:id/dns/batch` | POST | ✅ JWT (owner/editor) | Batch DNS |
| `/zones/:id/settings` | GET | ✅ JWT | Получить настройки |
| `/zones/:id/settings` | PATCH | ✅ JWT (owner/editor) | Обновить настройки |
| `/zones/:id/purge-cache` | POST | ✅ JWT (owner/editor) | Очистить кэш |

---

## 8. Структура таблицы zones

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | INTEGER | ID зоны в D1 |
| `account_id` | INTEGER | FK → accounts |
| `key_id` | INTEGER | FK → account_keys (CF ключ) |
| `cf_zone_id` | TEXT | ID зоны в Cloudflare |
| `status` | TEXT | `active`, `pending`, `error`, `deleted` |
| `plan` | TEXT | `free`, `pro`, `business`, `enterprise` |
| `ns_expected` | TEXT | Ожидаемые NS (через запятую) |
| `verified` | INTEGER | 1 = NS подтверждены |
| `ssl_status` | TEXT | `none`, `valid`, `expired`, `error` |
| `ssl_mode` | TEXT | `off`, `flexible`, `full`, `strict` |
| `ssl_last_checked` | TIMESTAMP | Последняя проверка SSL |
| `auto_https` | INTEGER | 1 = автоматический HTTPS |
| `caching_level` | TEXT | `off`, `basic`, `simplified`, `standard`, `aggressive` |
| `waf_mode` | TEXT | `off`, `low`, `medium`, `high` |
| `dns_records` | TEXT | Кэш DNS записей (JSON) |
| `last_sync_at` | TIMESTAMP | Последняя синхронизация с CF |
| `created_at` | TIMESTAMP | Дата создания |
| `updated_at` | TIMESTAMP | Дата обновления |

---

## 9. Связь Zone ↔ Domain

```
Zone                     Domain
────                     ──────
id              ←────    zone_id
key_id          ←────    key_id
ns_expected     ←────    ns
verified        ←────    ns_verified
```

- При создании/sync зоны автоматически создаётся root domain
- `ns` домена копируется из `ns_expected` зоны
- `ns_verified` обновляется при проверке активации зоны

---
