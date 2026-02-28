# TDS (Traffic Distribution System) — Спецификация

## 1. Обзор

TDS — модуль распределения трафика по правилам (geo, device, UTM, bot detection, MAB A/B). В отличие от Redirects (push-модель через CF Redirect Rules API), TDS использует **pull-модель**: Client Worker деплоится на аккаунт клиента, сам тянет правила из 301.st API, кеширует в локальную D1 и обрабатывает запросы на edge.

**Ключевое преимущество pull-модели:** после деплоя worker'а изменение правил **не требует CF API вызовов** — worker забирает правила сам. Это критично для Free-тарифа.

### Сравнение с Redirects

| | Redirects | TDS |
|---|-----------|-----|
| Модель | Push (CF Redirect Rules API) | Pull (Client Worker) |
| Условия | Hostname, Path | Geo, Device, OS, Browser, Bot, UTM, Path, Referrer |
| CF API при изменении правил | 1-2 вызова | **0** |
| Гранулярность статистики | Per-host | Per-rule |
| Каналов сбора статистики | 1 (CF GraphQL) | 3 (DO + AE + D1) |
| Лимиты клиента | 0% (нативные CF rules) | ~56% Worker/DO |

---

## 2. Два типа TDS-правил

### SmartLink (параметрический)

Условия по URL-параметрам: `utm_source`, `utm_campaign`, `sub*`, `click_id`.

- Срабатывает **только при наличии** нужных параметров
- Используется для A/B-тестов, разделения по источникам, DeepLink

### SmartShield (защитный)

Условия по CF-метаданным: geo, device, OS, browser, bot, ASN.

- Фоновая фильтрация: боты → белый сайт, целевой трафик → оффер
- Работает на **всех запросах** без параметров

### Общие действия (actions)

| Действие | Описание |
|----------|----------|
| `redirect` | 301/302 на URL (с подстановкой: `{country}`, `{device}`, `{path}`, `{host}`) |
| `block` | 403 Forbidden |
| `pass` | Пропустить к origin |
| `mab_redirect` | MAB-алгоритм выбирает вариант (Paid план) |

---

## 3. Архитектура

```
┌─────────────────────────────────────────────────────┐
│                 301.st Platform                       │
│                                                       │
│  DB301 (D1)                                           │
│  ┌───────────────┐                                    │
│  │ tds_rules      │  ← CRUD через API                │
│  │ tds_params     │  ← справочник параметров          │
│  │ rule_domain_map│  ← привязка правил к доменам      │
│  │ tds_stats      │  ← агрегаты с клиентов            │
│  └───────┬───────┘                                    │
│          │                                            │
│  API Worker (src/api/)                                │
│  ┌─────────────────────────────┐                      │
│  │ CRUD:  /tds/rules           │ ← UI (app.301.st)   │
│  │ Sync:  /tds/sync            │ ← Client Worker      │
│  │ Stats: /tds/postback        │ ← MAB конверсии      │
│  └─────────────────────────────┘                      │
└───────────────────────────────────────────────────────┘
                         │
    ┌────────────────────┘
    │  301.st деплоит Worker на аккаунт клиента
    ▼
┌─────────────────────────────────────────────────────┐
│          Customer Cloudflare Account (Free)           │
│                                                       │
│  TDS Worker (301-tds)      Durable Object (TdsCounter)│
│  ┌──────────────────┐     ┌──────────────────┐        │
│  │ Routes: N доменов │     │ In-memory agg    │        │
│  │ Rules: per-domain │────▶│ alarm (15 мин):  │        │
│  │                   │     │  flush → D1      │        │
│  │ Три канала:       │     └────────┬─────────┘        │
│  │  ├─ AE (always)   │             │                   │
│  │  ├─ DO (primary)  │             ▼                   │
│  │  └─ D1 (fallback) │    Client D1 (301-tds)         │
│  └──────────────────┘     ┌──────────────────┐        │
│                            │ tds_rules (cache) │        │
│  Analytics Engine          │ domain_config     │        │
│  ┌──────────────────┐     │ stats_hourly      │        │
│  │ TDS data points   │     │ mab_stats         │        │
│  │ 3 мес retention   │     │ sync_status       │        │
│  │ 100k points/день  │     └──────────────────┘        │
│  └──────────────────┘                                  │
└─────────────────────────────────────────────────────┘
```

