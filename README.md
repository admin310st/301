# Структура проекта 301/ 

```plaintext
301/
├── README.md                     # Описание проекта
│
├── schema/                       # SQL и миграции базы (Cloudflare D1)
│   ├── 301.sql                   # основная схема БД (референс)
│   ├── 301_d1.sql                # адаптация под Cloudflare D1
│   └── migrations/               # миграции (ALTER/добавления)
│
├── src/
│   ├── api/                       # главный воркер платформы 301.st
│   │   ├── auth/                  # авторизация, регистрация, OAuth
│   │   ├── projects/              # CRUD проектов
│   │   ├── sites/                 # CRUD сайтов
│   │   ├── domains/               # CRUD доменов
│   │   │   └── health.ts          # GET /domains/:id/health
│   │   │
│   │   ├── health/                # Domain Health Check System
│   │   │   ├── client/            # Client Worker source
│   │   │   │   ├── index.ts       # Main worker: fetch + scheduled
│   │   │   │   ├── vt.ts          # VirusTotal API + queue
│   │   │   │   ├── phishing.ts    # CF Phishing check
│   │   │   │   ├── webhook.ts     # Push data → 301.st
│   │   │   │   ├── domains.ts     # Domains + anomaly detection
│   │   │   │   └── wrangler.template.toml
│   │   │   ├── bundle.ts          # Pre-bundled worker for deploy
│   │   │   └── setup.ts           # Setup endpoints
│   │   │
│   │   ├── tds/                   # Traffic Distribution System
│   │   │   ├── client/            # TDS Worker source
│   │   │   │   ├── index.ts       # TDS Worker: rules engine
│   │   │   │   ├── client.sql     # D1 schema
│   │   │   │   └── wrangler.template.toml
│   │   │   └── bundle.ts          # (planned) Pre-bundled TDS worker
│   │   │
│   │   ├── redirects/             # Redirect rules
│   │   ├── workers/               # Worker config management
│   │   │   └── config.ts          # Generate/store wrangler.toml
│   │   │
│   │   ├── integrations/          # External APIs
│   │   │   ├── keys/              # Key encryption & storage
│   │   │   └── providers/
│   │   │       ├── cloudflare/    # CF API
│   │   │       │   ├── initkey.ts     # CF key init + auto client setup
│   │   │       │   ├── client-env.ts  # Client environment orchestrator
│   │   │       │   ├── d1.ts          # D1 API
│   │   │       │   ├── d1-sync.ts     # Push data to client D1
│   │   │       │   ├── kv.ts          # KV namespace API
│   │   │       │   ├── workers.ts     # Workers deploy, secrets, routes
│   │   │       │   ├── zones.ts       # Zones API
│   │   │       │   └── zoneconf.ts    # Zone config (DNS, SSL, WAF)
│   │   │       ├── virustotal/    # VT API
│   │   │       ├── namecheap/
│   │   │       └── namesilo/
│   │   │
│   │   ├── jobs/                  # Background jobs
│   │   │   └── redirect-stats.ts  # Traffic anomaly detection
│   │   ├── lib/                   # Utilities
│   │   ├── types/                 # TypeScript types
│   │   └── wrangler.toml
│   │
│   ├── webhook/                   # Webhook receiver (webhook.301.st)
│   │   ├── index.ts
│   │   ├── health.ts              # POST /health - receive client data
│   │   ├── jwt.ts
│   │   └── wrangler.toml
│   │
│   └── system/                    # (planned) Cron, queues, backup
│
├── wiki/                         # Documentation
│   ├── Health_Check.md
│   ├── TDS.md
│   └── ...
│
└── .github/workflows/            # CI/CD
```

## Воркеры

| Воркер | Расположение | Домен | Назначение |
|--------|--------------|-------|------------|
| API | `src/api/` | 301.st | Основной API платформы |
| Webhook | `src/webhook/` | webhook.301.st | Приём данных от клиентов |
| Health Client | `src/api/health/client/` | *.workers.dev | Авто-деплой на CF клиента |
| TDS Client | `src/api/tds/client/` | *.workers.dev | Авто-деплой на CF клиента |

## Клиентское окружение

При добавлении CF ключа (`POST /integrations/cloudflare/init`) автоматически создаётся:

```
Client CF Account:
│
├── D1: 301-client              # Shared database
│   ├── domain_list             # Domains (synced from 301.st)
│   ├── traffic_stats           # Traffic data
│   ├── domain_threats          # VT results (Health)
│   ├── threat_check_queue      # VT queue (Health)
│   ├── tds_rules               # TDS rules (synced from 301.st)
│   └── domain_config           # TDS config
│
├── KV: 301-keys                # Integration keys (VT, etc.)
│
├── Worker: 301-health          # Health monitoring
│   ├── Bindings: D1, KV
│   ├── Cron: "0 */12 * * *"
│   └── Secrets: JWT_TOKEN
│
└── Worker: 301-tds             # (planned) Traffic distribution
    ├── Bindings: D1, KV, DO
    └── Routes: domain.com/* → 301-tds
```

## Architecture (Push Model)

```
301.st (master)                Client (slave)
     │                              │
     │  1. Client configures        │
     │     TDS in 301.st UI         │
     │                              │
     │  2. 301.st PUSH data  ─────► │  D1 (local cache)
     │     via CF D1 API            │
     │                              │
     │                              │  3. Worker reads from D1
     │                              │     (no API calls during request)
     │                              │
     │  ◄───────────────────────────│  4. Health Worker PUSH
     │     POST /webhook/health     │     results to 301.st
     │                              │
```

**Key points:**
- Workers read from local D1 (fast, no external calls)
- 301.st pushes config changes to client D1
- Health Worker pushes results back to 301.st

---

# Локальное окружение

## 1. Требования

* Node.js >= 20.x
* npm >= 10.x
* Wrangler >= 3.0.0

```bash
node -v && npm -v && npx wrangler -v
```

## 2. Установка

```bash
cd ~/git/301/src/api
npm install
```

## 3. Запуск

```bash
npx wrangler dev --env dev
```

## 4. Тестирование

```bash
# Register
curl -X POST http://127.0.0.1:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@local.dev","password":"secret123"}'

# Check DB
npx wrangler d1 execute 301-dev --local --env dev \
  --command="SELECT * FROM users;"
```

## 5. Библиотеки (Edge-compatible)

| Назначение | Библиотека | НЕ использовать |
|------------|------------|-----------------|
| Routing | `hono` | `express` |
| Validation | `zod` | `joi`, `yup` |
| Password hash | `bcrypt-ts` | `bcrypt` |
| JWT | `jose` | `jsonwebtoken` |
| Crypto | `crypto.subtle` | Node `crypto` |

## 6. Deploy

```bash
# Production
npx wrangler deploy

# Staging
npx wrangler deploy --env staging
```
