# Cтруктура проекта 301/


```plaintext
301/
├── README.md                     # Описание проекта и инструкции по запуску
│
├── schema/                       # SQL и миграции базы (Cloudflare D1)
│   ├── 301.sql                   # основная схема БД (референс)
│   ├── 301_d1.sql                # адаптация под Cloudflare D1
│   └── migrations/               # миграции (ALTER/добавления)
│
├── src/
├── api/                       # главный воркер платформы 301.st
│   ├── auth/                  # авторизация, регистрация, OAuth
│   ├── projects/              # CRUD проектов
│   ├── sites/                 # CRUD сайтов
│   ├── domains/               # CRUD доменов и зон
│   ├── redirects/             # правила редиректов
│   ├── tds/                   # правила TDS
│   ├── integrations/          # внешние API
│   │   ├── keys/              # ключи интеграций (шифрование, хранение)
│   │   ├── cloudflare/        # CF API: zones, routes, KV, workers
│   │   ├── namecheap/
│   │   ├── namesilo/
│   │   ├── hosttracker/
│   │   └── analytics/
│   ├── jobs/                  # постановка задач во внутренние очереди
│   ├── lib/                   # crypto, jwt, sessions, d1, kv, turnstile, ratelimit
│   ├── types/                 # типы окружения
│   └── wrangler.toml          # конфигурация воркера API
│
├── system/                    # объединённый edge + jobs (внутренние задачи)
│   ├── health.ts              # /health, /status
│   ├── cron.ts                # периодические задания
│   ├── backup.ts              # резервные копии (D1/KV 301)
│   ├── cleanup.ts             # TTL очистка
│   ├── queue.ts               # обработка внутренних очередей
│   └── wrangler.toml          # конфигурация системного воркера
│
├── webhook/                   # приём внешних событий (HostTracker, CF Events, др.)
│   ├── index.ts
│   └── wrangler.toml
│
├── wiki/                         # документация проекта
│
└── .github/workflows/            # CI/CD (GitHub Actions)
    ├── deploy.yml
    ├── backup.yml
    └── sync_wiki.yml

```

---
#  Локальное тестовое окружение для Cloudflare Workers (301.st)

##  1. Подготовка окружения

### 1.1 Требования

* Node.js >= 20.x
* npm >= 10.x
* Wrangler >= 3.0.0

Проверка версий:

```bash
node -v
npm -v
npx wrangler -v
```

### 1.2 Установка Wrangler (если не установлен)

```bash
npm install -g wrangler
```

### 1.3 Переход в каталог проекта

```bash
cd ~/git/301
```

Создай каталог воркера:

```bash
mkdir -p src/api
cd src/api
```

---

##  2. Установка зависимостей

Создай локальный `package.json`:

```bash
npm init -y
```

Установи зависимости, совместимые с Cloudflare Workers:

```bash
npm install hono zod bcrypt-ts jose
```

>  Эти библиотеки работают в среде Cloudflare Workers и не используют Node.js API.
>
> * `hono` — фреймворк для маршрутизации
> * `zod` — валидация данных
> * `bcrypt-ts` — безопасное хэширование на Edge
> * `jose` — JWT для авторизации

---

##  3. Настройка `wrangler.toml`

Создай файл `src/api/wrangler.toml`:

```toml
name = "301"
main = "index.ts"
compatibility_date = "2025-10-25"

# Production (основная база)
[[d1_databases]]
binding = "DB301"
database_name = "301"
database_id = "********-****-****-****-************"

[[kv_namespaces]]
binding = "KV_SESSIONS"
id = "*******************************"

# Development (локальное окружение)
[env.dev]
[[env.dev.d1_databases]]
binding = "DB301"
database_name = "301-dev"
database_id = "******************************"

[[env.dev.kv_namespaces]]
binding = "KV_SESSIONS"
id = "********************************"
```

> `main` должен указывать **на файл внутри текущего каталога** (`index.ts`), а не на `src/api/index.ts`.

---

## 4. Где хранится локальная база D1

Wrangler создаёт SQLite-файлы в директории:

```
src/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/301-dev.sqlite
```

Проверить наличие:

```bash
ls -lh .wrangler/state/v3/d1/miniflare-D1DatabaseObject/
```

Открыть базу:

```bash
sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/301-dev.sqlite
```

---

## 5. Библиотеки для среды Cloudflare Workers

| Назначение         | Используемая библиотека    | Node-альтернатива (не использовать) |
| ------------------ | -------------------------- | ----------------------------------- |
| Маршрутизация      | `hono`                     | `express`                           |
| Валидация данных   | `zod`                      | `joi`, `yup`                        |
| Хэширование пароля | `bcrypt-ts`                | `bcrypt`, `bcryptjs`                |
| JWT (токены)       | `jose`                     | `jsonwebtoken`                      |
| Криптография       | Встроенный `crypto.subtle` | Node `crypto`                       |

> ❌ Не использовать библиотеки, зависящие от Node.js (`fs`, `path`, `process`, `net`).

---

## 6. .gitignore (минимум для проекта 301.st)

```bash
# Node / Wrangler
data/
node_modules/
.wrangler/
dist/
.env
frontend/node_modules/
frontend/dist/
frontend/build/
```

---

## 7. Локальное тестирование API

### 7.1 Запуск воркера

```bash
cd ~/git/301/src/api
npx wrangler dev --env dev
```

**Результат:**

```
Your Worker has access to DB301 (local) and KV_SESSIONS
⬣ Listening at http://127.0.0.1:8787
```

### 7.2 Тестирование эндпоинтов

**Регистрация:**

```bash
curl -X POST http://127.0.0.1:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@local.dev","password":"secret123"}'
```

**Логин:**

```bash
curl -i -X POST http://127.0.0.1:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@local.dev","password":"secret123"}'
```

**Обновление токена:**

```bash
curl -X POST http://127.0.0.1:8787/auth/refresh \
  -H "Cookie: refresh_id=<uuid из Set-Cookie>"
```

**Проверка пользователя:**

```bash
curl -X GET http://127.0.0.1:8787/auth/me \
  -H "Authorization: Bearer <access_token>"
```

**Выход (Logout):**

```bash
curl -X POST http://127.0.0.1:8787/auth/logout \
  -H "Cookie: refresh_id=<uuid>"
```

**Проверка записи в БД**
Из папки с api/ (где находится БД .wrangler) выполнить
```
npx wrangler d1 execute 301-dev --local --env dev --command="SELECT * FROM users;"
```
Должна отобразиться строка с email = test@local.dev и password_hash.


---

## 8. Итог

* Все воркеры должны использовать **ESM и Web API** (не Node).
* Локальная база D1 хранится в `.wrangler/state/v3/d1/`.
* Все тесты выполняются через `wrangler dev --env dev`.
* Продакшн-деплой осуществляется через `wrangler deploy`.