---

## 4. Жизненный цикл правила

### Статусы правила (tds_rules.status)

| Статус | Значение |
|--------|----------|
| `draft` | Создано, не привязано к доменам |
| `active` | Привязано, доступно для sync |
| `disabled` | Отключено владельцем |

### Статусы привязки (rule_domain_map.binding_status)

| Статус | Значение |
|--------|----------|
| `pending` | Привязка создана, ждёт sync |
| `applied` | Worker забрал правило |
| `failed` | Ошибка sync |
| `removed` | Отвязано |

### Поток

```
POST /tds/rules          →  tds_rules (status: draft)
POST /tds/rules/:id/domains  →  rule_domain_map (binding_status: pending)
                                  tds_rules (status: active)
Client Worker GET /tds/sync   →  rule_domain_map (binding_status: applied)
Visitor → Worker → matchRule()  →  action (redirect/block/pass)
```

---

## 5. API Endpoints

### Файлы

```
src/api/tds/
├── conditions.ts     # Zod-валидация conditions/actions/logic_json
├── presets.ts        # Пресеты S1-S5, L1-L3 + expandTdsPreset()
├── tds.ts            # CRUD handlers
├── sync.ts           # Worker sync + MAB postback
└── client/
    ├── index.ts      # Client Worker + TdsCounter DO
    └── client.sql    # Client D1 schema
```

### Справочники

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/tds/presets` | GET | JWT | Список пресетов для UI |
| `/tds/params` | GET | JWT | Справочник доступных параметров |

### CRUD правил

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/tds/rules` | GET | JWT | Список правил аккаунта |
| `/tds/rules/:id` | GET | JWT | Одно правило + привязки |
| `/tds/rules` | POST | editor | Создать правило вручную |
| `/tds/rules/from-preset` | POST | editor | Создать из пресета |
| `/tds/rules/:id` | PATCH | editor | Обновить |
| `/tds/rules/:id` | DELETE | editor | Удалить (каскад rule_domain_map) |
| `/tds/rules/reorder` | PATCH | editor | Изменить приоритеты |

