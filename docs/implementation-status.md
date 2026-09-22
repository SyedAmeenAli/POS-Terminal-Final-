# Implementation Status

Progress record for the phased build. **This document is a record, not a source of truth** — verify it against the actual repository, migrations, tests and configuration before trusting it.

Specification: `docs/master-implementation-plan.md`
Permanent rules: `docs/architecture.md`

---

## Phase index

| Phase | Name | Status | Completed |
|---|---|---|---|
| 0 | Architecture contract | COMPLETE | 2026-07-29 |
| 1 | Repo bootstrap and surface trim | COMPLETE | 2026-07-29 |
| 2 | Terminal authentication and network hardening | COMPLETE | 2026-07-29 |
| 2A | Cashier profiles and attribution | COMPLETE | 2026-07-29 |
| 2B | Shifts, invoice numbering, card tender | COMPLETE | 2026-07-29 |
| 3 | Least-privilege database role and connectivity | COMPLETE | 2026-07-29 |
| 4 | Till frontend | COMPLETE | 2026-07-29 |
| 5 | Multi-till concurrency verification | COMPLETE | 2026-07-29 |
| 6 | Deployment and operations | COMPLETE WITH DEFERRALS | 2026-07-29 |
| 7 | Owner override for high-risk till actions | COMPLETE | 2026-07-30 |
| 8 | Till operations UX | COMPLETE | 2026-07-30 |

Status values: `NOT STARTED`, `IN PROGRESS`, `COMPLETE`, `COMPLETE WITH DEFERRALS`, `BLOCKED`.

---

## Known repository state at plan authoring

Recorded so a later session can tell what was true at the start rather than inferring it.

- This repo currently contains **documentation only**. No `src/`, no `package.json`. Phase 1 populates it.
- The IMS source repo (`/Users/shaikmoosakalam/Desktop/ims - 1 `) was verified clean: typecheck passing, lint passing, 23 test files / 86 tests passing.
- The shared Cloud SQL database is reachable and contains one active `users` row (the owner identity used for `actorUserId`).
- The IMS repo has **no authentication** — `requireRole` is a no-op, `globalAuthenticationHook` injects the owner, the server binds `0.0.0.0`, no CORS. Phase 2 addresses this for the till.
- The database password used during development was exposed in plaintext and **has not yet been rotated**. Phase 3, task 5.

---

## Outstanding cross-phase items

Carried until explicitly closed.

| Item | Raised | Closes in | Status |
|---|---|---|---|
| Rotate the exposed database password | Pre-Phase 0 | Phase 3 | CLOSED |
| Move both backends to Cloud SQL Auth Proxy | Pre-Phase 0 | Phase 3 | CLOSED |
| ~~Retire the IMS `/pos` route~~ | Pre-Phase 0 | — | **CANCELLED** — client requires both POS clients permanently. See `architecture.md` §3a. Do not re-open. |
| Verify reports tolerate both order classes (null vs populated terminal/cashier/shift) | Coexistence decision | Phase 6 | CLOSED |
| Decide: restrict IMS POS to non-cash, or document the shift-reconciliation gap | Coexistence decision | Phase 6 | CLOSED — documented operational gap |
| Enable macOS auto-login on the till, then run the reboot test | Phase 6 | Before unattended operation | OPEN — LaunchAgents do not start until user login; without auto-login an unattended reboot leaves the till dead |
| Test a Cloud SQL restore into a throwaway clone (`pnpm verify:restore`) | Phase 6 | Before unattended operation | OPEN — production baseline captured 2026-07-29T14:07Z: 427 orders / 427 items / 243 tenders / 234 invoiced / max `INV/2026-27/000234` |
| Re-open the LaunchAgent decision if FileVault is ever enabled | Phase 6 | On FileVault change | WATCH — auto-login becomes impossible and daemons do not help; disk stays encrypted until a human unlocks it |

---

## Phase records

Append one section per completed phase, newest last. Template:

```markdown
## Phase N — <name>

**Status:** COMPLETE | COMPLETE WITH DEFERRALS | BLOCKED
**Date:** YYYY-MM-DD

### Implemented components
### Files changed
### Migrations added
### Tests added
### Verification commands executed, and their results
### Acceptance criteria review
Every criterion marked PASS / FAIL / PARTIAL / NOT TESTED, with an explanation for anything other than PASS.
### Known limitations
### Deferred items
### Decisions made
### Suggested next phase
```

<!-- Phase records begin below this line -->

## Phase 0 — Architecture contract

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Created POS table access contract with read/write, read-only and forbidden table lists.
- Recorded Phase 0 non-goals.
- Verified `docs/architecture.md` was present and left unchanged.

### Files changed

- Created `docs/table-access.md`
- Modified `docs/implementation-status.md`

### Migrations added

None.

### Tests added

None. Phase 0 introduces documentation only.

### Verification commands executed, and their results

- `pwd && rg --files -g 'AGENTS.md' -g 'CLAUDE.md' -g 'docs/master-implementation-plan.md' -g 'docs/architecture.md' -g 'docs/implementation-status.md'` — PASS; required files present.
- `sed -n '1,240p' AGENTS.md` — PASS; repository instructions read.
- `sed -n '1,260p' docs/master-implementation-plan.md` — PASS; Phase 0 tasks and acceptance criteria read.
- `sed -n '1,260p' docs/architecture.md` — PASS; permanent rules and five constraints read.
- `sed -n '1,260p' docs/implementation-status.md` — PASS; current progress record read before update.
- `sed -n '1,260p' docs/phase-controller-prompt.md` — PASS; phased controller read.
- `find . -maxdepth 3 -type f | sort` — PASS; repository inspected and contains documentation only.
- `test ! -e src && test ! -e package.json && test ! -e drizzle && echo 'no application code or migrations present'` — PASS; no application code, package manifest or migrations present.
- `shasum -a 256 docs/architecture.md` before and after Phase 0 edits — PASS; checksum remained `1916cdfecb34f09c83bba011149ed03aab50c7a1cd720632fcf73c330338474e`.

### Acceptance criteria review

- PASS — `docs/architecture.md` present and unmodified by this phase.
- PASS — `docs/table-access.md` created with read/write, read-only and forbidden lists.
- PASS — non-goals recorded in `docs/table-access.md`.
- PASS — no application code written.

### Known limitations

- Repository is still documentation-only. Phase 1 is responsible for bootstrapping application code.

### Deferred items

- All Phase 1 and later implementation work remains deferred until explicitly authorised.

### Decisions made

- Business settings remain named as a category because Phase 0 specification does not enumerate concrete table names for that group.
- `webhook_events` access is explicitly limited to idempotency dedupe.

### Suggested next phase

Phase 1 — Repo bootstrap and surface trim.

## Phase 1 — Repo bootstrap and surface trim

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Copied IMS backend source into this repo, excluding `docs/`, `AGENTS.md`, `CLAUDE.md`, `.git`, `node_modules` and `dist`.
- Initialized fresh git metadata for this standalone project.
- Removed non-till route registrations and deleted non-POS routes, services, adapters, ports, cron, migration files, scripts, IMS frontend and upload leftovers.
- Trimmed catalogue routes to read-only endpoints.
- Trimmed inventory routes to `GET /inventory/:variantId` only.
- Trimmed order routes to till-appropriate order lifecycle, return, receipt email and payment QR endpoints.
- Kept Razorpay, email, secrets, integration HTTP, password hashing, order, catalogue, inventory, settings and audit write-path code.
- Disabled POS-side migration scripts with the schema-ownership message.
- Added read-only mirror header to `src/infrastructure/database/schema.ts`.
- Pruned env schemas and `.env.example` to POS-safe keys only.
- Rewrote `README.md` for the POS terminal backend role.

### Files changed

- Created copied backend project files: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, Docker/config support files and retained `src/` backend code.
- Modified retained backend files under `src/api`, `src/application`, `src/infrastructure`, `src/tests`.
- Modified `README.md`, `.env.example`, `.gitignore`.
- Deleted copied non-POS code: deleted route/service/adapter/port/test surfaces, `src/infrastructure/cron/`, `drizzle/`, `drizzle.config.ts`, `src/infrastructure/database/migrate.ts`, `src/infrastructure/database/seed.ts`, `scripts/`, copied IMS `web/`, `uploads/`, `scratch/`.

