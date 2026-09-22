# Master Implementation Plan — Standalone POS Terminal

Authoritative specification. Permanent rules live in `docs/architecture.md` and are not repeated here — **read that first**.

Phases are executed **one at a time**, each explicitly authorised. Acceptance criteria are a mandatory checklist, not guidance.

| Phase | Name | Touches IMS repo? |
|---|---|---|
| 0 | Architecture contract | No |
| 1 | Repo bootstrap and surface trim | No |
| 2 | Terminal authentication and network hardening | Yes (schema) |
| 2A | Cashier profiles and attribution | Yes (schema) |
| 2B | Shifts, invoice numbering, card tender | Yes (schema) |
| 3 | Least-privilege database role and connectivity | Yes (grants) |
| 4 | Till frontend | No |
| 5 | Multi-till concurrency verification | Runs both |
| 6 | Deployment and operations | No |

Paths: this repo is `/Users/shaikmoosakalam/Desktop/pos-terminal`. The IMS repo is `/Users/shaikmoosakalam/Desktop/ims - 1 ` — **the trailing space is part of the folder name**; copy-paste it, never retype.

---

# Phase 0 — Architecture Contract

## Objective
Establish the written contract every later phase obeys. No application code.

## Tasks
1. Verify `docs/architecture.md` is present and its five constraints are understood.
2. Create `docs/table-access.md` listing the tables this backend touches:
   - Read/write: `sales_orders`, `sales_order_items`, `payment_tenders`, `stock_events`, `inventory_stock`, `audit_log`, `webhook_events` (idempotency dedupe only), and — once created — `pos_terminals` (read for auth, write `last_seen_at`), `pos_shifts` (insert on open, update on close), `invoice_counters` (locked and incremented during allocation).
   - Read only: `products`, `product_variants`, `categories`, `product_types`, business settings, `users` (owner resolution), and — once created — `cashiers` (read the active list and verify PINs; creation/disable/PIN-reset are back-office work).
   - Explicitly forbidden: `suppliers`, `purchase_orders`, `purchase_order_items`, `supplier_payments`, `expenses`, `campaigns`, `ai_search_sessions`, `ai_search_messages`, `conversation_state`, `product_embeddings`.
   - Note: terminal, cashier and shift **rows are created by IMS provisioning scripts**, not by this backend. Its writes are limited to the operational updates above. This classification must match the Phase 3 grant list exactly — if they diverge, the grants are wrong or the till breaks.
3. Record the non-goals: no schema authority, no cron, no webhook handling, no purchase orders, no suppliers, no analytics, no AI search, no campaigns, no user management, no bulk import.
4. Initialise `docs/implementation-status.md` if absent.

## Acceptance Criteria
- [ ] `docs/architecture.md` present and unmodified by this phase
- [ ] `docs/table-access.md` created with all three lists
- [ ] Non-goals recorded
- [ ] No application code written

---

# Phase 1 — Repo Bootstrap and Surface Trim

## Objective
Populate this repo from the IMS backend, then delete everything a till does not need. Subtraction and rewiring only — no new features.

