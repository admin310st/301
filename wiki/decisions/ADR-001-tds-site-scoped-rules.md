# ADR-001: TDS rules — site-scoped + удаление rule_domain_map

- **Статус:** Accepted
- **Дата:** 2026-03-03
- **Issue:** [#22 TDS: make rules site-scoped (add site_id)](https://github.com/admin310st/301/issues/22)

## Контекст

TDS правила сейчас привязаны к аккаунту (`tds_rules.account_id`) и связаны с доменами через промежуточную таблицу `rule_domain_map`:

```
tds_rules (account_id) → rule_domain_map → domains → sites
```

### Проблемы текущей модели

1. **Broken UX**: правило создаётся "в вакууме" без контекста сайта. Пользователь должен вручную привязать домены через пикер, который показывает ВСЕ домены аккаунта (включая donor/reserve, где нет CF Worker).

2. **Хрупкая связь**: UI (streams tab) реконструирует привязку к сайту через string comparison `binding.domain_name === site.acceptor_domain` — ненадёжно.

3. **Inconsistency**: Redirect rules уже привязаны к доменам напрямую (`redirect_rules.domain_id`). TDS — единственный потребитель `rule_domain_map`.

4. **Каскадный баг**: при удалении домена `rule_domain_map` записи удаляются (`domains.ts:1145`), что уничтожает связь TDS правила с сайтом. Правильное поведение — правило остаётся на сайте, сайт может получить новый acceptor domain.

### Аудит rule_domain_map

Полный аудит кодовой базы показал:

| Потребитель | Использует `redirect_rule_id`? | Использует `tds_rule_id`? |
|-------------|-------------------------------|--------------------------|
| `tds/tds.ts` (7 мест) | Нет | Да |
| `tds/sync.ts` (3 места) | Нет | Да |
| `domains/domains.ts` (1 место) | Нет | Через domain_id FK |

**`redirect_rule_id` FK мёртвый** — ни один endpoint не записывает и не читает. Redirect rules хранят `domain_id` прямо в своей таблице (после migration 0007).

**Вывод:** `rule_domain_map` обслуживает только TDS, и может быть полностью заменена колонкой `site_id` в `tds_rules`.

## Решение

### 1. Добавить `site_id` FK в `tds_rules`

```sql
ALTER TABLE tds_rules ADD COLUMN site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL;
```

`ON DELETE SET NULL` — при удалении сайта правило не теряется, а становится "осиротевшим" (можно переназначить).

### 2. Перенести `sync_status` в `tds_rules`

Из `rule_domain_map` используются:
- `binding_status` → новое поле `tds_rules.sync_status`
- `last_synced_at` → новое поле `tds_rules.last_synced_at`
- `last_error` → новое поле `tds_rules.last_error`

```sql
ALTER TABLE tds_rules ADD COLUMN sync_status TEXT
  CHECK(sync_status IN ('pending','applying','applied','failed')) DEFAULT 'pending';
ALTER TABLE tds_rules ADD COLUMN last_synced_at TEXT;
ALTER TABLE tds_rules ADD COLUMN last_error TEXT;
```

### 3. Удалить `rule_domain_map`

```sql
DROP TABLE IF EXISTS rule_domain_map;
```

### 4. Новая модель данных

```
Site (has acceptor_domain via domains.role='acceptor')
 └── tds_rules (site_id FK)
      └── acceptor domain implicit from site
```

Домен определяется через JOIN:
```sql
SELECT d.domain_name
FROM sites s
JOIN domains d ON d.site_id = s.id AND d.role = 'acceptor' AND d.blocked = 0
WHERE s.id = tds_rules.site_id
LIMIT 1
```

## Изменения по файлам

### Schema (migration)

| Действие | Описание |
|----------|----------|
| `ALTER TABLE tds_rules ADD COLUMN site_id` | FK на sites |
| `ALTER TABLE tds_rules ADD COLUMN sync_status` | pending/applying/applied/failed |
| `ALTER TABLE tds_rules ADD COLUMN last_synced_at` | timestamp последней синхронизации |
| `ALTER TABLE tds_rules ADD COLUMN last_error` | текст последней ошибки |
| Backfill `site_id` | Из существующих rule_domain_map → domains → sites |
| `DROP TABLE rule_domain_map` | После backfill |

### API (`src/api/tds/tds.ts`) — 7 мест

| Endpoint | Было | Станет |
|----------|------|--------|
| `POST /tds/rules` | Без site контекста | Обязательный `site_id` в body |
| `POST /tds/rules/from-preset` | INSERT в rule_domain_map | `site_id` в tds_rules, без rule_domain_map |
| `GET /tds/rules` | COUNT rule_domain_map | JOIN sites для site_name |
| `GET /tds/rules/:id` | JOIN rule_domain_map + domains | JOIN sites + domains(acceptor) |
| `PATCH /tds/rules/:id` | UPDATE rule_domain_map → pending | UPDATE tds_rules.sync_status → pending |
| `DELETE /tds/rules/:id` | UPDATE rule_domain_map → removed | DELETE tds_rules (или soft delete через status) |
| `POST /tds/rules/:id/domains` | **Удалить** | Не нужен |
| `GET /tds/rules/:id/domains` | **Удалить** | Не нужен |
| `DELETE /tds/rules/:id/domains/:domainId` | **Удалить** | Не нужен |

### Sync (`src/api/tds/sync.ts`) — 3 места

| Функция | Было | Станет |
|---------|------|--------|
| `handleTdsSync` SELECT | JOIN rule_domain_map → domains | JOIN sites → domains(acceptor) |
| `handleTdsSync` UPDATE | UPDATE rule_domain_map.binding_status | UPDATE tds_rules.sync_status |
| `computeVersionHash` | JOIN rule_domain_map | JOIN по tds_rules.updated_at (без binding) |

### Apply (`src/api/tds/tds.ts:675-771`)

| Было | Станет |
|------|--------|
| SELECT JOIN rule_domain_map → domains | SELECT JOIN sites → domains(acceptor) |
| UPDATE rule_domain_map → applied | UPDATE tds_rules.sync_status → applied |

### Domains (`src/api/domains/domains.ts:1145`)

| Было | Станет |
|------|--------|
| `DELETE FROM rule_domain_map WHERE domain_id = ?` | Удалить строку. TDS правила остаются на сайте. |

### Удаляемые endpoints

- `POST /tds/rules/:id/domains`
- `GET /tds/rules/:id/domains`
- `DELETE /tds/rules/:id/domains/:domainId`

Роуты убираются из `src/api/index.ts`.

## Миграция данных

```sql
-- 1. Backfill site_id из rule_domain_map → domains → sites
UPDATE tds_rules SET site_id = (
  SELECT d.site_id FROM rule_domain_map rdm
  JOIN domains d ON rdm.domain_id = d.id
  WHERE rdm.tds_rule_id = tds_rules.id
    AND rdm.binding_status != 'removed'
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.binding_status != 'removed'
);

-- 2. Backfill sync_status из rule_domain_map
UPDATE tds_rules SET sync_status = (
  SELECT rdm.binding_status FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.binding_status != 'removed'
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM rule_domain_map rdm
  WHERE rdm.tds_rule_id = tds_rules.id AND rdm.binding_status != 'removed'
);

-- 3. Drop table
DROP TABLE IF EXISTS rule_domain_map;
```

## План реализации

```
Фаза 1: migration   → schema changes + backfill + drop rule_domain_map
Фаза 2: api         → переписать tds.ts, sync.ts, убрать binding endpoints, fix domains.ts
Фаза 3: docs        → обновить wiki/API_TDS.md, wiki/TDS.md
Фаза 4: reviewer    → code review всех изменений
```

## Альтернативы

### A. Оставить rule_domain_map, добавить site_id как кэш
- Плюс: минимальные изменения в sync/apply
- Минус: дублирование данных, rule_domain_map всё ещё мёртвый для redirects, лишняя сложность

**Отклонено** — таблица не несёт ценности, только усложняет.

### B. Только добавить site_id, не удалять rule_domain_map
- Плюс: backward-compatible
- Минус: два источника правды, старые endpoints продолжают работать с неконсистентными данными

**Отклонено** — half-measure создаёт путаницу.

## Риски

| Риск | Митигация |
|------|-----------|
| Backfill не найдёт site для правила (orphaned binding) | Правила без site_id получат `sync_status='failed'`, видны в UI как "unassigned" |
| UI ломается (binding endpoints удалены) | Деплой API + UI одновременно |
| Rollback после DROP TABLE | Backfill обратимый только до DROP. Делаем backup перед миграцией |

## Последствия

- TDS правила становятся site-scoped — консистентно с redirect rules
- Убирается 1 таблица, 3 endpoint, ~200 строк кода
- Sync queries упрощаются (1 JOIN вместо 2)
- UI получает естественный flow: Site → TDS tab → Create Rule