### Migrations added

None. POS-side migration commands are disabled.

### Tests added

None. Existing kept tests were updated for the trimmed POS surface.

### Verification commands executed, and their results

- `git status --short` in IMS repo — PASS; clean.
- `pnpm typecheck` in IMS repo — PASS.
- `pnpm lint` in IMS repo — PASS.
- `pnpm test` in IMS repo — PASS after approved rerun; 23 files / 86 tests passed. Initial sandbox run failed with `EPERM` writing Vitest temp files outside the POS writable workspace.
- `rsync -a --exclude ...` from IMS repo to POS repo — PASS.
- `git init` — PASS after approved rerun; initial sandbox run could not create `.git`.
- `pnpm install` — PASS after approved network rerun. Initial sandbox run failed with `fetch failed`.
- `CI=true pnpm install --no-frozen-lockfile` — PASS after approved network rerun; lockfile updated after dependency pruning.
- `CI=true pnpm typecheck` — PASS; zero TypeScript errors.
- `CI=true pnpm lint` — PASS; zero ESLint errors.
- `CI=true pnpm test` — PASS; 9 files / 27 tests passed.
- `CI=true pnpm build` — PASS.
- `CI=true pnpm db:migrate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- `CI=true pnpm db:generate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- `test ! -e src/infrastructure/cron && ! rg -n "registerScheduler" src package.json` — PASS.
- `rg -n -i "shiprocket|delhivery|vertex|gemini|ai_provider|meta_messaging|\bmeta\b" src` — PASS; no integration references.
- `rg -n "app\.(post|patch|delete)" src/api/routes/catalog-routes.ts src/api/routes/inventory.routes.ts` — PASS; no catalogue/inventory write routes.
- `rg -n "app\.(patch|post)\(\"/orders/:id/(ship|deliver|create-shipment)" src/api/routes/orders.routes.ts` — PASS; fulfilment order routes absent.
- `shasum -a 256 AGENTS.md CLAUDE.md docs/architecture.md docs/master-implementation-plan.md docs/table-access.md` — PASS; protected docs and instruction files survived copy with expected hashes.
- `git check-ignore -v .env && git status --short --ignored` — PASS; `.env` and `.env.bak` ignored.
- `curl -sS http://127.0.0.1:3009/health` against approved `CI=true PORT=3009 pnpm dev` server — PASS; returned `{"success":true,"data":{"status":"ok"}}`. Initial sandbox `pnpm dev` failed with `listen EPERM` for `tsx` IPC; approved rerun booted.

### Acceptance criteria review

- PASS — `docs/`, `AGENTS.md`, `CLAUDE.md` survived copy intact.
- PASS — `pnpm typecheck` zero errors.
- PASS — `pnpm lint` zero errors.
- PASS — `pnpm test` passes.
- PASS — `pnpm dev` boots; `GET /health` returns `{"success":true,"data":{"status":"ok"}}`.
- PASS — `pnpm db:migrate` and `pnpm db:generate` both exit 1 with the ownership message.
- PASS — `src/infrastructure/cron/` does not exist; no `registerScheduler` reference remains in `src` or `package.json`.
- PASS — grep finds zero integration references to Shiprocket, Delhivery, Meta, Vertex or Gemini in `src/`.
- PASS — `POST /inventory/adjust` and all catalogue write routes are absent.
- PASS — `.env` is gitignored; secret scan found no committed secrets. Local `.env` and `.env.bak` remain ignored.

### Known limitations

- Phase 2 authentication is not implemented yet; this is expected for Phase 1.
- Backend still binds `0.0.0.0`; Phase 2 owns host hardening.

### Deferred items

- Terminal authentication, CORS, rate limiting and host binding remain deferred to Phase 2.
- Cashier attribution remains deferred to Phase 2A.
- Shifts, invoice numbering and card tender remain deferred to Phase 2B.
- Least-privilege database role and password rotation remain deferred to Phase 3.

### Decisions made

- Removed copied IMS frontend and upload directories because Phase 1 is backend bootstrap; till frontend is Phase 4.
- Retained `audit-log.service.ts` because `order.service.ts` still writes audit entries.
- Retained schema definitions needed for typed Drizzle queries, with the required read-only mirror header.
- POS internal idempotency continues using an existing allowed `webhook_events.provider` enum value with distinct event IDs; no schema migration was made in this repo.

### Suggested next phase

Phase 2 — Terminal authentication and network hardening.

## Phase 2 — Terminal authentication and network hardening

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Preserved approved Phase 1 implementation in git commit `1a3b96b`.
- Added IMS-owned terminal schema: `terminal_status`, `pos_terminals`, and nullable `sales_orders.terminal_id`.
- Added IMS provisioning script `pnpm provision:terminal <terminal name>` that creates a random terminal token, stores only its password hash, and prints the plaintext token once.
- Copied the updated IMS schema mirror into POS while preserving the read-only mirror header.
- Replaced POS authentication with Bearer terminal-token authentication, SHA-256 digest cache, disabled-terminal checks, and owner-user audit attribution.
- Added bounded terminal-auth cache with TTL from `TERMINAL_AUTH_CACHE_TTL_SECONDS`, default `60`.
- Added local-only `POST /internal/flush-auth-cache` for immediate revocation.
- Added once-per-minute `pos_terminals.last_seen_at` updates.
- Added explicit CORS allowlist from `CORS_ALLOWED_ORIGINS`; wildcard origins are rejected.
- Added global in-memory rate limiting keyed by terminal id after auth and by IP before auth.
- Changed POS host default to `127.0.0.1`.
- Wired `POST /orders` to persist the authenticated terminal id on `sales_orders.terminal_id`.
- Ensured auth-failure logging includes source IP only, with no terminal token logging.

### Files changed

- POS: `.env.example`, `README.md`, `package.json`, `pnpm-lock.yaml`
- POS: `src/env.ts`, `src/env-sync.ts`, `src/index.ts`
- POS: `src/api/server.ts`, `src/api/middleware/auth.ts`, `src/api/middleware/global-rate-limit.ts`, `src/api/routes/orders.routes.ts`
- POS: `src/application/services/order.service.ts`
- POS: `src/infrastructure/database/schema.ts`
- POS tests: `src/tests/setup.ts`, `src/tests/terminal-auth.test.ts`, `src/tests/order-terminal.test.ts`
- IMS: `src/infrastructure/database/schema.ts`, `scripts/provision-terminal.ts`, `package.json`

### Migrations added

- IMS: `drizzle/migrations/0004_oval_blob.sql`

Reviewed SQL before applying. It is additive-only: creates one enum, creates `pos_terminals`, adds nullable `sales_orders.terminal_id`, and adds a foreign key from `sales_orders.terminal_id` to `pos_terminals.id`.

### Tests added

- POS terminal authentication route tests for health exemption, absent/unknown/disabled/active terminal tokens, once-per-minute `last_seen_at`, CORS rejection, order terminal attribution, and flush-based revocation.
- POS order service test verifying `terminal_id` is inserted with a new order.

### Verification commands executed, and their results

- `pnpm db:generate` in IMS repo — PASS; generated `0004_oval_blob.sql`.
- Manual read of `drizzle/migrations/0004_oval_blob.sql` — PASS; additive-only.
- `pnpm db:migrate` in IMS repo — PASS; migration applied.
- `pnpm typecheck` in IMS repo — PASS.
- `pnpm lint` in IMS repo — PASS.
- `pnpm test` in IMS repo — PASS after approved rerun for Vitest temp-file writes; 23 files / 86 tests passed.
- `pnpm db:seed` in IMS repo — PASS; created baseline owner/business data for live verification.
- `pnpm seed:demo-products` in IMS repo — PASS; created product/variant/inventory data for live order verification.
- `CI=true pnpm install --no-frozen-lockfile` in POS repo — PASS after approved rerun; dependency tree normalized after adding `@fastify/cors`.
- `CI=true pnpm typecheck` in POS repo — PASS.
- `CI=true pnpm lint` in POS repo — PASS.
- `CI=true pnpm test` in POS repo — PASS; 11 files / 34 tests passed.
- `CI=true pnpm build` in POS repo — PASS.
- `CI=true pnpm db:migrate` in POS repo — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- `CI=true pnpm db:generate` in POS repo — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- Live POS server on `127.0.0.1:3010` — PASS; verified health, auth failures, active terminal, CORS rejection, order persistence, cache flush revocation, and no plaintext-token storage.
- `test ! -e src/infrastructure/cron && ! rg -n "registerScheduler" src package.json` — PASS.
- `rg -n -i "shiprocket|delhivery|vertex|gemini|ai_provider|meta_messaging|\bmeta\b" src` — PASS; no forbidden integration references.
- `rg -n "console\.(log|info|warn|error).*token|authorization" src` — PASS for terminal-token logging; matches are non-terminal auth header construction/tests/redaction references, not terminal-token logs.
- `git check-ignore -v .env .env.bak` — PASS; both local env files ignored.

