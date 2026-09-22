# MASTER PROMPT — POS PHASE 7: OWNER OVERRIDE FOR HIGH-RISK TILL ACTIONS

**Target session:** Backend + Frontend Dev
**Repo:** `pos-terminal`
**Depends on:** IMS Phase 22 (owner gate) merged — this phase consumes the credential it establishes
**Related:** `docs/architecture.md` §3 (identity model), IMS `docs/master-prompts/saas-phase-22-owner-gate-and-cashier-admin.md`

## PHASE OVERVIEW
Today any cashier standing at the till can **cancel a paid order, process a return, or apply an unlimited discount** with nothing but a 4-digit PIN — which `architecture.md` §3 explicitly states is attribution, not a security boundary. These are the classic retail fraud paths, and commercial POS systems universally require a manager credential for them.

This phase adds a third identity tier: the **owner override**, sharing one credential with the IMS back office.

## THE IDENTITY MODEL AFTER THIS PHASE
Extends `architecture.md` §3 from two tiers to three:

| Tier | Purpose | Security boundary? | Scope |
|---|---|---|---|
| **Terminal token** | Authenticates the device | Yes | Every request |
| **Cashier PIN** | Attribution — who is at the till | No | Stamped on orders and audit rows |
| **Owner password** | Authorises high-risk actions | Yes | Void, return, large discount |

The owner password is the **same credential as the IMS back office**, because both backends read `business_settings.owner_password_hash` from the shared database. Change it once in IMS; the till picks it up on the next verification. No sync job, no SSO, no token exchange.

## CRITICAL: SHARED CREDENTIAL, SEPARATE SESSIONS
The password is shared. **Sessions must not be.**

- Give this repo its own `POS_OWNER_SESSION_SECRET`, distinct from IMS's `OWNER_SESSION_SECRET`.
- **Never** share the signing secret between IMS and POS. If both signed with the same key, an IMS back-office session cookie could be replayed against the till — a browser session on an office laptop would silently authorise voids at the counter. Separate secrets make each session valid only where it was issued.
- Do not attempt to verify IMS-issued tokens here. The till authenticates independently.

## STRICT RULES
- The POS database role is **read-only** on `business_settings` (Phase 3 grants). The till reads the hash; it must never set or change the owner password. Password management stays in IMS.
- Reuse `verifyPassword` from `password.adapter.ts`. No second hashing scheme.
- Never log or return the owner password, its hash, or a session token.
- Overrides must work while the terminal is authenticated as normal — this is an additional gate, never a replacement for the terminal token.
- No schema changes. This phase adds no tables and no columns.

## BACKEND DIRECTIVES

1. **Session service** — mirror IMS's `owner-session.service.ts`: HMAC-signed opaque token, expiry embedded, `timingSafeEqual` comparison. Two deliberate differences:
   - Cookie name `pos_owner_session`, so it cannot collide with IMS's on a shared hostname.
   - **Shorter TTL — 30 minutes, not 12 hours.** A till sits unattended on a shop floor; a 12-hour override session is an unlocked till for a whole trading day. The owner re-authenticates per override burst, which is the point.

2. **Read the shared hash** via a `getOwnerPasswordHash()` equivalent selecting `owner_password_hash` from `business_settings`. Port the IMS implementation rather than inventing a second one.

3. **Fail closed.** If `owner_password_hash` is unset, every override-gated route must **deny**, with a message telling the operator to set it in IMS. An unset password must never mean "allow" — that inverts the entire phase. Cover it with a named test.

4. **Routes:**
   - `POST /owner/verify` — `{ password }` → sets the `pos_owner_session` cookie. Rate-limit aggressively following the existing `webhook-rate-limit.ts` / `ai-rate-limit.ts` pattern; lock out after ~5 failures, keyed by terminal id.
   - `POST /owner/end` — clears the cookie. Must be callable at any time.
   - `GET /owner/status` — `{ authorised: boolean, expiresAt }` so the UI can show remaining time.

5. **`requireOwnerOverride` preHandler**, applied to:
   - `PATCH /orders/:id/cancel` — cancelling a **paid** order. Cancelling a `Draft` or `Pending` order needs no override; nothing has been taken yet. Gate on order status, not blindly on the route.
   - `PATCH /orders/:id/return` — always.
   - `POST /orders/:id/void-payment-qr` — always.
   - `POST /orders` and `PATCH /orders/:id/confirm` — **only** when a discount exceeds the threshold (directive 6).

6. **Discount threshold.** Read `OVERRIDE_DISCOUNT_PERCENT_THRESHOLD` from env, default `25`. Evaluate against the **effective** discount on the whole order — order-level plus line-level combined, as a percentage of pre-discount subtotal. Computing it per-line is exploitable: a cashier could apply 24% to every line and clear the gate while discounting the basket 24%.
   Compute this **server-side from the persisted order**, never from a client-supplied figure.

7. **Audit every override.** Each successful override writes an `audit_log` row: action, order id, terminal id, cashier id, and what was authorised. Also log **failed** override attempts with terminal id — repeated failures at one counter is exactly the signal worth having. Never log the attempted password.

## FRONTEND DIRECTIVES

8. **Override prompt** — a modal requesting the owner password, shown when a gated action is attempted without an active override session. On success, retry the original action automatically so the cashier does not lose their place.

9. **Visible override banner** whenever a session is active, showing remaining time and a one-tap "End override". An override session the owner forgets to close is the failure mode this prevents — they walk away, the till stays unlocked.

10. **Auto-end the override** on: successful completion of the gated action, tab hidden for more than a few minutes, or TTL expiry. Do not silently extend on activity.

11. **Offline behaviour — state it plainly in the UI.** Override verification needs the backend. While offline, gated actions are **unavailable**, not queued. Queueing a void that was never authorised would let anyone with the till offline-void paid orders and have them apply on reconnect. Show "requires connection" rather than failing obscurely.

12. Never store the owner password. Not in `localStorage`, not in component state beyond the in-flight request, never logged.

## DEFINITION OF DONE
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` clean in both repos
- [ ] Test: cancel a **paid** order without override → 401; with override → succeeds
- [ ] Test: cancel a `Draft`/`Pending` order without override → succeeds (no needless friction)
- [ ] Test: return without override → 401; with override → succeeds
- [ ] Test: order with 30% effective discount → override required; 10% → not required
- [ ] Test: 24% applied to every line still trips the threshold (aggregate, not per-line)
- [ ] Test: **`owner_password_hash` unset → gated actions deny, never allow**
- [ ] Test: wrong password → 401, lockout engages after the configured threshold
- [ ] Test: an IMS-issued session cookie does **not** authorise a POS override (separate secrets)
- [ ] Test: override session expires after its TTL
- [ ] Test: successful and failed overrides both write `audit_log` rows; the password appears in none
- [ ] Manual: same owner password works in IMS back office and at the till, and changing it in IMS takes effect at the till without a restart
- [ ] Manual: offline, a gated action shows "requires connection" and is not queued
- [ ] Local commit only, never push without explicit authorization

## FOLLOW-UP, NOT THIS PHASE
- Per-cashier permission tiers (a "supervisor" who can void but is not the owner) remain a deliberate non-goal, consistent with `architecture.md` §3.
- IMS's `OWNER_SESSION_SECRET` currently falls back to a random per-process value when unset, which silently invalidates every session on restart. That is an IMS operational issue worth fixing there — set it explicitly in both repos' environments.
