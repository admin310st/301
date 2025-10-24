# Cтруктура проекта 301/

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