### Acceptance criteria review

- PASS — Generated migration SQL was reviewed before applying and is additive-only.
- PASS — IMS order/sale regression coverage still passes after migration; no existing IMS sale path was changed except for the nullable terminal column.
- PASS — IMS `pnpm typecheck`, `pnpm lint`, and `pnpm test` are clean.
- PASS — POS `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` are clean.
- PASS — No auth header returns 401 with `{ success:false, message:"Terminal not authorised" }`.
- PASS — Malformed or unknown terminal token returns the same 401 response.
- PASS — Disabled terminal token returns the same 401 response, including after revocation cache flush.
- PASS — Active terminal token permits protected routes.
- PASS — `GET /health` works without a token.
- PASS — `POST /orders` populates `sales_orders.terminal_id` with the authenticated terminal id.
- PASS — Disabling a terminal and calling local cache flush revokes it immediately.
- PASS — Cache TTL is configurable by `TERMINAL_AUTH_CACHE_TTL_SECONDS`, defaults to 60 seconds, and is documented.
- PASS — Disallowed CORS origin is rejected.
- PASS — Provisioning prints the token once and stores only a hash in the database.
- PASS — Terminal-token source and live verification found no plaintext token persisted or logged.

### Known limitations

- Rate limiting is in-memory for this phase; multi-instance production coordination remains Phase 6 operational work unless a later phase specifies a shared limiter.
- The live verification seeded IMS demo products because the development database had no sellable variants before verification.

### Deferred items

- Cashier profiles and cashier attribution remain deferred to Phase 2A.
- Shifts, invoice numbering and card tender remain deferred to Phase 2B.
- Least-privilege database role, Cloud SQL Auth Proxy and exposed database-password rotation remain deferred to Phase 3.

### Decisions made

- Immediate revocation uses the documented local-only `POST /internal/flush-auth-cache` endpoint while restart remains an operational fallback.
- Auth cache stores SHA-256 token digests only, not plaintext tokens or bearer headers.
- POS continues to attach the owner user for audit until cashier attribution is introduced in Phase 2A.
- Terminal provisioning remains an IMS script because IMS owns schema and back-office terminal lifecycle.

### Suggested next phase

Phase 2A — Cashier profiles and attribution.

## Phase 2A — Cashier profiles and attribution

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Preserved approved Phase 2 implementation in POS commit `3d9b3e3` and IMS commit `392eb2e`.
- Added IMS-owned cashier schema: `cashier_status`, `cashiers`, and nullable `sales_orders.cashier_id`.
- Added IMS `pnpm manage:cashier` script with `create`, `disable`, and `reset-pin`; it stores PIN hashes only and prints no PIN value or hash.
- Copied the cashier schema additions into the POS read-only mirror.
- Added terminal-protected POS `GET /cashiers` returning active cashiers only as `{ id, name }`.
- Added terminal-protected POS `POST /cashiers/verify-pin` returning `{ cashierId, name }` for a correct PIN or identical 401 shape for wrong, unknown, disabled, or locked cashiers.
- Added aggressive PIN-failure limiter keyed by terminal id and cashier id, with `CASHIER_PIN_MAX_FAILURES` default `5` and `CASHIER_PIN_WINDOW_SECONDS` default `300`.
- Threaded optional `cashierId` through `createOrder`, `confirmOrder`, `payOrder`, `cancelOrder`, and `returnOrder`.
- Added server-side active-cashier validation before accepting cashier attribution.
- Added `cashierId` + denormalised `cashierName` to order audit metadata when a cashier is supplied, while keeping owner `actorUserId` unchanged.

### Files changed

- POS: `.env.example`, `README.md`
- POS: `src/env.ts`, `src/env-sync.ts`
- POS: `src/api/server.ts`, `src/api/routes/cashiers.routes.ts`, `src/api/routes/orders.routes.ts`
- POS: `src/api/validators/cashiers.ts`, `src/api/validators/orders.ts`
- POS: `src/application/services/cashier.service.ts`, `src/application/services/order.service.ts`
- POS: `src/infrastructure/database/schema.ts`
- POS tests: `src/tests/setup.ts`, `src/tests/cashiers.test.ts`, `src/tests/order-cashier.test.ts`
- IMS: `src/infrastructure/database/schema.ts`, `scripts/manage-cashier.ts`, `package.json`

### Migrations added

- IMS: `drizzle/migrations/0005_smiling_mephistopheles.sql`

Reviewed SQL before applying. It is additive-only: creates `cashier_status`, creates `cashiers`, adds nullable `sales_orders.cashier_id`, and adds a foreign key from `sales_orders.cashier_id` to `cashiers.id`.

### Tests added

- POS cashier route tests for active-only list projection, correct PIN, wrong PIN, unknown cashier id, disabled cashier attribution rejection, identical 401 shape, and configured lockout.
- POS order service tests for cashier id persistence, cashier audit metadata, disabled cashier rejection before insert, and no-cashier order creation with `cashier_id` null.

### Verification commands executed, and their results

- `pnpm db:generate` in IMS repo — PASS; generated `0005_smiling_mephistopheles.sql`.
- Manual read of `drizzle/migrations/0005_smiling_mephistopheles.sql` — PASS; additive-only.
- `pnpm db:migrate` in IMS repo — PASS; migration applied.
- `pnpm typecheck` in IMS repo — PASS.
- `pnpm lint` in IMS repo — PASS.
- `pnpm test` in IMS repo — PASS after approved rerun for Vitest temp-file writes; 23 files / 86 tests passed.
- `CI=true pnpm typecheck` in POS repo — PASS.
- `CI=true pnpm lint` in POS repo — PASS.
- `CI=true pnpm test` in POS repo — PASS; 13 files / 41 tests passed.
- `CI=true pnpm build` in POS repo — PASS.
- `CI=true pnpm db:migrate` in POS repo — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- `CI=true pnpm db:generate` in POS repo — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- `test ! -e src/infrastructure/cron && ! rg -n "registerScheduler" src package.json` — PASS.
- `rg -n -i "shiprocket|delhivery|vertex|gemini|ai_provider|meta_messaging|\bmeta\b" src` — PASS; no forbidden integration references in POS `src`.
- PIN/hash source scans — PASS; PIN hashes appear only in schema/service/script internals and tests, never in API response projection; console scans found no PIN value, PIN hash, or authorization logging. IMS script output contains usage text and status messages only.

### Acceptance criteria review

- PASS — Migration is additive-only and IMS regression tests still pass, so IMS POS/order behaviour remains unaffected by the nullable column.
- PASS — `pnpm typecheck` and `pnpm lint` are clean in both repos.
- PASS — `GET /cashiers` returns active cashiers only and never returns hashes or status detail.
- PASS — Correct PIN returns 200; wrong PIN returns 401; unknown cashier id returns 401 with identical response shape.
- PASS — PIN endpoint locks out after the configured failure threshold.
- PASS — Order with a cashier stores `sales_orders.cashier_id` and writes `cashierId` + `cashierName` into `audit_log.metadata`.
- PASS — Client-supplied disabled cashier id is rejected server-side.
- PASS — Order with no cashier still succeeds and stores `cashier_id` as null.
- PASS — Grep/source review confirms no PIN value or hash is logged or returned.

### Known limitations

- Cashier PIN is attribution only and remains deliberately weaker than terminal authentication.
- PIN failure tracking is in-memory for this phase; multi-instance coordination remains an operational/deployment concern unless a later phase introduces shared state.

### Deferred items

- Shifts, invoice numbering and card tender remain deferred to Phase 2B.
- Least-privilege database role, Cloud SQL Auth Proxy and exposed database-password rotation remain deferred to Phase 3.

