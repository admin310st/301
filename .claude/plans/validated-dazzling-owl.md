# Коррекция: Health Worker + Client D1 + Документация

## Согласованная архитектура

| Что | Кто | Статус |
|-----|-----|--------|
| Redirect stats (CF GraphQL) | Платформа (`redirect-stats.ts` cron) | Работает |
| Anomaly detection + Phishing check | Платформа (`redirect-stats.ts`) | Работает |
| VT domain checks | Клиент (`301-health`) → webhook | Работает |
| TDS stats | Клиент (`301-tds`) → webhook | Работает |

**Принцип**: CF GraphQL/Zones API требуют CF token → делает платформа. VT API → делает клиент (политика Google).

---

## Коррекции

Все пункты открыты.

### 1. Удалить `traffic_stats` из client D1 schema

| Файл | Действие |
|------|----------|
| `src/api/client-env/setup.ts` | Удалить CREATE TABLE traffic_stats |
| `src/api/health/setup.ts` | Удалить CREATE TABLE traffic_stats |
| `src/api/health/client/client.sql` | Удалить CREATE TABLE traffic_stats |

### 2. Убрать broken code из health worker

Client worker НЕ имеет CF token → `detectTrafficAnomalies()` и `checkZonePhishing()` не работают.

| Файл | Что удалить |
|------|-------------|
| `src/api/health/bundle.ts` | `detectTrafficAnomalies()`, `checkZonePhishing()`, блок anomalies+phishing в `runFullCycle`, `zones` из webhook payload |
| `src/api/health/client/domains.ts` | `detectTrafficAnomalies()` |
| `src/api/health/client/phishing.ts` | `checkZonePhishing()` + весь файл если больше ничего нет |
| `src/api/health/client/index.ts` | Импорты и вызовы `detectTrafficAnomalies`, `checkZonePhishing` |

### 3. Убрать zones processing из webhook handler

| Файл | Что удалить |
|------|-------------|
| `src/webhook/health.ts` | `zones` из payload, `processZonePhishing()`, zones processing в `processHealthData()` |

### 4. Dead code cleanup

| Файл | Что удалить |
|------|-------------|
| `src/api/integrations/providers/cloudflare/d1-sync.ts` | `syncTrafficStats()`, `batchSyncToClient()` |

### 5. Документация

| Файл | Что | Статус |
|------|-----|--------|
| `wiki/Health_Check.md` | Убрать упоминание traffic_stats, zones из client worker | Открыто |
| `wiki/API_Health.md` | Убрать zones из webhook payload example | Открыто |
| `wiki/API_ClientEnvironment.md` | Убрать traffic_stats из client D1 описания | Открыто |

> wiki/Home.md, wiki/Workers.md — уже актуальны после реструктуризации.

---

## Verification

1. `npm run lint`
2. `npm run typecheck`
3. Grep `traffic_stats` — не должно остаться в client-контексте
4. Grep `CF_API_TOKEN` — не должно остаться в health worker контексте
5. Grep `detectTrafficAnomalies` — 0 результатов в client/bundle
6. Grep `processZonePhishing` — 0 результатов в webhook/health.ts