## Preconditions
- IMS repo has a clean working tree (committed), passes `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Tasks

1. **Copy source into this existing repo** (it already contains `docs/`, `AGENTS.md`, `CLAUDE.md` — do not destroy them):
   ```
   rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
     --exclude 'docs' --exclude 'AGENTS.md' --exclude 'CLAUDE.md' \
     "/Users/shaikmoosakalam/Desktop/ims - 1 /" \
     "/Users/shaikmoosakalam/Desktop/pos-terminal/"
   ```
   Then `git init` (fresh history — this is a new project, not a fork) and `pnpm install`.

2. **Keep routes:** `orders.routes.ts`, `catalog-routes.ts`, `inventory.routes.ts`, `settings.routes.ts`.

3. **Delete routes** and their `app.register(...)` calls in `src/api/server.ts`: `ai-search`, `campaigns`, `purchase-orders`, `supplier-routes`, `finance`, `analytics`, `users`, `audit-log`, `webhooks`, `shipments`, `alerts`.

4. **Keep services:** `order.service.ts`, `catalog-service.ts`, `inventory.service.ts`, `business-settings.service.ts`, `integration-settings.service.ts`, `audit-log.service.ts` (write path still called by `order.service.ts`), `auth.service.ts` (currently the `AuthenticatedUser` type; Phase 2 reworks it).

5. **Delete services:** `ai-search`, `ai-search-session`, `ai-vision`, `campaigns`, `purchase-order`, `supplier-service`, `finance`, `analytics`, `user-management`, `webhook`, `shipment`, `alerts`, `bulk-import`.

6. **Trim `catalog-routes.ts` to read paths only.** Keep `GET /categories`, `GET /product-types`, `GET /products`, `GET /products/:id`, `GET /products/:id/variants`. Delete every write endpoint including `analyze-image`, `upload-image`, `bulk-import`, `ai/generate-category`.
   *Rationale and accepted cost:* see `architecture.md` §7. The unknown-item-at-counter gap is a recorded limitation, not something to solve with catalogue write access.

7. **Trim `orders.routes.ts`.** Keep `POST /orders`, `GET /orders`, `GET /orders/:id`, `PATCH /orders/:id/confirm`, `PATCH /orders/:id/pay`, `PATCH /orders/:id/cancel`, `PATCH /orders/:id/return`, `POST /orders/:id/email-receipt`, `POST /orders/:id/generate-payment-qr`, `POST /orders/:id/void-payment-qr`. Delete `ship`, `deliver`, `create-shipment`.
   `return` **stays** — a till that cannot process a refund is unusable in a real shop.

8. **Trim `inventory.routes.ts` to `GET /inventory/:variantId` only.** Delete `GET /inventory/stagnant` and — deliberately — `POST /inventory/adjust`. Stock write-off from a till is the classic shrinkage fraud path and a 4-digit PIN is not adequate attribution for it. Sales still decrement stock correctly through the order flow.

9. **Delete adapters and ports:** `vertex-vision.*` + `vision.port.ts`, `meta.*` + `messaging.port.ts`, `shiprocket.*`, `delhivery.*` + `shipment.port.ts`, `ai-provider.port.ts`.
   **Keep:** `razorpay.*` + `payment.port.ts`, `email.*` + `email.port.ts`, `gcp-secrets`, `local-env-secrets`, `secrets-factory`, `secrets.port.ts`, `integration-http.ts`, `errors.ts`, `password.adapter.ts` (Phase 2 and 2A use its hashing).
   Update `integration-factories.ts` accordingly.

10. **Delete cron entirely:** `rm -rf src/infrastructure/cron/` and remove the `registerScheduler()` import and call from `src/index.ts`. Deleting the directory is deliberate — a config flag can be flipped back on by accident, a missing directory cannot.

11. **Neutralise migrations.** Delete `drizzle/`, `drizzle.config.ts`, `src/infrastructure/database/migrate.ts`, `src/infrastructure/database/seed.ts`, and `scripts/`. Replace both migration scripts in `package.json`:
    ```json
    "db:generate": "echo 'Schema is owned by the ims-1 repo. Run migrations there.' && exit 1",
    "db:migrate":  "echo 'Schema is owned by the ims-1 repo. Run migrations there.' && exit 1",
    ```
    **Keep** `src/infrastructure/database/schema.ts` — Drizzle needs it for typed queries — with this header:
    ```ts
    // READ-ONLY MIRROR of the ims-1 schema. This repo does not own or migrate the
    // database. When ims-1's schema changes, copy this file across.
    ```

12. **Prune env** in `.env`, `.env.example`, `src/env.ts`, `src/env-sync.ts`. Keep `DATABASE_URL`, `NODE_ENV`, `GCP_PROJECT_ID`, `GCP_SECRET_MANAGER_ENABLED`, `RAZORPAY_*`, `EMAIL_*`. Remove `SHIPROCKET_*`, `DELHIVERY_*`, `META_MESSAGING_*`, `VERTEX_VISION_*`, `AI_PROVIDER`, `GEMINI_*`, `JWT_SECRET`. `env.ts` and `env-sync.ts` carry duplicate schemas and must stay in sync with each other. They fail boot on missing required keys — desired behaviour, do not soften.

13. **Delete tests** for deleted surfaces. Keep order, catalog, inventory, tax, split-tender and email-receipt tests.

14. Rewrite `README.md` for this repo's actual role, referencing `docs/architecture.md`.

## Acceptance Criteria
- [ ] `docs/`, `AGENTS.md`, `CLAUDE.md` survived the copy intact
- [ ] `pnpm typecheck` zero errors
- [ ] `pnpm lint` zero errors
- [ ] `pnpm test` passes
- [ ] `pnpm dev` boots; `GET /health` returns `{"success":true,"data":{"status":"ok"}}`
- [ ] `pnpm db:migrate` and `pnpm db:generate` both exit 1 with the ownership message
- [ ] `src/infrastructure/cron/` does not exist; no `registerScheduler` reference remains
- [ ] Grep finds zero references to shiprocket, delhivery, meta, vertex or gemini in `src/`
- [ ] `POST /inventory/adjust` and all catalogue write routes are absent
- [ ] `.env` gitignored; no secrets committed

---

# Phase 2 — Terminal Authentication and Network Hardening

## Objective
Close the network hole. Machine-to-machine authentication, preserving the deliberate no-login cashier UX.

## Tasks

### Part A — schema, executed in the IMS repo
1. Add to `src/infrastructure/database/schema.ts`:
   ```ts
   export const terminalStatusEnum = pgEnum("terminal_status", ["active", "disabled"]);

   export const posTerminals = pgTable("pos_terminals", {
     id: uuid("id").primaryKey(),
     name: varchar("name", { length: 100 }).notNull(),
     tokenHash: text("token_hash").notNull(),
     status: terminalStatusEnum("status").default("active").notNull(),
     lastSeenAt: timestamp("last_seen_at", { mode: "date" }),
     createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
   });
   ```
   On `salesOrders` add nullable `terminalId: uuid("terminal_id").references(() => posTerminals.id)`.
2. `pnpm db:generate`, **read the generated SQL** and confirm additive-only (one `CREATE TYPE`, one `CREATE TABLE`, one nullable `ADD COLUMN`), then `pnpm db:migrate`.
3. Add `scripts/provision-terminal.ts` in the IMS repo: takes a name, generates `crypto.randomBytes(32).toString("base64url")`, stores only `await hashPassword(token)`, prints the plaintext **once** with a "will not be shown again" warning. Register a `provision:terminal` package script.
4. Copy the updated `schema.ts` into this repo, preserving its read-only-mirror header.

### Part B — middleware, in this repo
5. Rewrite `src/api/middleware/auth.ts`:
   - `getTerminalTokenFromRequest` — `Authorization: Bearer <token>` only. No cookie fallback; this is a machine client.
   - `requireTerminal` — 401 `{ success: false, message: "Terminal not authorised" }` when the header is absent, the token matches nothing, or the terminal is `disabled`.
   - **Verification cache:** bcrypt per request is too slow for a till. Cache SHA-256(token) → terminal, bounded size, TTL from `TERMINAL_AUTH_CACHE_TTL_SECONDS` (default 60). Cache the digest, never the raw token.
   - **Revocation is a security property, not an implementation detail.** A disabled terminal keeps working until its cache entry expires, so provide an immediate-revocation path that does not require waiting out the TTL: a localhost-bound `POST /internal/flush-auth-cache`, or a documented backend restart (sub-second for a till). Whichever is chosen must be tested and appear in the Phase 6 runbook.
   - Attach `request.terminal` via Fastify module augmentation, matching the existing `request.user` pattern.
   - Continue resolving the owner `users` row for `actorUserId` — audit FKs still need it. The *gate* is the terminal token.
   - Register as a global `onRequest` hook. Exempt **only** `GET /health`.
6. `POST /orders` passes `request.terminal.id` into `createOrder`, persisted to `sales_orders.terminal_id`.
7. Update `lastSeenAt` at most once per minute per terminal, not per request.

### Part C — network hardening, in this repo
8. **CORS:** `pnpm add @fastify/cors`, explicit allowlist from `CORS_ALLOWED_ORIGINS` (comma-separated). Never `*`.
9. **Rate limiting:** global limiter following the existing `webhook-rate-limit.ts` / `ai-rate-limit.ts` pattern. Key by terminal id when authenticated, IP otherwise. Generous enough for a real cashier (1–2 req/s), tight enough to blunt brute force.
10. **Bind address:** replace the hardcoded `host = "0.0.0.0"` in `src/index.ts` with env-driven `HOST`, default `127.0.0.1`.
11. Log authentication failures with source IP. Never log the attempted token.

## Acceptance Criteria
- [ ] Generated migration SQL reviewed and confirmed additive-only before applying
- [ ] IMS back office still completes a sale unchanged after the migration
- [ ] `pnpm typecheck` + `pnpm lint` clean in both repos
- [ ] No `Authorization` header → 401
- [ ] Malformed or unknown token → 401
- [ ] Valid token for a `disabled` terminal → 401
- [ ] Valid active token → 200
- [ ] `GET /health` reachable with no token
- [ ] Order created via this API has `sales_orders.terminal_id` populated
- [ ] Disabling a terminal then flushing the cache revokes access immediately, without waiting out the TTL
- [ ] `TERMINAL_AUTH_CACHE_TTL_SECONDS` is env-configurable, default documented
- [ ] Request from a disallowed origin rejected by CORS
- [ ] `provision:terminal` prints the token once; plaintext appears nowhere in the database
- [ ] Grep confirms the plaintext token is never logged

---

# Phase 2A — Cashier Profiles and Attribution

## Objective
Attribute every sale, discount, void and refund to the person who performed it. Today every action resolves to the single owner account, so the audit log cannot answer "who gave that 40% discount".

**Read `architecture.md` §3 before implementing.** Terminal token is the security boundary; the cashier PIN is attribution only.

## Tasks

### Part A — schema, in the IMS repo
1. Add:
   ```ts
   export const cashierStatusEnum = pgEnum("cashier_status", ["active", "disabled"]);

   export const cashiers = pgTable("cashiers", {
     id: uuid("id").primaryKey(),
     name: varchar("name", { length: 100 }).notNull(),
     pinHash: text("pin_hash").notNull(),
     status: cashierStatusEnum("status").default("active").notNull(),
     createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
   });
   ```
   On `salesOrders` add nullable `cashierId: uuid("cashier_id").references(() => cashiers.id)`.
2. No `audit_log` schema change: its existing `metadata` jsonb carries `cashierId` **and** `cashierName`. The name is denormalised deliberately — an audit trail that becomes unreadable when a cashier is renamed or removed is not an audit trail.
3. Generate, review, migrate, copy `schema.ts` across.
4. Add `scripts/manage-cashier.ts` in the IMS repo: create (name + PIN, stores hash only), disable, reset PIN. **No API surface** — cashier management is back-office work.

### Part B — backend, in this repo
5. `GET /cashiers` — `{ id, name }` for **active** cashiers only. No hashes, no status detail, no disabled entries.
6. `POST /cashiers/verify-pin` — `{ cashierId, pin }` → 200 `{ cashierId, name }` or 401. Requires a valid terminal token like every route.
   - Rate-limit this endpoint aggressively and lock after ~5 failures in a short window, keyed by `cashierId` + terminal.
   - Identical response shape **and timing** for "unknown cashier" and "wrong PIN" — do not leak which cashiers exist.
7. Thread `cashierId` through `createOrder`, `confirmOrder`, `payOrder`, `cancelOrder`, `returnOrder`. Include `cashierId` + `cashierName` in `logAudit` metadata. Keep `actorUserId` unchanged — cashier is additive attribution, not a replacement.
8. **Validate server-side** that the supplied `cashierId` exists and is `active` before accepting any mutation. Never trust a client-supplied identity.

## Acceptance Criteria
- [ ] Migration additive-only; IMS POS unaffected
- [ ] `pnpm typecheck` + `pnpm lint` clean in both repos
- [ ] `GET /cashiers` returns active only, never a hash
- [ ] Correct PIN → 200; wrong PIN → 401; unknown cashier id → 401 with identical shape
- [ ] PIN endpoint locks out after the configured threshold
- [ ] Order with a cashier has `sales_orders.cashier_id` set and `audit_log.metadata` carries `cashierId` + `cashierName`
- [ ] Client-supplied `cashierId` for a `disabled` cashier is rejected server-side
- [ ] Order with no cashier still succeeds with `cashier_id` null
- [ ] Grep confirms no PIN or hash is logged or returned

---

# Phase 2B — Shifts, Invoice Numbering, Card Tender

## Objective
Three things a till cannot go to production without: cash reconciliation, legally valid invoice numbers, and card acceptance.

## Tasks

### Part 1 — shift sessions and cash reconciliation

Schema (IMS repo):
```ts
export const shiftStatusEnum = pgEnum("shift_status", ["open", "closed"]);

