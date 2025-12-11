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



