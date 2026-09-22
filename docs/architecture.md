# Architecture and Permanent Project Rules

Authoritative for: business rules, architecture, database semantics, security constraints, integration boundaries.

These rules are **permanent**. They do not change phase to phase. If an implementation conflicts with anything here, report the conflict — do not silently choose a different design.

---

## 1. System topology

Two independent backend deployments share one Cloud SQL Postgres database.

| System | Repo | Role |
|---|---|---|
| IMS back office | `/Users/shaikmoosakalam/Desktop/ims - 1 ` (trailing space in folder name) | Catalogue authoring, purchasing, suppliers, analytics, fulfilment, **webhooks**, **cron**, **schema owner** |
| POS terminal | this repo | Till only. N instances, one per counter. No cron, no webhooks, no schema authority. |

**Database:** Cloud SQL Postgres `ims-postgres`, project `ims-project-503105`, database `final_ims_build`.

### Why a separate backend rather than a shared one

If the IMS backend dies, the till must keep selling. A frontend-only POS pointed at the single existing API goes down with it.

### Why not direct database access from the till frontend

`src/application/services/order.service.ts` guarantees correctness under concurrent tills through `db.transaction` + `lockOrderForUpdate` row locks + idempotency-key deduplication against `webhook_events`. Bypassing it means reimplementing all of that; getting it wrong means overselling stock. Postgres is the arbiter and is indifferent to how many backend processes call it — a second backend process running the same logic is safe and is the standard horizontal-scaling answer.

### Why clone-and-trim rather than a shared package

Single developer, single shop, stable and well-tested source backend. Package extraction overhead (versioning, lockstep upgrades, monorepo tooling) exceeds its benefit at this scale.

**Accepted cost:** bug fixes must be ported between the two repos by hand. Procedure lives in the Phase 6 runbook.

### Honest limit of this design

This buys resilience against **backend process** failure. It does **not** protect against database failure. A Cloud SQL outage stops both systems; the only mitigation is the till's offline queue, which supports cash tender only.

---

## 2. The five constraints

Violating any of these breaks production. They apply to every phase.

1. **The IMS repo is the sole schema owner.** This repo must NEVER run `drizzle-kit generate` or `db:migrate`. Two repos migrating one database fight over the drizzle journal and corrupt migration history. This repo consumes the schema read/write only.

2. **Cron must be OFF in this backend.** The IMS backend's `registerScheduler()` starts 10 jobs (`low-stock-monitor`, `stockout-alert-monitor`, `stagnant-stock-monitor`, `broken-assortment-monitor`, `shipment-delay-monitor`, `rto-hazard-monitor`, `ndr-routing-monitor`, `overdue-po-monitor`, `qr-expiry-monitor`, `stale-conversation-gc`). A second instance running them double-fires every alert and GC pass against the same rows.

3. **Webhooks stay with the IMS backend only.** Razorpay, Shiprocket and Meta each accept exactly one callback URL. This repo must not register webhook routes. UPI capture lands via the IMS webhook, writes to the shared database, and the till reads the resulting `Paid` state.

4. **Never bypass `order.service.ts`.** All stock and order mutation goes through its existing transactional functions. No raw SQL writes to `inventory_stock` or `sales_orders`.

5. **Terminal authentication is mandatory.** The IMS backend currently has none — `requireRole` is a no-op pass-through, `globalAuthenticationHook` injects the owner user, the server binds `0.0.0.0`, no CORS. Defensible for one owner on one laptop; not defensible for a till on shop wifi, where it would let anyone on the network void orders, adjust stock and read all sales data.

---

## 3. Identity model — three distinct concepts, never conflated

| Concept | Purpose | Security boundary? |
|---|---|---|
| **Terminal token** | Authenticates the machine. 256-bit random, hashed at rest, sent as `Authorization: Bearer`. | **Yes.** The real boundary. Required on every request. |
| **Cashier PIN** | Attribution — who is at the till right now. | **No.** A 4-digit PIN is shoulder-surfable. It answers "who gave that discount", never "who may call this API". |
| **Owner user** | The `users` row supplying `actorUserId` for audit FKs. | No. Legacy acting identity, retained for schema compatibility. |
| **Owner password** *(POS Phase 7)* | Authorises high-risk actions: voiding a paid order, returns, discounts over threshold. | **Yes.** Same credential as the IMS back office — both read `business_settings.owner_password_hash` from the shared database. Sessions are **not** shared: each side signs with its own secret, so an IMS cookie cannot authorise a till override. |

Consequences that must hold in implementation:

- A cashier PIN alone must never grant API access.
- The PIN selects an identity; it does not authorise an action. No per-cashier permission tiers.
- Never describe the PIN as "login" or "security" in UI, code comments, or docs.

---

## 3a. Two POS clients coexist permanently

The client requires **both** the IMS back-office POS page (`/pos` in the IMS frontend) and this standalone till. This is a permanent requirement, not a migration state. Do not propose or implement retiring either one.

Both write orders to the same `sales_orders` table, so the data model permanently contains two classes of order:

| | IMS POS page | This till |
|---|---|---|
| `terminal_id` | null | populated |
| `cashier_id` | null | populated when a cashier is selected |
| `shift_id` | null | populated when a shift is open |
| Offline capable | No | Yes |
| Counted in shift reconciliation | **No** | Yes |