### Привязка к доменам

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/tds/rules/:id/domains` | POST | editor | Привязать к доменам |
| `/tds/rules/:id/domains` | GET | JWT | Список привязок |
| `/tds/rules/:id/domains/:domainId` | DELETE | editor | Отвязать |

### Синхронизация и постбэк

| Endpoint | Метод | Auth | Описание |
|----------|-------|------|----------|
| `/tds/sync` | GET | Service JWT | Данные для Worker sync (version-based delta) |
| `/tds/postback` | POST | — | Фиксация конверсии MAB |

---

## 6. Пресеты

Каждый пресет = одна запись `tds_rules` (не несколько, как в Redirects).

### SmartShield пресеты (S1-S5)

| ID | Название | Фиксированные условия | Пользователь задаёт | Приоритет |
|----|----------|----------------------|---------------------|-----------|
| S1 | Bot Shield | `bot: true` | `action` (redirect\|block), `action_url` | 10 |
| S2 | Geo Filter | — | `geo[]`, `action_url` | 50 |
| S3 | Mobile Redirect | `device: "mobile"` | `action_url` | 40 |
| S4 | Desktop Redirect | `device: "desktop"` | `action_url` | 40 |
| S5 | Geo + Mobile | `device: "mobile"` | `geo[]`, `action_url` | 30 |

### SmartLink пресеты (L1-L3)

| ID | Название | Фиксированные условия | Пользователь задаёт | Приоритет |
|----|----------|----------------------|---------------------|-----------|
| L1 | UTM Split | — | `utm_source[]`, `action_url` | 50 |
| L2 | Facebook Traffic | `utm_source: ["facebook","fb","fb_ads","meta"]`, `match_params: ["fbclid"]` | `action_url` | 40 |
| L3 | Google Traffic | `utm_source: ["google","google_ads"]`, `match_params: ["gclid"]` | `action_url` | 40 |

### Пример создания из пресета

```json
POST /tds/rules/from-preset
{
  "preset_id": "S5",
  "params": {
    "geo": ["RU", "KZ", "UA"],
    "action_url": "https://m.offer.example.com/cis"
  },
  "domain_ids": [45, 46],
  "rule_name": "CIS Mobile Offer"
}
```

---

## 7. Условия и валидация (conditions.ts)

### RuleConditions

| Поле | Тип | Описание |
|------|-----|----------|
| `geo` | `string[]` | ISO 3166-1 alpha-2 (RU, US, ...) — включение |
| `geo_exclude` | `string[]` | Исключение стран |
| `device` | `"mobile" \| "desktop" \| "any"` | Устройство |
| `os` | `string[]` | Android, iOS, Windows, macOS, Linux, iPadOS |
| `browser` | `string[]` | Chrome, Safari, Firefox, Edge, Opera |
| `bot` | `boolean` | Является ботом |
| `utm_source` | `string[]` | Значения utm_source |
| `utm_campaign` | `string[]` | Значения utm_campaign |
| `match_params` | `string[]` | OR-логика: совпадение если ЛЮБОЙ из параметров в URL |
| `path` | `string` | Regex для пути |
| `referrer` | `string` | Regex для реферера |

### match_params — OR-логика для click ID

Пресеты L2/L3 требуют OR: «utm_source=facebook ИЛИ fbclid в URL».

Логика в `matchRule()`:
- Если `match_params` задан и один из параметров найден в URL → условие выполнено, `utm_source` проверка пропускается
- Если `match_params` задан, но ни один не найден И `utm_source` не совпадает → правило не матчится

### LogicJson (хранится в tds_rules.logic_json)

```typescript
{
  conditions: RuleConditions;
  action: "redirect" | "block" | "pass" | "mab_redirect";
  action_url: string | null;
  status_code: 301 | 302 | 307;
  variants?: Array<{             // Только для mab_redirect
    url: string;
    alpha: number;               // Thompson Sampling параметр
    beta: number;
  }>;
}
```

---

## 8. Client Worker (src/api/tds/client/index.ts)

### Edge-оптимизации

| Оптимизация | Описание | Экономия |
|-------------|----------|----------|
| **Bypass статики** | `.css/.js/.png/.jpg/...` не проходят TDS | ~30-50% запросов |
| **Cache-Control** | `public, max-age=300` для URL-only правил | 10-100x для повторов |
| **Client Hints** | `Sec-CH-UA-Mobile` → точнее UA | Точность device |
| **iPad ≠ mobile** | iPad → desktop (стандарт арбитражных TDS) | Корректность |
| **Anti-loop** | `_tdspass` param предотвращает цикл | Предотвращение 5xx |
| **Kill switch** | `DISABLE_TDS=true` env var | Мгновенное отключение |
| **X-Edge-Redirect** | Debug header в DevTools | Отладка |
| **Accept-CH** | На passthrough-ответах запрашивает Client Hints | Будущие запросы |

### Device detection

Приоритет: Client Hints → UA fallback. iPad исключён из mobile.

```
Sec-CH-UA-Mobile: ?1 → mobile
Sec-CH-UA-Mobile: ?0 → desktop
Нет заголовка → UA regex (без iPad) → mobile | desktop
```

### Cache-Control стратегия

| Тип правила | Cache-Control | Причина |
|-------------|---------------|---------|
| Только по URL/path | `public, max-age=300` | Одинаковый результат для всех |
| По geo/device/UA | `private, no-cache` | Зависит от клиента |
| MAB | `private, no-cache` | Каждый запрос = новый выбор |

### Env bindings

```typescript
interface Env {
  DB: D1Database;                          // Client D1 (кеш правил + статистика)
  JWT_TOKEN: string;                       // Сервисный JWT для API
  ACCOUNT_ID: string;                      // ID аккаунта в 301.st
  API_URL: string;                         // https://api.301.st
  RULES_CACHE_TTL?: string;               // TTL sync в секундах (default: 300)
  DISABLE_TDS?: string;                    // Kill switch
  TDS_COUNTER: DurableObjectNamespace;     // DO для агрегации статистики
  TDS_ANALYTICS: AnalyticsEngineDataset;   // AE для fire-and-forget записи
}
```

---

## 9. Синхронизация правил (pull-модель)

### Как работает

1. Client Worker хранит `version` hash в `sync_status`
2. По TTL (default 300s) вызывает `GET /tds/sync?version={hash}`
3. Платформа:
   - Hash совпадает → **304 Not Modified** → 0 D1 writes
   - Hash изменился → полный набор правил → DELETE + INSERT

### Бюджет D1 writes

**Без delta sync:** 288 syncs/день × 2000 правил = **576k writes → превышение 100k лимита**

**С delta sync:** правила меняются редко → 99% sync = 0 writes → **~5k writes/день**

### Ответ API

```json
{
  "version": "a1b2c3d4e5f6",
  "rules": [
    {
      "id": 1,
      "domain_name": "example.com",
      "priority": 10,
      "conditions": { "geo": ["RU"], "device": "mobile" },
      "action": "redirect",
      "action_url": "https://offer.com/{country}",
      "status_code": 302,
      "active": true
    }
  ],
  "configs": [
    {
      "domain_name": "example.com",
      "tds_enabled": true,
      "default_action": "pass",
      "smartshield_enabled": true,
      "bot_action": "pass"
    }
  ]
}
```

---

## 10. Статистика

### Принцип: две таблицы по типу правил

SmartShield (защита) и SmartLink (маршрутизация) — разная ценность, разный объём, разный TTL.

| | SmartShield | SmartLink |
|---|-------------|-----------|
| Ценность | Информационная (блоки/пропуски) | Денежная (каждый переход) |
| Гранулярность | Per-domain, per-hour | Per-rule, per-hour, per-country, per-device |
| Объём (20 доменов) | ~20 строк/день | до ~24k строк/день |
| TTL (client D1) | 7 дней | 30 дней |
| TTL (DB301) | По решению | По решению |

### Два контура (client → platform)

| | Redirects | TDS |
|---|-----------|-----|
| Источник | CF GraphQL Analytics | DO + AE + D1 → Webhook push |
| Гранулярность | Per-host | Per-rule (shield/link) |
| Допустима потеря | Да | Нет (SmartLink — каждый переход) |
| Доставка на платформу | System Worker cron pull | Client Worker cron push (POST /tds) |

### Три канала записи (на клиенте)

```
Worker request
  │
  ├─── 1. AE: writeDataPoint()        ← fire-and-forget, 3-мес retention
  │
  ├─── 2. DO: emit event → TdsCounter ← primary, агрегация в памяти
  │     │
  │     └── alarm (15 мин) → flush → Client D1 (stats_shield / stats_link)
  │
  └─── 3. D1 fallback (при ошибке DO) ← UPSERT напрямую
