##  Domains API

### Базовый URL

```
https://api.301.st/domains
```

---

### 1 GET /domains

Список всех доменов аккаунта с группировкой по root domain (2-го уровня).

**Требует:** `Authorization: Bearer <access_token>`

**Query параметры:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `role` | string | Фильтр по роли: `acceptor`, `donor`, `reserve` |
| `blocked` | boolean | Фильтр по блокировке: `true`, `false` |
| `zone_id` | number | Фильтр по зоне |
| `site_id` | number | Фильтр по сайту |
| `project_id` | number | Фильтр по проекту |

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/domains" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "total": 5,
  "groups": [
    {
      "root": "example.com",
      "zone_id": 1,
      "domains": [
        {
          "id": 1,
          "site_id": 10,
          "zone_id": 1,
          "key_id": 42,
          "parent_id": null,
          "domain_name": "example.com",
          "role": "acceptor",
          "ns": "ns1.cloudflare.com,ns2.cloudflare.com",
          "ns_verified": 1,
          "proxied": 1,
          "blocked": 0,
          "blocked_reason": null,
          "ssl_status": "valid",
          "expired_at": null,
          "created_at": "2025-01-10T08:00:00Z",
          "updated_at": "2025-01-10T08:00:00Z",
          "site_name": "Main Landing",
          "site_status": "active",
          "project_id": 5,
          "project_name": "Brand Campaign Q1"
        },
        {
          "id": 2,
          "site_id": 10,
          "zone_id": 1,
          "key_id": 42,
          "parent_id": 1,
          "domain_name": "api.example.com",
          "role": "acceptor",
          "ns": "ns1.cloudflare.com,ns2.cloudflare.com",
          "ns_verified": 1,
          "proxied": 1,
          "blocked": 0,
          "blocked_reason": null,
          "ssl_status": "valid",
          "expired_at": null,
          "created_at": "2025-01-11T09:00:00Z",
          "updated_at": "2025-01-11T09:00:00Z",
          "site_name": "Main Landing",
          "site_status": "active",
          "project_id": 5,
          "project_name": "Brand Campaign Q1"
        },
        {
          "id": 3,
          "site_id": null,
          "zone_id": 1,
          "key_id": 42,
          "parent_id": 1,
          "domain_name": "blog.example.com",
          "role": "reserve",
          "ns": "ns1.cloudflare.com,ns2.cloudflare.com",
          "ns_verified": 1,
          "proxied": 1,
          "blocked": 0,
          "blocked_reason": null,
          "ssl_status": "valid",
          "expired_at": null,
          "created_at": "2025-01-11T10:00:00Z",
          "updated_at": "2025-01-11T10:00:00Z",
          "site_name": null,
          "site_status": null,
          "project_id": null,
          "project_name": null
        }
      ]
    },
    {
      "root": "promo-brand.io",
      "zone_id": 2,
      "domains": [
        {
          "id": 4,
          "site_id": 10,
          "zone_id": 2,
          "key_id": 42,
          "parent_id": null,
          "domain_name": "promo-brand.io",
          "role": "donor",
          "ns": "ns3.cloudflare.com,ns4.cloudflare.com",
          "ns_verified": 1,
          "proxied": 1,
          "blocked": 0,
          "blocked_reason": null,
          "ssl_status": "valid",
          "expired_at": null,
          "created_at": "2025-01-12T08:00:00Z",
          "updated_at": "2025-01-12T08:00:00Z",
          "site_name": "Main Landing",
          "site_status": "active",
          "project_id": 5,
          "project_name": "Brand Campaign Q1"
        }
      ]
    }
  ]
}
```

**С фильтрами:**

```bash
# Только заблокированные домены
curl -X GET "https://api.301.st/domains?blocked=true" \
  -H "Authorization: Bearer <access_token>"

# Только доноры
curl -X GET "https://api.301.st/domains?role=donor" \
  -H "Authorization: Bearer <access_token>"

# Домены конкретного сайта
curl -X GET "https://api.301.st/domains?site_id=10" \
  -H "Authorization: Bearer <access_token>"

# Домены конкретного проекта
curl -X GET "https://api.301.st/domains?project_id=5" \
  -H "Authorization: Bearer <access_token>"
```

---

### 2 GET /domains/:id

Получить детали конкретного домена.

**Требует:** `Authorization: Bearer <access_token>`

**Пример запроса:**

```bash
curl -X GET "https://api.301.st/domains/2" \
  -H "Authorization: Bearer <access_token>"