export const posShifts = pgTable("pos_shifts", {
  id: uuid("id").primaryKey(),
  terminalId: uuid("terminal_id").notNull().references(() => posTerminals.id),
  openedByCashierId: uuid("opened_by_cashier_id").references(() => cashiers.id),
  closedByCashierId: uuid("closed_by_cashier_id").references(() => cashiers.id),
  status: shiftStatusEnum("status").default("open").notNull(),
  openingFloat: numeric("opening_float", { precision: 10, scale: 2 }).notNull(),
  countedCash: numeric("counted_cash", { precision: 10, scale: 2 }),
  expectedCash: numeric("expected_cash", { precision: 10, scale: 2 }),
  variance: numeric("variance", { precision: 10, scale: 2 }),
  note: text("note"),
  openedAt: timestamp("opened_at", { mode: "date" }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { mode: "date" }),
}, (table) => [
  index("pos_shifts_terminal_status_idx").on(table.terminalId, table.status),
]);
```
Add nullable `shiftId` to `salesOrders`.

Rules:
- **One open shift per terminal**, enforced with a partial unique index (`WHERE status = 'open'`), not application logic alone.
- **Do not block sales when no shift is open** — same reasoning as cashier selection. Sales proceed with `shift_id` null and are reported as "outside shift" so they are visible rather than hidden.
- `expectedCash` = `openingFloat` + cash tenders − cash refunds, computed **server-side** at close from `payment_tenders`. Card and UPI are excluded entirely — they never enter the drawer. Getting this wrong makes every till look massively over.
- `variance` = `countedCash` − `expectedCash`. Store it; never auto-correct. A corrected variance is a shortage you will never find.
- **The cashier enters counted cash before `expectedCash` is revealed.** The API must not return `expectedCash` until `countedCash` is submitted — otherwise the count stops being an independent check.

Endpoints:
- `POST /shifts/open` — `{ openingFloat, cashierId }`, rejects if one is already open.
- `GET /shifts/current` — open shift plus live **X report** (order count, gross, discounts, tax, per-tender totals, refunds). Read-only, repeatable, must **not** include `expectedCash`.
- `POST /shifts/close` — `{ countedCash, cashierId, note? }` → computes expected and variance, closes, returns the **Z report**.
- `GET /shifts/:id/report` — reprintable Z report.

Add `SHOP_TIMEZONE` to env (default `Asia/Kolkata`) and use it for all shift/day boundaries.

### Part 2 — sequential invoice numbering

Schema (IMS repo):
```ts
export const invoiceCounters = pgTable("invoice_counters", {
  id: uuid("id").primaryKey(),
  seriesKey: varchar("series_key", { length: 32 }).notNull(),   // "2025-26"
  lastNumber: integer("last_number").default(0).notNull(),
}, (table) => [uniqueIndex("invoice_counters_series_idx").on(table.seriesKey)]);
```
Add to `salesOrders`: nullable `invoiceNumber: varchar("invoice_number", { length: 32 })` with a unique index, and nullable `invoicedAt`.

Rules:
- Assign **at `payOrder`**, inside the existing transaction — not at confirm. A confirmed-then-cancelled order must not consume a number.
- Lock the counter row with `SELECT ... FOR UPDATE` inside that transaction. This serialises allocation across both backends and all tills, the same mechanism that already prevents overselling.
- A replayed pay (existing idempotency guard) must return the **same** number, never allocate a second.
- Format `INV/{seriesKey}/{zero-padded}`, e.g. `INV/2025-26/000123`. Series key is the Indian financial year (April–March) in `SHOP_TIMEZONE`.
- Never expose an endpoint that allocates a number outside the pay transaction.

### Part 3 — card tender, recorded not integrated

- Remove the server-side rejection of `card` in split-tender validation.
- Add nullable `cardLast4: varchar(4)` and `cardApprovalCode: varchar(32)` to `payment_tenders`.
- Require both when a `card` tender is recorded — without them, card totals cannot be reconciled against bank settlement.
- **Never** a full PAN, expiry, CVV or track data (`architecture.md` §5). Add a code comment stating this so a future contributor does not "helpfully" add a card-number field.
- Card tenders count toward the order total but are excluded from `expectedCash`.

## Acceptance Criteria
- [ ] Migration additive-only, verified by reading generated SQL; IMS POS unaffected
- [ ] `pnpm typecheck` + `pnpm lint` clean in both repos
- [ ] Second `POST /shifts/open` on a terminal with an open shift → rejected
- [ ] `GET /shifts/current` never returns `expectedCash`
- [ ] `expectedCash` includes cash, subtracts cash refunds, excludes card and UPI
- [ ] Variance stored as-is, including when negative
- [ ] Invoice numbers sequential and gapless across 50 sequential pays
- [ ] A failed or rolled-back pay consumes no invoice number
- [ ] Replaying a pay idempotency key returns the same invoice number
- [ ] Financial-year rollover starts a new series at 1
- [ ] Card tender accepted with last-4 + approval code, rejected without
- [ ] Grep confirms no field anywhere can hold a full card number
- [ ] Shift/day boundaries computed in `SHOP_TIMEZONE`, verified with a post-00:00-IST sale

---

# Phase 3 — Least-Privilege Database Role and Connectivity

## Objective
Make the shared-database topology structurally safe, and remove the manual-IP-allowlist fragility.

**Why this matters more than it looks:** constraint 1 is currently only documentation. A role with no DDL converts it into something the database enforces. Defence in depth — the `package.json` guard stops the honest mistake, the role stops everything else.

## Tasks
1. Create the role from a superuser connection:
   ```sql
   CREATE ROLE pos_terminal_app WITH LOGIN PASSWORD '<generated>';
   ```
   Generate with `openssl rand -base64 32` or a password manager. Never reuse the existing password.
2. Grant only what the till needs:
   - `SELECT` on catalogue, business settings, `cashiers`, `users`.
   - `SELECT, UPDATE` on `pos_terminals` — update is required for `last_seen_at` (Phase 2). Deliberately **no** `INSERT`: terminals are provisioned from the IMS repo, never created by the till.
   - `SELECT, INSERT, UPDATE` on `sales_orders`, `sales_order_items`, `payment_tenders`, `stock_events`, `inventory_stock`, `audit_log`, `webhook_events`, `pos_shifts`, `invoice_counters`.
   - Cross-check this list against `docs/table-access.md` before applying. They must agree exactly.
   - `USAGE, SELECT` on sequences those tables require.
   - **No** `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, or `DELETE`. `DELETE` is omitted deliberately: the order lifecycle cancels and returns via status transitions, never row deletion. A legitimate need for `DELETE` is a design smell to investigate, not to grant.
   - `REVOKE ALL` on the forbidden tables from `docs/table-access.md`.
   - `REVOKE CREATE ON SCHEMA public FROM pos_terminal_app`.
