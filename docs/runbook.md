# POS Terminal Runbook

Date: 2026-07-29

This runbook is for the standalone POS terminal in `/Users/shaikmoosakalam/Desktop/pos-terminal`. The IMS back office remains the schema owner and the only home for cron and webhooks.

## Deploy Or Rebuild A Till

1. Install Node.js compatible with `package.json`, pnpm, the Cloud SQL Auth Proxy and Caddy if TLS is needed.
2. Clone or copy this repository to the till machine.
3. Configure `.env` from `.env.example`. Keep `HOST=127.0.0.1` for same-host deployments. Use `GCP_SECRET_MANAGER_ENABLED=true` and `DATABASE_URL_SECRET_NAME=POS_DATABASE_URL` when Secret Manager is available.
4. Install and build:
   ```bash
   pnpm install
   pnpm build
   cd web && pnpm install && pnpm build
   ```
5. Create the log directory. **launchd does not create it**, and a missing
   directory makes the job fail to spawn with no log explaining why — this is
   the single most common launchd install failure:
   ```bash
   mkdir -p ~/Library/Logs/pos-terminal
   ```
6. Copy and edit the launchd templates:
   ```bash
   cp deploy/launchd/com.pos-terminal.*.plist ~/Library/LaunchAgents/
   sed -i '' "s/REPLACE_WITH_SHOP_USER/$(whoami)/g" ~/Library/LaunchAgents/com.pos-terminal.*.plist
   sed -i '' "s|REPLACE_WITH_NODE_PATH|$(which node)|g" ~/Library/LaunchAgents/com.pos-terminal.backend.plist
   ```
   Then confirm the `cloud-sql-proxy` path in the proxy plist matches this host
   (`which cloud-sql-proxy`) — the Homebrew google-cloud-sdk location differs
   between Apple Silicon and Intel.

   **Why the plists invoke node directly rather than `pnpm start`:** launchd
   runs with a minimal PATH that excludes pnpm and nvm shims. `pnpm` cannot be
   spawned. The node path is absolute and therefore version-pinned — a node
   upgrade, especially via nvm, silently breaks the job. Re-run the `sed` above
   after any node upgrade.

   **Why there is no `WorkingDirectory` key:** macOS TCC blocks LaunchAgents
   from taking a cwd under `~/Desktop`, `~/Documents` or `~/Downloads`. The
   `cd` inside the command runs after the process starts and is unaffected.
   Installing the repo outside those directories avoids the restriction
   entirely and is preferable for a real till.
7. Install log rotation. Substitute the user first — the paths must match the
   plists exactly or nothing rotates and the logs grow unbounded:
   ```bash
   sed "s/REPLACE_WITH_SHOP_USER/$(whoami)/g" deploy/newsyslog.conf | sudo tee /etc/newsyslog.d/pos-terminal.conf >/dev/null
   sudo newsyslog -nv /etc/newsyslog.d/pos-terminal.conf   # dry run: confirms paths parse
   ```