### Decisions made

- Unknown cashier and wrong PIN share the same response shape; unknown cashier verification still performs a dummy password check to avoid a cheap existence oracle.
- Cashier name is denormalised into audit metadata at mutation time so audit entries remain readable if a cashier is renamed later.
- `sales_orders.cashier_id` is nullable and optional on every mutation so sales can continue if a cashier is not selected.

### Suggested next phase

Phase 2B — Shifts, invoice numbering, card tender.

## Phase 2B — Shifts, invoice numbering, card tender

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Preserved approved Phase 2A implementation in POS commit `771b6c7` and IMS commit `220b4c9`.
- Added IMS-owned shift schema: `shift_status`, `pos_shifts`, one-open-shift partial unique index per terminal, and nullable `sales_orders.shift_id`.
- Added IMS-owned invoice schema: `invoice_counters`, nullable unique `sales_orders.invoice_number`, and nullable `sales_orders.invoiced_at`.
- Added card reconciliation fields to `payment_tenders`: nullable `card_last4` and `card_approval_code`, with code comments forbidding full PAN, expiry, CVV, track or EMV storage.
- Copied Phase 2B schema additions into the POS read-only schema mirror.
- Added `SHOP_TIMEZONE`, default `Asia/Kolkata`, to env schemas, `.env.example`, tests and README.
- Added POS shift endpoints: `POST /shifts/open`, `GET /shifts/current`, `POST /shifts/close`, `GET /shifts/:id/report`.
- Implemented X/Z reports. `GET /shifts/current` omits `expectedCash`; close computes and stores `expectedCash` and `variance`.
- Linked new POS orders to the current open terminal shift when one exists; orders still succeed with `shift_id` null when no shift is open.
- Added invoice allocation inside `payOrder` transaction using an `invoice_counters` row locked `FOR UPDATE`; replay returns the existing invoice number.
- Added financial-year series formatting in `SHOP_TIMEZONE`, e.g. `INV/2026-27/000001`.
- Enabled recorded card tenders with required last-4 and approval code; full card fields are still absent.

### Files changed

- POS: `.env.example`, `README.md`, `docs/implementation-status.md`
- POS: `src/env.ts`, `src/env-sync.ts`
- POS: `src/api/server.ts`, `src/api/routes/shifts.routes.ts`, `src/api/validators/shifts.ts`, `src/api/validators/orders.ts`
- POS: `src/application/services/order.service.ts`, `src/application/services/shift.service.ts`
- POS: `src/infrastructure/database/schema.ts`
- POS tests: `src/tests/setup.ts`, `src/tests/order-phase-2b.test.ts`, `src/tests/shifts.test.ts`
- IMS: `src/infrastructure/database/schema.ts`

### Migrations added

- IMS: `drizzle/migrations/0006_nappy_captain_stacy.sql`

Reviewed SQL before applying. It is additive-only: creates one enum, two tables, nullable columns, indexes, foreign keys, and the partial unique index enforcing one open shift per terminal.

### Tests added

- POS order tests for 50 sequential gapless invoice numbers, failed tender validation consuming no invoice number, failed pre-allocation stock path consuming no invoice number, replayed pay returning the same invoice, financial-year rollover in `Asia/Kolkata`, card tender acceptance, and card tender rejection without last-4/approval code.
- POS shift tests for rejecting a second open shift, hiding `expectedCash` in the current X report, `SHOP_TIMEZONE` business date after midnight IST, expected-cash arithmetic, and negative variance storage.

### Verification commands executed, and their results

- `pnpm db:generate` in IMS repo — PASS; generated `0006_nappy_captain_stacy.sql`.
- Manual read of `drizzle/migrations/0006_nappy_captain_stacy.sql` — PASS; additive-only and includes the partial unique open-shift index.
- `pnpm db:migrate` in IMS repo — PASS; migration applied.
- `pnpm typecheck` in IMS repo — PASS.
- `pnpm lint` in IMS repo — PASS.
- `pnpm test` in IMS repo — PASS after approved rerun for Vitest temp-file writes; 23 files / 86 tests passed.
- `CI=true pnpm typecheck` in POS repo — PASS.
- `CI=true pnpm lint` in POS repo — PASS.
- `CI=true pnpm test` in POS repo — PASS; 15 files / 50 tests passed.
- `CI=true pnpm build` in POS repo — PASS.
- `CI=true pnpm db:migrate` in POS repo — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- `CI=true pnpm db:generate` in POS repo — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- `test ! -e src/infrastructure/cron && ! rg -n "registerScheduler" src package.json` — PASS.
- `rg -n -i "shiprocket|delhivery|vertex|gemini|ai_provider|meta_messaging|\bmeta\b" src` — PASS; no forbidden integration references in POS `src`.
- Card-data source scan — PASS; no full-card-number storage field exists. Matches were redaction keys, unrelated `trackingNumber` fields, tests, and the explicit no-PAN/no-CVV schema comments.
- Auth/PIN/card console scan — PASS; no terminal token, cashier PIN/PIN hash, authorization header, or card data logging found in POS `src`.

### Acceptance criteria review

- PASS — Migration is additive-only and IMS regression tests still pass, so IMS POS/order behaviour remains unaffected by nullable additions.
- PASS — `pnpm typecheck` and `pnpm lint` are clean in both repos.
- PASS — Second shift open for a terminal with an open shift is rejected; database also enforces this with a partial unique index.
- PASS — `GET /shifts/current` never returns `expectedCash`.
- PASS — `expectedCash` adds opening float and cash tenders, subtracts cash refunds, and excludes UPI/card.
- PASS — Variance is stored as counted cash minus expected cash, including negative values.
- PASS — Invoice numbers are sequential and gapless across 50 sequential pays in regression coverage.
- PASS — Failed validation and failed pre-allocation pay paths consume no invoice number.
- PASS — Replaying a pay idempotency key returns the same invoice number without incrementing the counter.
- PASS — Financial-year rollover starts a new series at 1 using `SHOP_TIMEZONE`, verified with a post-00:00 IST timestamp.
- PASS — Card tender is accepted with last-4 + approval code and rejected without them.
- PASS — Source scan confirms no field exists to hold a full card number.
- PASS — Shift/day business date uses `SHOP_TIMEZONE`, verified with a post-00:00 IST shift timestamp.

### Known limitations

- Shift report gross/discount summaries are intentionally compact for the backend API; frontend presentation/report formatting remains Phase 4.
- Cash refund subtraction treats returned cash orders as cash refunds for reconciliation. Partial-refund tender modelling is not introduced in this phase.

### Deferred items

- Till frontend shift UX, invoice display/receipt rendering, duplicate reprint flow and offline queue integration remain deferred to Phase 4.
- Multi-till adversarial concurrency verification remains deferred to Phase 5.
- Least-privilege database role, Cloud SQL Auth Proxy and exposed database-password rotation remain deferred to Phase 3.

### Decisions made

- Invoice allocation happens only inside the pay transaction and uses `SELECT ... FOR UPDATE` on the counter row, not a Postgres sequence.
- Orders are linked to an open shift opportunistically; no open shift never blocks a sale.
- Current X reports omit `expectedCash`; only close/Z report and closed reprint include it.
- Card support is record-only and limited to bank-slip last-4 plus approval code.

### Suggested next phase

Phase 3 — Least-privilege database role and connectivity.

## Phase 3 — Least-privilege database role and connectivity

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Preserved approved Phase 2B implementation in POS commit `976034b` and IMS commit `b366b8a`.
- Created and verified least-privilege database role `pos_terminal_app`.
- Granted POS read/write, read-only and forbidden-table privileges to match `docs/table-access.md`.
- Revoked schema `CREATE` from the POS role.
- Rotated the previous database-owner password and updated both local ignored env files and Secret Manager versions without committing secret values.
- Split POS Secret Manager lookup from IMS by adding `DATABASE_URL_SECRET_NAME`, so POS reads `POS_DATABASE_URL` while IMS continues to read `DATABASE_URL`.
- Moved both backends to Cloud SQL Auth Proxy connectivity on localhost port `15432`.
- Cleared Cloud SQL authorized networks.
- Removed a catalogue `FOR UPDATE` lock in POS inventory lookup so sales run under read-only catalogue permissions while preserving the `inventory_stock FOR UPDATE` stock lock.

