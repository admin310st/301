##  Подходы к реализации редиректов

Редиректы (301/302) при блокировках или TDS — ключевой функционал.
Избегайте DNS-редиректов ((CNAME / A) не HTTP, вредно для SEO).
- 301 через API Cloudflare автоматически создаёт один общий редирект-Worker в аккаунте клиента (например, bulk-redirects-301).
  - Привязывает его ко всем «заблокированным» доменам через Routes (blocked1.example.com/*, geo.old.example.net/* и т.д.). 
  - Хранит маппинг «домен → целевой URL» у себя (D1/KV).
  -  Worker у клиента — очень простой, он делает fetch к вашему API или читает список из вашего KV по API.
- Использование Redirect Rules - до 10 правил на зону чтобы снизить нагрузку на Workers.

### Основной подход: Workers (бесплатно, гибко)
- **Как работает**: Один Worker привязывается к маршрутам в разных зонах (e.g., `brand-ru.org/*`, `brand-us.com/*`).
- **Автоматизация**: Платформа деплоит Worker, добавляет маршруты через API. Клиент нажимает "Заблокировать" — система обновляет конфиг.
- **Плюсы**: Нет лимитов на количество (только 100k запросов), динамическая логика (гео, EU). Гибкость - возможно управление через TDS-Worker и редирект-Worker.
- **Минусы**: Требует кода (но платформа скрывает от клиента).

#### Пример. простой редирект-Worker
```
export default {
  fetch(request) {
    return Response.redirect('https://active-brand.com', 302);
  }
}
```
#### Пример. Универсальный редирект-Worker на аккаунте клиента
```
const REDIRECTS = {
  'old1.example.com': 'https://active1.brand.com',
  'spam2.example.net': 'https://active1.brand.com',
  'geo-old.example.org': 'https://active2.brand.com',
  // ...
};
```

Альтернатива: Worker у клиента статический, а список редиректов обновляется через Wrangler API при изменении и редеплоим Worker через API, когда клиент меняет настройки.

### Дополнительный подход: Redirect Rules (бесплатно, просто) (`Rules → Rulesets → HTTP Request Rules → Manage rules → Add rule → "Redirect" action`)
- **Как работает**: Правила в Rulesets (HTTP Request Rules). Пример: `Hostname eq "old.com"` → Redirect to `new.com` (302).
- **Лимит**: 10 на зону.
- **Использование**: HTTP-редиректы (301/302) на основе: Hostname (example.com), Path (/old/*), Query, Country, Device и др.
  - Поддерживают wildcard (*), но не поддерживают регулярные выражения и подстановки (/user/123 → /profile?id=123 — нельзя).
- **Плюсы**: Без кода, через UI/API. Подходит для статических редиректов.
- **Минусы**: Нет динамики (нельзя условия по гео/EU). Создаётся в зоне источника, но редирект на любую зону/внешний домен.
  - Нельзя: `if (country == 'RU') → A, else → B` в одном правиле. Нужно 2 правила.
  - `/old/page1→/new/page1` —нельзя. Только `/old/*→/new/` (всё в один URL).
- **Когда использовать**: Как "простой режим" в UI для новичков (≤10 доменов, без логики).

#### Пример API-запроса.  Cначала надо найти или создать ruleset `http_request_redirect`.
```
POST https://api.cloudflare.com/client/v4/zones/{zone_id_A}/rulesets
{
  "name": "redirects",
  "kind": "zone",
  "phase": "http_request_redirect",
  "rules": [{
    "expression": "http.host eq \"offer.blocked.com\"",
    "action": "redirect",
    "action_parameters": {
        "status_code": 302,
        "target_url": { "value": "https://active.net/geo" }
      }
    }
  }]
}
```

> При использовани Redirect Rules в UI 301  выводится сообшение клиенту: «Осталось X из 10 редиректов для этого сайта» 

### Page Rules и Bulk Redirects (не рекомендуется)
- Page Rules: 3 на аккаунт (Free) — слишком мало.
- Bulk Redirects: Только Business+ — избыточно.

---

###  Таблица типовых редиректов: Routing Rules vs Альтернативы (Free Plan)

| ID | Название                    | Категория     | IF (CF Expression)                                                                 | THEN (Target)                                             | Code    | Лимит (правил на зону) | Альтернатива                                   | Примечания |
|----|----------------------------|---------------|-----------------------------------------------------------------------------------|-----------------------------------------------------------|---------|------------------------|-----------------------------------------------|------------|
| T1 | Domain → Domain (catch-all)| domain        | `http.host == "source.com"`                                                       | `https://target.com{http.request.uri.path}{?}`           | 301/302 | 1                      | Worker                                        | Основной донор → primary / external |
| T2 | HTTP → HTTPS               | domain        | `http.request.scheme == "http"`                                                   | `https://{http.host}{http.request.uri.path}{?}`          | 301     | 1                      | Automatic HTTPS (включён по умолчанию)        | Ручное правило надёжнее |
| T3 | non-www → www              | domain        | `http.host == "example.com"`                                                      | `https://www.example.com{http.request.uri.path}{?}`      | 301     | 1                      | Worker                                        | SEO canonical |
| T4 | www → non-www              | domain        | `http.host == "www.example.com"`                                                  | `https://example.com{http.request.uri.path}{?}`          | 301     | 1                      | Worker                                        | SEO canonical |
| T5 | Path prefix → Path         | path          | `(http.host == "example.com") && (http.request.uri.path starts_with "/old")`      | `https://example.com/new{http.request.uri.path}{?}`      | 301/302 | 1                      | **Worker** (рекомендуется)                    | Routing Rules не умеют менять путь без полного URL |
| T6 | Exact path → URL           | path          | `(http.host == "example.com") && (http.request.uri.path == "/old")`               | `https://target.tld/new`                                 | 301/302 | 1                      | Worker                                        | Пробелы в URL недопустимы |
| T7 | Preserve query             | modifier      | *(implicit)*                                                                      | `{http.request.uri.path}{?}`                             | —       | 0                      | —                                             | `{?}` в конце сохраняет query |
| T8 | Drop query                 | modifier      | *(implicit)*                                                                      | `{http.request.uri.path}`                                | —       | 0                      | —                                             | Без `{?}` — query отбрасывается |
| T9 | User-Agent redirect        | conditional   | `http.user_agent contains "Bot"`                                                  | `https://target.tld{http.request.uri.path}`              | 302     | 1                      | **Worker** (гибче: case-insensitive, regex)   | Быстро тратит лимит (10 правил) |
| T10| Geo redirect               | conditional   | `ip.geoip.country == "RU"`                                                        | `https://ru.target.tld{http.request.uri.path}{?}`        | 302     | 1                      | Worker                                        | **Полностью доступно на Free** |
| T11| Maintenance redirect       | technical     | `http.host == "example.com"`                                                      | `https://status.tld`                                     | 302     | 1                      | Worker                                        | Временный статус |
| T12| Kill-switch                | technical     | `http.host == "example.com"`                                                      | ❌ `about:blank` **недопустим**                          | 302     | —                      | **Worker**, возвращающий `204 No Content`     | Routing Rules требуют валидный HTTPS-URL |

>  **Примечания к синтаксису**:
> - `{http.request.uri.path}` — путь без query string  
> - `{?}` — автоматически добавляет `?<query>` при наличии  
> - Все условия **чувствительны к регистру**, если не использовать `lower()`

---

##  Рекомендации для 301.st

1. **Routing Rules используйте только для простых, статических редиректов** (T1–T4, T6, T10, T11) — до 10 правил на зону.
2. **Сложную логику (T5, T9, T12) реализовывайте через Worker**:
   - Не тратит лимит Routing Rules
   - Поддерживает case-insensitive, регулярные выражения, куки, динамические цели
   - Единственный способ реализовать «kill-switch» (T12)
3. **Geo-редиректы (T10) работают на Free** — ошибочно считать их платными.
4. **Никогда не используйте `about:blank`, `javascript:`, ``** в Routing Rules — только валидные `http(s)://` URL.
5. **Всегда добавляйте `{?}`**, если нужно сохранить UTM-метки и query-параметры.
6. **Для массовых редиректов (>10)** — только Worker. Routing Rules не масштабируются.
7. **Проверяйте синтаксис** через Cloudflare Dashboard → Rules → Routing Rules → «Edit expression».