8. Start services:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pos-terminal.cloud-sql-proxy.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pos-terminal.backend.plist
   ```
9. Verify:
   ```bash
   curl -sS http://127.0.0.1:3001/health
   ```
10. Complete one test sale on the till UI and verify the invoice number appears.

## TLS

If the till frontend and backend run on the same host with `HOST=127.0.0.1`, TLS can be skipped because the backend is not exposed on shop wifi.

If any browser reaches the backend over the network, put Caddy in front using `deploy/Caddyfile`, use a real hostname, and set `CORS_ALLOWED_ORIGINS` to the production frontend origin. Never use wildcard CORS.

## Process Supervision

Use launchd on macOS with the templates in `deploy/launchd/`.

After installing the plists:

```bash
launchctl print gui/$(id -u)/com.pos-terminal.cloud-sql-proxy
launchctl print gui/$(id -u)/com.pos-terminal.backend
```

Kill-test both services:

```bash
pkill -9 -f "cloud-sql-proxy.*ims-project-503105:asia-south2:ims-postgres"
pkill -9 -f "node dist/src/index.js"
sleep 10
curl -sS http://127.0.0.1:3001/health
```

`KeepAlive` and `RunAtLoad` must bring both services back.

## Boot Behaviour: LaunchAgents + Auto-Login

**Decision (2026-07-29): LaunchAgents plus macOS auto-login. Not LaunchDaemons.**

LaunchAgents start at **user login**, not at boot. Without auto-login, an unattended reboot lands on the login screen and the till stays dead until a human signs in.

LaunchDaemons would start at boot, but were rejected because in this specific deployment they introduce four problems:

1. **Application Default Credentials break.** `cloud-sql-proxy` authenticates via ADC at `~/.config/gcloud/application_default_credentials.json`. A root daemon's `$HOME` is `/var/root`, so it cannot find them. Working around it needs an explicit `--credentials-file`, and the usual fallback — a service-account key — is unavailable because the `iam.disableServiceAccountKeyCreation` org policy blocks key creation on this project.
2. **TCC still applies.** The repo under `~/Desktop` remains restricted; daemons do not escape it.
3. **Runs as root** unless a `UserName` key is added. A till backend should not run as root.
4. **Node is installed per-user** via nvm.

Auto-login avoids all four and is the normal pattern for a retail till.

**Enable it:** System Settings → Users & Groups → *Automatically log in as* → select the till user. GUI only; not reliably scriptable.

**Security trade, accepted deliberately:** anyone who reboots the machine gets an unlocked desktop. Acceptable for a machine behind a counter — `.env`, the terminal token and ADC are protected by file permissions, and physical access to an unencrypted disk defeats those regardless. Mitigate with a short screen-lock timeout so an idle till still locks.

**Precondition:** this works because FileVault is **off** on the till machine (verified `fdesetup status`, 2026-07-29).

> **If FileVault is ever enabled, this decision is void.** Auto-login becomes impossible, and LaunchDaemons do not help either — the disk stays encrypted until someone unlocks it at the login screen, so no launchd configuration can start the till unattended. The real options at that point are: accept that a human unlocks the till each morning, or move the backend off this Mac to an always-on host. Re-open this decision before enabling FileVault, not after.

## Reboot Test

Run after enabling auto-login. Required before the till is left unattended.

```bash
sudo reboot
```

Do not touch the machine while it comes back — the point is proving it recovers with no human step. Wait about 60 seconds after the desktop appears, then:

```bash
launchctl list | grep pos-terminal
curl -s -w "\nHTTP:%{http_code}\n" http://127.0.0.1:3001/health
```

**Pass:** both jobs present with fresh PIDs, `/health` returns 200, nothing done by hand.

If the backend is absent while the proxy is up, it most likely lost the startup race — the backend can start before the proxy has bound port 15432. `KeepAlive` should recover it within roughly 5 seconds; re-run the check to confirm. If it does not recover:

```bash
tail -30 ~/Library/Logs/pos-terminal/backend.log
```

Record the reboot-test date and result in `docs/implementation-status.md`. Re-test after any change to the plists, the node version, or the repo location.

## Health Checking

`GET /health` proves only the HTTP server is alive. It deliberately does not require the database, because restarting the app during a database blip does not fix Cloud SQL. If the till reports database-down errors, inspect the Auth Proxy first, then Cloud SQL status.

## Rate Limiting Is Per-Instance

`GLOBAL_RATE_LIMIT_MAX_REQUESTS` is enforced by an in-memory `Map` in
`src/api/middleware/global-rate-limit.ts`. Each Cloud Run instance keeps its
own counters, so the real ceiling is:

    effective limit = GLOBAL_RATE_LIMIT_MAX_REQUESTS x running instances

`pos-terminal` is capped at `maxScale=2` to bound that multiplier at 2x. Raising
maxScale raises the effective rate limit by the same factor — if you raise it,
divide `GLOBAL_RATE_LIMIT_MAX_REQUESTS` to compensate, or the limit silently
loosens.

Making the limit genuinely global needs shared counters (Memorystore, ~$25/mo).
That was not taken: the project has an explicit cost constraint, and the traffic
this service sees is a known, small number of tills rather than open internet
traffic. `src/tests/global-rate-limit.test.ts` asserts the per-instance
threshold so a regression in the limiter itself is still caught.

## Structured Logs

Backend logs are JSON lines containing `timestamp`, `method`, `path`, `status`, `durationMs`, `terminalId` and `errorType` when applicable. Launchd writes them to `~/Library/Logs/pos-terminal/backend.log`; `deploy/newsyslog.conf` rotates them.

Never log terminal tokens, cashier PINs, PIN hashes, full database URLs or full card data.

## Provision A Terminal

From the IMS repo:

```bash
cd "/Users/shaikmoosakalam/Desktop/ims - 1 "
pnpm provision:terminal "Counter 1"
```

Copy the printed token immediately into the till setup screen. The plaintext token is shown once and is not stored in the database.

## Revoke A Lost Or Stolen Terminal

Disabling alone is not immediate revocation because POS caches verified tokens for `TERMINAL_AUTH_CACHE_TTL_SECONDS`.

1. In the IMS-owned database, set the terminal row to disabled using IMS operational access:
   ```sql
   update pos_terminals set status = 'disabled' where id = '<terminal-id>';
   ```
2. Immediately flush the POS auth cache from the POS host:
   ```bash
   curl -sS -X POST http://127.0.0.1:3001/internal/flush-auth-cache
   ```
3. Verify the old token now receives `401 Terminal not authorised`.
4. Provision a replacement terminal and enter the new token on the till.

## Recover Sales Stranded On A Revoked Terminal

Queued cash sales are real revenue. Do not delete them.

1. Provision a replacement terminal.
2. Enter the replacement token on the till.
3. Retry queued entries marked `terminal_revoked`; their idempotency keys make retry safe.
4. If retry cannot run, export the queue JSON from the till and reconcile by hand against stock and cash.

## Manage Cashiers

From the IMS repo, use the cashier management script:

```bash
cd "/Users/shaikmoosakalam/Desktop/ims - 1 "
pnpm manage:cashier create "Cashier Name" 1234
pnpm manage:cashier disable <cashier-id>
pnpm manage:cashier reset-pin <cashier-id> 9876
```

Disabling a cashier stops new attribution. It must never rewrite old sales or audit history; `cashierName` is denormalised into audit metadata so old records stay readable.

## Rotate Database Credentials

1. Rotate Cloud SQL user credentials in Cloud SQL.
2. Update GCP Secret Manager secret `POS_DATABASE_URL` for POS and `DATABASE_URL` for IMS.
3. Update gitignored local `.env` files only if local fallback is used.
4. Restart the POS backend and IMS backend.
5. Verify old credentials no longer work.
6. Complete one POS test sale and one IMS sale.
7. Update `docs/secret-inventory.md` with the rotation date, never the value.

The compromised development password was rotated in Phase 3 on 2026-07-29 and the old password was verified rejected.

## Port A Bug Fix From IMS

Files that exist in both repos and commonly need manual porting:

- `src/application/services/order.service.ts`
- `src/application/services/inventory.service.ts`
- `src/application/services/catalog-service.ts`
- `src/application/services/business-settings.service.ts`
- `src/application/services/integration-settings.service.ts`
- `src/application/services/audit-log.service.ts`
- `src/infrastructure/database/schema.ts`
- `src/infrastructure/database/db.ts`
- `src/infrastructure/adapters/email.*`
- `src/infrastructure/adapters/razorpay.*`
- `src/infrastructure/adapters/gcp-secrets.adapter.ts`
- `src/infrastructure/adapters/local-env-secrets.adapter.ts`
- `src/infrastructure/adapters/secrets-factory.ts`
- `src/infrastructure/adapters/password.adapter.ts`

Rule: `schema.ts` changes always originate in the IMS repo, are migrated there, and are copied here as a read-only mirror. Never generate or run POS migrations.

## Update Procedure

```bash
git pull
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cd web
pnpm install
pnpm exec tsc -b
pnpm lint
pnpm test
pnpm build
cd ..
launchctl kickstart -k gui/$(id -u)/com.pos-terminal.backend
curl -sS http://127.0.0.1:3001/health
```

Then complete one test sale.

## Database Unreachable

Expected cashier behavior:

- Offline or backend unreachable: cash sales queue locally.
- Backend up but database down: 5xx responses are treated as queueable by the till UI.
- Stock may be stale while offline.

Escalation order:

1. Check Cloud SQL Auth Proxy service.
2. Check Cloud SQL status and backups.
3. Do not re-ring queued cash sales unless reconciliation confirms the original did not sync.

## Backups And Restore

Cloud SQL automated backups and PITR must remain enabled. **"Backups enabled" and "backups restorable" are different claims** — only a real restore proves the second. Two independent writers on one database makes a bad write more likely, not less, so this is worth actually exercising rather than assuming.

**Never restore over production.** Always restore to a new instance.

### Step 1 — capture a fresh production baseline

Comparison is meaningless without one. From the POS host, with the Auth Proxy running:

```bash
cd /Users/REPLACE_WITH_SHOP_USER/Desktop/pos-terminal
VERIFY_DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm verify:restore
```

Record the output. Baseline captured 2026-07-29T14:07Z:

| Metric | Value |
|---|---|
| `sales_orders` | 427 |
| `sales_order_items` | 427 |
| `payment_tenders` | 243 |
| `invoiced_orders` | 234 |
| `max_invoice_number` | `INV/2026-27/000234` |
| latest order | 2026-07-28T21:04Z |

### Step 2 — restore to a new instance

1. Console → SQL → `ims-postgres` → **Backups**. Confirm a recent successful backup; note its timestamp.
2. On that backup row → **⋮** → **Restore** → **restore to a new instance**. Never "restore to this instance".
3. Name it `ims-postgres-restore-test`, smallest tier, same region (`asia-south2`). Takes 10–20 minutes.

### Step 3 — verify the data came back

Run a second Auth Proxy against the clone on a spare port, leaving the production proxy on 15432 untouched:

```bash
cloud-sql-proxy --address 127.0.0.1 --port 15433 \
  ims-project-503105:asia-south2:ims-postgres-restore-test
