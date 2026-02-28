# 301.st — Платформа управления редиректами

**301.st** — SaaS-платформа для управления доменами, редиректами и TDS через Cloudflare.
Serverless-архитектура, multi-tenant изоляция, интеграции с регистраторами и аналитикой.

---

## ОГЛАВЛЕНИЕ

### Архитектура и данные

1. [Архитектура системы](Architecture) — структура, слои, взаимодействие компонентов
2. [Модель данных](Data_Model) — D1, KV, R2, Durable Objects, ER-диаграмма
3. [Безопасность](Security) — auth, JWT, шифрование, CORS, rate limiting
4. [Воркеры](Workers) — Core и Client воркеры, шаблоны, деплой

### Четыре направления платформы

Каждое направление — концепция + API:

5. **Redirects** — нативные CF Redirect Rules (Single Redirects API)
   - [Redirects](Redirects) — концепция, шаблоны T1-T7, CF expressions
   - [API: Redirects](API_Redirects) — CRUD endpoints, sync, analytics
6. **TDS** — Traffic Distribution System (pull-модель, Client Worker)
   - [TDS](TDS) — концепция, условия, A/B тесты, MAB
   - [API: TDS](API_TDS) — правила, привязки, пресеты, постбэки, статистика
7. **Health Check** — мониторинг доменов (VT, phishing, anomalies)
   - [Health Check](Health_Check) — концепция, архитектура, источники данных
   - [API: Health](API_Health) — endpoints, webhook, client worker API
8. **Client Environment** — развёртывание инфраструктуры на CF аккаунте клиента
   - [API: Client Environment](API_ClientEnvironment) — setup, teardown, middleware

### API

9. [API: Авторизация](API_Auth) — register, login, OAuth, refresh, sessions
10. [API: Основные сущности](API_Integrations) — проекты, сайты, зоны, домены
11. [API: Интеграции](API_IntegrationsKeys) — Cloudflare, Namecheap, HostTracker
12. [API: Domains](API_Domains) — CRUD доменов
13. [API: Projects](API_Projects) — CRUD проектов
14. [API: Sites](API_Sites) — CRUD сайтов

### Дополнительно

15. [Аналитика](Analytics) — метрики, логи, отчёты
16. [Уведомления](Notifications) — email, Telegram, webhooks
17. [Backup и DevOps](Backup_DevOps) — CI/CD, бэкапы, мониторинг
18. [Тарифы и биллинг](Pricing) — планы подписки
19. [Глоссарий](Glossary) — термины и сокращения
20. [Приложения](Appendix) — схемы, примеры, troubleshooting
21. [Инструкция для вебмастеров](Appendix_instruction) — практический гайд

### Справочные

- [Identity Flow](IdentityFlow) — OAuth flow, диаграммы
- [Key Integration](KeyIntegraton) — интеграция ключей
- [MAB Algorithms](mab-algorithms) — алгоритмы Multi-Armed Bandits
- [Proxy](Proxy) — Namecheap relay, прокси

---

## КРАТКО О ПРОЕКТЕ

- Serverless на **Cloudflare**
   - *Workers / D1 / KV / Durable Object / Queues / R2*
- Централизованное управление доменами и редиректами
- Изоляция данных multi-tenant
- Интеграции: Cloudflare API, Namecheap, GoDaddy, HostTracker, GA, YM
- Масштабируемость до **2000+ клиентов**

---

© 301.st — Cloudflare Redirect Management Platform
