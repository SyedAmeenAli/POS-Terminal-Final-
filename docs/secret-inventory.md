# Secret Inventory

Date: 2026-07-29

Do not paste secret values into this file. Record only location, ownership and rotation evidence.

| Secret | Primary location | Local fallback | Readers | Rotation evidence |
|---|---|---|---|---|
| POS database URL | GCP Secret Manager secret `POS_DATABASE_URL` selected with `DATABASE_URL_SECRET_NAME=POS_DATABASE_URL` | POS `.env` as `DATABASE_URL`, gitignored | POS backend service account / local operator | Rotated in Phase 3 on 2026-07-29 after the original password was exposed during development. Old password rejection was verified in Phase 3. |
| IMS database URL | GCP Secret Manager secret `DATABASE_URL` | IMS `.env`, gitignored | IMS backend service account / local operator | Rotated in Phase 3 on 2026-07-29 after the original password was exposed during development. Old password rejection was verified in Phase 3. |
| Terminal tokens | Plaintext printed once by IMS `pnpm provision:terminal`; hash stored in `pos_terminals.token_hash` | None | Operator at provisioning time only | Rotate by disabling the terminal, flushing POS auth cache, provisioning a replacement terminal, and entering the new token on the till. |
| Cashier PINs | Hash stored in `cashiers.pin_hash` | None | IMS `manage-cashier.ts`; POS verifies hash only | Rotate with IMS `pnpm manage:cashier reset-pin`. PINs are attribution, not security. |
| POS owner session signing secret | GCP Secret Manager secret `POS_OWNER_SESSION_SECRET` or POS process environment | POS `.env` as `POS_OWNER_SESSION_SECRET`, gitignored | POS backend only | Introduced in Phase 7 on 2026-07-30. Must be distinct from IMS `OWNER_SESSION_SECRET`; rotate by updating the POS secret and restarting the POS backend, which invalidates active owner override sessions. |
| IMS owner session signing secret | IMS process environment / Secret Manager as `OWNER_SESSION_SECRET` | IMS `.env`, gitignored | IMS backend only | Must be distinct from POS `POS_OWNER_SESSION_SECRET`; rotate by updating IMS and restarting IMS, which invalidates active IMS owner sessions. |
| Razorpay keys | GCP Secret Manager: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | POS `.env`, gitignored | POS backend for QR creation; IMS backend for webhooks | Rotate in Razorpay dashboard, update Secret Manager, restart affected services. |
| Receipt email API key | GCP Secret Manager: `EMAIL_API_KEY` | POS `.env`, gitignored | POS backend receipt sender | Rotate in email provider dashboard, update Secret Manager, restart POS backend. |
| GCP project id | Environment value `GCP_PROJECT_ID` | POS/IMS `.env`, gitignored | Both backends | Not a secret, but controls where secrets are read. |

## Secret Handling Rules

- Never commit `.env`, unit files containing credentials, tokens, private keys, database URLs or customer data.
- Launchd plist templates in `deploy/launchd/` intentionally contain no credentials.
- Caddy config in `deploy/Caddyfile` intentionally contains no credentials.
- Logs must never include terminal tokens, cashier PINs, PIN hashes or full database URLs.
- Full card numbers, expiry, CVV and track data must never be accepted or stored anywhere.

## Rotation Checklist

1. Rotate at the upstream authority: Cloud SQL, Razorpay, email provider or IMS provisioning script.
2. Update GCP Secret Manager first.
3. Update local gitignored `.env` only where needed.
4. Restart the affected supervised service.
5. Verify `/health`.
6. For database credentials, perform one full test sale.
7. Record the date and evidence here without recording the value.