3. Point this backend's `DATABASE_URL` at the new role. Percent-encode special characters in the password (`@` → `%40`) or the connection-string parser misreads the host.
4. Store credentials in GCP Secret Manager via the existing `SecretsPort` / `GcpSecretsAdapter`. Set `GCP_SECRET_MANAGER_ENABLED=true` and confirm resolution, with local `.env` as fallback only.
5. **Rotate the exposed password.** The original database password was pasted in plaintext during development and must be treated as compromised. Rotate in Cloud SQL Console → Users, then update `.env` and the Secret Manager value in **both** repos. Not optional, not deferrable.
6. **Move both backends to the Cloud SQL Auth Proxy.** The current public-IP + authorized-networks setup already broke once when the laptop IP rotated. A till cannot depend on someone re-editing an allowlist.
   - Grant `roles/cloudsql.client` to each backend's identity.
   - Run the proxy alongside each backend; point `DATABASE_URL` at `127.0.0.1:5432`.
   - Remove the authorized-networks entries afterwards; disable public IP if nothing else needs it.
   - The proxy terminates TLS, so the `ssl: { rejectUnauthorized: false }` workaround in `db.ts` is no longer needed on that path. Keep the existing `isLocalDb` branch intact so both paths still work.

## Acceptance Criteria
- [ ] Backend runs entirely on `pos_terminal_app`; a full sale completes
- [ ] As that role, `CREATE TABLE test_x (id int);` fails with a permission error
- [ ] As that role, `SELECT * FROM suppliers;` fails with a permission error
- [ ] `pnpm db:migrate` still exits 1 (Phase 1 guard intact)
- [ ] Old password rotated in both repos; the old password no longer works
- [ ] Both backends connect via the Auth Proxy with no authorized-networks entry
- [ ] `pnpm test` green in both repos after the credential change