### Files changed

- POS: `.env.example`, `README.md`, `docs/implementation-status.md`
- POS: `src/application/services/inventory.service.ts`
- POS: `src/infrastructure/adapters/gcp-secrets.adapter.ts`
- Ignored local env files in POS and IMS were updated outside git.
- Secret Manager versions for `DATABASE_URL` and `POS_DATABASE_URL` were updated outside git.

### Migrations added

None. Phase 3 changes database grants, credentials and connectivity only. POS migration commands remain disabled.

### Tests added

None. Phase 3 was verified with live role, connectivity and regression checks.

### Verification commands executed, and their results

- POS Phase 2B preservation commit — PASS; commit `976034b`.
- IMS Phase 2B preservation commit — PASS; commit `b366b8a`.
- Grant matrix review against `docs/table-access.md` — PASS; implemented grants match the Phase 3 table contract.
- Live role setup script — PASS; role, grants, env metadata and Secret Manager versions updated.
- Old database password rejection check — PASS; previous password no longer authenticates.
- POS role permission probe through Cloud SQL Auth Proxy — PASS; `current_user` is `pos_terminal_app`, `CREATE TABLE` is denied, `SELECT suppliers` is denied, and `SELECT products` is allowed.
- IMS role probe through Cloud SQL Auth Proxy — PASS; IMS connects through the proxy with the owner role.
- Full live sale through POS backend and Secret Manager — PASS; terminal-authenticated create, confirm and pay completed with status `Paid` and an invoice number.
- Cloud SQL authorized-networks describe — PASS; no authorized-network values are configured.
- POS `CI=true pnpm typecheck` — PASS.
- POS `CI=true pnpm lint` — PASS.
- POS `CI=true pnpm test` — PASS; 15 files / 50 tests passed.
- POS `CI=true pnpm build` — PASS.
- POS `CI=true pnpm db:migrate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- POS `CI=true pnpm db:generate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- IMS `pnpm typecheck` — PASS.
- IMS `pnpm lint` — PASS.
- IMS `pnpm test` — PASS; 23 files / 86 tests passed.
- `git check-ignore -v .env .env.bak` in POS and IMS — PASS; secret-bearing env files remain ignored.
- Committed-file database URL scan in POS — PASS; no committed POS file contains a database URL literal.

### Acceptance criteria review

- PASS — Backend runs entirely on the POS DB user during live POS flow; verified through Secret Manager-backed startup and `current_user`.
- PASS — Full sale completes under the POS role.
- PASS — POS role cannot `CREATE TABLE`.
- PASS — POS role cannot `SELECT suppliers`.
- PASS — POS `pnpm db:migrate` still exits 1 with the schema ownership message.
- PASS — Old database password has been rotated; the old password was rejected, and both repos plus Secret Manager were updated.
- PASS — Both backends connect through Cloud SQL Auth Proxy.
- PASS — Cloud SQL has no authorized-network entry configured.
- PASS — `pnpm test` passes in both repositories after the credential and connectivity change.

### Known limitations

- Cloud SQL public IP remains enabled, but authorized networks are cleared. Public IP was not disabled because Phase 3 says to do so only if nothing else needs it, and this phase did not prove that no other dependency uses it.
- The local proxy port is `15432` because local port `5432` was already occupied.

### Deferred items

- Till frontend remains deferred to Phase 4.
- Multi-till adversarial concurrency verification remains deferred to Phase 5.
- Deployment and operations hardening remains deferred to Phase 6.

### Decisions made

- POS uses `DATABASE_URL_SECRET_NAME=POS_DATABASE_URL` to avoid overwriting the IMS-owned `DATABASE_URL` Secret Manager secret.
- IMS continues to use the `DATABASE_URL` Secret Manager secret with the rotated owner credential.
- Catalogue existence checks avoid `FOR UPDATE`; stock concurrency still locks `inventory_stock` rows in the order service path.

### Suggested next phase

Phase 4 — Till frontend.

## Phase 4 — Till frontend

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Preserved approved Phase 3 implementation in POS commit `c3821a3`.
- Added `web/` as a Vite + React + TypeScript till app.
- Built a single full-screen till surface with no back-office shell, sidebar, command palette, quick-create menu, mobile admin navigation or admin route config.
- Added terminal-token setup screen backed by `localStorage`.
- Added API client Bearer-token injection, 401 blocking screen and replacement-token action without automatically clearing the stored token.
- Kept machine-readable client error types for offline sync decisions.
- Added product search, variant loading, keyboard-wedge barcode scan handling and responsive cart.
- Implemented order and line discounts, split tender, card slip last-4 and card approval-code entry.
- Added IndexedDB-backed offline queue with localStorage fallback for constrained runtimes, stable idempotency keys, FIFO replay, failed-entry surfacing, terminal-revoked recovery and JSON export.
- Added distinct UI states for offline, backend unreachable and database-down 5xx; database-down 5xx queues cash sales instead of prompting a re-ring.
- Added cashier picker/PIN verification, permanent active-cashier display and offline unverified cashier switching.
- Added shift open, X report, counted-cash-first close flow, Z report display and duplicate receipt reprint.
- Added invoice-number display on payment complete, printable receipt and email receipt action.
- Added Vite `/api` dev proxy to the POS backend.
- Fixed the IMS POS bugs while porting: queue sync guard uses a ref instead of display state, cart line controls do not shrink/clip, discount columns are responsive, and the cart header has gap/min-width/flex constraints.

### Files changed

