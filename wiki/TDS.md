# Cloudflare для TDS-платформы: базовые условия, правила и бизнес-модель

## 1. Базовые условия («сигналы»), доступные в Cloudflare Worker бесплатно

Cloudflare автоматически добавляет в запрос заголовки и свойства, которые можно использовать без внешних API:

| УСЛОВИЕ              | КАК ПОЛУЧИТЬ                          | ПРИМЕР ЗНАЧЕНИЯ                | ПРИМЕЧАНИЕ |
|----------------------|---------------------------------------|--------------------------------|------------|
| Гео (страна)        | `request.cf.country`                 | `"RU"`, `"US"`                | ISO 3166-1 alpha-2, ~250 значений (не 320 — таких стран нет) |
| Регион/город        | `request.cf.region`, `request.cf.city` | `"Moscow"`, `"California"`  | Менее надёжны, могут быть пустыми |
| User-Agent          | `request.headers.get('User-Agent')`  | `"Mozilla/5.0 ..."`           | Нужен парсинг (например, через `ua-parser-js`) |
| Устройство          | `request.cf.clientTcpRtt` + UA → вывод | —                           | Cloudflare **не даёт** прямой флаг «mobile/desktop» — нужно определять самим |
| Операционная система| Через UA                             | `"Android"`, `"iOS"`, `"Windows"` | Требует парсинга |
| Браузер             | Через UA                             | `"Chrome"`, `"Safari"`       | Требует парсинга |
| IP-адрес            | `request.headers.get('CF-Connecting-IP')` | `"203.0.113.42"`          | Можно использовать для чёрных списков |
| Параметры URL       | `new URL(request.url).searchParams`  | `?utm_source=spam`            | Полный контроль |
| Путь (path)         | `new URL(request.url).pathname`      | `"/offer"`                    | — |
| Хост (домен)        | `new URL(request.url).hostname`      | `"brand-ru.org"`              | Ключ для выбора TDS-конфига |

> **Важно**: Cloudflare **не предоставляет** готовый флаг `isMobile` на бесплатном тарифе.  
> Нужен  лёгкий парсер (например, `is-mobile`) — работает быстро и не требует внешних вызовов.

---

## 2. Как устроены «правила» в TDS-наборе

**Правила обрабатываются сверху вниз, первое совпавшее — выполняется.**  
Это классическая модель `match-first`, как в Page Rules или firewall.

### Пример структуры правила (внутри одном TDS-наборе):

| № | УСЛОВИЯ                        | ДЕЙСТВИЕ                              |
|---|--------------------------------|---------------------------------------|
| 1 | Гео = RU, Устройство = Mobile | → Редирект на лендинг A              |
| 2 | Гео = RU                      | → Софт-блок (302 на белый сайт)      |
| 3 | Гео = US, Источник = fb.com   | → Редирект на лендинг B              |
| 4 | Любое гео                     | → Редирект на универсальный лендинг  |

> Если запрос из RU с мобилки — сработает **правило 1**, остальные игнорируются.

---

## 3. Бизнес-модель: Free vs Paid

### Бесплатный тариф (Free Plan)
- Клиент получает возможность создать **оди TDS-набор** (один набор правил)  
- Максимум **5–10 правил** (ограничение UI/удобства, не техническое)  
- Все правила — на основе доступных сигналов (гео, UA, параметры и т.д.)  
- **Worker — один**, привязан ко всем доменам клиента  
- Конфигурация хранится **у вас** (в D1/KV), клиент выбирает шаблон  

> **Цель**: дать рабочий TDS **«из коробки»** для кастомной настройки.

---

### Платный тариф (Paid Plan)
- Клиент может создать **несколько TDS-наборов**  
- Каждый набора — **независимый набор правил**  
- Привязка к **домену или группе доменов**  
- Возможности:  
  - A/B-тестирование (2 набора на один домен с весами)  
  - Разные стратегии под гео/источник  
  - Сложные цепочки (например, pre-TDS → geo-split → device-split)  

