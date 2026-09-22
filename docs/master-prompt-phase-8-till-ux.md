# MASTER PROMPT — PHASE 8: TILL OPERATIONS UX

You are working in `/Users/shaikmoosakalam/Desktop/pos-terminal`.

## Read first
1. `AGENTS.md`
2. `docs/master-implementation-plan.md`
3. `docs/architecture.md`
4. `docs/implementation-status.md`

## Task
Improve POS till operations UX without changing protected business rules.

## Current POS design (do not violate)
- No login on open.
- Terminal token authenticates the device from `localStorage`.
- Cashier PIN is attribution only, not a security boundary.
- Sales must still work with no cashier selected.
- Sales must still work with no open shift.
- Owner password gates only Phase 7 high-risk actions (void paid order, return, discount over threshold).
- Shift data lives in `pos_shifts`; sales link through `sales_orders.shift_id`.
- Current receipt panel (`web/src/pages/POSPage.tsx` ~line 992) shows only invoice number, order id, and total — this phase replaces it with a real receipt.

## Required changes

### 1. Cashier sign-out button
- In the POS header or Cashier panel, add a clearly visible **"Sign out cashier"** button.
- Appears only when `activeCashier` is set.
- Clears `activeCashier`, the cashier picker selection, and the PIN input field.
- Must NOT close the shift.
- Must NOT clear the terminal token.
- Must NOT block sales — an unattributed sale must still be possible immediately after.
- Header reverts to "No cashier selected".
- Add/update web tests covering: button visibility toggles with `activeCashier`, click clears exactly cashier state (not shift, not token), a sale still succeeds right after sign-out.

### 2. Shift close UX
- Rename or clarify the existing close action — "End Shift" or "Close Shift", pick one and use it consistently in the UI copy.
- Preserve the counted-cash-first rule: `expectedCash` must never be shown or fetched before `countedCash` is submitted. This is a control, not a display order — verify the API call sequence enforces it, not just the JSX order.
- Close request sends `{ cashierId, countedCash, note }` when an active cashier exists; omit `cashierId` when none is selected (shift close must not itself require a cashier, consistent with rule that shifts don't block on cashier selection).
- After close, render the Z report: expected, counted, variance, tender totals by method, order count, business date (in `SHOP_TIMEZONE`, not UTC — check `getCurrentShift`/`closeShift` response shape before assuming a field name).
- Header reverts to "No open shift".
- Do NOT auto sign-out the cashier on shift close unless you add an explicit, tested reason to do so — these are independent identities (device / cashier / shift) and closing one must not silently mutate another. If you decide auto-sign-out is correct, justify it in the report and add a test proving it.

### 3. Real receipt
Replace the current minimal receipt panel with a proper till receipt. Include, from the order/shift/cashier data already available via existing API responses (extend the client types only if a field is genuinely missing server-side — do not add new backend fields without checking `docs/table-access.md` first):

- Business/store name if available in business settings.
- Invoice number (`receiptOrder.invoiceNumber`) and a short order reference.
- Date/time of the transaction.
- Cashier name, or literally "Unattributed" when `cashierId` is null — do not leave it blank.
- Terminal id/name if available.
- Line items: name, quantity, unit price, line total.
- Subtotal, discount, tax, total — reuse the existing computed fields on `receiptOrder`, do not recompute independently and risk drifting from what was actually charged.
- Tenders broken out by method (cash/UPI/card), matching `payment_tenders`.
- Change due, only when a cash tender exceeds the amount owed and the data supports computing it — do not fabricate a value if the API doesn't return one.
- A visible "RETURN" / "REFUND" marker when the order is a return, not just for the existing "DUPLICATE" reprint marker.

Layout: compact, monochrome-friendly (this is what gets printed on thermal receipt paper or plain `window.print()`), not the card-styled UI used elsewhere in the app. A separate print stylesheet or a dedicated receipt component is more appropriate than reusing panel styling.

**Never render:** terminal token, cashier PIN, PIN hash, full card number, CVV, card expiry, any `Authorization` header value, or the database connection string. Card tender shows only `method`, `cardLast4`, `cardApprovalCode` — exactly what's already stored per the Phase 2B card-tender design, nothing more.

Add/update tests asserting the receipt renders each required field and that none of the forbidden values can appear even if present somewhere in the order object (e.g. a snapshot/regex test on rendered output, not just "the component didn't crash").

### 4. Database ownership — do not touch
- Do NOT run `pnpm db:generate`.
- Do NOT run `pnpm db:migrate`.
- Do NOT add POS-side migrations.
- If any of the above changes seem to require a schema change, **stop and report the conflict** rather than working around it. This repo does not own the schema (see `architecture.md` §2, constraint 1).

## Verification
Run and report only what actually ran and passed — do not claim a check passed without executing it:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cd web && pnpm exec tsc -b
cd web && pnpm lint
cd web && pnpm test
cd web && pnpm build
```

## Report format
- Files changed.
- For each of the three features: what was implemented, what tests were added, and explicit confirmation the protected rules above were not violated (no-cashier sales still work, no-shift sales still work, counted-cash-first held, no forbidden data rendered).
- Any schema conflict encountered, reported rather than worked around.
- Verification commands actually run, with pass/fail for each.
