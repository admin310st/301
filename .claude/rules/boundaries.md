# Architectural Boundaries (301.st)

Strict separation between workers must be preserved.

## API Worker

Path: `src/api/**`

Responsible for:

* Authentication
* CRUD operations
* Integrations
* Apply Pipeline
* D1 and KV interaction

## System Worker

Path: `src/system/**`

Responsible for:

* Scheduled jobs (cron)
* Cleanup tasks
* Statistics collection
* Maintenance routines

## Webhook Worker

Path: `src/webhook/**`

Responsible for:

* External event ingestion
* Validation and normalization of incoming events

## Client Workers

Deployed to customer Cloudflare accounts.

* Execute redirect/TDS logic
* Must not contain platform business logic

---

Cross-boundary modifications require explicit justification.
No business logic duplication across workers.

