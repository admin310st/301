# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**301.st** is a SaaS platform for managing domains, redirects, and TDS (Traffic Distribution System) via Cloudflare infrastructure. Built as a serverless application on Cloudflare Workers with multi-tenant isolation.

## Development Commands

```bash
# Navigate to API worker directory
cd src/api

# Install dependencies
npm install

# Run local development server
npx wrangler dev --env dev

# Deploy to production
npx wrangler deploy

# Execute D1 database queries locally
npx wrangler d1 execute 301-dev --local --env dev --command="SELECT * FROM users;"

# Apply migrations to remote D1
wrangler d1 execute 301 --remote --file=schema/migrations/XXXX_name.sql
```

## Architecture

### Workers (Cloudflare)
- **API Worker** (`src/api/`): Main platform logic - auth, CRUD, integrations, apply engine
- **System Worker** (`src/system/`): Cron jobs, backups, cleanup, statistics collection
- **Webhook Worker** (`src/webhook/`): External event reception (HostTracker, CF Events)
- **Client Workers**: Deployed to customer CF accounts for redirect/TDS execution

### Storage (Cloudflare)
- **D1** (`DB301`): Primary database - users, projects, sites, domains, zones, rules
- **KV Namespaces**:
  - `KV_SESSIONS`: Sessions, OAuth state, omni tokens
  - `KV_CREDENTIALS`: Encrypted API keys (AES-GCM)
  - `KV_RATELIMIT`: Rate limiting
  - `KV_RULES`: Redirect rules for edge
  - `KV_TDS`: Compiled TDS rules

### Key Libraries (Edge-compatible)
- `hono`: HTTP framework
- `zod`: Validation
- `bcrypt-ts`: Password hashing
- `jose`: JWT handling

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
└── migrations/     # SQL migration files (auto-deployed via GitHub Actions)
```

## Key Patterns

### Draft Mode
All user changes save to D1 as `draft`. Nothing applies to Cloudflare until user clicks "APPLY" which triggers the Apply Pipeline.

### Apply Pipeline Flow
```
UI (draft) → API /apply → CF API → Customer Account
```
1. Decrypt CF token (AES-GCM with MASTER_SECRET)
2. Verify token with CF
3. Apply Redirect Rules / deploy Worker / update KV
4. Mark as `applied` in D1

### Error Handling Strategy
- **External API first**: Always call CF/Namecheap before writing to D1
- **Retry with backoff**: D1 failures get 3 retries (100ms, 200ms, 300ms)
- **Rollback on failure**: If D1 write fails after CF success, attempt rollback
- **Partial success**: Batch operations continue on individual failures, collect errors

### Entity Hierarchy
```
Account
└── Projects (campaigns/brands)
    ├── Integrations (CF keys, analytics)
    └── Sites (traffic units)
        ├── Primary Domain (acceptor)
        └── Donor Domains (redirect to primary)
```

Zones are technical containers (1 zone = 1 second-level domain), hidden from UI.

## Environment Variables

Secrets managed via `wrangler secret put`:
- `MASTER_SECRET`: Encryption key for credentials
- `MAILERSEND_API_TOKEN`: Email sending
- `TURNSTILE_SECRET`: Bot protection
- `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`: OAuth

## Notes

- All code must be Edge-compatible (no Node.js APIs like `fs`, `path`, `process`)
- Use `crypto.subtle` for cryptography, not Node `crypto`
- Migrations in `schema/migrations/` auto-deploy on push to main via GitHub Actions
- Documentation in `wiki/` directory - see `Architecture.md` for detailed system design