```

**Запись разделяется по `tds_type` правила:**
- `traffic_shield` → `recordShieldStat(env, domain, ruleId, "blocks"|"passes")`
- `smartlink` → `recordLinkStat(env, domain, ruleId, country, device)`
- Bot check (shield) всегда пишет в `stats_shield`

### Push-модель: Client → Webhook

```
Client D1 (stats_shield + stats_link + mab_stats)
  │  cron: 0 */6 * * *
  │
  └── pushStats(env)
        │
        ├── SELECT completed hours (hour < current)
        ├── POST webhook.301.st/tds  { shield[], links[], mab[] }
        ├── DELETE pushed rows from client D1
        └── RESET mab impressions counter
              │
              ↓
DB301 (tds_stats_shield + tds_stats_link + tds_rules.logic_json)
```

**Защита от дублирования:** push отправляет только завершённые часы (`hour < текущий`), после успешной отправки строки удаляются. Текущий час остаётся в client D1 для агрегации.

### Durable Object: TdsCounter

- Один DO instance (`idFromName("global")`) на worker
- In-memory `Map<string, HourlyBucket>` — ключ: `{tds_type}:{domain}:{rule_id}:{hour}`
- Инкремент счётчиков без I/O на каждый запрос
- Alarm каждые 15 минут → batch flush:
  - Shield buckets → `stats_shield` (компактная запись)
  - Link buckets → `stats_link` (раскрытие by_country × by_device в отдельные строки)
- При ошибке flush → retry через 1 минуту

**Почему 15 минут:**

| Interval | Flush/день | D1 writes | % лимита |
|----------|-----------|-----------|----------|
| 5 мин | 288 | 63k | 63% |
| **15 мин** | **96** | **24k** | **24%** ✅ |
| 30 мин | 48 | 15k | 15% |

### Analytics Engine

```typescript
env.TDS_ANALYTICS.writeDataPoint({
  indexes: [event.domain],
  blobs: [domain, rule_id, action, country, device, variant_url],
  doubles: [1],  // count
});
```

- Zero overhead (non-blocking)
- Не расходует D1 writes
- 3-месяц retention
- SQL API для гибких запросов

### Client D1: две таблицы

**stats_shield** — компактная (SmartShield):
```sql
CREATE TABLE stats_shield (
    domain_name TEXT NOT NULL,
    rule_id INTEGER,
    hour TEXT NOT NULL,          -- '2026-02-26T14'
    hits INTEGER DEFAULT 0,
    blocks INTEGER DEFAULT 0,
    passes INTEGER DEFAULT 0,
    UNIQUE(domain_name, rule_id, hour)
);
```

**stats_link** — гранулярная (SmartLink):
```sql
CREATE TABLE stats_link (
    domain_name TEXT NOT NULL,
    rule_id INTEGER NOT NULL,
    hour TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'XX',
    device TEXT NOT NULL DEFAULT 'desktop',
    hits INTEGER DEFAULT 0,
    redirects INTEGER DEFAULT 0,
    UNIQUE(domain_name, rule_id, hour, country, device)
);
```

**Ключевое:** country/device — колонки в UNIQUE constraint, не JSON blob. Это даёт нативный SQL GROUP BY без парсинга.

### DB301: зеркальные таблицы

**tds_stats_shield** — агрегат по домену (без rule_id):
```sql
UNIQUE(account_id, domain_name, hour)
-- Поля: hits, blocks, passes, collected_at
```

**tds_stats_link** — полная гранулярность:
```sql
UNIQUE(account_id, domain_name, rule_id, hour, country, device)
-- Поля: hits, redirects, collected_at
```

### Webhook POST /tds

Auth: API key (SHA-256 hash) → `src/webhook/auth.ts`

**Payload:**
```json
{
  "account_id": 19,
  "timestamp": "2026-02-26T12:00:00Z",
  "shield": [
    { "domain_name": "example.com", "hour": "2026-02-26T06", "hits": 150, "blocks": 30, "passes": 120 }
  ],
  "links": [
    { "domain_name": "offer.com", "rule_id": 42, "hour": "2026-02-26T06", "country": "US", "device": "mobile", "hits": 80, "redirects": 80 }
  ],
  "mab": [
    { "rule_id": 42, "variant_url": "https://v1.com", "impressions": 50 }
  ]
}
```

**Обработка:**
- shield → UPSERT `DB301.tds_stats_shield` (additive: `hits = hits + excluded.hits`)
- links → UPSERT `DB301.tds_stats_link` (additive)
- mab → UPDATE `tds_rules.logic_json.variants[].impressions`

### TTL cleanup (safety net)

Cron `cleanupOldStats(env)` — удаляет записи старше TTL на клиенте:
- `stats_shield` → DELETE WHERE hour < now - 7d
- `stats_link` → DELETE WHERE hour < now - 30d

---

## 11. MAB (Multi-Armed Bandits)

### Где работает

- **Выбор варианта** — на edge (Client Worker): Thompson Sampling / UCB / Epsilon-Greedy
- **Обновление статистики** — AE + DO + D1 fallback (как обычные events)

### Postback (конверсии)

```
Конверсия на оффере → POST /tds/postback
{
  "rule_id": 42,
  "variant_url": "https://offer-a.com",
  "converted": 1,
  "revenue": 150
}
```

Платформа обновляет `alpha/beta` в `tds_rules.logic_json`. При следующем sync Worker получает обновлённые веса.

Postback идёт на **301.st API** (не на клиентский Worker):
- URL единый для всех клиентов
- Платформа знает mapping `rule_id → account`
- Не нужно раскрывать URL клиентского Worker'а

### Plan gating

| Функция | Free | Paid |
|---------|------|------|
| redirect, block, pass | ✅ | ✅ |
| SmartLink (UTM) | ✅ | ✅ |
| SmartShield (geo, bot) | ✅ | ✅ |
| mab_redirect | ❌ | ✅ |

---

## 12. Бюджет CF Free Plan

### Расчёт: 100 доменов, ~56k effective Worker invocations/день

| Ресурс | Free лимит | Расход | % |
|--------|-----------|--------|---|
| Worker requests | 100k/день | 56k | 56% |
| DO requests | 100k/день | 56k | 56% |
| D1 rows read | 5M/день | 617k | 12% |
| D1 rows written | 100k/день | 24k | 24% |
| AE data points | 100k/день | 56k | 56% |

### CF API при изменении правил

| Сценарий | CF API calls |
|----------|-------------|
| Изменение logic_json/conditions | **0** — Worker заберёт при sync |
| Добавление домена к правилу | 1-2 (re-seed + route) |
| Удаление домена | 1-2 (re-seed + delete route) |
| Включение/отключение правила | **0** |

---

## 13. Миграции

### DB301 (платформа)

```sql
-- 0013_tds_rules_extend.sql
ALTER TABLE tds_rules ADD COLUMN status TEXT DEFAULT 'draft';
ALTER TABLE tds_rules ADD COLUMN preset_id TEXT;

