# Quality gates (301.st)

## After any code changes:
- npm run lint

## Before marking the task as done:
- npm run typecheck

## Before commit/push:
- npm run build

## Type correctness is validated via:
- TypeScript LSP (interactive)
- `npm run typecheck` (wrangler types)

## ESLint is NOT used as a type checker.

