# RUNBOOK (301.st)

Operational commands and procedures.

## Local Development

### API Worker

```bash
cd src/api
npm install
npx wrangler dev --env dev
```

## Deploy

```bash
cd src/api
npx wrangler deploy
```

## Logs (Production Tail)

```bash
cd src/api
npx wrangler tail --format=pretty
```

## D1 Operations

### Execute a query locally

```bash
npx wrangler d1 execute 301-dev --local --env dev --command="SELECT * FROM users;"
```

### Apply a migration remotely

```bash
npx wrangler d1 execute DB301 --remote --file=schema/migrations/XXXX_name.sql --config src/api/wrangler.toml
```

## Notes

* Secrets are managed via `wrangler secret put` (never via `.env`).
* Prefer `npm run build` (dry-run deploy) before pushing.

