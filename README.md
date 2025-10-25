# Cтруктура проекта 301/


```plaintext
301/
├── README.md                    # Краткое описание, ссылки, инструкция запуска
├── wrangler.toml                # Основная конфигурация для Cloudflare Workers
├── package.json                 # зависимости, сборка TypeScript
├── tsconfig.json                # конфиг TypeScript
│
├── schema/                      # SQL и миграции D1
│   ├── 301.sql                  # основная схема D1
│   ├── 301_d1.sql               # схема инициализации через Wrangler
│   └── migrations/              # миграции D1
│
├── src/                         # Исходный код (основная разработка)
│   ├── api/                     # API Workers (Core Layer)
│   │   ├── index.ts             # Точка входа api.301.st
│   │   ├── auth/                # Авторизация, OAuth, Refresh Flow
│   │   ├── projects/            # CRUD: проекты, зоны, домены
│   │   ├── redirects/           # CRUD: редиректы, правила
│   │   ├── analytics/           # Метрики, отчёты, логи
│   │   └── integrations/        # Внешние API (Cloudflare, Namecheap, HostTracker)
│   │
│   ├── edge/                    # Edge Router — 301/302 редиректы
│   │   ├── index.ts             # Основная точка входа edge.301.st
│   │   └── redirects.ts         # Логика обработки и кэширования KV_RULES
│   │
│   ├── jobs/                    # Фоновые задачи (Cron / Queues)
│   │   ├── index.ts             # jobs.301.st
│   │   ├── backup_r2.ts         # резервные копии D1/KV → R2
│   │   ├── rotate_keys.ts       # ротация JWT/MASTER_SECRET
│   │   └── analytics_aggregate.ts # агрегация аналитики
│   │
│   ├── webhook/                 # Приём внешних событий
│   │   ├── index.ts             # webhook.301.st
│   │   └── handlers/            # обработчики конкретных событий
│   │
│   ├── client/                  # Воркеры, создаваемые в аккаунтах клиентов
│   │   ├── templates/           # шаблоны (TDS, redirect)
│   │   ├── deploy.ts            # API деплоя в CF
│   │   └── utils.ts             # вспомогательные функции
│   │
│   ├── lib/                     # общие утилиты (Core Layer)
│   │   ├── crypto.ts            # AES-GCM шифрование / расшифровка
│   │   ├── jwt.ts               # подпись и верификация токенов
│   │   ├── kv.ts                # работа с KV (KV_CREDENTIALS, KV_RULES, KV_SESSIONS)
│   │   ├── d1.ts                # работа с D1 (prepare, bind, run)
│   │   └── logger.ts            # логирование и аудит
│   │
│   └── types/                   # Типы данных (TS)
│       ├── models.d.ts          # типы таблиц D1
│       ├── api.d.ts             # структуры запросов/ответов API
│       └── worker.d.ts          # общие интерфейсы
│
├── frontend/                    # React-приложение (Webstudio сборка)
│   ├── public/                  
│   ├── src/                     
│   │   ├── components/          
│   │   ├── pages/               
│   │   ├── api/ (fetch to api.301.st)
│   │   └── utils/               
│   └── package.json             
│
├── scripts/                     # сервисные утилиты
│   ├── init_db.sh               # инициализация базы D1
│   ├── deploy_api.sh            # деплой API-воркера
│   ├── deploy_edge.sh           # деплой Edge Router
│   ├── deploy_jobs.sh           # деплой фоновых задач
│   ├── backup_r2.sh             # резервное копирование
│   └── test_api.sh              # тесты REST API через curl
│
├── docs/                        # Документация и wiki
│   ├── Home.md
│   ├── Architecture.md
│   ├── Data_Model.md
│   ├── Security.md
│   ├── Glossary.md
│   └── ...
│
└── .github/
    └── workflows/
        ├── deploy.yml           # CI/CD деплой через wrangler
        ├── backup.yml           # ежедневные бэкапы
        └── sync_wiki.yml        # синхронизация wiki
```

## Логическая группировка

| Категория        | Назначение                                          |
| ---------------- | --------------------------------------------------- |
| **schema/**      | Хранилище D1 SQL и миграций                         |
| **src/api/**     | API Core Worker (CRUD, Auth, Billing, Integrations) |
| **src/edge/**    | Edge Router Worker (редиректы, KV Rules)            |
| **src/jobs/**    | Cron / Queues / Backups                             |
| **src/webhook/** | Приём внешних событий                               |
| **src/client/**  | Управление воркерами клиентов                       |
| **frontend/**    | React / Webstudio SPA                               |
| **scripts/**     | Bash / Wrangler / CI/CD утилиты                     |
| **docs/**        | Wiki-документация (md-файлы)                        |

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
database_id = "8cb2011e-****-****-****-6b02961bc60e"

[[kv_namespaces]]
binding = "KV_SESSIONS"
id = "ed063b***************0b44ea13f7b"

# Development (локальное окружение)
[env.dev]
[[env.dev.d1_databases]]
binding = "DB301"
database_name = "301-dev"
database_id = "1a2b3c4****************nopqrstuv"

[[env.dev.kv_namespaces]]
binding = "KV_SESSIONS"
id = "ed063b4d****************4ea13f7b"
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