- POS: `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `docs/implementation-status.md`
- Web: `web/package.json`, `web/tsconfig.json`, `web/tsconfig.app.json`, `web/tsconfig.node.json`, `web/vite.config.ts`, `web/index.html`
- Web: `web/src/App.tsx`, `web/src/main.tsx`, `web/src/styles.css`, `web/src/vite-env.d.ts`
- Web: `web/src/api/client.ts`, `web/src/api/orders.ts`, `web/src/api/types.ts`
- Web: `web/src/pages/POSPage.tsx`, `web/src/pages/POSPage.test.tsx`
- Web: `web/src/utils/offlineQueue.ts`, `web/src/test/setup.ts`

### Migrations added

None. Phase 4 is frontend-only.

### Tests added

- Web Vitest coverage for token setup and Bearer authorization.
- Web Vitest coverage for 401 blocking without stored-token deletion.
- Web Vitest coverage for scan to cart, discount, split tender, card slip fields, paid invoice and emailed receipt.
- Web Vitest coverage for database-down cash-sale queueing.
- Web Vitest coverage for terminal-revoked queued entries surviving replacement-token entry.
- Web Vitest coverage for cashier switching, shift open/X/close/Z and duplicate reprint.
- Web Vitest coverage for keyboard-wedge barcode input.

### Verification commands executed, and their results

- `CI=true pnpm install --no-frozen-lockfile` — PASS after approved network rerun; workspace lockfile updated for `web`.
- Web `CI=true pnpm exec tsc -b` — PASS.
- Web `CI=true pnpm lint` — PASS; `oxlint --deny-warnings` reported no warnings, including no hook/dependency suppressions.
- Web `CI=true pnpm test` — PASS; 1 file / 7 tests passed.
- Web `CI=true pnpm build` — PASS; Vite production build completed.
- POS `CI=true pnpm typecheck` — PASS.
- POS `CI=true pnpm lint` — PASS.
- POS `CI=true pnpm test` — PASS; 15 files / 50 tests passed.
- POS `CI=true pnpm build` — PASS.
- POS `CI=true pnpm db:migrate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- POS `CI=true pnpm db:generate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- IMS `pnpm typecheck` — PASS.
- IMS `pnpm lint` — PASS.
- IMS `pnpm test` — PASS after approved rerun for Vitest temp-file writes; 23 files / 86 tests passed.
- Card/full-card source scan — PASS; new web source has no full-card-number, CVV, expiry, PAN or track field. Existing matches are the redaction list, unrelated shipment `trackingNumber`, and the explicit no-PAN/no-CVV schema comment.
- Hook-warning/suppression scan — PASS; no `eslint-disable`, `react-hooks/exhaustive-deps` suppression or `isSyncingQueue` self-dependency exists in `web/src`.
- `git check-ignore -v .env .env.bak web/dist web/node_modules` — PASS; secret env files and generated frontend output/dependencies are ignored.

### Acceptance criteria review

- PASS — `pnpm exec tsc -b` and lint are clean in `web/`.
- PASS — Full frontend sale flow is covered by web tests: scan, cart, discount, split tender, paid invoice and emailed receipt.
- PASS — Barcode scanner input registers via keyboard-wedge key events when the page has focus.
- PASS — Connectivity chip state is driven by stable failure-mode state and queue sync uses a ref guard; no flashing loop or self-feeding dependency remains.
- PASS — Cart CSS renders long names with wrapping, fixed stepper width and responsive discount/tender grids for phone width.
- PASS — No unresolved hook/dependency warnings or suppressions exist in `web/src`.
- PASS — Requests carry `Authorization: Bearer`; no token shows setup; 401 shows blocking screen without wiping the stored token.
- PASS — Offline/database-down cash sale queues with action-time idempotency keys and sync guard; frontend regression covers a queued cash sale instead of duplicate re-ring.
- PASS — Cashier picker works, active cashier is always visible, `cashierId` is included in mutation payloads, and offline switches are labelled unverified.
- PASS — Offline, backend-unreachable and database-down states show distinct messages; 5xx database-down is queueable.
- PASS — Terminal revoked mid-queue marks entries `terminal_revoked`, retains them through token replacement, exposes retry and provides JSON export.
- PASS — Shift open, X report, counted-cash-first close and Z report work; expected cash is not shown until close.
- PASS — Invoice number appears on payment-complete receipt, print surface and email receipt path.
- PASS — Receipt reprint is available for recent orders and marked `DUPLICATE`.
- PASS — Card tender requires last-4 and approval code from the separate card-machine slip; no full-card-number field exists.

### Known limitations

- Phase 4 verification uses frontend tests with mocked API responses for UI acceptance. Live adversarial multi-instance and offline replay verification remains Phase 5 by plan.
- Offline queue stores cash-sale payloads locally until replay; operational recovery and stranded-sale procedures remain Phase 6 runbook work.

### Deferred items

- Multi-till adversarial concurrency verification remains deferred to Phase 5.
- Deployment, process supervision, structured logging, runbook and permanent IMS/POS coexistence checks remain deferred to Phase 6.

### Decisions made

- The till app is a single React screen instead of a routed admin app.
- `web/dist` is generated and ignored; source remains under `web/src`.
- Offline cashier switching uses cached active cashiers and labels the identity unverified rather than pretending PIN verification happened offline.
- The replacement-token flow deliberately preserves queued entries and does not auto-clear tokens on transient 401-like failures.

### Suggested next phase

Phase 5 — Multi-till concurrency verification.

## Phase 5 — Multi-till concurrency verification

**Status:** COMPLETE
**Date:** 2026-07-29

### Implemented components

- Preserved approved Phase 4 implementation in POS commit `c53148a`.
- Added Phase 5 verification evidence in `docs/phase-05-verification-results.md`.
- Fixed POS paid-order return handling so counter refunds work for paid till sales.
- Added a POS `pg` pool idle-client error handler so transient database connection termination does not crash the process.

### Files changed

- `src/application/services/order.service.ts`
- `src/infrastructure/database/db.ts`
- `docs/phase-05-verification-results.md`
- `docs/implementation-status.md`

### Migrations added

None. POS schema remains IMS-owned; no POS migration commands were run except previously established guards in earlier phases.

### Tests added

No committed automated test file was added. Phase 5 is adversarial live verification and its repeatable evidence is recorded in `docs/phase-05-verification-results.md`.

### Verification commands executed, and their results

- Phase 5 live multi-process harness — PASS; 20 oversell races, cross-instance confirm/pay idempotency, failed-pay invoice-gap check, 50 concurrent pays, shift reconciliation, offline replay, attribution and cron duplicate checks passed.
- Phase 5 IMS-down kill test — PASS; POS completed the prepared mid-flight sale and a second sale while IMS was stopped; after IMS restart, IMS read both orders as `Paid`.
- POS `CI=true pnpm typecheck` — PASS.
- POS `CI=true pnpm lint` — PASS.
- POS `CI=true pnpm test` — PASS; 15 files / 50 tests passed.
- POS `CI=true pnpm build` — PASS.
- Web `CI=true pnpm exec tsc -b` — PASS.
- Web `CI=true pnpm lint` — PASS.
- Web `CI=true pnpm test` — PASS; 1 file / 7 tests passed.
- Web `CI=true pnpm build` — PASS.
- IMS `CI=true pnpm typecheck` — PASS.
- IMS `CI=true pnpm lint` — PASS.
- IMS `CI=true pnpm test` — PASS after approved rerun for Vitest temp-file writes; 23 files / 86 tests passed.
- IMS `CI=true pnpm build` — PASS after approved rerun for `dist` writes.

### Acceptance criteria review

- PASS — Oversell race ran 20 iterations with zero oversells and no negative stock.
- PASS — Cross-instance idempotency verified for both `confirm` and `pay`.
- PASS — Invoice numbers were gapless and unique across 50 concurrent pays spanning both POS backends.
- PASS — Failed pay consumed no invoice number; next valid pay received the next suffix.
- PASS — Shift `expectedCash` was correct and variance was stored uncorrected.
- PASS — Kill test proved the till stayed operational with IMS down and IMS saw the paid orders after restart.
- PASS — Offline replay produced no duplicate order/item set; stock-collision replay surfaced insufficient stock and left stock non-negative.
- PASS — `terminal_id` populated for POS orders and remained null for an IMS order.
- PASS — No duplicate cron side effects were found in `alerts`.
- PASS — Results are documented in `docs/phase-05-verification-results.md`; no tests were skipped.

### Known limitations

- IMS still has the legacy POS/order service path without Phase 2B POS-specific invoice, shift and card-tender logic. Phase 5 used two POS backend instances for multi-till concurrency and IMS for null-terminal attribution plus IMS-down availability recovery.
- Phase 5 evidence uses live seeded rows in the shared non-production dataset; the harness itself remains a temporary `/private/tmp` artifact, not committed production code.

### Deferred items

- Deployment, process supervision, structured logging, operational runbooks and permanent IMS/POS coexistence checks remain deferred to Phase 6.

### Decisions made

- Allowing returns from `Paid` is required for a physical till refund and matches the architecture note that returns are kept at the till.
- Database idle-client errors are logged with message only; connection strings and secret values are never logged.

### Suggested next phase

Phase 6 — Deployment and operations.

## Phase 6 — Deployment and operations

**Status:** COMPLETE WITH DEFERRALS
**Date:** 2026-07-29

### Implemented components

- Preserved approved Phase 5 implementation in POS commit `389073e`.
- Added structured JSON backend logging for request, response and error events.
- Added launchd supervision templates for the POS backend and Cloud SQL Auth Proxy.
- Added Caddy TLS reverse-proxy template.
- Added macOS `newsyslog` log-rotation config.
- Added production `pnpm start` script.
- Added `docs/runbook.md` with terminal provisioning, revocation, stranded-sales recovery, cashier management, credential rotation, fix porting, rebuild, update and database-unreachable procedures.
- Added `docs/secret-inventory.md` with secret locations, readers and rotation evidence.
- Added `docs/phase-06-verification-results.md` with live evidence and explicit not-tested/deferred items.

### Files changed

- `package.json`
- `src/api/server.ts`
- `src/api/middleware/auth.ts`
- `src/infrastructure/database/db.ts`
- `src/index.ts`
- `src/utils/logger.ts`
- `deploy/Caddyfile`
- `deploy/launchd/com.pos-terminal.backend.plist`
- `deploy/launchd/com.pos-terminal.cloud-sql-proxy.plist`
- `deploy/newsyslog.conf`
- `docs/runbook.md`
- `docs/secret-inventory.md`
- `docs/phase-06-verification-results.md`
- `docs/implementation-status.md`

### Migrations added

None. POS schema remains IMS-owned. POS migration commands were run only as guards and exited 1 with the ownership message.

### Tests added

No new automated test files were added. Phase 6 added operational configuration and documentation plus live verification evidence.

### Verification commands executed, and their results

- `plutil -lint deploy/launchd/com.pos-terminal.backend.plist deploy/launchd/com.pos-terminal.cloud-sql-proxy.plist` — PASS.
- Cloud SQL instance describe via gcloud — PASS; automated backups enabled, PITR enabled, 7 retained backups and 7 transaction-log retention days.
- Cloud SQL backup list via gcloud — PASS; latest automated backup `1785276000000` was successful on 2026-07-29.
- Built POS backend live check on `HOST=127.0.0.1` — PASS; `/health` returned `{"success":true,"data":{"status":"ok"}}`.
- Launchd install and `kill -9` restart test — PASS; installed LaunchAgents under `~/Library/LaunchAgents` using `~/Library/Logs/pos-terminal`; backend restarted from PID `29225` to `29415` and `/health` returned `HTTP:200`; Cloud SQL Auth Proxy restarted from PID `28252` to `29491`.
- Phase 6 live sale / revocation / replacement recovery script — PASS; full sale paid with invoice `INV/2026-27/000173`, disabled-token flush revoked immediately, replacement-token recovery sale paid with invoice `INV/2026-27/000174`.
- Structured log sampling — PASS; JSON logs contain `timestamp`, `method`, `path`, `status`, `durationMs`, `terminalId`, and `errorType` on error events.
- Phase 5 regression harness — PASS; 20 oversell races, cross-instance idempotency, 50 gapless concurrent invoices, shift reconciliation, offline replay, attribution and cron checks passed.
- Phase 5 IMS-down kill regression — PASS; POS completed two sales while IMS was stopped and IMS saw both after restart.
- POS `CI=true pnpm typecheck` — PASS.
- POS `CI=true pnpm lint` — PASS.
- POS `CI=true pnpm test` — PASS; 15 files / 50 tests passed.
- POS `CI=true pnpm build` — PASS.
- POS `CI=true pnpm db:migrate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- POS `CI=true pnpm db:generate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- Web `CI=true pnpm exec tsc -b` — PASS.
- Web `CI=true pnpm lint` — PASS.
- Web `CI=true pnpm test` — PASS; 1 file / 7 tests passed.
- Web `CI=true pnpm build` — PASS.
- IMS `CI=true pnpm typecheck` — PASS.
- IMS `CI=true pnpm lint` — PASS.
- IMS `CI=true pnpm test` — PASS after approved rerun for Vitest temp-file writes; 23 files / 86 tests passed.
- IMS `CI=true pnpm build` — PASS after approved rerun for `dist` writes.
- IMS null-attribution static scan — PASS; IMS application/report code does not reference `terminal_id`, `cashier_id` or `shift_id`.
- IMS `/pos` static route verification — PASS; IMS keeps the route, page, sidebar route config and permission entry. `web/src/App.routing.test.tsx` contains a direct-navigation regression, but IMS `vitest.config.ts` only includes `src/**/*.test.ts`, so that web test is not part of the configured IMS suite.
- IMS-POS shift-cash gap documentation — PASS; `docs/runbook.md` and `docs/architecture.md` document that IMS `/pos` cash is outside standalone till `pos_shifts.expectedCash`.
- Ignore check for `.env`, `.env.bak`, `web/dist`, `web/node_modules` — PASS.

### Acceptance criteria review

- PARTIAL — Backend and Auth Proxy restart automatically after `kill -9` and reboot: both LaunchAgents restarted after `kill -9`, but reboot recovery is not tested yet because macOS auto-login must be enabled first.
- PASS — TLS terminating or `HOST=127.0.0.1` verified for same-host: built backend verified on `127.0.0.1`; Caddy template added for network exposure.
- PASS — Structured JSON logs with `terminalId`, rotation configured: live logs verified and `deploy/newsyslog.conf` added.
- PASS — No secrets in committed files, image or unit file: deploy templates contain no secret values and secret-bearing files remain ignored.
- PARTIAL — Cloud SQL backups confirmed; restore actually tested: automated backups and PITR confirmed with gcloud, but restore to a temporary target was not executed.
- PASS — Runbook covers every procedure in task 6, including revocation-lag caveat.
- PASS — Immediate revocation tested: disable plus cache flush stopped a cached token immediately.
- PASS — Stranded-sales recovery tested under a replacement token.
- PASS — Secret inventory recorded with rotation dates; compromised-password rotation from Phase 3 confirmed.
- PASS — A full test sale completed on the built POS backend.
- PASS — IMS `/pos` route still present: static verification confirmed the `/pos` route, `POSPage.tsx`, sidebar route config and permission entry remain in IMS. `web/src/App.routing.test.tsx` contains a direct-navigation regression, but the configured IMS suite does not include web tests.
- PASS — Back-office reports verified against a mix of both order classes: Phase 5 live data included POS orders with terminal attribution and an IMS order with null terminal/cashier/shift; IMS report/application code scan found no attribution-column assumption, and IMS regression tests passed.
- PASS — IMS-POS cash-reconciliation gap documented and accepted operationally: `docs/runbook.md` and `docs/architecture.md` state standalone till shift reconciliation covers till cash only, not IMS `/pos` cash.

### Known limitations

- Launchd templates were installed and `kill -9` restart was verified for both backend and Cloud SQL Auth Proxy. Reboot recovery is still untested until macOS auto-login is enabled.
- Cloud SQL restore was not tested to a temporary instance or database in this session. Backups and PITR are confirmed, and the runbook records the restore-test procedure.
- IMS POS remains available permanently by client requirement. Cash taken through IMS `/pos` is outside standalone till shift reconciliation and must be handled operationally.

### Deferred items

- Enable macOS auto-login on the till account and perform the reboot restart test.
- Perform a Cloud SQL restore to a temporary target and record the restore evidence.

### Decisions made

- Same-host deployment uses `HOST=127.0.0.1`; TLS is required only if the backend is exposed beyond localhost.
- Operational unit templates use placeholders and no embedded secrets.
- IMS POS was kept because current Phase 6 and architecture require both POS clients permanently.

### Suggested next phase

No further implementation phase is defined in the master plan. Complete the deferred operational installation and restore checks before production cutover.

## Phase 7 — Owner override for high-risk till actions

**Status:** COMPLETE
**Date:** 2026-07-30

### Implemented components

- Preserved approved Phase 6 implementation in POS commit `d9c8e00`.
- Added Phase 7 plan addendum in `docs/master-implementation-plan-phase-7.md`.
- Added POS-only owner override session handling using cookie `pos_owner_session`, 30-minute TTL and `POS_OWNER_SESSION_SECRET`, distinct from IMS `OWNER_SESSION_SECRET`.
- Added owner override API routes: `POST /owner/verify`, `POST /owner/end`, `GET /owner/status`.
- Added terminal-keyed owner password failure rate limiting and lockout.
- Added POS read path for shared IMS owner credential at `business_settings.owner_password_hash`; no schema changes or POS migrations were added.
- Added `requireOwnerOverride` gate for paid cancel, returns, QR voids and discounts over `OVERRIDE_DISCOUNT_PERCENT_THRESHOLD`.
- Added server-side aggregate effective discount calculation for line-level plus order-level discounts.
- Added successful and failed owner override audit rows without owner password, hash or session-token values.
- Added till UI owner password modal, retry-after-authorise behavior, active override banner, one-tap end and offline block for gated discounted sales.
- Updated secret inventory for POS and IMS owner session signing secrets.

### Files changed

- `.env.example`
- `docs/architecture.md`
- `docs/secret-inventory.md`
- `docs/master-implementation-plan-phase-7.md`
- `src/api/middleware/auth.ts`
- `src/api/middleware/owner-rate-limit.ts`
- `src/api/routes/owner.routes.ts`
- `src/api/routes/orders.routes.ts`
- `src/api/server.ts`
- `src/application/services/business-settings.service.ts`
- `src/application/services/order.service.ts`
- `src/application/services/owner-session.service.ts`
- `src/env.ts`
- `src/env-sync.ts`
- `src/tests/order-discounts.test.ts`
- `src/tests/orders-routes.test.ts`
- `src/tests/owner-override-routes.test.ts`
- `src/tests/owner-session.test.ts`
- `src/tests/terminal-auth.test.ts`
- `web/src/api/client.ts`
- `web/src/api/orders.ts`
- `web/src/api/types.ts`
- `web/src/pages/POSPage.tsx`
- `web/src/pages/POSPage.test.tsx`
- `web/src/styles.css`

### Migrations added

None. POS schema remains IMS-owned. `db:migrate` and `db:generate` were run only as guards and exited 1 with the ownership message.

### Tests added

- `src/tests/owner-session.test.ts`
- `src/tests/owner-override-routes.test.ts`
- Added aggregate owner-discount tests in `src/tests/order-discounts.test.ts`.
- Added owner override frontend retry and offline-gated-discount tests in `web/src/pages/POSPage.test.tsx`.
- Updated order route and terminal auth mocks for the new owner override service contract.

### Verification commands executed, and their results

- POS `CI=true pnpm typecheck` — PASS.
- POS `CI=true pnpm lint` — PASS.
- POS `CI=true pnpm test` — PASS; 18 files / 73 tests passed.
- POS `CI=true pnpm build` — PASS.
- POS `CI=true pnpm db:migrate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- POS `CI=true pnpm db:generate` — PASS for guard; exited 1 with `Schema is owned by the ims-1 repo. Run migrations there.`
- Web `CI=true pnpm exec tsc -b` — PASS.
- Web `CI=true pnpm lint` — PASS.
- Web `CI=true pnpm test` — PASS; 1 file / 9 tests passed.
- Web `CI=true pnpm build` — PASS.
- IMS `CI=true pnpm typecheck` — PASS after approved rerun for sibling-repo temp-file writes.
- IMS `CI=true pnpm lint` — PASS after approved rerun for sibling-repo temp-file writes.
- IMS `CI=true pnpm test` — PASS after approved rerun for sibling-repo temp-file writes; 26 files / 99 tests passed.

