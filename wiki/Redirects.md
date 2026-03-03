# Redirects — Спецификация редиректов для 301.st

## Обзор

Редиректы (301/302) — ключевой функционал для арбитража и SEO.

**Основные сценарии:**
- Блокировка домена рекламной сетью → редирект на резервный
- SEO canonical (www ↔ non-www)
- Миграция страниц и доменов
- Maintenance mode
- Создаётся в зоне источника, редирект на любую зону/внешний домен.

**Важно:** Избегайте DNS-редиректов (CNAME/A) — они не являются HTTP-редиректами и вредны для SEO.

> **API endpoints:** см. [API_Redirects](API_Redirects)

---

## Нативная реализация через Cloudflare

301.st использует **исключительно нативные Cloudflare Redirect Rules** (Single Redirects API) для базовых редиректов. Правила деплоятся через [Rulesets API](https://developers.cloudflare.com/rules/redirect-rules/) в фазу `http_request_dynamic_redirect`.

### Почему нативный подход

| Аспект | Нативные Redirect Rules | Workers |
|--------|------------------------|---------|
| Скорость | Мгновенно на edge, до Workers | ~1-5ms cold start |
| Лимиты Workers | Не расходует | 100K req/day (Free) |
| Стабильность | Инфраструктура CF, SLA 100% | Зависит от Worker runtime |
| Стоимость | Бесплатно (до 10 правил/зону) | Платно после лимитов |
| Сложная логика | Ограничена (нет geo/UA) | Полная гибкость |

**Вывод:** Для простых редиректов (T1-T7) — нативные правила. Для сложной логики (geo, UA, A/B) — TDS через Workers.

### Статистика редиректов

Статистика срабатываний получается через **CF GraphQL Analytics API**:

```graphql
query RedirectStats($zoneTag: String!, $datetimeStart: DateTime!, $datetimeEnd: DateTime!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        filter: {
          datetime_geq: $datetimeStart
          datetime_lt: $datetimeEnd
          edgeResponseStatus_in: [301, 302, 307, 308]
        }
        limit: 1000
        orderBy: [count_DESC]
      ) {
        dimensions {
          clientRequestHTTPHost
        }
        count
      }
    }
  }
}
```

- Dataset: `httpRequestsAdaptiveGroups`
- Тип переменных: `DateTime!` (формат `YYYY-MM-DDT00:00:00Z`), **не** `Date!`
- Фильтр: `edgeResponseStatus_in: [301, 302, 307, 308]` — все HTTP redirect-коды
- Group by: `clientRequestHTTPHost` — привязка к домену-источнику
- Data retention (Free): **3 дня** — поэтому batch job собирает данные ежедневно в накопительные счётчики (см. секцию Analytics ниже)
- **Требует permission:** `Analytics Read` (zone scope, id: `9c88f9c5bce24ce7af9a958ba9c504db`)

---

## Подходы к реализации

### 1. Single Redirects (рекомендуется для простых случаев)

**Где:** `Rules → Redirect Rules`

**Лимиты по тарифам:**

| План | Правил на зону | Wildcard | Regex |
|------|----------------|----------|-------|
| Free | 10 | ✅ | ❌ |
| Pro | 25 | ✅ | ❌ |
| Business | 50 | ✅ | ✅ |
| Enterprise | 300 | ✅ | ✅ |

**Возможности:**
- HTTP-редиректы (301/302) на основе: Hostname, Path
- Поддерживает wildcard (`*`), но **не regex** (Free/Pro)
- Статические и динамические URL-цели

**Ограничения:**
- ❌ Условия по `http.user_agent` — не поддерживается
- ❌ Условия по `ip.geoip.country` — не поддерживается
- ❌ Условия по HTTP-заголовкам — не поддерживается
- ❌ Regex-подстановки (`/user/123` → `/profile?id=123`) — только Business+

**Требования:**
- Proxy = ON (оранжевое облако) на DNS-записи

**Пример API-запроса:**
```json
POST https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets
{
  "name": "redirects",
  "kind": "zone",
  "phase": "http_request_dynamic_redirect",
  "rules": [{
    "expression": "http.host eq \"old.example.com\"",
    "action": "redirect",
    "action_parameters": {
      "from_value": {
        "status_code": 301,
        "target_url": {
          "expression": "concat(\"https://new.example.com\", http.request.uri.path)"
        },
        "preserve_query_string": true
      }
    }
  }]
}
```

---

### 2. Bulk Redirects (для массовых статических редиректов)

**Где:** `Rules → Bulk Redirects` (account-level)

**Лимиты по тарифам:**

| План | Правил | Списков | URL-редиректов |
|------|--------|---------|----------------|
| Free | 15 | 5 | 10,000 |
| Pro | 15 | 5 | 25,000 |
| Business | 15 | 5 | 50,000 |
| Enterprise | 50 | 25 | 1,000,000 |

**Возможности:**
- Массовые статические редиректы (CSV-импорт)
- Поддерживает условия по `ip.src.country` в expression правила

**Ограничения:**
- ❌ Динамические URL-цели
- ❌ Regex и string replacement

---

### 3. Workers / Snippets (для сложной логики)

**Когда использовать:**
- Условия по User-Agent (mobile redirect, bot detection)
- Условия по Geo (country, region)
- Комбинированные условия (geo + device + time)
- Kill-switch (204 No Content)
- Динамическая логика (A/B тесты с весами)

**Преимущества:**
- Не тратит лимит Single Redirects
- Полный контроль: regex, cookies, headers
- Масштабируется на любое количество доменов

**Лимиты Workers (Free):**
- 100,000 запросов/день
- 10ms CPU time

---

### 4. Page Rules (не рекомендуется)

- **Лимит:** 3 правила на Free — слишком мало
- **Статус:** Deprecated, мигрируйте на Redirect Rules

---

## Классификация шаблонов редиректов

### ✅ Настоящие редиректы (Single Redirects)

**(Free Plan, до 10 правил на зону)**

| ID | Название | Примечание | CF | 301.st |
|----|----------|------------|:--:|:------:|
| T1 | Domain → Domain | Основной кейс (донор → лендинг) | ✅ | ✅ |
| T2 | HTTP → HTTPS | CF делает автоматически, ручное правило надёжнее | ✅ | ⚠️ |
| T3 | non-www → www | SEO canonical | ✅ | ✅ |
| T4 | www → non-www | SEO canonical | ✅ | ✅ |
| T5 | Path prefix → Path | Wildcard (`/old/*`), но без regex | ✅ | ✅ |
| T6 | Exact path → URL | A/B-тесты, точечные замены | ✅ | ✅ |
| T7 | Maintenance redirect | Временный редирект на статус-страницу | ✅ | ✅ |

> **Легенда:** CF = поддержка Cloudflare, 301.st = реализация в платформе
> - ✅ — полная поддержка
> - ⚠️ — поддержка с ограничениями (T2: CF делает автоматически, отдельное правило избыточно)

---

### 🔄 Модификаторы (часть синтаксиса URL-цели)

| ID | Название | Синтаксис | Статус | CF | 301.st |
|----|----------|-----------|--------|:--:|:------:|
| T8 | Preserve query | `{?}` в конце URL | ✅ Обязательно для арбитража | ✅ | ✅ |
| T9 | Drop query | без `{?}` | ⛔ Редко — UTM/click_id критичны | ✅ | ⚠️ |

> **Примечание:** T9 поддерживается CF, но в 301.st по умолчанию всегда сохраняем query (T8)

---

### ❌ Не Single Redirects (требуют Worker/Snippets)

| ID | Название | Причина |
|----|----------|---------|
| T10 | User-Agent redirect | `http.user_agent` не поддерживается |
| T11 | Mobile redirect | `http.user_agent contains "mobi"` не поддерживается |
| T12 | Geo redirect | `ip.geoip.country` не поддерживается |
| T13 | Kill-switch | `about:blank` недопустим — нужен Worker с `204 No Content` |

---

## Полная таблица шаблонов: IF → THEN

### Примечания к синтаксису

- `{http.request.uri.path}` — путь без query string
- `{?}` — автоматически добавляет `?<query>` при наличии
- Все условия **чувствительны к регистру** (использовать `lower()` при необходимости)

---

### T1: Domain → Domain

| Вариант | Описание | IF (Expression) | THEN (Target) | Code | Применимость |
|---------|----------|-----------------|---------------|------|--------------|
| **T1a** | Preserve path + query | `http.host eq "source.com"` | `https://target.com{http.request.uri.path}{?}` | 301/302 | Донор → лендинг (основной) |
| **T1b** | All to root | `http.host eq "source.com"` | `https://target.com/` | 301/302 | Весь трафик на главную |
| **T1c** | To external URL | `http.host eq "source.com"` | `https://partner.com/offer123{?}` | 301/302 | Донор → внешний партнёр |
| **T1d** | Subdomain catch-all | `http.host eq "*.source.com"` | `https://target.com{http.request.uri.path}{?}` | 301/302 | Все поддомены → target |

**Примеры T1a:**
| Исходный URL | Результат |
|--------------|-----------|
| `source.com/` | `target.com/` |
| `source.com/offer` | `target.com/offer` |
| `source.com/offer?utm_source=fb&click_id=123` | `target.com/offer?utm_source=fb&click_id=123` |

---

### T2: HTTP → HTTPS

| Вариант | Описание | IF (Expression) | THEN (Target) | Code | Применимость |
|---------|----------|-----------------|---------------|------|--------------|
| **T2a** | Force HTTPS (all) | `http.request.scheme eq "http"` | `https://{http.host}{http.request.uri.path}{?}` | 301 | Весь сайт |
| **T2b** | Force HTTPS (path) | `http.request.scheme eq "http" and starts_with(http.request.uri.path, "/admin")` | `https://{http.host}{http.request.uri.path}{?}` | 301 | Только /admin/* |

> ⚠️ CF делает автоматически (Always Use HTTPS), но ручное правило даёт контроль.

---

### T3: non-www → www

| Вариант | Описание | IF (Expression) | THEN (Target) | Code | Применимость |
|---------|----------|-----------------|---------------|------|--------------|
| **T3a** | Apex to www | `http.host eq "example.com"` | `https://www.example.com{http.request.uri.path}{?}` | 301 | SEO canonical |

**Примеры:**
| Исходный URL | Результат |
|--------------|-----------|
| `example.com/` | `www.example.com/` |
| `example.com/page?id=1` | `www.example.com/page?id=1` |

---

### T4: www → non-www

| Вариант | Описание | IF (Expression) | THEN (Target) | Code | Применимость |
|---------|----------|-----------------|---------------|------|--------------|
| **T4a** | www to apex | `http.host eq "www.example.com"` | `https://example.com{http.request.uri.path}{?}` | 301 | SEO canonical |

---

### T5: Path prefix → Path

| Вариант | Описание | IF (Expression) | THEN (Target) | Code | Применимость |
|---------|----------|-----------------|---------------|------|--------------|
| **T5a** | Prefix to new path (same domain) | `http.host eq "example.com" and starts_with(http.request.uri.path, "/old/")` | `https://example.com/new/{?}` | 301/302 | Все `/old/*` → `/new/` |
| **T5b** | Prefix to other domain | `http.host eq "old.com" and starts_with(http.request.uri.path, "/blog/")` | `https://blog.new.com/{?}` | 301/302 | Миграция раздела |
| **T5c** | Remove locale prefix | `http.host eq "example.com" and starts_with(http.request.uri.path, "/en/")` | `https://example.com/{?}` | 301 | `/en/page` → `/page` |

> ⚠️ **Ограничение:** Wildcard работает, но нельзя сохранить часть пути после префикса. `/old/page1` → `/new/page1` требует Worker.

---

### T6: Exact path → URL

| Вариант | Описание | IF (Expression) | THEN (Target) | Code | Применимость |
|---------|----------|-----------------|---------------|------|--------------|
| **T6a** | Path to path (same domain) | `http.host eq "example.com" and http.request.uri.path eq "/old-page"` | `https://example.com/new-page{?}` | 301/302 | Переименование страницы |
| **T6b** | Path to other domain | `http.host eq "example.com" and http.request.uri.path eq "/partner"` | `https://partner.com/landing{?}` | 301/302 | Партнёрская ссылка |
| **T6c** | Path to URL (drop query) | `http.host eq "example.com" and http.request.uri.path eq "/redirect"` | `https://target.com/fixed` | 302 | Фиксированный target |

**Примеры T6a:**
| Исходный URL | Результат |
|--------------|-----------|
| `example.com/old-page` | `example.com/new-page` |
| `example.com/old-page?ref=abc` | `example.com/new-page?ref=abc` |

---

### T7: Maintenance redirect

| Вариант | Описание | IF (Expression) | THEN (Target) | Code | Применимость |
|---------|----------|-----------------|---------------|------|--------------|
| **T7a** | All to status page | `http.host eq "example.com"` | `https://status.example.com/maintenance` | **302** | Временное обслуживание |
| **T7b** | Except status page | `http.host eq "example.com" and not starts_with(http.request.uri.path, "/status")` | `https://example.com/status` | **302** | Maintenance с исключением |

> ⚠️ **Важно:** Используйте **302** (temporary), не 301 — иначе браузеры закешируют редирект.

---

## Сводная таблица параметров

| ID | Source Pattern | Preserve Path | Preserve Query | Default Code | Лимит |
|----|----------------|---------------|----------------|--------------|-------|
| T1a | `domain/*` | ✅ | ✅ | 301 | 1 |
| T1b | `domain/*` | ❌ | ❌ | 301 | 1 |
| T1c | `domain/*` | ❌ | ✅ | 301 | 1 |
| T1d | `*.domain/*` | ✅ | ✅ | 301 | 1 |
| T2a | `http://domain/*` | ✅ | ✅ | 301 | 1 |
| T2b | `http://domain/path/*` | ✅ | ✅ | 301 | 1 |
| T3a | `domain/*` (non-www) | ✅ | ✅ | 301 | 1 |
| T4a | `www.domain/*` | ✅ | ✅ | 301 | 1 |
| T5a | `domain/prefix/*` | ❌ | ✅ | 301 | 1 |
| T5b | `domain/prefix/*` | ❌ | ✅ | 301 | 1 |
| T5c | `domain/locale/*` | ❌ | ✅ | 301 | 1 |
| T6a | `domain/exact-path` | ❌ | ✅ | 301 | 1 |
| T6b | `domain/exact-path` | ❌ | ✅ | 301 | 1 |
| T6c | `domain/exact-path` | ❌ | ❌ | 302 | 1 |
| T7a | `domain/*` | ❌ | ❌ | **302** | 1 |
| T7b | `domain/*` (except) | ❌ | ❌ | **302** | 1 |

---

## Worker/Snippets шаблоны (T10-T13)

Эти сценарии **не поддерживаются** в Single Redirects и реализуются через Worker.

### T10: User-Agent redirect

```javascript
export default {
  async fetch(request) {
    const ua = request.headers.get('User-Agent') || '';
    if (/bot|crawler|spider/i.test(ua)) {
      return Response.redirect('https://safe.example.com/', 302);
    }
    return fetch(request);
  }
}
```

### T11: Mobile redirect

```javascript
export default {
  async fetch(request) {
    const ua = request.headers.get('User-Agent') || '';
    if (/mobile|android|iphone/i.test(ua)) {
      const url = new URL(request.url);
      return Response.redirect(`https://m.example.com${url.pathname}${url.search}`, 302);
    }
    return fetch(request);
  }
}
```

### T12: Geo redirect

```javascript
export default {
  async fetch(request) {
    const country = request.cf?.country || 'XX';
    const url = new URL(request.url);

    const geoTargets = {
      'RU': 'https://ru.example.com',
      'UA': 'https://ua.example.com',
      'DE': 'https://de.example.com'
    };

    if (geoTargets[country]) {
      return Response.redirect(`${geoTargets[country]}${url.pathname}${url.search}`, 302);
    }
    return fetch(request);
  }
}
```

### T13: Kill-switch (204 No Content)

```javascript
export default {
  async fetch(request) {
    // Полная блокировка — возвращаем пустой ответ
    return new Response(null, { status: 204 });
  }
}
```

---

## Рекомендации для 301.st

### Когда использовать Single Redirects:
- ✅ T1-T7 — простые статические редиректы
- ✅ До 10 правил на зону (Free)
- ✅ Не требуется логика по geo/UA/headers

### Когда использовать Worker:
- ✅ T10-T13 — условия по User-Agent, Geo
- ✅ Более 10 редиректов на зону
- ✅ Динамическая логика (A/B тесты, ротация)
- ✅ Kill-switch

### Общие правила:
1. **Всегда добавляйте `{?}`** для сохранения UTM и click_id
2. **Используйте 302 для временных редиректов** (maintenance)
3. **Проверяйте Proxy = ON** на DNS-записи
4. **Показывайте лимиты в UI:** «Осталось X из 10 редиректов»

---

## Интеграция с Cloudflare API

### Получение существующих правил

```bash
GET https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets?phase=http_request_dynamic_redirect
```

### Создание правила

```bash
POST https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets/{ruleset_id}/rules
```

### Обновление правила

```bash
PATCH https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets/{ruleset_id}/rules/{rule_id}
```

### Удаление правила

```bash
DELETE https://api.cloudflare.com/client/v4/zones/{zone_id}/rulesets/{ruleset_id}/rules/{rule_id}
```

## Связь с другими модулями

- **Domains** — редирект привязан к домену
- **Sites** — группировка редиректов по сайтам
- **TDS** — сложная логика (T10-T13) переходит в TDS-модуль
- **Analytics** — отслеживание срабатываний редиректов

### Влияние на роль домена

| Шаблоны | Влияние на role |
|---------|-----------------|
| T1, T5, T6, T7 | Устанавливает `donor` — эти шаблоны перенаправляют трафик |
| T3, T4 | **Не меняет роль** — canonical редиректы (www ↔ non-www) не перенаправляют трафик на другой домен |

> **Примечание:** При удалении всех "donor" редиректов (T1/T5/T6/T7) роль домена возвращается в `reserve`.

- Архитектура хранения (Templates/Presets в коде, Rules в D1)
- Привязка редиректов к домену (не к Site)
- Analytics через CF GraphQL API + накопительный счётчик
- Batch job 1 раз в день для сохранения статистики

 # Redirects Module — Финальная спецификация

## 1. Обзор

Модуль Redirects управляет простыми HTTP-редиректами (301/302) через Cloudflare Single Redirects API.

**Ключевые решения:**
-  Редиректы привязаны к **Domain** (не к Site)
-  Templates (T1-T7) и Presets (P1-Pn) хранятся в **коде** (constants)
-  Пользовательские правила хранятся в **D1** (redirect_rules)
-  Analytics через CF GraphQL API + накопительный счётчик
-  Batch job 1 раз в день для сохранения статистики

---

## 2. Архитектура

### 2.1 Общая схема

```
┌─────────────────────────────────────────────────────────────────┐
│ КОД (src/constants/redirects/)                                  │
├─────────────────────────────────────────────────────────────────┤
│ templates.ts    — T1-T7 (CF expressions, defaults)              │
│ presets.ts      — P1-Pn (комбинации шаблонов)                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ D1 DATABASE                                                     │
├─────────────────────────────────────────────────────────────────┤
│ redirect_rules  — пользовательские правила + analytics          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ CLOUDFLARE (клиентский аккаунт)                                 │
├─────────────────────────────────────────────────────────────────┤
│ Redirect Rules  — правила в зоне (phase: http_request_dynamic_redirect) │
│ GraphQL API     — аналитика 3xx ответов                         │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Иерархия данных

```
Account
  └── Project
        └── Site (логическая группа)
              └── Domain ← редирект привязан сюда
                    └── Zone (CF) ← правило деплоится сюда
```

**Важно:**
- Редирект = правило для конкретного домена-источника
- CF Redirect Rule создаётся в **зоне** домена
- Лимит 10 правил считается **per zone**
- Site используется только для группировки в UI

---

## 3. Templates (T1-T7)

Шаблоны — фиксированные CF expressions. Хранятся в коде.

### 3.1 Список шаблонов

| ID | Название | Категория | Описание |
|----|----------|-----------|----------|
| T1 | Domain → Domain | domain | Основной кейс (донор → лендинг) |
| T3 | non-www → www | canonical | SEO canonical |
| T4 | www → non-www | canonical | SEO canonical |
| T5 | Path prefix → Path | path | Wildcard `/old/*` → `/new/` |
| T6 | Exact path → URL | path | Точечная замена страницы |
| T7 | Maintenance | temporary | Временный редирект |

> **Примечание:** T2 (HTTP→HTTPS) исключён — CF делает автоматически

### 3.2 Параметры шаблонов

| ID | Настраиваемые параметры | Preserve Path | Preserve Query | Default Code |
|----|-------------------------|---------------|----------------|--------------|
| T1 | target_url | ✅ | ✅ | 301 |
| T3 | — (фиксирован) | ✅ | ✅ | 301 |
| T4 | — (фиксирован) | ✅ | ✅ | 301 |
| T5 | source_path, target_path | ❌ | ✅ | 301 |
| T6 | source_path, target_url | ❌ | ✅ | 301 |
| T7 | target_url | ❌ | ❌ | **302** |

### 3.3 CF Expressions

```typescript
// T1: Domain → Domain
{
  expression: 'http.host eq "{source_domain}"',
  target: 'concat("https://{target_domain}", http.request.uri.path)',
  preserve_query: true
}

// T3: non-www → www
{
  expression: 'http.host eq "{domain}"',
  target: 'concat("https://www.{domain}", http.request.uri.path)',
  preserve_query: true
}

// T4: www → non-www
{
  expression: 'http.host eq "www.{domain}"',
  target: 'concat("https://{domain}", http.request.uri.path)',
  preserve_query: true
}

// T5: Path prefix → Path
{
  expression: 'http.host eq "{domain}" and starts_with(http.request.uri.path, "{source_path}")',
  target: '"https://{domain}{target_path}"',
  preserve_query: true
}

// T6: Exact path → URL
{
  expression: 'http.host eq "{domain}" and http.request.uri.path eq "{source_path}"',
  target: '"{target_url}"',
  preserve_query: true
}

// T7: Maintenance
{
  expression: 'http.host eq "{domain}"',
  target: '"{target_url}"',
  preserve_query: false,
  status_code: 302  // ВАЖНО: всегда 302
}
```

---

## 4. Presets (P1-Pn)

Пресеты — готовые комбинации шаблонов. Хранятся в коде.

| ID | Название | Состав | Применение |
|----|----------|--------|------------|
| P1 | SEO Canonical (www) | T3 | Стандартный SEO |
| P2 | SEO Canonical (non-www) | T4 | Стандартный SEO |
| P3 | Domain Migration | T1 + T3 | Переезд домена с www-редиректом |
| P4 | Maintenance Mode | T7 | Временное обслуживание |
| P5 | Full Migration | T1 + T3 + T5 (×N) | Полный переезд с путями |

---

## 5. Database Schema

### 5.1 Таблица redirect_rules

```sql
CREATE TABLE IF NOT EXISTS redirect_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Владелец и связи
    account_id INTEGER NOT NULL,
    domain_id INTEGER NOT NULL,              -- Домен-источник
    zone_id INTEGER NOT NULL,                -- Зона CF (для лимитов)

    -- Шаблон и пресет
    template_id TEXT NOT NULL,               -- T1, T3, T4, T5, T6, T7
    preset_id TEXT,                          -- P1-Pn (nullable)
    preset_order INTEGER,                    -- Порядок в пресете

    -- Параметры правила
    rule_name TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',       -- JSON с параметрами
    status_code INTEGER NOT NULL DEFAULT 301
        CHECK(status_code IN (301, 302)),

    -- Состояние
    enabled INTEGER NOT NULL DEFAULT 1,

    -- Синхронизация с Cloudflare
    sync_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(sync_status IN ('pending', 'synced', 'error')),
    cf_rule_id TEXT,
    cf_ruleset_id TEXT,
    last_synced_at TEXT,
    last_error TEXT,

    -- Analytics (накопительные счётчики)
    clicks_total INTEGER NOT NULL DEFAULT 0,
    clicks_yesterday INTEGER NOT NULL DEFAULT 0,
    clicks_today INTEGER NOT NULL DEFAULT 0,
    last_counted_date TEXT,                  -- YYYY-MM-DD

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Foreign Keys
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
    FOREIGN KEY (zone_id) REFERENCES zones(id) ON DELETE CASCADE
);
```

### 5.2 Индексы

```sql
-- Выборка по аккаунту
CREATE INDEX idx_redirect_rules_account ON redirect_rules(account_id);

-- Подсчёт лимитов per zone
CREATE INDEX idx_redirect_rules_zone_enabled ON redirect_rules(zone_id, enabled);

-- Выборка по домену
CREATE INDEX idx_redirect_rules_domain ON redirect_rules(domain_id);

-- Batch job синхронизации
CREATE INDEX idx_redirect_rules_sync_pending ON redirect_rules(sync_status)
    WHERE sync_status = 'pending';

-- Группировка по пресетам
CREATE INDEX idx_redirect_rules_preset ON redirect_rules(account_id, preset_id, preset_order)
    WHERE preset_id IS NOT NULL;

-- Уникальность: один template на домен
CREATE UNIQUE INDEX idx_redirect_rules_unique ON redirect_rules(domain_id, template_id)
    WHERE enabled = 1;
```

### 5.3 Примеры записей

**Одиночный шаблон T1:**
```json
{
  "id": 1,
  "domain_id": 45,
  "template_id": "T1",
  "preset_id": null,
  "rule_name": "cryptoboss.pics → cryptoboss.com",
  "params": {
    "target_url": "https://cryptoboss.com"
  },
  "status_code": 301,
  "enabled": 1,
  "sync_status": "synced",
  "clicks_total": 12847
}
```

**Пресет P3 (2 правила):**
```json
// Правило 1
{
  "id": 2,
  "domain_id": 45,
  "template_id": "T1",
  "preset_id": "P3",
  "preset_order": 1,
  "rule_name": "Domain Migration (1/2)",
  "params": {"target_url": "https://new.com"}
}

// Правило 2
{
  "id": 3,
  "domain_id": 45,
  "template_id": "T3",
  "preset_id": "P3",
  "preset_order": 2,
  "rule_name": "Domain Migration (2/2)",
  "params": {}
}
```

---

## 6. Analytics

### 6.1 Источник данных

- CF GraphQL Analytics API (`https://api.cloudflare.com/client/v4/graphql`)
- Dataset: `httpRequestsAdaptiveGroups`
- Filter: `edgeResponseStatus_in: [301, 302, 307, 308]` — только HTTP redirect-коды (не весь диапазон 300-399)
- Тип переменных: `DateTime!` (формат ISO 8601 с временем), **не** `Date!`
- Group by: `clientRequestHTTPHost`
- **Требует permission:** `Analytics Read` (zone scope)

### 6.2 Лимиты Free Plan

| Параметр | Free | Pro | Business |
|----------|------|-----|----------|
| Data retention | **3 дня** | 30 дней | 90 дней |
| API calls/day | ~1000 | ~10000 | ~100000 |

### 6.3 Pipeline сбора статистики (`updateRedirectStats`)

Чтобы не терять данные после 3-дневного retention:

**Крон:** `0 2 * * *` — запускается ежедневно в **02:00 UTC** (`src/api/jobs/redirect-stats.ts`)

**Алгоритм:**
1. Получить все зоны с активными редиректами (JOIN `zones` + `redirect_rules`)
2. Для каждой зоны расшифровать CF token через `getDecryptedKey(env, key_id)`
3. Запросить CF GraphQL API `httpRequestsAdaptiveGroups` за **вчерашний день** (полные сутки 00:00–23:59 UTC)
4. Фильтр: `edgeResponseStatus_in: [301, 302, 307, 308]`, группировка по `clientRequestHTTPHost`
5. Маппинг host → domain_id через таблицу `domains` (WHERE `zone_id = ?`)
6. Для каждого домена с данными:
   - `clicks_total += count`
   - `clicks_yesterday = clicks_today` (ротация)
   - `clicks_today = count` (новые данные)
   - `last_counted_date = today` (idempotency guard — не обновлять дважды за день)
7. Для доменов **без данных** — ротация: `clicks_yesterday = clicks_today`, `clicks_today = 0`
8. Проверка аномалий: `detectAnomaly(clicks_today_old, new_count)` — сравнивает N-2 vs N-1
9. При серьёзной аномалии (`drop_90`, `zero_traffic`) — проверка phishing через CF Zone API

**Семантика полей в `redirect_rules`:**

| Поле | Описание |
|------|----------|
| `clicks_total` | Накопительный счётчик (всегда растёт) |
| `clicks_today` | Данные за **последний обработанный день** (N-1), НЕ за текущий день |
| `clicks_yesterday` | Данные за **позавчера** (N-2), для сравнения с `clicks_today` |
| `last_counted_date` | Дата последнего обновления (idempotency — предотвращает двойной подсчёт) |

> **Важно:** Несмотря на название, `clicks_today` содержит данные за вчера (N-1), а `clicks_yesterday` — за позавчера (N-2). Имена полей отражают их роль в UI (показываем «сегодня» и «вчера»), а не абсолютные даты.

### 6.4 Anomaly Detection

При обновлении счётчиков pipeline проверяет аномалии трафика:

```
detectAnomaly(N-2_value, N-1_value) → AnomalyType | null
```

| Аномалия | Условие | Действие |
|----------|---------|----------|
| `zero_traffic` | N-1 = 0, N-2 >= 20 | Проверка phishing через CF API |
| `drop_90` | N-1 < N-2 * 0.1 (падение >90%) | Проверка phishing через CF API |
| `drop_50` | N-1 < N-2 * 0.5 (падение >50%) | Только пометка, без phishing check |

При `zero_traffic` или `drop_90` — вызывается `checkZonePhishing()` через CF Zone API. Если phishing подтверждён, все домены зоны блокируются (`blocked = 1, blocked_reason = 'phishing'`).

### 6.5 Trend calculation (UI)

```javascript
const trend = clicks_today > clicks_yesterday * 1.1 ? 'up'
            : clicks_today < clicks_yesterday * 0.9 ? 'down'
            : 'neutral';
```

---

## 7. UI Flow

### 7.1 Навигация

```
Projects → Site → Redirects
```

### 7.2 List View

**Header:**
- Название Site
- Кнопка [+ New Redirect]
- Фильтр по домену
- Zone Limits (per zone)

**Таблица:**
| Status | Domain | Target | Type | Code | Clicks | Trend | Sync | Actions |
|--------|--------|--------|------|------|--------|-------|------|---------|

### 7.3 Create/Edit Drawer

1. Source Domain (select + лимит)
2. Template (T1-T7) или Preset (P1-Pn)
3. Parameters (зависят от template)
4. Status Code (301/302)
5. Preview (CF expression)
6. Save & Deploy

### 7.4 Sync Status

| Status | Badge | Описание |
|--------|-------|----------|
| synced | ✅ Synced | Правило активно в CF |
| pending | ⏳ Pending | Ожидает деплоя |
| error | ❌ Error | Ошибка CF API |

---

## 8. Validation

| Правило | Сообщение |
|---------|-----------|
| Zone limit | "Zone limit reached (10/10)" |
| Duplicate template | "This template already exists for this domain" |
| Invalid URL | "Target must be a valid HTTPS URL" |
| Path format | "Path must start with /" |

---

## 9. Scope & Exclusions

### В scope:
- ✅ Simple redirects (T1-T7)
- ✅ CF Single Redirects API
- ✅ Analytics via CF GraphQL API
- ✅ Накопительные счётчики

### Вне scope (TDS module):
- ❌ Geo redirects (T12)
- ❌ User-Agent redirects (T10, T11)
- ❌ Kill-switch (T13)
- ❌ A/B testing with weights
- ❌ Workers-based redirects

---

## 10. Implementation Plan

1. **Миграция БД** — создать redirect_rules
2. **API для UI** — CRUD endpoints
3. **Templates/Presets** — constants в коде
4. **CF Integration** — деплой правил в зону
5. **Analytics** — batch job + GraphQL API
