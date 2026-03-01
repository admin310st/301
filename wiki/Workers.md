# Workers — сводка по направлениям платформы

## Redirects

**Размещение на клиенте:** Нативные CF Redirect Rules. Правила деплоятся через Rulesets API в фазу `http_request_dynamic_redirect` напрямую в зону клиента. Без Workers — правила исполняются на CF edge до любого кода. Лимит 10 правил/зону (Free).

**Сбор статистики:** CF GraphQL Analytics API, dataset `httpRequestsAdaptiveGroups`, фильтр по `edgeResponseStatus` 301/302. Группировка по `clientRequestHTTPHost` — получаем count per domain (не per rule). Data retention на Free — 3 дня.

**Обработка:** Batch job (cron 1x/день) забирает вчерашние данные из GraphQL, добавляет в накопительные счётчики в D1 (`clicks_total`, `clicks_yesterday`, `clicks_today`). Так данные не теряются после 3-дневного retention.

**UI:** Таблица правил per site. Колонки: домен, target, тип (T1-T7), код (301/302), clicks, trend (up/down/neutral), sync status (synced/pending/error). Zone limits показываются в header.

---

## TDS

**Размещение на клиенте:** Worker `301-tds` деплоится в CF аккаунт клиента через `setupClientEnvironment()`. Правила хранятся в DB301, client worker тянет их по запросу через `GET /tds/sync` (pull model). Worker routes привязываются к доменам динамически. Исполнение на edge — geo/device/utm/bot routing, MAB A/B тесты.

**Сбор статистики:** Client worker пишет в client D1 (таблицы `stats_shield`, `stats_link`, `mab_stats`). По cron (`0 */6 * * *`) отправляет агрегаты через `POST webhook.301.st/tds` (API key auth, SHA-256).

**Обработка:** Webhook принимает три потока: `shield[]` → UPSERT в `tds_stats_shield` (per domain, per hour), `links[]` → UPSERT в `tds_stats_link` (per rule, per hour, per country, per device), `mab[]` → обновление impressions в `tds_rules.logic_json.variants`. Все счётчики аддитивные.

**UI:** Список правил с domain_count и статусом (draft/active/disabled). Drawer для создания из пресетов (S1-S5 shield, L1-L3 smartlink) или вручную. Привязка доменов к правилам. Drag & drop для приоритетов. MAB: выбор алгоритма (Thompson/UCB/e-greedy), варианты с весами, postback URL для конверсий.

---

## Health Check

**Размещение на клиенте:** Worker `301-health` деплоится вместе с `301-tds` через `setupClientEnvironment()`. Использует shared D1 (`301-client`) и KV (`301-keys` для VT API key). Рабочий cron: `0 */12 * * *`. При деплое временно добавляется `*/1` cron для self-check — после подтверждения установки удаляется (lazy cleanup).

**Сбор статистики:** Client worker автономно: проверяет VT по очереди (4 req/min). Результаты пишет в client D1 (`domain_threats`, `threat_check_queue`). Отправляет через `POST webhook.301.st/health` (threats).

**Обработка:** Webhook: threats → UPSERT `domain_threats` (score, categories, reputation, source). 301.st также самостоятельно poll'ит GraphQL 1x/сутки для anomaly detection и проверяет zones phishing через CF API. Два источника (client VT + platform) работают автономно.

**UI:** Светофор в таблице доменов: blocked, threat_score > 0, OK, нет данных. Детальная страница (`GET /domains/:id/health`): blocked reason, VT threats (score, categories). Зависит от `client_env` — если не настроен, показывается banner.

---

## Общая инфраструктура на клиенте

Все ресурсы создаются через `setupClientEnvironment()` (all or nothing):

| Ресурс | Имя | Назначение |
|--------|-----|------------|
| D1 | `301-client` | Shared DB: domain_list, domain_threats, TDS rules, stats |
| KV | `301-keys` | Ключи интеграций (VT_API_KEY и т.д.) |
| Worker | `301-health` | Мониторинг: VT checks |
| Worker | `301-tds` | TDS: маршрутизация по geo/device/utm/bot, MAB |

**Auth:** API key (nanoid 32). SHA-256 хэш в DB301, plain key в CF Secrets на клиенте. Shared auth для всех webhook endpoints: `src/webhook/auth.ts`.

**НЕ является частью окружения** (создаётся отдельно):
- CF Redirect Rules (push через Rulesets API, per zone)
- DNS A-records (auto при www-redirect)
- Worker Routes (динамические, per domain)

> **Подробности:** [API_ClientEnvironment](API_ClientEnvironment)