---

# Phase 4 — Till Frontend

## Objective
Build the till UI: single full-screen app, seeded from the IMS `POSPage.tsx`, with its known bugs fixed rather than cloned.

## Tasks
1. Scaffold `web/` as Vite + React + TypeScript. Copy `api/client.ts`, `api/types.ts`, `api/orders.ts`, the component primitives `POSPage.tsx` actually imports, the theme provider, and `POSPage.tsx`. Leave the rest behind.
2. **No back-office chrome.** `AppShell`, `Sidebar`, `CommandPalette`, `QuickCreateMenu`, `MobileNavigation` and `config/routes.ts` are admin concerns. The till page **is** the app.
3. **Terminal token** in `api/client.ts`: read from `localStorage`, inject `Authorization: Bearer`. First run shows a one-time setup screen to paste the provisioned token. On 401 show a blocking "terminal not authorised" screen with a re-enter action — but do **not** auto-clear the stored token, or a brief backend blip becomes a cashier lockout.
4. Reuse `client.ts`'s existing `extractErrorMessage`; keep `errorType` machine-readable for the sync UI.
5. **Fix these three bugs while porting** (diagnosed against the IMS POS):
   - **Sync status flash loop.** `syncQueue` is a `useCallback` listing `isSyncingQueue` in its own deps while calling `setIsSyncingQueue` inside itself, so it gets a new identity every run; the `useEffect` that calls it lists `syncQueue` as a dependency, so each sync retriggers the effect. Self-feeding loop, visible as a flashing connectivity chip. **Fix:** hold the guard in a `useRef`; keep any display-only state out of every dependency array. Also resolve the related `react-hooks(exhaustive-deps)` warning about the missing `isNetworkFailure` dependency rather than suppressing it — genuine stale-closure risk in the same path.
   - **Cart item clipping.** The quantity-stepper column lacks `flexShrink: 0`; the per-line discount grid uses a hard `gridTemplateColumns: '110px 1fr'` floor that cannot fit at phone width. **Fix:** add `flexShrink: 0`; drop or make the fixed column responsive.
   - **Cart header collision.** Header uses `justifyContent: 'space-between'` with no `gap` and an unconstrained banner span. **Fix:** add `gap`, `flexShrink: 0` on the left group, `flex: 1; minWidth: 0; textAlign: right; lineHeight: 1.4` on the banner — or move it to its own row.
