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

### API

5. [API: Авторизация](API_Auth) — register, login, OAuth, refresh, sessions
6. [API: Основные сущности](API_Integrations) — проекты, сайты, зоны, домены
7. [API: Интеграции](API_IntegrationsKeys) — Cloudflare, Namecheap, HostTracker
8. [API: Domains](API_Domains) — CRUD доменов
9. [API: Projects](API_Projects) — CRUD проектов
10. [API: Sites](API_Sites) — CRUD сайтов
11. [API: Redirects](API_Redirects) — CRUD редиректов, sync, analytics
12. [API: TDS](API_TDS) — правила, привязки, пресеты, постбэки, статистика
13. [API: Health](API_Health) — endpoints, webhook, client worker API
14. [API: Client Environment](API_ClientEnvironment) — setup, teardown, middleware

### Дополнительно

15. [Redirects](Redirects) — концепция, шаблоны T1-T7, CF expressions
16. [TDS](TDS) — концепция, условия, A/B тесты, MAB
17. [Health Check](Health_Check) — концепция, архитектура, источники данных
18. [Аналитика](Analytics) — метрики, логи, отчёты
19. [Уведомления](Notifications) — email, Telegram, webhooks
20. [Backup и DevOps](Backup_DevOps) — CI/CD, бэкапы, мониторинг
21. [Тарифы и биллинг](Pricing) — планы подписки
22. [Глоссарий](Glossary) — термины и сокращения
23. [Приложения](Appendix) — схемы, примеры, troubleshooting
24. [Инструкция для вебмастеров](Appendix_instruction) — практический гайд

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
