# POS Terminal Backend

Standalone till backend for the premium clothing IMS. This service shares the Cloud SQL Postgres database owned by the IMS back office, but runs independently so the counter can keep selling if the IMS backend process is unavailable.

Read `docs/architecture.md` before changing behaviour. It defines the permanent constraints: no schema ownership, no cron, no webhook routes, no direct stock/order mutation outside `order.service.ts`, and mandatory terminal authentication in later phases.

## Scope

This repo is till-only:

- sales order creation and lifecycle actions needed at the counter
- catalogue and inventory reads
- business and integration settings reads
- payment QR and receipt email integration paths retained for orders

This repo does not own migrations, cron jobs, webhook handling, catalogue writes, purchase orders, suppliers, analytics, campaigns, AI search, user management, or bulk import.

## Development

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm db:generate` and `pnpm db:migrate` are intentionally disabled. Run schema changes only from the IMS repo.

## Environment

Copy `.env.example` to a local `.env` and provide POS-safe values. `.env` is gitignored and must never be committed.

Kept environment groups:

- `DATABASE_URL`
- `DATABASE_URL_SECRET_NAME` (use `POS_DATABASE_URL` when Secret Manager is enabled)
- `NODE_ENV`
- `HOST` (defaults to `127.0.0.1`)
- `SHOP_TIMEZONE` (defaults to `Asia/Kolkata`)
- `GCP_PROJECT_ID`
- `GCP_SECRET_MANAGER_ENABLED`
- `CORS_ALLOWED_ORIGINS`
- `TERMINAL_AUTH_CACHE_TTL_SECONDS` (defaults to `60`)
- `GLOBAL_RATE_LIMIT_MAX_REQUESTS` / `GLOBAL_RATE_LIMIT_WINDOW_SECONDS`
- `CASHIER_PIN_MAX_FAILURES` (defaults to `5`)
- `CASHIER_PIN_WINDOW_SECONDS` (defaults to `300`)
- `RAZORPAY_*`
- `EMAIL_*`
