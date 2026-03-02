# TODO — Открытые вопросы и задачи

## Интеграционные тесты — Фаза 2 (2026-03-02)

### Результаты

| Блок | Тесты | Результат |
|------|-------|-----------|
| CE1–CE8 Client Environment | 8/8 | **ALL PASS** |
| R1–R7 Redirects | 7/7 | **ALL PASS** (clicks=0 — CF Analytics delay) |
| T1–T10 TDS | 10/10 | **ALL PASS** |
| H1–H8 Health | — | **BLOCKED** (нет VT API key) |

### Блокеры найденные при тестировании

- [x] `rule_domain_map` таблица отсутствовала в DB301 — миграция 0018 создана и применена
- [x] `POST /system/cron/run` не был подключён к роутеру — route добавлен, задеплоен
- [x] **TDS apply/push endpoint** — `POST /tds/apply` реализован, задеплоен
- [ ] **Health тесты (H1–H8)** — требуют VT API key от пользователя

### Изменения в коде (при тестировании)

1. `schema/migrations/0018_rule_domain_map.sql` — новая миграция
2. `src/api/index.ts` — добавлен import `handleRunCronTask`, route `POST /system/cron/run`
3. `api-301` worker — redeployed
4. `src/api/tds/tds.ts` — добавлен `handleApplyTdsRules`, push TDS правил в client D1

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

---

## Domains

### Валидации в handleUpdateDomain

- [ ] Добавить валидацию согласованности role/site_id
- [ ] Если role=acceptor, требовать site_id (или разрешить?)

### Очистка при удалении домена

- [ ] handleDeleteDomain: очищать rule_domain_map перед удалением
- [ ] handleDeleteDomain: очищать redirect_rules перед удалением

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

### Namecheap

- [ ] Реализовать проверку expiration доменов
- [ ] Реализовать верификацию ключей

---

## TDS

### MAB — оставшиеся задачи

- [ ] Postback auth hardening (rate limit, account isolation)
- [ ] DO per-variant bucketing (AE + mab_stats достаточно на старте)
- [ ] Frontend UI для MAB (drawer, выбор алгоритма, stats отображение)
- [ ] Plan gating enforcement (MAB только в Paid плане)

### Побочные задачи TDS

- [ ] При откреплении домена от сайта — деактивировать TDS (binding_status = 'retired')
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
