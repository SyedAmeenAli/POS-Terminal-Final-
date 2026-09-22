# Repository Instructions for Codex

## Required reading, before modifying anything

1. `docs/master-implementation-plan.md` — the authoritative specification
2. `docs/architecture.md` — permanent rules that do not change between phases
3. `docs/implementation-status.md` — progress record

The master implementation plan is authoritative for business rules, architecture, database semantics, security constraints, integration boundaries, phase definitions and acceptance criteria.

`docs/implementation-status.md` records progress but **must be verified against the actual repository** — code, migrations, tests, configuration. Do not assume it is accurate.

## What this repository is

A standalone POS terminal backend and frontend, sharing a Cloud SQL Postgres database with a separate IMS back-office repository at `/Users/shaikmoosakalam/Desktop/ims - 1 ` (**the trailing space is part of the folder name** — copy-paste it, never retype).

## Development workflow

- Work on **only** the explicitly authorised phase.
- Do not automatically continue to another phase.
- Inspect existing code before creating new abstractions.
- Prefer extending established repository patterns over introducing new ones.
- Keep changes small, reviewable, and scoped to the current phase.
- Add or update tests for every material behaviour introduced.
- Run the applicable type-check, lint, test, migration and build commands.
- **Never report a check as passing unless you actually executed it successfully.**
- Never hide, skip, or delete a failing test to complete a phase.
- Update `docs/implementation-status.md` when a phase completes.
- Stop after the completion report.

## Commands

Once Phase 1 has populated the repository:

```bash
pnpm install
pnpm dev          # start backend
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm db:generate` and `pnpm db:migrate` are **deliberately disabled** in this repository and exit 1. Schema is owned by the IMS repo. This is not a bug — do not "fix" it.

Frontend (from Phase 4): `cd web && pnpm dev`, `pnpm exec tsc -b`, `pnpm lint`.

## Protected rules

Do not alter the following unless the authorised phase explicitly requires it. If a phase appears to require it, **report the conflict instead of proceeding**.

- The five constraints in `docs/architecture.md` §2
- Stock and reservation semantics
- Transaction boundaries and idempotency rules
- Invoice-number allocation (sequential, gapless, per financial year)
- Cash reconciliation arithmetic
- Public API contracts consumed by either frontend
- Authentication rules and the identity model in `architecture.md` §3
- Audit-trail completeness
- Secret-management practices

## Absolute prohibitions

- Never run `drizzle-kit generate` or `db:migrate` from this repository.
- Never write raw SQL that mutates `inventory_stock` or `sales_orders` — go through `order.service.ts`.
- Never register cron jobs or webhook routes here.
- Never weaken security controls, validation, idempotency, transaction boundaries or audit requirements to make implementation easier.
- Never place secrets, credentials, tokens, private keys or customer data in source, tests, fixtures, logs, documentation or commits.
- Never store a full card number, expiry, CVV or track data anywhere.
- Never log terminal tokens, cashier PINs, PIN hashes or full connection strings.

## When documentation and implementation conflict

Report, do not silently resolve:

- the documented requirement
- the current implementation
- the consequence of the mismatch
- your recommended resolution
