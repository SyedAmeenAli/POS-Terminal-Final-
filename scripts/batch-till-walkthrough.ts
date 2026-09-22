// PROPOSAL 02 §5 — THE SAME WALK, RUNG AT THE TILL.
//
// The console's walk proves the console. It proves NOTHING about the counter,
// which is a second service with its own copy of the stock path — and the
// counter is where FEFO operates and where expired stock would reach a
// customer.
//
// This runs the stock half of the same walk through THIS service's
// adjustStockInTransaction, against the tenant the console's walk created. If
// the two services disagree about anything, that is the divergence proposal
// 02 §0 predicts, and it is better found here than by the reconciliation cron
// at 3 a.m.
//
// Everything runs as app_runtime with app.current_tenant_id set — exactly how
// a real till request runs, RLS in force. This service has no runAsJob by
// design: it never runs tenant-less, and adding a bypass purely for a test
// would weaken the property being tested.
//
// PROPOSAL 11 §1 — AND NOW OVER HTTP TOO.
//
// The stock assertions below always ran under RLS with the tenant GUC set, so
// this file was never as blind as the IMS walkthroughs were. What it never
// touched was the ROUTE layer: requireTerminal, the validation schemas, the
// HTTP status a cashier's screen actually receives, and the money path itself
// — POST /orders, confirm, pay. This service has 25 routes and, until this
// change, not one automated check in either repo reached any of them.
//
// That matters most for the expired-stock refusal. 06-pharmacy-compliance §0
// turns on that refusal being absolute AT THE COUNTER, and every existing
// assertion proves it in the service. A refusal the service raises and the
// route swallows would look identical from here.
//
// Run:
//   WALK_TENANT_ID=... WALK_VARIANT_ID=... ./node_modules/.bin/tsx scripts/batch-till-walkthrough.ts
import { sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

import { AppError } from "../src/api/errors.js";
import { buildServer } from "../src/api/server.js";
import { adjustStockInTransaction } from "../src/application/services/inventory.service.js";
import { hashPassword } from "../src/infrastructure/adapters/password.adapter.js";
import {
  beginRequestTransaction,
  commitRequestTransaction,
} from "../src/infrastructure/database/db.js";

const tenantId = process.env.WALK_TENANT_ID ?? "";
const variantId = process.env.WALK_VARIANT_ID ?? "";

if (!tenantId || !variantId) {
  console.error("Set WALK_TENANT_ID and WALK_VARIANT_ID (from the console's walk).");
  process.exit(2);
}

const pass: string[] = [];
const fail: string[] = [];
const check = (name: string, ok: boolean, detail = "") =>
  (ok ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ""}`);

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof beginRequestTransaction>>["txDb"]["transaction"]>[0]>[0];

/** One tenant-scoped transaction, the way a till request runs. */
const asTill = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
  const handle = await beginRequestTransaction(tenantId);
  try {
    const result = await fn(handle.txDb as unknown as Tx);
    await commitRequestTransaction(handle);
    return result;
  } catch (error) {
    await handle.client.query("ROLLBACK").catch(() => undefined);
    handle.client.release();
    throw error;
  }
};

const adjust = (input: Parameters<typeof adjustStockInTransaction>[2]) =>
  asTill((tx) => adjustStockInTransaction(tx, tenantId, input));

const refused = async (name: string, code: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
    check(name, false, "it was ACCEPTED");
  } catch (error) {
    const actual = error instanceof AppError ? error.errorType : String(error).slice(0, 70);
    check(name, actual === code, `got ${actual}, wanted ${code}`);
  }
};

const stamp = Date.now();

// buildServer with requestTransactions: true — what src/index.ts runs. The
// flag opens the per-request transaction and sets app.current_tenant_id, so
// RLS applies to these calls exactly as it does to a real till request.
const app = buildServer({ requestTransactions: true });
await app.ready();

type Json = { data?: unknown; errorType?: string; message?: string };
const json = (r: { body: string }): Json => {
  try { return JSON.parse(r.body) as Json; } catch { return {}; }
};

/** Refused over HTTP with a specific errorType. Never a thrown service error. */
const refusedOverHttp = async (
  name: string,
  wanted: string,
  call: () => Promise<{ body: string; statusCode: number }>,
) => {
  const response = await call();
  if (response.statusCode < 400) {
    check(name, false, `it was ACCEPTED with ${response.statusCode}`);
    return;
  }
  const actual = json(response).errorType ?? `HTTP ${response.statusCode}`;
  check(name, actual === wanted, `got ${actual}, wanted ${wanted}`);
};

await asTill(async (tx) => {
  await tx.execute(sql`update product_variants set tracking_mode = 'batch' where id = ${variantId}`);
  check("setup: the fixture variant is batch-tracked", true);
});

// A FIXTURE TERMINAL, provisioned the way IMS provisions one.
//
// The token is minted by IMS's createTerminal in production — this service
// owns no migrations and has no provisioning route — but pos_terminals is
// tenant-scoped and shared, so the walk can write its own fixture row inside
// a tenant transaction. tokenHash is argon2; tokenPrefix is the first 12
// characters, which is what the indexed lookup narrows on.
const TERMINAL_TOKEN = `walk_${randomBytes(24).toString("hex")}`;
const TERMINAL_ID = randomUUID();

await asTill(async (tx) => {
  await tx.execute(sql`
    insert into pos_terminals (id, tenant_id, name, token_hash, token_prefix, status)
    values (${TERMINAL_ID}, ${tenantId}, ${`Walk till ${stamp}`},
            ${await hashPassword(TERMINAL_TOKEN)}, ${TERMINAL_TOKEN.slice(0, 12)}, 'active')`);
  check("setup: a fixture terminal is provisioned", true);
});

const asTerminal = (method: "GET" | "PATCH" | "POST", url: string, payload?: unknown) =>
  app.inject({
    headers: { authorization: `Bearer ${TERMINAL_TOKEN}` },
    method,
    payload: payload as never,
    url,
  });

// R1 — THE ROUTE LAYER. None of this is reachable from a service call.
const noToken = await app.inject({ method: "GET", url: "/products" });
check("R1. TILL ROUTE: no terminal token is refused", noToken.statusCode === 401, `got ${noToken.statusCode}`);

const badToken = await app.inject({ headers: { authorization: "Bearer walk_not_a_real_token" }, method: "GET", url: "/products" });
check("    an unknown terminal token is refused", badToken.statusCode === 401, `got ${badToken.statusCode}`);

const withToken = await asTerminal("GET", "/products");
check("    a provisioned token reaches the catalogue", withToken.statusCode === 200, `got ${withToken.statusCode}`);

// 5 — inbound with no batch
await refused("5. TILL: adding stock without a batch", "LOT_REQUIRED", () =>
  adjust({ eventType: "PURCHASE_RECEIPT", idempotencyKey: `till-${stamp}-nolot`, qtyDeltaMilli: 5000n, reason: "till walk", variantId }),
);

// 6, 7 — two batches, the second expiring EARLIER
await adjust({ eventType: "PURCHASE_RECEIPT", idempotencyKey: `till-${stamp}-late`, lot: { batchNumber: `TILL-LATE-${stamp}`, expiryDate: "2030-01-01" }, qtyDeltaMilli: 5000n, reason: "till walk", variantId });
await adjust({ eventType: "PURCHASE_RECEIPT", idempotencyKey: `till-${stamp}-soon`, lot: { batchNumber: `TILL-SOON-${stamp}`, expiryDate: "2027-01-01" }, qtyDeltaMilli: 3000n, reason: "till walk", variantId });

await asTill(async (tx) => {
  const r = (await tx.execute<{ stock: string; lots: string }>(sql`
    select ist.on_hand_qty_milli::text stock, coalesce(sum(il.on_hand_qty_milli),0)::text lots
    from inventory_stock ist left join inventory_lots il on il.variant_id = ist.variant_id
    where ist.variant_id = ${variantId} group by ist.on_hand_qty_milli`)).rows[0]!;
  check("6. TILL: rollup equals the sum of the lots", r.stock === r.lots, `${r.stock} vs ${r.lots}`);
});

// 8 — RESERVE then SALE, and FEFO must take the earlier batch
const REF = `${tenantId}:tillline${stamp}`;
await adjust({ eventType: "RESERVE", idempotencyKey: `till-${stamp}-res`, qtyDeltaMilli: 1500n, reason: "till walk", reservationRef: REF, variantId });
await adjust({ eventType: "SALE", idempotencyKey: `till-${stamp}-sale`, qtyDeltaMilli: 1500n, reason: "till walk", reservationRef: REF, variantId });

await asTill(async (tx) => {
  const sold = (await tx.execute<{ b: string }>(sql`
    select il.batch_number b from stock_events se join inventory_lots il on il.id = se.lot_id
    where se.variant_id = ${variantId} and se.event_type = 'SALE' order by se.id desc limit 1`)).rows[0];
  // THE test of this whole proposal. Before it, a sale rung here decremented
  // inventory_stock, wrote a stock_events row with a NULL lot_id, and never
  // touched the lots.
  check("8. TILL: the sale carries a lot_id and FEFO took the EARLIEST", sold?.b === `TILL-SOON-${stamp}`, sold?.b ?? "NO LOT RECORDED");

  const held = (await tx.execute<{ n: string }>(sql`
    select count(*)::text n from lot_reservations where reservation_ref = ${REF}`)).rows[0]!.n;
  check("   TILL: the reservation was consumed by the sale", held === "0", `${held} left`);
});

// R2 — THE MONEY PATH, over HTTP. Create, confirm, pay.
//
// Everything above drives adjustStockInTransaction directly. This drives the
// three routes a cashier actually presses, so it also exercises the validation
// schemas, the order service's own reserve-then-sell sequencing, and the lot
// selection underneath it.
const created = await asTerminal("POST", "/orders", {
  idempotencyKey: `till-http-${stamp}`,
  items: [{ quantity: 1, variantId }],
  paymentPreference: "cash",
});
check("R2. TILL ROUTE: POST /orders creates a sale", created.statusCode === 201 || created.statusCode === 200,
  `got ${created.statusCode} ${created.body.slice(0, 120)}`);
const httpOrderId = (json(created).data as { id?: string } | undefined)?.id ?? "";

const confirmed = await asTerminal("PATCH", `/orders/${httpOrderId}/confirm`, {
  idempotencyKey: `till-http-${stamp}-confirm`,
  shippingAddressLine1: "Counter sale",
  shippingCity: "Shop",
  shippingPostalCode: "000000",
  shippingState: "Local",
});
check("    PATCH /orders/:id/confirm reserves the stock", confirmed.statusCode === 200,
  `got ${confirmed.statusCode} ${confirmed.body.slice(0, 120)}`);

// The tender must equal the order's own total. Hardcoding a price here made
// this fail with TENDER_AMOUNT_MISMATCH — which is the route doing its job,
// and is itself worth knowing: the till verifies the money, it does not
// accept whatever the client says was paid.
const fetched = await asTerminal("GET", `/orders/${httpOrderId}`);
const orderTotal = Number((json(fetched).data as { total?: number } | undefined)?.total ?? 0);
check("    GET /orders/:id returns the sale with a total", orderTotal > 0, `total ${orderTotal}`);

const paid = await asTerminal("PATCH", `/orders/${httpOrderId}/pay`, {
  idempotencyKey: `till-http-${stamp}-pay`,
  tenders: [{ amount: orderTotal.toFixed(2), method: "cash" }],
});
check("    PATCH /orders/:id/pay completes it", paid.statusCode === 200,
  `got ${paid.statusCode} ${paid.body.slice(0, 120)}`);

await asTill(async (tx) => {
  // The claim this whole proposal exists for: a sale rung THROUGH THE ROUTE
  // names the lot it came out of. Proposal 02's original defect was a till
  // sale that decremented inventory_stock and wrote a NULL lot_id.
  const lot = (await tx.execute<{ b: string }>(sql`
    select il.batch_number b from stock_events se join inventory_lots il on il.id = se.lot_id
    where se.variant_id = ${variantId} and se.event_type = 'SALE' order by se.id desc limit 1`)).rows[0];
  check("    the HTTP sale carries a lot_id", !!lot?.b, lot?.b ?? "NO LOT RECORDED");
});

// 9 — expired stock at the counter
await asTill(async (tx) => {
  await tx.execute(sql`update inventory_lots set expiry_date = '2020-01-01' where variant_id = ${variantId} and batch_number = ${`TILL-SOON-${stamp}`}`);
  await tx.execute(sql`update inventory_lots set on_hand_qty_milli = 0 where variant_id = ${variantId} and batch_number <> ${`TILL-SOON-${stamp}`}`);
  // The expired lot is topped up to a KNOWN quantity, deliberately.
  //
  // Without this the earlier HTTP sale leaves it holding less than one unit,
  // so the next order is refused by the availability check on inventory_stock
  // — which runs BEFORE the lot fork — and answers INSUFFICIENT_STOCK. That
  // is a correct refusal for the wrong reason, and it would have made this
  // step pass or fail on arithmetic rather than on expiry. Ample stock, all
  // of it expired, is the only state that tests the thing being claimed.
  await tx.execute(sql`update inventory_lots set on_hand_qty_milli = 10000 where variant_id = ${variantId} and batch_number = ${`TILL-SOON-${stamp}`}`);
  // Reservations are cleared on BOTH sides, not just on inventory_stock.
  // Leaving lot_reservations behind while zeroing the rollup is precisely the
  // drift assertRollupMatches exists to refuse, and it made the next step fail
  // with INSUFFICIENT_STOCK instead of the EXPIRED_STOCK being tested.
  await tx.execute(sql`delete from lot_reservations where variant_id = ${variantId}`);
  await tx.execute(sql`update inventory_lots set reserved_qty_milli = 0 where variant_id = ${variantId}`);
  await tx.execute(sql`update inventory_stock set on_hand_qty_milli = (select coalesce(sum(on_hand_qty_milli),0) from inventory_lots where variant_id = ${variantId}), reserved_qty_milli = 0 where variant_id = ${variantId}`);
});

await refused("9. TILL: selling when the only stock is EXPIRED", "EXPIRED_STOCK", () =>
  adjust({ eventType: "RESERVE", idempotencyKey: `till-${stamp}-expired`, qtyDeltaMilli: 500n, reason: "till walk", reservationRef: `${tenantId}:x${stamp}`, variantId }),
);

// R3 — AND THE CASHIER MUST SEE IT.
//
// The check above proves the service refuses. It cannot prove the refusal
// survives the route: a handler that caught EXPIRED_STOCK and answered 200,
// or flattened it to a generic 500, would look identical from the service.
// 06-pharmacy-compliance §0 depends on this being absolute at the counter,
// and nothing asserted the counter until now.
const expiredOrder = await asTerminal("POST", "/orders", {
  idempotencyKey: `till-http-${stamp}-expired`,
  items: [{ quantity: 1, variantId }],
  paymentPreference: "cash",
});

await refusedOverHttp("R3. TILL ROUTE: the cashier is refused EXPIRED_STOCK, not shown a success", "EXPIRED_STOCK", async () =>
  expiredOrder.statusCode >= 400
    ? expiredOrder
    : asTerminal("PATCH", `/orders/${(json(expiredOrder).data as { id?: string } | undefined)?.id ?? ""}/confirm`, {
        idempotencyKey: `till-http-${stamp}-expired-confirm`,
        shippingAddressLine1: "Counter sale",
        shippingCity: "Shop",
        shippingPostalCode: "000000",
        shippingState: "Local",
      }),
);

// 12 — no drift, and nothing written without naming its lot
await asTill(async (tx) => {
  const drift = await tx.execute(sql`
    select pv.id from product_variants pv join inventory_stock ist on ist.variant_id = pv.id
    left join inventory_lots il on il.variant_id = pv.id where pv.tracking_mode = 'batch'
    group by pv.id, ist.on_hand_qty_milli, ist.reserved_qty_milli, ist.damaged_qty_milli
    having (ist.on_hand_qty_milli + ist.reserved_qty_milli + ist.damaged_qty_milli)
        <> coalesce(sum(il.on_hand_qty_milli + il.reserved_qty_milli + il.damaged_qty_milli), 0)`);
  check("12. TILL: reconciliation reports zero drift after till sales", drift.rows.length === 0, `${drift.rows.length} drifted`);

  const nullLots = (await tx.execute<{ n: string }>(sql`
    select count(*)::text n from stock_events
    where variant_id = ${variantId} and reason = 'till walk' and lot_id is null`)).rows[0]!.n;
  check("   TILL: no till movement was written without naming its lot", nullLots === "0", `${nullLots} events have a NULL lot_id`);
});

// Zero, not delete — stock_events is append-only and references the lots.
await asTill(async (tx) => {
  await tx.execute(sql`delete from lot_reservations where tenant_id = ${tenantId}`);
  await tx.execute(sql`update inventory_lots set on_hand_qty_milli = 0, reserved_qty_milli = 0, damaged_qty_milli = 0 where tenant_id = ${tenantId}`);
  await tx.execute(sql`update inventory_stock set on_hand_qty_milli = 0, reserved_qty_milli = 0, damaged_qty_milli = 0 where tenant_id = ${tenantId}`);
  await tx.execute(sql`update product_variants set tracking_mode = 'none' where tenant_id = ${tenantId}`);
  // DISABLED, not deleted. sales_orders.terminal_id references this row, so
  // the sales this walk rang would have to be destroyed first — and which till
  // rang a sale is part of the audit trail, not scratch data. Disabling is
  // also what a shop does with a retired till, so it is the more faithful
  // teardown anyway.
  await tx.execute(sql`update pos_terminals set status = 'disabled' where id = ${TERMINAL_ID}`);
  check("cleanup left this walk's tenant holding no stock", true);
});

await app.close();

for (const line of pass) console.log(`  PASS  ${line}`);
for (const line of fail) console.log(`  FAIL  ${line}`);
console.log(`\n${pass.length}/${pass.length + fail.length} TILL walk-through steps passed`);
process.exit(fail.length === 0 ? 0 : 1);
