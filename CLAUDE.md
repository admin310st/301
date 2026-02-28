# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

---

## Project Overview

**301.st** is a SaaS platform for managing domains, redirects, and TDS (Traffic Distribution System) via Cloudflare infrastructure. Built as a serverless application on Cloudflare Workers with multi-tenant isolation.

---

## Architecture

### Workers (Cloudflare)

* **API Worker** (`src/api/`): Main platform logic — authentication, CRUD, integrations, apply engine.
* **System Worker** (`src/system/`): Cron jobs, backups, cleanup, statistics collection.
* **Webhook Worker** (`src/webhook/`): External event reception (HostTracker, Cloudflare events).
* **Client Workers**: Deployed to customer Cloudflare accounts for redirect/TDS execution.

---

## Technology Stack

* `hono` — HTTP framework
* `zod` — validation
* `bcrypt-ts` — password hashing (Edge-compatible)
* `jose` — JWT handling

Documentation: `wiki/Architecture.md`

---

## Documentation

Project wiki: `wiki/`
- `wiki/Architecture.md` — detailed system design
- `wiki/decisions/` — Architecture Decision Records (ADR)

When making architectural decisions, propose an ADR draft before implementing.
```

### Storage (Cloudflare)

* **D1 (DB301)**: Primary database — users, projects, sites, domains, zones, rules.
* **KV Namespaces**:

  * `KV_SESSIONS` — sessions, OAuth state, omni tokens.
  * `KV_CREDENTIALS` — encrypted API keys (AES-GCM).
  * `KV_RATELIMIT` — rate limiting.
  * `KV_RULES` — redirect rules for edge.
  * `KV_TDS` — compiled TDS rules.

---

## Code Structure

```
src/api/
├── auth/           # Auth endpoints (classic, OAuth Google/GitHub)
├── projects/       # Project CRUD
├── sites/          # Site CRUD
├── domains/        # Domain CRUD
├── integrations/   # External API integrations
│   ├── keys/       # Integration key management
│   └── providers/  # Cloudflare, Namecheap, etc.
├── jobs/           # Cron handlers
├── lib/            # Shared utilities (crypto, jwt, auth middleware, etc.)
├── types/          # TypeScript types (Env interface)
└── index.ts        # Main router, exports fetch + scheduled handlers

schema/
├── 301.sql         # Reference DB schema
├── 301_d1.sql      # D1-adapted schema
└── migrations/     # SQL migration files
```

---

## Key Patterns

### Draft Mode

All user changes are saved to D1 as `draft`. Nothing is applied to Cloudflare until the user triggers the Apply Pipeline.

### Apply Pipeline Flow

```
UI (draft) → API /apply → Cloudflare API → Customer Account
```

1. Decrypt Cloudflare token (AES-GCM with `MASTER_SECRET`).
2. Verify token with Cloudflare.
3. Apply Redirect Rules / deploy Worker / update KV.
4. Mark entity as `applied` in D1.

### Error Handling Strategy

* **External API first**: Call Cloudflare/registrar before writing to D1.
* **Retry with backoff**: D1 failures retry 3 times (100ms, 200ms, 300ms).
* **Rollback on failure**: If D1 write fails after Cloudflare success, attempt rollback.
* **Partial success allowed**: Batch operations continue; collect individual errors.

---

## Entity Hierarchy

```
Account
 ├── Free Domains (reserve)
 │       └── Zones (technical, hidden)
 │
 └── Projects
        ├── Integrations
        ├── Sites
        │     ├── Primary Domain
        │     ├── Donor Domains (0..N)
        │     └── Future site entities (analytics, rules, reports)
        │
        ├── Domains (via Sites)
        │       └── Zones (Cloudflare)
        │
        └── Zones (Cloudflare grouping)
              ├── Integration binding (Cloudflare Account Key)
              ├── Domain list
              └── DNS management context
```

---

## Environment Variables

Secrets are managed via `wrangler secret put`:

* `MASTER_SECRET` — encryption key for credentials.
* `MAILERSEND_API_TOKEN` — email sending.
* `TURNSTILE_SECRET` — bot protection.
* `GOOGLE_CLIENT_ID/SECRET` — OAuth.
* `GITHUB_CLIENT_ID/SECRET` — OAuth.

---

## Architectural Invariants

* All code must be Edge-compatible.
* No Node.js APIs (`fs`, `path`, `process`, etc.).
* Use `crypto.subtle` instead of Node `crypto`.
* All schema changes must go through migrations.
* Apply Pipeline is the only path to modify customer Cloudflare resources.