6. **Offline queue** unchanged in design: IndexedDB-backed, idempotency keys generated at action time (not sync time), FIFO replay, `failed` entries surfaced not dropped.
7. **Offline honesty:** the persistent "stock levels may be outdated" banner is a trust requirement. `INSUFFICIENT_STOCK` on replay must surface as a distinct, actionable failure.
8. **Cashier UX** (Phase 2A backend): shift-start picker, PIN entry, active cashier permanently visible, one-tap switch (friction here is what makes staff share one profile all day). Send `cashierId` with mutations. Do not block sales when none is selected. Offline: cache `{ id, name }`, allow switching without PIN, mark those actions `cashierUnverified: true` and label them as unverified — never present an unchecked identity as verified.
9. **Distinguish three failure modes** — they look identical to a cashier and are completely different problems:
   - *Offline*: queue absorbs sales, stock-staleness banner, cash tender only.
   - *Backend unreachable, network fine*: same queueing, different message; points at the supervisor's job.
   - *Backend up, database down*: API answers but data calls 5xx, and `GET /health` may still say `ok` since it only proves the HTTP server is alive. **Treat these 5xx as queueable**, exactly like network failures. Surfacing "sale failed" here makes the cashier re-ring and creates duplicate orders.
10. **Terminal revoked while offline — do not destroy real revenue.** A till can be disabled while holding queued sales that genuinely happened.
    - A 401 during replay marks entries `failed` with reason `terminal_revoked`, never discards them.
    - Queued entries survive a token change — they are keyed by their own idempotency keys.
    - After a new token is entered, those entries can be retried under it; the backend's idempotency guard makes retry safe.
    - Provide a JSON queue export as the last-resort reconciliation path.