```

**Успешный ответ:**

```json
{
  "ok": true,
  "domain": {
    "id": 2,
    "account_id": 1,
    "site_id": 10,
    "zone_id": 1,
    "key_id": 42,
    "parent_id": 1,
    "domain_name": "api.example.com",
    "role": "acceptor",
    "ns": "ns1.cloudflare.com,ns2.cloudflare.com",
    "ns_verified": 1,
    "proxied": 1,
    "blocked": 0,
    "blocked_reason": null,
    "ssl_status": "valid",
    "expired_at": null,
    "created_at": "2025-01-11T09:00:00Z",
    "updated_at": "2025-01-11T09:00:00Z",
    "cf_zone_id": "abc123def456",
    "zone_status": "active",
    "ns_expected": "ns1.cloudflare.com,ns2.cloudflare.com",
    "site_name": "Main Landing",
    "site_status": "active",
    "project_id": 5,
    "project_name": "Brand Campaign Q1"
  }
}
```

**Ошибки:**

```json
{
  "ok": false,
  "error": "domain_not_found"
}
```

---

### 3 POST /domains

Создать поддомен (3-го/4-го уровня).

**Требует:** `Authorization: Bearer <access_token>` (owner или editor)

> **Важно:** Root домены (2-го уровня) создаются автоматически через sync зон. Этот endpoint только для поддоменов.

**Параметры запроса:**

| Поле | Тип | Обязательно | Описание |
|------|-----|-------------|----------|
| `domain_name` | string | да | Полное имя домена (только 3-й+ уровень) |
| `zone_id` | number | нет | ID зоны (наследует key_id и ns) |
| `parent_id` | number | нет | ID родительского домена |
| `role` | string | нет | Роль: `acceptor`, `donor`, `reserve` (по умолчанию: `reserve`) |

**Пример запроса:**

```bash
curl -X POST "https://api.301.st/domains" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "domain_name": "promo.example.com",
    "zone_id": 1,
    "parent_id": 1,
    "role": "donor"
  }'
```

**Успешный ответ:**

```json
{
  "ok": true,
  "domain": {
    "id": 6,
    "domain_name": "promo.example.com",
    "zone_id": 1,
    "parent_id": 1,
    "role": "donor"
  }
}
```

**Ошибки:**

```json
// Попытка создать root domain
{
  "ok": false,
  "error": "cannot_create_root_domain",
  "message": "Root domains (2nd level) are created via zone sync. Use /zones/sync or add zone in Cloudflare."
}

// Домен уже существует
{
  "ok": false,
  "error": "domain_already_exists"
}

// Зона не найдена
{
  "ok": false,
  "error": "zone_not_found"
}

// Родительский домен не найден
{
  "ok": false,
  "error": "parent_not_found"
}

// Не переданы обязательные поля
{
  "ok": false,
  "error": "missing_fields",
  "fields": ["domain_name"]
}
```

---

### 4 PATCH /domains/:id

Обновить домен.

**Требует:** `Authorization: Bearer <access_token>` (owner или editor)

**Параметры запроса:**

| Поле | Тип | Описание |
|------|-----|----------|
| `role` | string | Новая роль: `acceptor`, `donor`, `reserve` |
| `site_id` | number/null | Привязка к сайту |
| `blocked` | boolean | Статус блокировки |
| `blocked_reason` | string/null | Причина блокировки |

**Пример запроса:**

```bash
curl -X PATCH "https://api.301.st/domains/2" \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "donor",
    "blocked": true,
    "blocked_reason": "ad_network"
  }'
```

**Успешный ответ:**

```json
{
  "ok": true
}
```

**Ошибки:**

```json
// Домен не найден
{
  "ok": false,
  "error": "domain_not_found"
}

// Нет полей для обновления
{
  "ok": false,
  "error": "no_fields_to_update"
}
```

---

### 5 DELETE /domains/:id

Удалить домен.

**Требует:** `Authorization: Bearer <access_token>` (owner или editor)

> **Важно:** Root домены (2-го уровня) удалить нельзя — они управляются через зоны.

**Пример запроса:**

```bash
curl -X DELETE "https://api.301.st/domains/6" \
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
// Домен не найден
{
  "ok": false,
  "error": "domain_not_found"
}

// Нельзя удалить root домен
{
  "ok": false,
  "error": "cannot_delete_root_domain",
  "message": "Root domain is managed by zone. Delete the zone instead."
}
```

---

### 6 Роли доменов

| Роль | Описание | Может быть primary? |
|------|----------|---------------------|
| `acceptor` | Основной домен (лендинг, TDS) — принимает трафик | ✅ Да |
| `donor` | Донор для редиректов (используется в рекламе) | ❌ Нет |
| `reserve` | В резерве, не привязан к сайту | ❌ Нет |

---

### 7 Причины блокировки

| Причина | Описание |
|---------|----------|
| `unavailable` | Домен недоступен технически |
| `ad_network` | Заблокирован рекламной сетью |
| `hosting_registrar` | Заблокирован хостингом/регистратором |
| `government` | Государственная блокировка |
| `manual` | Ручная блокировка пользователем |

---

### 8 Связь с Site/Project

Домены связаны с проектами через сайты:

```
Domain.site_id → Site.project_id → Project
```

**Поля из связанных таблиц:**

| Поле | Источник | Описание |
|------|----------|----------|
| `site_name` | sites.site_name | Название сайта |
| `site_status` | sites.status | Статус сайта: `active`, `paused`, `archived` |
| `project_id` | projects.id | ID проекта |
| `project_name` | projects.project_name | Название проекта |

> **Примечание:** Если `site_id = null`, домен находится в резерве (Free Domains) и не привязан к проекту.

---

### 9 Таблица endpoints

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/domains` | GET | ✅ JWT | Список доменов с группировкой |
| `/domains/:id` | GET | ✅ JWT | Детали домена |
| `/domains` | POST | ✅ JWT (owner/editor) | Создать поддомен |
| `/domains/:id` | PATCH | ✅ JWT (owner/editor) | Обновить домен |
| `/domains/:id` | DELETE | ✅ JWT (owner/editor) | Удалить домен |

---
