# Phase 5 Verification Results

Date: 2026-07-29

Phase 5 was run against a shared non-production Cloud SQL dataset through the local Cloud SQL Auth Proxy on `127.0.0.1:15432`.

## Process Topology

- POS backend A: `127.0.0.1:3021`
- POS backend B: `127.0.0.1:3023`
- IMS backend: `127.0.0.1:3022`
- Both POS backends used the same database and independent Node processes.
- IMS was stopped during the kill test, then restarted for recovery verification.

## Correctness Results

| Check | Result | Evidence |
|---|---|---|
| Oversell race | PASS | 20 iterations, 20 passes, zero oversells, stock never negative, one `RESERVE` row per winning race. |
| Cross-instance idempotency | PASS | Same `confirm` key sent to POS A then POS B produced one reserve event and one durable dedupe row. Same `pay` key replayed across processes returned the same invoice and one durable dedupe row. |
| Invoice concurrency | PASS | 50 concurrent pays across both POS processes produced `INV/2026-27/000115` through `INV/2026-27/000164`, unique and gapless. |
| Failed pay invoice gap | PASS | Invalid card tender failed while max suffix remained `113`; next valid payment received `INV/2026-27/000114`. |
| Shift reconciliation | PASS | Cash, UPI, card, split cash+UPI and cash refund mix closed with `expectedCash=190.00`, `countedCash=180.00`, `variance=-10.00`; DB stored the same uncorrected variance. |
| Availability / IMS-down kill test | PASS | With IMS stopped, POS completed the prepared mid-flight sale and completed a second sale. After IMS restart, IMS read both orders as `Paid`; DB showed both as `Paid` with terminal attribution and non-negative stock. |
| Offline replay | PASS | Replayed offline sale produced exactly one order and one item set. Stock-collision replay surfaced insufficient stock clearly and left stock unavailable and non-negative. |
| Attribution | PASS | 99 POS orders from the final run had `terminal_id` populated. IMS-created order kept `terminal_id` null. |
| Cron non-duplication | PASS | Duplicate `alerts.dedup_key` group count was `0` with both backends up across cron intervals. |
| Skipped tests | PASS | None skipped. |

## Issues Found And Fixed

- POS returns could not process paid till sales, because `returnOrder` only allowed `Delivered`. Phase 5 shift reconciliation requires a counter cash refund, so POS now allows returns from `Paid` as well as `Delivered`.
- A terminated idle `pg` connection could crash the POS process because the pool had no `error` listener. The POS pool now handles idle-client errors and logs only a sanitized message.

## Verification Commands

- Phase 5 live harness: PASS.
- Phase 5 IMS-down kill test: PASS.
- POS `CI=true pnpm typecheck`: PASS.
- POS `CI=true pnpm lint`: PASS.
- POS `CI=true pnpm test`: PASS, 15 files / 50 tests.
- POS `CI=true pnpm build`: PASS.
- Web `CI=true pnpm exec tsc -b`: PASS.
- Web `CI=true pnpm lint`: PASS.
- Web `CI=true pnpm test`: PASS, 1 file / 7 tests.
- Web `CI=true pnpm build`: PASS.
- IMS `CI=true pnpm typecheck`: PASS.
- IMS `CI=true pnpm lint`: PASS.
- IMS `CI=true pnpm test`: PASS after sandbox-approved rerun for Vitest temp writes, 23 files / 86 tests.
- IMS `CI=true pnpm build`: PASS after sandbox-approved rerun for `dist` writes.