### Acceptance criteria review

- PASS — `pnpm typecheck`, `pnpm lint`, `pnpm test` clean in both POS and IMS repos.
- PASS — Paid order cancel without override returns 401; with POS owner session succeeds.
- PASS — Pending cancel without override succeeds.
- PASS — Return without override returns 401; with POS owner session succeeds.
- PASS — 30% effective discount requires override; 10% does not.
- PASS — Aggregate discount is evaluated basket-wide: 24% line discount plus 2% order discount trips the 25% threshold even though each individual discount source is below threshold.
- PASS — `owner_password_hash` unset denies gated actions with `OWNER_PASSWORD_NOT_SET`.
- PASS — Wrong owner password returns 401 and lockout engages after configured failures.
- PASS — IMS-issued `ims_owner_session` cookie does not authorise POS override.
- PASS — POS owner session expires after the 30-minute TTL.
- PASS — Successful and failed override attempts write audit rows; tests assert attempted owner password values do not appear in audit rows.
- PASS — Same shared owner hash is read per verification request; test changes the mocked IMS-owned hash and verifies the new password without restarting POS.
- PASS — Offline high-discount checkout shows a connection-required message and is not queued.
- PASS — Local implementation only; no push was performed.

### Known limitations

- The live IMS browser/back-office password-change flow was not manually exercised; automated route coverage verifies the same shared hash read semantics and no-restart behavior.
- `POS_OWNER_SESSION_SECRET` is optional in local development and falls back to a random process secret if unset; production must set it explicitly and keep it distinct from IMS `OWNER_SESSION_SECRET`.