11. **Shift UX** (Phase 2B backend): open prompt with float + cashier; persistent header showing open shift and cashier; X report view; close flow where **counted cash is entered before expected is revealed** — do not display or even pre-fetch expected beforehand; Z report shown and reprintable.
12. **Invoice number and reprint:** show the invoice number prominently on the payment-complete screen and on every receipt, printed and emailed — it is the legal identifier, not the order UUID. Provide receipt reprint for recent orders, visibly marked `DUPLICATE` so a reprint cannot be passed off as a second sale.
13. **Card tender UX:** require last-4 and approval code from the bank terminal slip. Labels must make clear these come from the separate card machine. **Never** a full-card-number field.
14. **Dev proxy:** `vite.config.ts` proxies `/api` to this backend's port. A different production origin must appear in `CORS_ALLOWED_ORIGINS`.

## Acceptance Criteria
- [ ] `pnpm exec tsc -b` and lint clean in `web/`
- [ ] Full sale end to end: scan → cart → discount → split tender → paid → emailed receipt
- [ ] Barcode scanner input registers (keyboard-wedge; page must have focus)
- [ ] Connectivity chip steady, no flashing
- [ ] Cart renders cleanly at phone width with a long product name — nothing clipped or overlapping
- [ ] No unresolved `react-hooks(exhaustive-deps)` warnings
- [ ] Requests carry `Authorization: Bearer`; no token → setup screen; 401 → blocking screen without wiping a working session
- [ ] Offline cash sale syncs once on reconnect, no duplicate
- [ ] Cashier picker works; active cashier always visible; `cashierId` reaches the backend; offline switch labelled unverified
- [ ] Three failure modes show distinct messages; a database-down 5xx queues instead of prompting a re-ring
- [ ] Terminal revoked mid-queue: entries marked `terminal_revoked`, survive a new token, retry successfully, exportable as JSON
- [ ] Shift open/X/close/Z all work; counted cash required before expected is shown
- [ ] Invoice number on screen and on printed + emailed receipts
- [ ] Receipt reprint works and is marked `DUPLICATE`
- [ ] Card tender requires last-4 + approval code; no full-card-number field exists

---

# Phase 5 — Multi-Till Concurrency Verification

## Objective
Prove the inherited correctness guarantees actually hold across two backend processes. Adversarial testing, not feature work. **A failure here is a stop-ship** — do not paper over it with a retry.

## Preconditions
- Run against a non-production dataset or data you are willing to lose.
- Both backends running simultaneously on different ports against the same database. Testing them one at a time proves nothing.
- Verify outcomes by reading the **database**, not by trusting API responses.

## Tasks
1. Seed a variant with `inventory_stock` quantity exactly 1.
2. **Oversell race.** Fire `confirm` for that SKU at both backends as near-simultaneously as possible (a script, not manual clicking). Exactly one succeeds; the other gets `INSUFFICIENT_STOCK`; stock lands at 0, never negative; exactly one `RESERVE` row. **Repeat ~20 times** with fresh stock — a single pass proves very little about a race.
3. **Cross-instance idempotency.** Send an identical `confirm` idempotency key to backend A then backend B. The second must dedupe, not re-apply. Exactly one reservation, one dedupe row. Repeat for `pay`. This is the test that catches a per-process cache masquerading as a durable guard.
4. **Invoice numbering under concurrency.** Drive ~50 pays across both instances, some concurrent. Numbers strictly sequential, **no gaps, no duplicates**; a failed pay consumes none; a replayed key returns the same number. Verify by reading `sales_orders.invoice_number` sorted.
5. **Shift reconciliation accuracy.** Ring a deliberate mix — cash, UPI, card, split cash+UPI, and a cash refund — then close. `expectedCash` includes only cash movements (refund subtracted) and excludes UPI and card entirely. Variance equals counted − expected and is stored uncorrected.
6. **Availability / kill test.** With a sale mid-flight, kill the IMS backend. The till completes the sale, starts and completes another, and restarting the IMS backend shows those orders with nothing to reconcile. **This is the original justification for the whole architecture** — if it fails, the build did not deliver its one required benefit.
7. **Offline replay.** Offline → cash sale → reconnect: exactly one order, one item set, one reservation. Then the harder case: queue a sale offline, sell that SKU's last unit through the IMS backend meanwhile, reconnect — the replay must surface `INSUFFICIENT_STOCK` clearly rather than failing silently or corrupting stock.
8. **Attribution.** Orders via this backend have `terminal_id` populated; orders via the IMS POS have it null — proving the nullable column did not break the existing path.
9. **Cron non-duplication.** With both backends up across a cron interval, confirm alerts and GC occur once. Check `alerts` for duplicate rows for the same condition.
10. Record everything in `docs/phase-05-verification-results.md`, including any test skipped — say so explicitly rather than leaving it implied.

## Acceptance Criteria
- [ ] Oversell race: 20 iterations, zero oversells, stock never negative
- [ ] Cross-instance idempotency verified for both `confirm` and `pay`
- [ ] Invoice numbers gapless and unique across ~50 pays spanning both backends
- [ ] Shift `expectedCash` correct; variance stored uncorrected
- [ ] Kill test: till fully operational with the IMS backend down
- [ ] Offline replay: no duplicates; stock-collision case surfaces clearly
- [ ] `terminal_id` populated for POS orders, null for IMS orders
- [ ] No duplicate cron side effects
- [ ] Results documented, including any skipped test

