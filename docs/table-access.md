# POS Terminal Table Access Contract

This backend is a till-only service sharing the IMS-owned Cloud SQL Postgres database. It does not own schema, migrations, cron jobs, webhook handling, catalogue authoring, purchasing, analytics, campaigns, AI search, or user management.

## Read/write tables

The POS backend may read and write these tables, through established service boundaries:

- `sales_orders`
- `sales_order_items`
- `payment_tenders`
- `stock_events`
- `inventory_stock`
- `audit_log`
- `webhook_events` for idempotency dedupe only
- `pos_terminals` once created — read for authentication, write to update `last_seen_at` (Phase 2)
- `pos_shifts` once created — insert on shift open, update on shift close (Phase 2B)
- `invoice_counters` once created — locked and incremented during invoice-number allocation (Phase 2B)

All stock and order mutation must go through `order.service.ts`. No raw SQL writes may mutate `inventory_stock` or `sales_orders`.

Terminal, cashier and shift **rows are created by the IMS repo's provisioning scripts**, not by this backend. This backend's writes are limited to the operational updates listed above.

## Read-only tables

The POS backend may read these tables:

- `products`
- `product_variants`
- `categories`
- `product_types`
- business settings
- `users` for owner resolution
- `cashiers` once created — the till reads the active list and verifies PINs; creation, disabling and PIN resets are back-office work done via the IMS repo's `manage-cashier.ts`

## Forbidden tables

The POS backend must not touch these tables:

- `suppliers`
- `purchase_orders`
- `purchase_order_items`
- `supplier_payments`
- `expenses`
- `campaigns`
- `ai_search_sessions`
- `ai_search_messages`
- `conversation_state`
- `product_embeddings`

## Non-goals

This backend does not provide:

- schema authority or migrations
- cron jobs
- webhook handling
- purchase orders
- supplier management
- analytics
- AI search
- campaigns
- user management
- bulk import