-- 0017_tds_stats_split.sql (заменяет старую 0014_tds_stats)
DROP TABLE IF EXISTS tds_stats;

CREATE TABLE tds_stats_shield (
    account_id INTEGER NOT NULL,
    domain_name TEXT NOT NULL,
    hour TEXT NOT NULL,
    hits INTEGER DEFAULT 0,
    blocks INTEGER DEFAULT 0,
    passes INTEGER DEFAULT 0,
    collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, domain_name, hour)
);

CREATE TABLE tds_stats_link (
    account_id INTEGER NOT NULL,
    domain_name TEXT NOT NULL,
    rule_id INTEGER NOT NULL,
    hour TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'XX',
    device TEXT NOT NULL DEFAULT 'desktop',
    hits INTEGER DEFAULT 0,
    redirects INTEGER DEFAULT 0,
    collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, domain_name, rule_id, hour, country, device)
);
```

### Client D1 (client.sql)

| Таблица | Назначение |
|---------|------------|
| `tds_rules` | Кеш правил (sync с API), включает `tds_type` |
| `domain_config` | Настройки домена (tds_enabled, bot_action) |
| `stats_shield` | SmartShield агрегаты: hits, blocks, passes (DO flush + D1 fallback) |
| `stats_link` | SmartLink гранулярная: hits, redirects × country × device |
| `mab_stats` | Impressions/conversions по вариантам MAB |
| `sync_status` | Version hash, last sync, last push, setup_reported |

---

## 14. Связь с другими модулями

- **Redirects** — нативные CF Redirect Rules (push-модель). TDS дополняет: сложная логика (geo/device/UTM) через Worker (pull-модель)
- **Domains** — правила привязываются к доменам через `rule_domain_map`
- **Sites** — группировка доменов в UI
- **Client Environment** — setup D1/KV/Workers/Secrets на CF аккаунте клиента (`src/api/client-env/`)
- **Integrations** — CF-токен клиента для деплоя Worker
- **Webhook Worker** — приём статистики: `POST /tds` (shield + link + mab) → DB301