---

# Phase 6 — Deployment and Operations

## Objective
Run unattended. A shop counter has no engineer behind it.

## Tasks
1. **TLS** in front of this backend (Caddy or nginx; Caddy gets automatic certificates with far less config). Bearer tokens over plaintext HTTP on shop wifi are trivially sniffable, and a stolen token works until noticed. Same-host deployments may skip this only if `HOST=127.0.0.1` is genuinely verified.
2. **Process supervision** (systemd / pm2 / launchd) for both the backend and the Auth Proxy, restart-on-failure and start-on-boot, short backoff. A till that dies at 11am and stays dead is not a till.
3. **Health checking** wired to the supervisor so a hung-but-alive process is restarted. Note that `/health` only proves the HTTP server is up; consider a deeper variant that also checks the database, and be deliberate about which the supervisor uses — a database blip restarting the app process helps nobody.
4. **Structured JSON logging**: timestamp, method, path, status, duration, `terminalId`, `errorType`. File output with rotation at minimum.
5. **Backups:** confirm Cloud SQL automated backups and PITR are enabled and note the retention window. Two independent writers make a bad write more likely, not less — **test a restore** rather than trusting the setting.
6. **Write `docs/runbook.md`** covering:
   - Provision a terminal.
   - **Revoke a lost or stolen terminal:** set `status = 'disabled'` **and immediately flush the auth cache** (Phase 2). Without the flush the token keeps working until the TTL elapses. Never treat disabling alone as revocation.
   - **Recover sales stranded on a revoked terminal:** provision a replacement, enter its token, retry the `terminal_revoked` entries (idempotency makes retry safe), or export the queue as JSON and reconcile by hand. Losing real cash sales to a revocation is an operational failure.
   - **Manage cashiers** via `manage-cashier.ts`. Disabling stops new attribution but never rewrites history — the denormalised `cashierName` keeps old audit records readable.
   - Rotate database credentials.
   - **Port a bug fix from the IMS repo.** List the files existing in both — chiefly `order.service.ts`, `inventory.service.ts`, `schema.ts`, shared adapters. Rule: **`schema.ts` changes always originate in the IMS repo and are copied here, never the reverse.**
   - Rebuild a till from bare metal.
   - What to do when the till cannot reach the database: expected behaviour is the offline queue absorbing cash sales; escalation is Auth Proxy first, then Cloud SQL status.
7. **Secret inventory:** where each secret lives, who can read it, when it was last rotated. Confirm and date the compromised-password rotation from Phase 3.
8. **Update procedure:** git pull, install, build, restart supervisor, verify `/health` and one test sale. Write it down; "whatever I did last time" is not a procedure.
9. **Both POS clients are permanent — do NOT retire the IMS POS page.** The client requires both the IMS back-office POS (`/pos` in the IMS frontend) and this standalone till. An earlier draft of this plan called for retiring the IMS page after cutover; that was withdrawn once the requirement was confirmed. **Do not remove the IMS `/pos` route or `POSPage.tsx`.**

   Permanent consequences that follow, and must be handled rather than treated as transition artefacts:
   - **Two classes of order exist forever.** Orders from the IMS POS carry `terminal_id`, `cashier_id` and `shift_id` as null; orders from this till carry all three. Every report, export and reconciliation must tolerate both. Never write a query that assumes `terminal_id` is non-null.
   - **Shift cash reconciliation only covers this till.** Sales rung through the IMS POS never belong to a `pos_shifts` row, so they are invisible to the Z report. If the shop takes cash on the IMS page, that cash will not appear in expected-cash and will read as an overage. Either restrict the IMS POS to non-cash use, or accept and document the gap — do not let it be discovered during a cash count.
   - **Bug fixes must be applied to both frontends, permanently.** The two POS UIs share an ancestor but not a codebase. The three UI defects fixed in this repo (sync flash loop, cart clipping, header collision) had to be fixed separately in the IMS page. Treat any future POS UI fix as a two-repo task by default.

## Acceptance Criteria
- [ ] Backend and Auth Proxy both restart automatically after `kill -9` and after reboot
- [ ] TLS terminating, or `HOST=127.0.0.1` verified for same-host
- [ ] Structured JSON logs with `terminalId`, rotation configured
- [ ] No secrets in any committed file, image or unit file
- [ ] Cloud SQL backups confirmed; a restore actually tested
- [ ] Runbook covers every procedure in task 6, including the revocation-lag caveat
- [ ] Immediate revocation tested: disable + flush stops the token without waiting out the TTL
- [ ] Stranded-sales recovery tested under a replacement token
- [ ] Secret inventory recorded with rotation dates; compromised-password rotation confirmed
- [ ] A full test sale completes on the deployed till
- [ ] IMS `/pos` route still present and working — it is a permanent requirement, not a transition fallback
- [ ] Back-office reports verified against a mix of both order classes: rows with terminal/cashier/shift populated and rows with all three null
- [ ] The IMS-POS cash-reconciliation gap is either mitigated or explicitly documented and accepted
