# TODO — Открытые вопросы и задачи

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

### Cloudflare

_Нет открытых вопросов_

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

---

## Infrastructure

_Нет открытых вопросов_

---
