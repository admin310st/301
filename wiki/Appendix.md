# Проекты, Сайты, Зоны и Домены в 301.st

## 📚 Оглавление

1. [Общая концепция](#общая-концепция)
2. [Иерархия сущностей](#иерархия-сущностей)
3. [Детальное описание](#детальное-описание)
4. [Варианты использования](#варианты-использования)
5. [Управление блокировками](#управление-блокировками)
6. [Сценарии удаления](#сценарии-удаления)
7. [Миграция и перенос](#миграция-и-перенос)

---

## Общая концепция

301.st использует **четырёхуровневую иерархию** для управления доменами и трафиком:

```
Account (Аккаунт клиента)
  └─ Project (Проект/Кампания)
       └─ Site (Сайт)
            └─ Zone (Зона Cloudflare)
                 └─ Domain (Домен)
```

### Ключевые принципы:

- ✅ **Домены = активы** — при удалении сайта домен сохраняется и может быть переиспользован
- ✅ **Зоны = техническая инфраструктура** — при удалении зоны все её домены удаляются
- ✅ **1 зона = 1 сайт** — строгая привязка для простоты управления
- ✅ **Multi-tenant изоляция** — данные клиентов полностью изолированы через `account_id`

---

## Иерархия сущностей

### 🎯 Project (Проект)

**Назначение:** Логический контейнер верхнего уровня для группировки сайтов в рамках одной кампании или бренда.

**Основные поля:**
- `project_name` — название кампании (например, "Casino Q1 2025")
- `brand_tag` — краткий тег бренда
- `commercial_terms` — условия сотрудничества (RS, CPA, фикс)
- `start_date` / `end_date` — временные рамки

**Связи:**
- Принадлежит одному `Account`
- Содержит множество `Sites`

**Пример:**
```json
{
  "project_name": "Casino Brand Q1",
  "brand_tag": "casino",
  "commercial_terms": "RevShare 40%",
  "start_date": "2025-01-01",
  "end_date": "2025-03-31"
}
```

---

### 🌐 Site (Сайт)

**Назначение:** Функциональная единица управления трафиком. Объединяет домены, TDS-правила, аналитику и мониторинг.

**Основные поля:**
- `site_name` — название сайта
- `lang_code` — язык версии (ru, en, fr)
- `primary_zone_id` — ссылка на основную зону (денормализация)
- `primary_domain_id` — ссылка на основной домен (денормализация)
- `tds_enabled` — флаг активности TDS
- `monitoring_enabled` — флаг мониторинга
- `integrations_json` — подключённые сервисы (GA, YM, HostTracker)

**Связи:**
- Принадлежит одному `Project`
- Содержит множество `Zones` и `Domains`

**Пример:**
```json
{
  "site_name": "Casino RU",
  "lang_code": "ru",
  "tds_enabled": true,
  "monitoring_enabled": true,
  "integrations_json": {
    "google_analytics": "UA-123456-1",
    "yandex_metrica": "98765432"
  }
}
```

---

### ☁️ Zone (Зона Cloudflare)

**Назначение:** DNS-зона в Cloudflare, содержащая настройки SSL, proxy, кеширования и WAF.

**Основные поля:**
- `cf_zone_id` — ID зоны в Cloudflare API (уникальный)
- `ssl_mode` — режим SSL (off, flexible, full, strict)
- `proxied` — использование Cloudflare Proxy
- `auto_https` — автоматический HTTPS
- `caching_level` — уровень кеширования
- `waf_mode` — режим Web Application Firewall

**Связи:**
- Принадлежит одному `Site`
- Содержит множество `Domains`

**Принцип:** 1 зона = 1 сайт (строгая привязка)

**Пример:**
```json
{
  "cf_zone_id": "abc123def456",
  "ssl_mode": "full",
  "proxied": true,
  "auto_https": true,
  "caching_level": "standard",
  "waf_mode": "medium"
}
```

---

### 🌍 Domain (Домен)

**Назначение:** Доменное имя — технический актив клиента для приёма трафика.

**Основные поля:**
- `domain_name` — FQDN (уникально в системе)
- `registrar` — регистратор (namecheap, godaddy)
- `domain_role` — роль домена (primary, donor)
- `target_type` — тип маршрутизации (ip, cname, redirect, worker)
- `target_value` — адрес назначения
- `status` — статус (new, active, blocked)
- `ns_status` — статус NS-записей (pending, verified, error)

**Связи:**
- Принадлежит одному `Zone` (обязательно)
- Может принадлежать `Site` и `Project` (опционально)

**Роли домена:**

| Роль | Описание | Типичное использование |
|------|----------|------------------------|
| `primary` | Основной домен с TDS | Принимает весь трафик, распределяет по офферам |
| `donor` | Донор для рекламы | Редирект с рекламных сетей на primary |

**Пример Primary:**
```json
{
  "domain_name": "casino-brand.com",
  "domain_role": "primary",
  "target_type": "ip",
  "target_value": "1.2.3.4",
  "status": "active",
  "ns_status": "verified"
}
```

**Пример Donor:**
```json
{
  "domain_name": "win-today1.com",
  "domain_role": "donor",
  "target_type": "redirect",
  "target_value": "https://casino-brand.com",
  "status": "active",
  "ns_status": "verified"
}
```

---

## Варианты использования

### Вариант A: Строгая привязка (1 зона = 1 сайт)

**Рекомендуется для:** Арбитражного трафика, медиабаинга, аффилейт-маркетинга

**Структура:**
```
Project "Casino Q1 2025"
  │
  ├─ Site "Casino RU"
  │    └─ Zone: casino-brand.com
  │         ├─ Domain: casino-brand.com (primary) → IP 1.2.3.4
  │         ├─ Domain: www.casino-brand.com (alias) → CNAME casino-brand.com
  │         └─ Domain: m.casino-brand.com (mobile) → CNAME casino-brand.com
  │
  ├─ Site "Casino EN"
  │    └─ Zone: casino-en.com
  │         └─ Domain: casino-en.com (primary) → IP 1.2.3.5
  │
  └─ Site "Donor Pool FB"
       ├─ Zone: win1.com
       │    └─ Domain: win1.com (donor) → redirect https://casino-brand.com
       ├─ Zone: win2.com
       │    └─ Domain: win2.com (donor) → redirect https://casino-brand.com
       └─ Zone: win3.com
            └─ Domain: win3.com (donor) → redirect https://casino-brand.com
```

**Преимущества:**
- ✅ Чёткое разделение сайтов и доменов
- ✅ Простая аналитика (все переходы → один сайт)
- ✅ Удобное управление SSL и DNS на уровне зон
- ✅ Прозрачный биллинг (зона = единица тарификации)

**Когда использовать:**
- У каждого сайта один основной домен
- Доноры — это отдельные домены для рекламы
- Нужна строгая изоляция настроек между сайтами

---

### Вариант B: Множественные домены в одной зоне

**Рекомендуется для:** Поддоменов, алиасов, мультиязычных версий

**Структура:**
```
Project "Casino Brand"
  └─ Site "Casino Multi"
       └─ Zone: casino-brand.com
            ├─ Domain: casino-brand.com (primary) → IP 1.2.3.4
            ├─ Domain: www.casino-brand.com → CNAME casino-brand.com
            ├─ Domain: ru.casino-brand.com → CNAME casino-brand.com
            ├─ Domain: en.casino-brand.com → CNAME casino-brand.com
            └─ Domain: m.casino-brand.com → CNAME casino-brand.com
```

**Преимущества:**
- ✅ Одна зона = меньше управления
- ✅ Общие настройки SSL/DNS для всех поддоменов
- ✅ Экономия на тарифах Cloudflare

**Когда использовать:**
- Все домены — поддомены одной зоны
- Нужны общие настройки для всех версий
- Мультиязычный сайт на поддоменах

---

### Вариант C: Пул резервных доменов

**Рекомендуется для:** Подготовки доменов на случай блокировок

**Структура:**
```
Project "Casino Q1 2025"
  │
  ├─ Site "Casino RU" (ACTIVE)
  │    └─ Zone: casino-brand.com
  │         ├─ Domain: casino-brand.com (primary, active)
  │         └─ Domain: win1.com (donor, active)
  │
  └─ Site "Reserve Pool" (NEW)
       ├─ Zone: reserve1.com
       │    └─ Domain: reserve1.com (donor, new, ns_status=verified) ⏸️
       ├─ Zone: reserve2.com
       │    └─ Domain: reserve2.com (donor, new, ns_status=verified) ⏸️
       └─ Zone: reserve3.com
            └─ Domain: reserve3.com (donor, new, ns_status=pending) ⏳
```

**Преимущества:**
- ✅ Домены технически готовы (NS проверены)
- ✅ Мгновенная активация при блокировке
- ✅ Не тратят лимиты (status=new)

**Флоу активации резерва:**
```javascript
// 1. Донор забанен
UPDATE domains SET status='blocked' WHERE domain_name='win1.com';

// 2. Активируем резерв
UPDATE domains 
SET status='active', 
    site_id=<active_site_id>,
    target_value='https://casino-brand.com'
WHERE domain_name='reserve1.com' AND ns_status='verified';
```

---

## Управление блокировками

### Статусы домена

| Статус | ns_status | Описание |
|--------|-----------|----------|
| `new` | `pending` | Добавлен, ждём переноса NS ⏳ |
| `new` | `error` | Ошибка NS, нужно исправить ❌ |
| `new` | `verified` | **Готовый горячий резерв** 🔥 |
| `active` | `verified` | Работает полностью ✅ |
| `active` | `error` | Работал, но проблема с NS ⚠️ |
| `blocked` | `verified` | Заблокирован (технически работает) 🚫 |
| `blocked` | `error` | Заблокирован + проблема NS 🚫 |

---

### Категории блокировок

Система использует **5 упрощённых категорий** для ручного выбора:

#### 1️⃣ **`unavailable`** — Технически недоступен

**Включает:**
- HTTP ошибки (403, 404, 410, 503)
- DNS resolution failed
- SSL certificate invalid
- Connection timeout
- IP в чёрном списке
- Cloudflare zone deleted/suspended
- DDoS атака

**Когда выбирать:**
- HostTracker показал, что сайт не отвечает
- Cloudflare вернул ошибку зоны
- Технические проблемы на стороне хостинга

**Автоматизация:** ✅ Частично (HostTracker + CF API)

---

#### 2️⃣ **`ad_network`** — Бан рекламной сети

**Включает:**
- Facebook Ads policy violation
- Google Ads suspension
- TikTok Ads ban
- Native ads networks ban
- Taboola/Outbrain rejection
- Push networks ban

**Когда выбирать:**
- Рекламный кабинет заблокирован
- Креативы отклонены
- Домен в чёрном списке сети

**Автоматизация:** ❌ Только вручную

---

#### 3️⃣ **`hosting_registrar`** — Проблемы с хостингом/регистратором

**Включает:**
- Registrar abuse complaint
- Hosting account suspended
- Domain expired (не продлён)
- UDRP dispute (спор о домене)
- DMCA takedown
- Terms of Service violation
- Payment/chargeback issues

**Когда выбирать:**
- Письмо от регистратора о жалобе
- Домен истёк (expired)
- Хостинг приостановил аккаунт
- DMCA complaint

**Автоматизация:** ⚠️ Частично (проверка срока через WHOIS)

---

#### 4️⃣ **`government`** — Государственная блокировка

**Включает:**
- Роскомнадзор (РФ)
- Court order (судебное решение)
- ISP/провайдер блокировка
- DNS censorship
- Government takedown request
- Regional restrictions

**Когда выбирать:**
- Сайт работает из-за рубежа, но не в регионе
- Уведомление от РКН
- Судебное решение
- Провайдеры блокируют доступ

**Автоматизация:** ⚠️ Требует geo-мониторинга

**Типы блокировок:**
- **DNS блокировка** — провайдер блокирует DNS → заглушки НЕТ
- **IP блокировка** — блокировка по IP → заглушки НЕТ
- **DPI с редиректом** — 302 на zapret-info.gov.ru → **заглушка РКН видна**
- **DPI с HTTP 403** — провайдер возвращает 403 → **заглушка провайдера видна**

---

#### 5️⃣ **`manual`** — Ручное управление

**Включает:**
- Planned rotation (плановая ротация)
- Poor performance (низкая конверсия)
- Manual pause (временная пауза)
- A/B testing ended
- Budget depleted
- Campaign finished

**Когда выбирать:**
- Вы сами решили остановить домен
- Плохая конверсия → нужна замена
- Плановая смена доменов
- Тестирование завершено

**Автоматизация:** ❌ Полностью ручное

---

### Структура блокировки в БД

```sql
status TEXT CHECK(status IN ('new','active','blocked')),
blocked_reason TEXT CHECK(blocked_reason IN (
    'unavailable',
    'ad_network',
    'hosting_registrar',
    'government',
    'manual'
)),
blocked_details TEXT,  -- детали (JSON или текст)
blocked_at TIMESTAMP
```

**Пример:**
```json
{
  "status": "blocked",
  "blocked_reason": "ad_network",
  "blocked_details": "Facebook Ads: Policy violation - Cloaking detected",
  "blocked_at": "2025-01-15T10:30:00Z"
}
```

---

## Сценарии удаления

### Каскады Foreign Keys

```
Account (CASCADE)
  └─ Project (CASCADE)
       └─ Site (CASCADE)
            ├─ Zone (SET NULL)
            │    └─ Domain (CASCADE) ← удаление зоны удаляет домены!
            │
            └─ Domain (SET NULL) ← удаление сайта освобождает домены
```

---

### Сценарий 1: Удаление Account

```sql
DELETE FROM accounts WHERE id = 1;
```

**Результат:**
- ❌ **Удаляются безвозвратно:** Projects, Sites, Zones, Domains
- ❌ **Удаляются также:** Все данные клиента (аудит, аналитика, настройки)

**Восстановление:** ❌ Невозможно (каскадное удаление)

**Использование:** Полное удаление аккаунта клиента из системы

---

### Сценарий 2: Удаление Project

```sql
DELETE FROM projects WHERE id = 5;
```

**Результат:**
- ❌ **Удаляются безвозвратно:** Sites проекта
- ✅ **Освобождаются (остаются в системе):**
  - Zones (`site_id = NULL`)
  - Domains (`site_id = NULL`, `project_id = NULL`)

**Восстановление:** ✅ Зоны и домены можно переприсвоить другому проекту

**Использование:** Завершение кампании с сохранением доменов для переиспользования

**Пример:**
```
ДО:
Project "Casino Q1" (id=5)
  └─ Site "Casino RU" (id=10)
       └─ Zone (id=20, site_id=10)
            └─ Domain "casino-brand.com" (site_id=10, project_id=5)

DELETE FROM projects WHERE id = 5;

ПОСЛЕ:
Sites: удалены
Zones: id=20, site_id=NULL ← осиротела
Domains: "casino-brand.com", site_id=NULL, project_id=NULL ← осиротел
```

---

### Сценарий 3: Удаление Site

```sql
DELETE FROM sites WHERE id = 10;
```

**Результат:**
- ✅ **Освобождаются (остаются в системе):**
  - Zones (`site_id = NULL`)
  - Domains (`site_id = NULL`)

**Восстановление:** ✅ Зоны и домены можно переприсвоить другому сайту

**Использование:** Реорганизация структуры без потери доменов

**Пример:**
```
ДО:
Site "Casino RU" (id=10)
  └─ Zone (id=20, site_id=10)
       ├─ Domain "casino-brand.com" (site_id=10, zone_id=20)
       └─ Domain "win1.com" (site_id=10, zone_id=21)

DELETE FROM sites WHERE id = 10;

ПОСЛЕ:
Zones: 
  id=20, site_id=NULL ← осиротела
  id=21, site_id=NULL ← осиротела

Domains:
  "casino-brand.com", site_id=NULL, zone_id=20 ← осиротел
  "win1.com", site_id=NULL, zone_id=21 ← осиротел
```

---

### Сценарий 4: Удаление Zone

```sql
DELETE FROM zones WHERE id = 20;
```

**Результат:**
- ❌ **Удаляются безвозвратно:** ВСЕ домены этой зоны

**Восстановление:** ❌ Невозможно (домены удалены)

**Использование:** Зона удалена из Cloudflare → домены больше не работают

**⚠️ КРИТИЧНО:** Перед удалением зоны убедитесь, что домены не нужны!

**Пример:**
```
ДО:
Zone (id=20, cf_zone_id="abc123")
  ├─ Domain "casino-brand.com" (zone_id=20)
  ├─ Domain "www.casino-brand.com" (zone_id=20)
  └─ Domain "m.casino-brand.com" (zone_id=20)

DELETE FROM zones WHERE id = 20;

ПОСЛЕ:
Domains: ВСЕ УДАЛЕНЫ (каскадно)
```

---

### Сценарий 5: Удаление Domain

```sql
DELETE FROM domains WHERE id = 50;
```

**Результат:**
- ❌ **Удаляется безвозвратно:** Запись о домене

**Восстановление:** ❌ Невозможно (нужно добавлять заново)

**Использование:** Домен больше не используется и не нужен

---

## Миграция и перенос

### Перенос домена в другой сайт

**Кейс:** Домен нужно переместить из одного сайта в другой

```sql
-- Проверяем текущее состояние
SELECT * FROM domains WHERE domain_name = 'win1.com';
-- site_id=10, zone_id=20

-- Переносим домен в другой сайт
UPDATE domains 
SET site_id = 15,  -- новый сайт
    updated_at = CURRENT_TIMESTAMP
WHERE domain_name = 'win1.com';
```

**Результат:** ✅ Домен перенесён, зона осталась прежней

**Ограничения:** 
- Зона должна принадлежать целевому сайту (или быть NULL)
- Если зона привязана к другому сайту → нужно сначала освободить зону

---

### Перенос домена в другой проект

**Кейс:** Домен нужно переместить в другой проект (другая кампания)

```sql
-- Переносим домен и освобождаем от старого сайта
UPDATE domains 
SET project_id = 8,      -- новый проект
    site_id = NULL,      -- освобождаем
    updated_at = CURRENT_TIMESTAMP
WHERE domain_name = 'win1.com';

-- Затем привязываем к сайту в новом проекте
UPDATE domains 
SET site_id = 20
WHERE domain_name = 'win1.com';
```

**Результат:** ✅ Домен перенесён в другой проект

---

### Перенос зоны в другой сайт

**Кейс:** Зона со всеми доменами переходит в другой сайт

```sql
-- Переносим зону
UPDATE zones 
SET site_id = 15
WHERE id = 20;

-- Автоматически домены остаются привязаны к зоне
-- Но можно обновить site_id доменов:
UPDATE domains 
SET site_id = 15
WHERE zone_id = 20;
```

**Результат:** ✅ Зона и все её домены перенесены

---

### Активация резервного домена

**Кейс:** Донор забанен → активируем резерв

```sql
-- 1. Блокируем старый донор
UPDATE domains 
SET status = 'blocked',
    blocked_reason = 'ad_network',
    blocked_details = 'Facebook policy violation',
    blocked_at = CURRENT_TIMESTAMP
WHERE domain_name = 'win1.com';

-- 2. Активируем резерв
UPDATE domains 
SET status = 'active',
    site_id = 10,  -- привязываем к активному сайту
    target_type = 'redirect',
    target_value = 'https://casino-brand.com',
    updated_at = CURRENT_TIMESTAMP
WHERE domain_name = 'reserve1.com' 
  AND status = 'new' 
  AND ns_status = 'verified';
```

**Результат:** ✅ Резервный домен активирован и начинает работать

---

### Смена primary домена

**Кейс:** Primary домен заблокирован → новый домен становится primary

```sql
-- 1. Понижаем старый primary до donor
UPDATE domains 
SET status = 'blocked',
    domain_role = 'donor',
    blocked_reason = 'government',
    blocked_at = CURRENT_TIMESTAMP
WHERE domain_name = 'casino-brand.com';

-- 2. Повышаем новый домен до primary
UPDATE domains 
SET domain_role = 'primary',
    target_type = 'ip',
    target_value = '1.2.3.4',
    status = 'active'
WHERE domain_name = 'casino-brand-new.com';

-- 3. Обновляем ссылку в сайте
UPDATE sites 
SET primary_domain_id = (
    SELECT id FROM domains WHERE domain_name = 'casino-brand-new.com'
)
WHERE id = 10;

-- 4. Перенаправляем всех доноров на новый primary
UPDATE domains 
SET target_value = 'https://casino-brand-new.com'
WHERE site_id = 10 
  AND domain_role = 'donor' 
  AND target_type = 'redirect';
```

**Результат:** ✅ Новый primary работает, все доноры перенаправлены на него

---

## Лучшие практики

### ✅ Рекомендуется

1. **Готовить резервные домены заранее**
   - Регистрировать домены пулом
   - Переносить NS сразу (status=new, ns_status=verified)
   - Активировать по необходимости

2. **Использовать денормализацию**
   - `sites.primary_zone_id` и `primary_domain_id` для быстрого доступа
   - `domains.project_id` для группировки

3. **Периодически проверять осиротевшие сущности**
   ```sql
   -- Зоны без сайтов:
   SELECT * FROM zones WHERE site_id IS NULL;
   
   -- Домены без сайтов:
   SELECT * FROM domains WHERE site_id IS NULL;
   ```

4. **Логировать все изменения**
   - Использовать `audit_log` для отслеживания операций
   - Фиксировать причины блокировок в `blocked_details`

---

### ❌ Не рекомендуется

1. **Удалять зоны без крайней необходимости**
   - Все домены зоны удалятся безвозвратно
   - Лучше освободить зону (`site_id = NULL`) для переиспользования

2. **Оставлять много осиротевших сущностей**
   - Периодически переприсваивать или удалять неиспользуемые домены
   - Очищать старые заблокированные домены (> 90 дней)

3. **Хранить чувствительные данные в `blocked_details`**
   - Не добавлять пароли, токены, личные данные
   - Только техническая информация и комментарии

---

## Итоговая схема Foreign Keys

```
accounts
  └─ (CASCADE) → projects
       └─ (CASCADE) → sites
            ├─ (SET NULL) → zones
            │    └─ (CASCADE) → domains ← удаление зоны удаляет домены!
            │
            └─ (SET NULL) → domains ← удаление сайта освобождает домены
```

**Легенда:**
- `CASCADE` — каскадное удаление (родитель удалён → потомок удалён)
- `SET NULL` — освобождение (родитель удалён → потомок остаётся с NULL)

---

## Заключение

Четырёхуровневая иерархия **Project → Site → Zone → Domain** обеспечивает:

- ✅ Гибкость управления доменами как активами
- ✅ Защиту от потери данных (домены остаются при удалении сайта)
- ✅ Простоту аналитики и биллинга
- ✅ Multi-tenant изоляцию через `account_id`
- ✅ Возможность быстрой ротации доменов при блокировках

**Основные принципы:**
- Домены = активы (сохраняются при удалении сайтов)
- Зоны = инфраструктура (удаление зоны = удаление доменов)
- 1 зона = 1 сайт (строгая привязка для простоты)
- Резервные домены = горячий запас (status=new, ns_status=verified)

---

© 301.st — Cloudflare Redirect Management Platform