Rules that follow:

- **Never write a query assuming `terminal_id`, `cashier_id` or `shift_id` is non-null.** Reports, exports and reconciliation must handle both classes. This is the single most likely place for a subtle reporting bug.
- **Shift cash reconciliation covers this till only.** Cash taken on the IMS POS page never belongs to a `pos_shifts` row, so it is absent from `expectedCash` and will present as an unexplained overage at close. Either restrict the IMS page to non-cash sales, or document the gap so a cash count is never debugged from scratch.
- **POS UI fixes are a two-repo task by default.** The two frontends share an ancestor, not a codebase. The three defects fixed here (sync flash loop, cart clipping, header collision) required separate fixes in the IMS page.

## 4. Protected invariants

Do not alter these unless the authorised phase explicitly requires it. If a phase seems to require it, report the conflict first.

- Stock and reservation semantics
- Transaction boundaries and idempotency rules
- Invoice-number allocation (sequential, gapless, per financial year)
- Cash reconciliation arithmetic
- Public API contracts consumed by either frontend
- Authentication rules
- Audit-trail completeness
- Secret-management practices
- The five constraints in section 2

---

## 5. Security rules

- Secrets come from GCP Secret Manager via the existing `SecretsPort` / `GcpSecretsAdapter`, or from a gitignored `.env` locally. Never committed, never in an image, never in a unit file, never in logs.
- Never log: terminal tokens, cashier PINs, PIN hashes, full connection strings.
- **Card data:** store last-4 and approval code only. Never a full PAN, expiry, CVV, or any magstripe/EMV data. Storing any of those pulls this system into PCI-DSS scope, which is explicitly not wanted. No field anywhere may accept a full card number.
- Bind address is env-driven, defaulting to `127.0.0.1`. LAN exposure is a deliberate opt-in.
- CORS uses an explicit origin allowlist. Never `*`.
- The PIN-verification endpoint must be rate-limited aggressively — 4 digits is 10,000 combinations.
- Responses for "wrong PIN" and "unknown cashier" must be identical in shape and timing, so cashier existence is not leaked.

---

## 6. Data rules

- Currency is `numeric(precision, scale)` through Drizzle and compared as strings. Never floating-point arithmetic for money.
- All new columns on existing tables are **nullable**, so the IMS back office keeps working unchanged.
- All migrations are **additive**. No drops, no destructive alters, against a live shared database.
- Shift and day boundaries use `SHOP_TIMEZONE` (default `Asia/Kolkata`), never UTC. A "today's sales" figure computed in UTC is wrong for every sale after 05:30 IST.
- Invoice numbering must be **gapless**. A Postgres `SEQUENCE` is the wrong tool: `nextval()` is not rolled back on abort and therefore leaves gaps. Use a counter row locked with `SELECT ... FOR UPDATE` inside the same transaction that assigns the number.

---

## 7. Decisions taken, and their accepted costs

| Decision | Rationale | Accepted cost |
|---|---|---|
| No catalogue writes at the till | Cashier-created SKUs corrupt inventory data; smaller attack surface | Unknown item at the counter needs back-office help |
| No stock adjustment at the till | Classic shrinkage fraud path; a 4-digit PIN is not adequate attribution for writing off inventory | Damaged goods written off by back office |
| Returns **kept** at the till | Refunds happen at the counter; a till without returns is unusable | None |
| No ship/deliver at the till | Fulfilment is back-office work | None |
| Cashier PIN, not full login | Closes the discount/void/refund accountability gap without reintroducing the deliberately removed login system | PIN is attribution, not security |
| Card recorded, not integrated | Works day one on the bank machine every shop already has; avoids vendor commitment and PCI scope | Two devices at the counter until integration is chosen |
| **Keep both POS clients permanently** | Client requirement: the IMS back-office POS and this standalone till are both needed. (An earlier draft proposed retiring the IMS page; withdrawn once the requirement was confirmed.) | Permanent: two order classes in the data, POS UI fixes are a two-repo task, and IMS-POS sales fall outside shift reconciliation |
| Clone-and-trim, not shared package | See section 1 | Manual fix porting |
| LaunchAgents + macOS auto-login, not LaunchDaemons | Daemons break ADC (root `$HOME` is `/var/root`, and service-account keys are blocked by org policy), still hit TCC, and would run as root. Auto-login avoids all of it and is the normal retail-till pattern. | A reboot yields an unlocked desktop; mitigated by a short screen-lock timeout. **Void if FileVault is ever enabled** — see runbook. |

---

## 8. Known limitations — deliberately out of scope for v1

State these as limitations; do not silently implement them.

- **Open-price / miscellaneous line item** — needed for items absent from the catalogue. Requires a non-variant order line.
- **Parked / held sales** — customer steps away, cashier serves the next.
- **Full card integration** — single-device flow via Pine Labs / Razorpay POS / Ezetap. Needs a vendor decision.
- **Cash rounding** — paise do not circulate in India.
- **Database-outage resilience** — offline queue covers cash sales only.
- **Per-cashier permissions** — deliberate non-goal, see section 3.