### Deferred items

- None for Phase 7.

### Decisions made

- Owner override remains a terminal-authenticated additional gate, not a replacement for terminal authentication.
- Discount gating uses `>` threshold semantics: exactly 25% is allowed with the default threshold, anything over 25% requires owner override.
- Because the Phase 7 DoD phrase "24% applied to every line still trips the threshold" conflicts with the default 25% threshold when read literally, the implemented test covers the intended exploit: every individual discount source stays below threshold while the aggregate basket discount exceeds it.

### Suggested next phase

No further implementation phase is defined in the Phase 0-6 master plan. Phase 7 is complete; wait for the next authorised phase before continuing.

## Phase 8 — Till operations UX

**Status:** COMPLETE
**Date:** 2026-07-30

### Implemented components

- Added visible `Sign out cashier` control that appears only when a cashier is active.
- Sign-out clears only cashier state: active cashier, cashier picker and PIN input. It does not close a shift, clear the terminal token or block unattributed sales.
- Kept shift close copy consistent as `Close Shift`.
- Preserved counted-cash-first control: close API is not called until counted cash is entered; expected cash stays hidden until the close response.
- Shift close sends `{ cashierId, countedCash, note }` when a cashier is active and omits `cashierId` when no cashier is selected through existing payload construction.
- Expanded Z report display with business date, order count, tender totals, expected cash, counted cash and variance.
- Replaced minimal receipt panel with compact monochrome receipt rendering invoice, short order ref, date/time, cashier name or `Unattributed`, terminal id/name when present, line items, subtotal, discount, tax, total, tenders, card last-4/approval code and return/refund marker.
- Added print stylesheet for receipt-only printing on thermal-width paper.
- Extended frontend order types for fields already returned by the backend order response.

### Files changed

- `docs/implementation-status.md`
- `web/src/api/types.ts`
- `web/src/pages/POSPage.tsx`
- `web/src/pages/POSPage.test.tsx`
- `web/src/styles.css`

### Migrations added

None. Phase 8 did not run `pnpm db:generate` or `pnpm db:migrate`, and did not add schema changes.

### Tests added

- Cashier sign-out test covering button visibility, state clearing, shift preservation, terminal-token preservation and successful unattributed sale after sign-out.
- Shift close UX assertions covering no close API call before counted cash, close payload with cashier id when active, Z report fields and no automatic cashier sign-out.
- Receipt test covering required receipt fields and absence of terminal token, database URL, full card number, CVV and authorization values from rendered output.

### Verification commands executed, and their results

- Initial web checks attempted before dependencies were restored — FAIL due sandboxed registry DNS `fetch failed` after `web/node_modules` was recreated.
- `CI=true pnpm install --frozen-lockfile` — PASS after approved network rerun; restored workspace dependencies.
- POS `CI=true pnpm typecheck` — PASS.
- POS `CI=true pnpm lint` — PASS.
- POS `CI=true pnpm test` — PASS; 18 files / 73 tests passed.
- POS `CI=true pnpm build` — PASS.
- Web `CI=true pnpm exec tsc -b` — PASS.
- Web `CI=true pnpm lint` — PASS.
- Web `CI=true pnpm test` — PASS; 1 file / 11 tests passed.
- Web `CI=true pnpm build` — PASS.

### Acceptance criteria review

- PASS — Cashier sign-out button appears only with `activeCashier`.
- PASS — Sign-out clears `activeCashier`, cashier picker and PIN input.
- PASS — Sign-out does not close shift and does not clear terminal token.
- PASS — Sale succeeds immediately after sign-out with no `cashierId` in the create-order payload.
- PASS — Shift close action uses `Close Shift` consistently.
- PASS — Counted-cash-first control held: test clicks `Close Shift` before counted cash and verifies `/shifts/close` is not called.
- PASS — Close request includes `cashierId` when cashier is active; existing payload omits it when none is selected.
- PASS — Z report renders expected, counted, variance, tender totals by method, order count and business date.
- PASS — Header reverts to `No open shift` after close.
- PASS — Cashier is not automatically signed out on shift close.
- PASS — Receipt renders store label fallback, invoice, short order ref, transaction date/time, cashier, terminal, line items, subtotal, discount, tax, total, tenders and card slip fields.
- PASS — Receipt renders `RETURN`/`REFUND` marker when order status is `Returned`/`Refunded`.
- PASS — Receipt test confirms forbidden values are not rendered.
- PASS — No schema conflict encountered; no POS migrations or schema-generation commands were run.

### Known limitations

- Business/store name is not currently present in `business_settings`; receipt uses `POS Terminal` fallback rather than adding a schema field.
- Receipt cashier name for old duplicate reprints depends on the active cashier list or any `cashierName` supplied by a response. If a cashier id is present but no name is available, the receipt shows a short cashier reference instead of blank text.

### Deferred items

- None for Phase 8.

### Decisions made

- Did not auto sign-out cashier on shift close because cashier identity and shift state are independent by architecture.
- Kept backend unchanged for Phase 8; frontend types were extended for already-present order fields.

### Suggested next phase

No further implementation phase is defined here. Wait for explicit authorisation before continuing.
