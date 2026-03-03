# TODO — Открытые вопросы и задачи

## Интеграционные тесты — Фаза 2 (2026-03-03)

### Результаты

| Блок | Тесты | Результат |
|------|-------|-----------|
| CE1–CE8 Client Environment | 8/8 | **ALL PASS** |
| R1–R7 Redirects | 7/7 | **ALL PASS** (pipeline починен, clicks собираются) |
| T1–T10 TDS | 10/10 | **ALL PASS** |
| H1–H8 Health | 8/8 | **ALL PASS** (VT key добавлен, данные получены) |

---

---

## Redirects

### Статистика редиректов

**Вопрос:** Точность сбора статистики per-rule vs per-domain

**Текущая реализация:**
- CF GraphQL Analytics API группирует по `clientRequestHTTPHost`
- Получаем общий count 3xx на домен, без разбивки по правилам
- Все правила домена получают одинаковый `clicks_total`

**Варианты улучшения:**

| Вариант | Описание | Точность |
|---------|----------|----------|
| Текущий | По host | Per-domain |
| Path grouping | Добавить `clientRequestPath` в dimensions | Лучше для T5/T6 |
| Firewall Events | Использовать `firewallEventsAdaptiveGroups` с rule_id | Per-rule |

**Решение:** _Требует обсуждения_

### Фильтрация ботов в статистике

**Проблема:** текущий запрос считает все 3xx ответы включая ботов (поисковые краулеры, мониторинг и т.п.)

**Варианты:**

| Вариант | Условие | Точность | План |
|---------|---------|----------|------|
| Bot Management (платный) | `botScore_geq: 30` в фильтре GraphQL | Высокая | Paid plan only |
| User-Agent фильтр (бесплатный) | `clientRequestUserAgent_notlike` по паттернам bot/crawler | Средняя | Free plan fallback |
| ASN blacklist | `clientASN_ne` для известных датацентров поисковиков | Средняя | Дополнительно к UA |

**Реализация:**

- [ ] Добавить опцию `bot_filter` в настройки cron (`settings:cron` в KV)
- [ ] Если `bot_filter = "bot_management"` — добавить `botScore_geq: 30` в GraphQL фильтр
- [ ] Если `bot_filter = "ua_pattern"` — добавить `clientRequestUserAgent_notlike` паттерны
- [ ] По умолчанию `bot_filter = "none"` (текущее поведение, Free plan)

**GraphQL пример (Bot Management):**
```graphql
httpRequestsAdaptiveGroups(
  filter: {
    datetime_geq: $datetimeStart
    datetime_lt: $datetimeEnd
    edgeResponseStatus_in: [301, 302, 307, 308]
    botScore_geq: 30
  }
)
```

### Частотный сбор статистики (Paid plan)

**Текущее:** один крон в 02:00 UTC — суточный сбор за вчера.

**Задача:** для платных тарифов 301 добавить дополнительные сборы каждые 12 и 6 часов.

**Расписание (без пересечения с суточным):**

| Интервал | Время UTC | Описание |
|----------|-----------|----------|
| 24ч (общий) | 02:00 | Суточный сбор за вчера (все пользователи) |
| 12ч (paid) | 08:00, 20:00 | Промежуточный сбор текущего дня |
| 6ч (paid) | 05:00, 11:00, 17:00, 23:00 | Частый сбор текущего дня |

**Реализация:**

- [ ] Добавить `stats_interval` в настройки аккаунта или плана (`24h` / `12h` / `6h`)
- [ ] В `cron.ts` добавить задачи `taskUpdateRedirectStats12h` и `taskUpdateRedirectStats6h`
- [ ] Промежуточные сборы запрашивают данные за текущий день (partial day) — `datetime_geq` = начало дня, `datetime_lt` = now
- [ ] Промежуточные сборы обновляют только `clicks_today`, НЕ ротируют `clicks_yesterday`
- [ ] Суточный крон (02:00) остаётся единственным, кто ротирует счётчики
- [ ] Фильтровать аккаунты по плану: промежуточные кроны только для paid

---

## Domains

### Валидации в handleUpdateDomain

- [ ] Добавить валидацию согласованности role/site_id
- [ ] Если role=acceptor, требовать site_id (или разрешить?)

### Очистка при удалении домена

- [ ] handleDeleteDomain: очищать redirect_rules перед удалением
- ~~handleDeleteDomain: очищать rule_domain_map~~ → убирается в ADR-001

### Fix GET /domains?project_id filter (Issue #13)

План: `~/.claude/plans/tingly-whistling-moler.md`

- [ ] SELECT — использовать `d.project_id` вместо `p.id as project_id`
- [ ] Проверить согласованность фильтра и ответа

---

## Sites

### handleUnassignDomainFromSite

- [ ] При откреплении роль = 'reserve' (donor только при создании редиректа T1/T5/T6/T7)
- [ ] Добавить предупреждение в ответе если открепляется acceptor

---

## Integrations

### Cloudflare: handleVerifyKey сломан

- [ ] `handleVerifyKey` использует `getDecryptedToken()` (ENCRYPTION_KEY) вместо рабочего `getDecryptedKey()` (MASTER_SECRET) — всегда возвращает `key_decrypt_failed`
- [ ] Эндпоинт намеренно отключён от роутера до исправления
- [ ] Фикс: переписать на `getDecryptedKey()`, добавить route обратно

### Namecheap

- [ ] Реализовать проверку expiration доменов
- [ ] Реализовать верификацию ключей

---

## TDS

### ADR-001: Site-scoped rules + удаление rule_domain_map

**ADR:** `wiki/decisions/ADR-001-tds-site-scoped-rules.md` | **Статус:** Accepted

- [ ] Migration: `site_id`, `sync_status`, `last_synced_at`, `last_error` в tds_rules
- [ ] Migration: backfill site_id из rule_domain_map → domains → sites
- [ ] Migration: DROP TABLE rule_domain_map
- [ ] API: переписать tds.ts — site_id обязательный, убрать binding endpoints
- [ ] API: переписать sync.ts — JOIN через sites вместо rule_domain_map
- [ ] API: убрать DELETE FROM rule_domain_map в domains.ts:1145
- [ ] API: убрать routes `/tds/rules/:id/domains` из index.ts
- [ ] Docs: обновить wiki/API_TDS.md, wiki/TDS.md

### MAB — оставшиеся задачи

- [ ] Postback auth hardening (rate limit, account isolation)
- [ ] DO per-variant bucketing (AE + mab_stats достаточно на старте)
- [ ] Frontend UI для MAB (drawer, выбор алгоритма, stats отображение)
- [ ] Plan gating enforcement (MAB только в Paid плане)

### Побочные задачи TDS

- [ ] При откреплении домена от сайта — деактивировать TDS (sync_status = 'pending', status = 'paused')
- [ ] При смене роли acceptor → другая — деактивировать TDS

### Client Worker: убрать pull-механизм

- [ ] Убрать `autoSync()` pull из клиентского TDS воркера (`src/api/tds/client/index.ts`) — push через `POST /tds/apply` теперь основной путь
- [ ] Провести детальную инспекцию cron на клиенте — выявить все scheduled задачи, убрать дублирующие с push

### E2E: эмуляция трафика TDS

- [ ] Добавить в тесты TDS эмуляцию трафика по доступным правилам — проверить запись статистики на клиенте

---

## Infrastructure

### Client Environment

- [ ] DO (TdsCounter) + AE (TDS_ANALYTICS) bindings в TDS worker deploy

### Webhooks

- [ ] Убрать `KV_CREDENTIALS` из webhook wrangler.toml (больше не нужен)

---
