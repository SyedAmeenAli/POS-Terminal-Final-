# Repository Instructions for Claude Code

## Required reading, before planning or modifying code

1. `docs/master-implementation-plan.md` — the authoritative specification
2. `docs/architecture.md` — permanent rules that do not change between phases
3. `docs/implementation-status.md` — progress record

Treat the master implementation plan as authoritative. Treat the status document as a **record to verify**, not a source of truth — check it against the actual code, migrations, tests and configuration.

## What this repository is

A standalone POS terminal backend and frontend, sharing a Cloud SQL Postgres database with a separate IMS back-office repository at `/Users/shaikmoosakalam/Desktop/ims - 1 ` (**the trailing space is part of the folder name** — copy-paste it, never retype).

## Mandatory workflow

1. Inspect the existing repository.
2. Identify the explicitly authorised phase.
3. Read its dependencies and acceptance criteria.
4. Produce a brief implementation plan.
5. Implement **only** that phase.
6. Add or update tests.
7. Run the relevant verification commands.
8. Review every acceptance criterion.
9. Update `docs/implementation-status.md`.
10. Produce a completion report.
11. **Stop.**

Do not begin another phase without explicit user authorisation.

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

`pnpm db:generate` and `pnpm db:migrate` are **deliberately disabled** here and exit 1. Schema is owned by the IMS repo. This is intentional — do not "fix" it.

Frontend (from Phase 4): `cd web && pnpm dev`, `pnpm exec tsc -b`, `pnpm lint`.

## Do not

- Assume earlier phases are correctly implemented without checking.
- Rewrite unrelated modules or perform broad refactoring not required by the current phase.
- Introduce undocumented architectural patterns.
- Change business rules to simplify implementation.
- Suppress tests, validation, errors or security controls.
- Claim a check passed without executing it.
- Include secrets or customer data in code, tests, fixtures or logs.
- Run `drizzle-kit generate` or `db:migrate` from this repository.
- Write raw SQL mutating `inventory_stock` or `sales_orders` — go through `order.service.ts`.
- Register cron jobs or webhook routes here.
- Store a full card number, expiry, CVV or track data anywhere.
- Log terminal tokens, cashier PINs, PIN hashes or full connection strings.

## Protected rules

Do not alter unless the authorised phase explicitly requires it:

- The five constraints in `docs/architecture.md` §2
- Stock and reservation semantics
- Transaction boundaries and idempotency rules
- Invoice-number allocation (sequential, gapless, per financial year)
- Cash reconciliation arithmetic
- Public API contracts
- Authentication rules and the identity model in `architecture.md` §3
- Audit-trail completeness
- Secret-management practices

## When documentation and implementation conflict

Report clearly rather than silently resolving:

- the documented requirement
- the current implementation
- the consequence of the mismatch
- your recommended resolution
