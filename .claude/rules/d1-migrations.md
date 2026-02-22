# D1 Migrations Rules (301.st)

All database schema changes must follow migration rules.

## General Rules

* All schema changes must be placed in `schema/migrations/`.
* Never modify existing migration files.
* One logical change = one migration file.
* Migration files must be immutable once committed.

## Breaking Changes

* Breaking schema changes require an ADR.
* Avoid destructive changes when possible.
* Prefer additive changes (new columns, new tables) over modification.

## Deployment

* Migrations are applied via Wrangler.
* Migrations auto-deploy on push to main.

Database consistency is mandatory.

