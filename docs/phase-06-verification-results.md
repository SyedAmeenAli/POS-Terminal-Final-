# Phase 6 Verification Results

Date: 2026-07-29

## Implemented

- Added structured JSON application logging.
- Added launchd supervision templates for POS backend and Cloud SQL Auth Proxy.
- Added Caddy TLS reverse-proxy template.
- Added macOS `newsyslog` rotation config.
- Added `docs/runbook.md`.
- Added `docs/secret-inventory.md`.
- Added production `pnpm start` script.

## Live Checks

| Check | Result | Evidence |
|---|---|---|
| Phase 5 regression harness | PASS | 20 oversell races, cross-instance idempotency, failed-pay no-gap check, 50 concurrent pays, shift reconciliation, offline replay, attribution and cron duplicate checks passed. |
| Phase 5 IMS-down regression | PASS | POS completed prepared sale and second sale while IMS was stopped; IMS saw both after restart. |
| Localhost binding | PASS | Built backend started with `HOST=127.0.0.1`; `curl http://127.0.0.1:3041/health` returned `{"success":true,"data":{"status":"ok"}}`. |
| TLS or same-host | PASS | Same-host mode verified with `HOST=127.0.0.1`. `deploy/Caddyfile` added for network exposure. |
| Structured JSON logs | PASS | Live logs emitted JSON with `timestamp`, `method`, `path`, `status`, `durationMs`, `terminalId`; errors include `errorType` when present. |
| Log rotation config | PASS | `deploy/newsyslog.conf` added and launchd templates route output to log files. |
| Immediate revocation | PASS | Disabled test terminal plus `/internal/flush-auth-cache` changed old token from cached 200 to 401 immediately. |
| Stranded-sales recovery | PASS | Replacement terminal completed a queued-sale simulation under stable idempotency keys. |
| Full test sale | PASS | Built backend completed a paid cash sale with invoice `INV/2026-27/000173`; replacement-token recovery sale paid with invoice `INV/2026-27/000174`. |
| Cloud SQL backups | PASS | `gcloud sql instances describe` showed automated backups enabled, 7 retained backups, PITR enabled, 7 transaction-log retention days. `gcloud sql backups list` showed latest automated backup `1785276000000` successful on 2026-07-29. |
| Launchd plist syntax | PASS | `plutil -lint deploy/launchd/com.pos-terminal.backend.plist deploy/launchd/com.pos-terminal.cloud-sql-proxy.plist` passed. |
| Launchd install and `kill -9` restart | PASS | Installed LaunchAgents under `~/Library/LaunchAgents` using `~/Library/Logs/pos-terminal`; backend restarted from PID `29225` to `29415` and `/health` returned `HTTP:200`; Cloud SQL Auth Proxy restarted from PID `28252` to `29491`. |
| IMS `/pos` permanent route | PASS | Static verification found IMS keeps `web/src/App.tsx` route `/pos`, `web/src/pages/POSPage.tsx`, sidebar route config and permissions entry. `web/src/App.routing.test.tsx` contains a direct-navigation regression, but IMS `vitest.config.ts` only includes `src/**/*.test.ts`, so that web test is not part of the configured IMS suite. |
| IMS reports tolerate both order classes | PASS | Phase 5 live data included POS orders with `terminal_id` populated and an IMS order with `terminal_id`, `cashier_id` and `shift_id` null. IMS application/report scan found no report logic filtering on these attribution columns; existing IMS regression suite passed. |
| IMS-POS cash reconciliation gap documented | PASS | `docs/runbook.md` and `docs/architecture.md` state that `pos_shifts.expectedCash` covers standalone till cash only, not cash rung through IMS `/pos`. |
| No committed secrets in new operational files | PASS | New deploy templates contain placeholders only; `.env`, `.env.bak`, `web/dist` and `web/node_modules` are ignored. |

## Not Completed In This Session

| Check | Status | Reason |
|---|---|---|
| Backend and Auth Proxy restart after `kill -9` under supervisor | PASS | Backend and proxy were installed as LaunchAgents and both restarted with new PIDs after `kill -9`; final `/health` returned `HTTP:200`. |
| Restart after reboot | NOT TESTED | Rebooting the user's machine is outside a safe automated repo edit. Runbook contains the required reboot test. |
| Cloud SQL restore test | NOT TESTED | Backups and PITR were confirmed, but no temporary restore target was created/restored in this session. Runbook documents the required safe restore procedure. |
| IMS `/pos` route removal | NOT APPLICABLE | Current Phase 6 plan says IMS `/pos` is permanent and must not be retired. |

## Command Results

- POS `CI=true pnpm typecheck` — PASS.
- POS `CI=true pnpm lint` — PASS.
- POS `CI=true pnpm test` — PASS, 15 files / 50 tests.
- POS `CI=true pnpm build` — PASS.
- POS `CI=true pnpm db:migrate` — PASS for guard; exited 1 with schema ownership message.
- POS `CI=true pnpm db:generate` — PASS for guard; exited 1 with schema ownership message.
- Web `CI=true pnpm exec tsc -b` — PASS.
- Web `CI=true pnpm lint` — PASS.
- Web `CI=true pnpm test` — PASS, 1 file / 7 tests.
- Web `CI=true pnpm build` — PASS.
- IMS `CI=true pnpm typecheck` — PASS.
- IMS `CI=true pnpm lint` — PASS.
- IMS `CI=true pnpm test` — PASS after sandbox-approved rerun for Vitest temp-file writes, 23 files / 86 tests.
- IMS `CI=true pnpm build` — PASS after sandbox-approved rerun for `dist` writes.