> **Цель**: дать **гибкость продвинутому арбитражнику**.
```
## Доступные сигналы в Cloudflare Worker (бесплатный тариф)

**Все перечисленные данные доступны в любом Worker’е на бесплатном тарифе:**

| Сигнал              | Как получить                                      | Пример значения               |
|---------------------|---------------------------------------------------|-------------------------------|
| **Страна**          | `request.cf.country`                              | `"RU"`, `"US"`                |
| **IP-адрес**        | `request.headers.get('CF-Connecting-IP')`         | `"203.0.113.1"`               |
| **User-Agent**      | `request.headers.get('User-Agent')`               | `"Mozilla/5.0 ..."`           |
| **Хост (домен)**    | `new URL(request.url).hostname`                   | `"brand-ru.org"`              |
| **Путь**            | `new URL(request.url).pathname`                   | `"/offer"`                    |
| **Параметры URL**   | `new URL(request.url).searchParams`               | `?utm_source=fb`              |

> **TDS-правилах без внешних API и платных тарифов.**

Определение ботов и поисковиков (на Free)
Поисковые боты (Googlebot, YandexBot, Bingbot и др.) явно указывают себя в User-Agent.
Решение: проверка User-Agent на наличие ключевых строк.
Пример условия в TDS:
```
const isSearchBot = /Googlebot|bingbot|YandexBot|Baiduspider/i.test(ua);
```
«Плохие» боты (сканеры, парсеры) определяются по подозрительным UA (HeadlessChrome, python-requests и т.п.).

Базовые условия (на Free):
- Гео: request.cf.country (250+ стран)
- Устройство: определяется через User-Agent (mobile / desktop)
- Источник: User-Agent → поиск ботов (Googlebot, YandexBot и др.)
- Параметры URL, путь, домен



## Сравнение архитектуры редирект-Worker’ов 

- Worker привязывается к маршруту: example.com/* или *.example.com/*
- Один Worker может быть привязан к множеству маршрутов из разных зон
- В коде Worker’а вы не знаете, из какой зоны пришёл запрос — только по request.url или заголовкам
> Это ключевой момент: Worker — общий, а логика — должна разветвляться внутри.

### Вариант 1 зона + поддомены → один сложный Worker

Пример:

```
const url = new URL(request.url);
const host = url.hostname; // us.brand.com, ru.brand.com, ...

if (host === 'ru.brand.com') {
  if (country === 'RU') return tdsRU(request);
  else return redirect('https://global.brand.com');
} 
else if (host === 'us.brand.com') {
  if (userAgent.includes('bot')) return block();
  else return tdsUS(request);
}
// ... и так далее для 5+ гео, с вложенными условиями
```
Проблемы:

- Растёт глубина вложенности (2–3 уровня условий)
- Сложно тестировать, отлаживать, обновлять
- При добавлении нового гео — меняется общий код
- Ошибки в одном блоке могут повлиять на другие

### Вариант: N зон (N доменов) → Worker с плоской логикой

Подход:
- Один универсальный Worker, но каждому домену — своя конфигурация
- Конфигурация передаётся через секреты (env) или загружается по hostname

```
// Worker один для всех, но логика — по данным
const CONFIG = {
  'brand-us.com': { geo: 'US', rules: ['bot-block', 'ios-redirect'] },
  'brand-ru.org': { geo: 'RU', rules: ['soft-block', 'desktop-only'] },
  // ...
};

const host = new URL(request.url).hostname;
const config = CONFIG[host];

if (!config) return new Response('Not configured', { status: 404 });

// Плоская обработка:
if (config.geo === 'RU' && country === 'RU') {
  return handleTDS(request, 'ru');
}
if (config.rules.includes('bot-block') && isBot(userAgent)) {
  return block();
}
// ... условия на одном уровне
```
 или

меняем данные в CONFIG и загружам из вашего API по host.
Тогда Worker вообще не содержит логики гео — только

```
const config = await fetch(`https://api.301.example/config?host=${host}`);
return runTDS(request, config);
```

> При 5 зонах (5 доменов) логика остаётся плоской и изолированной.
> При 1 зоне с поддоменами — логика становится вложенной и хрупкой. 

Профессиональные TDS и арбитражные платформы предпочитают:
- Отдельные домены под гео/нишу/канал
- Единый Worker с внешней конфигурацией
- Полная изоляция при блокировке


Реализацияь на практике. 301 предлагает два варианта работы и два типа редирект-Worker.

## Публикация Worker

Worker — это код.
Маршрут (route) — это правило, где этот код запускать.
Один и тот же код можно запускать на десятках доменов из разных зон.

Когда вы деплоите Worker через Wrangler или API, вы указываете маршруты — URL-шаблоны, при обращении к которым будет запущен ваш Worker.

Пример маршрутов:

`example.com/*`
`*.brand.net/*`
`geo.offer.site/*`
Каждый такой маршрут привязан к конкретной зоне в Cloudflare:

example.com → зона с ID zone_abc
brand.net → зона с ID zone_def
offer.site → зона с ID zone_xyz
**Worker — один.**

Способ 1: Через `wrangler.toml`

```
name = "my-tds-worker"

# Один Worker, но маршруты в разных зонах
routes = [
  { pattern = "brand-us.com/*",      zone_name = "brand-us.com" },
  { pattern = "brand-ru.org/*",      zone_name = "brand-ru.org" },
  { pattern = "offer.brand-eu.net/*", zone_name = "brand-eu.net" }
]
```
Worker загружается один раз
Cloudflare создаёт привязки к трём разным зонам
Теперь запросы к любому из этих доменов запускают один и тот же код

Способ через API (более гибко - в рамах 301)
Сначала загружаете Worker-скрипт

```
PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/my-tds-worker
```

Потом привязываем его к маршруту в зоне A
```
POST https://api.cloudflare.com/client/v4/zones/{zone_id_A}/workers/routes
{ "pattern": "brand-us.com/*", "script": "my-tds-worker" }
```

И к маршруту в зоне B

```
POST https://api.cloudflare.com/client/v4/zones/{zone_id_B}/workers/routes
{ "pattern": "brand-ru.org/*", "script": "my-tds-worker" }
```


