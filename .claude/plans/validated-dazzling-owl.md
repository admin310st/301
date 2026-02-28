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

### 1. Удалить `traffic_stats` из client D1 schema

| Файл | Строки | Действие |
|------|--------|----------|
| `src/api/client-env/setup.ts` | 80-87 | Удалить CREATE TABLE traffic_stats |
| `src/api/health/setup.ts` | 79-80 | Удалить CREATE TABLE traffic_stats |
| `src/api/health/client/client.sql` | 56-61 | Удалить CREATE TABLE traffic_stats |

### 2. Убрать broken code из health worker

| Файл | Что удалить |
|------|-------------|
| `src/api/health/bundle.ts` | `detectTrafficAnomalies()` (строки 250-266) |
| `src/api/health/bundle.ts` | `checkZonePhishing()` (строки 384-409) |
| `src/api/health/bundle.ts` | Блок anomalies+phishing в `runFullCycle` (строки 188-209) |
| `src/api/health/bundle.ts` | `zones` из webhook payload (только `threats`) |
| `src/api/health/client/domains.ts` | `detectTrafficAnomalies()` (строки 164-181) |

### 3. Убрать zones processing из webhook handler

| Файл | Что удалить |
|------|-------------|
| `src/webhook/health.ts` | `zones` из WebhookPayload interface |
| `src/webhook/health.ts` | `processZonePhishing()` (строки 136-172) |
| `src/webhook/health.ts` | zones processing в `processHealthData()` (строки 106-116) |

### 4. Dead code cleanup

| Файл | Что удалить |
|------|-------------|
| `src/api/integrations/providers/cloudflare/d1-sync.ts` | `syncTrafficStats()`, `batchSyncToClient()` |

### 5. Документация

| Файл | Что |
|------|-----|
| `wiki/API_ClientEnvironment.md` | health = VT only; убрать traffic_stats, phishing, zones из payload |
| `wiki/Health_Check.md` | Проверить актуальность |
| `wiki/TODO.md` | Обновить чеклист |

---

## Verification

1. `npm run lint`
2. `npm run typecheck`
3. Grep `traffic_stats` — не должно остаться в client-контексте
4. Grep `CF_API_TOKEN` — не должно остаться в health worker контексте