```

Then in another terminal:

```bash
cd /Users/REPLACE_WITH_SHOP_USER/Desktop/pos-terminal
VERIFY_DATABASE_URL='postgresql://postgres:<clone-password>@127.0.0.1:15433/final_ims_build' pnpm verify:restore
```

No `psql` required — the script uses the repo's existing `pg` dependency.

**Reading the result.** Counts should be at or below the baseline, matching the backup timestamp rather than the present moment — a backup taken before the latest sales legitimately has fewer rows. What must hold regardless:

- `invoice_sequence_gaps` is **0**. Gapless invoice numbering is a legal requirement; a restore that produces gaps is a failed restore, however healthy the row counts look.
- `max_invoice_number` is consistent with `invoiced_orders`.
- `sales_order_items` is not wildly out of proportion to `sales_orders`.
- `latest_order` is at or before the backup timestamp.

### Step 4 — delete the clone

Console → SQL → `ims-postgres-restore-test` → **Delete**. It bills hourly for as long as it exists. Stop the second proxy too.

### Step 5 — record it

Add the restore date, clone name, and both sets of counts to `docs/implementation-status.md`. An untested restore claim is worth nothing; an undated one nearly as little. Re-test after any schema change large enough to alter the table set.

## Both POS Clients Are Permanent

**Do not retire the IMS `/pos` page.** The client requires both it and the standalone till. An earlier draft of the plan contained a retirement procedure; it was withdrawn once the requirement was confirmed. See `architecture.md` §3a.

Operating consequences to keep in mind:

1. **Two order classes exist permanently.** Orders from the IMS POS have `terminal_id`, `cashier_id` and `shift_id` null; orders from the till have them populated. Any report, export or reconciliation must handle both. Never assume `terminal_id` is non-null.
2. **Cash rung on the IMS POS is outside shift reconciliation.** It belongs to no `pos_shifts` row, so it never reaches `expectedCash` and will appear as an unexplained overage at close. Either keep the IMS page to non-cash sales, or record the expected discrepancy so a cash count is not debugged from scratch.
3. **POS UI fixes are a two-repo task.** The two frontends share an ancestor, not a codebase. Fixing one does not fix the other.
