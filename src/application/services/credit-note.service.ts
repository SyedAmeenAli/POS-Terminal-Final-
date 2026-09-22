// T16b — credit notes & returns. A credit note MIRRORS the original order
// line's gst_treatment and tax split — it never recomputes them (same
// discipline as deriveGstTreatment being classified once at confirmation,
// never at read/filing time; see tax.service.ts). Called from inside
// order.service.ts's returnOrder transaction, not exposed as its own
// mutating route — a credit note only ever exists because a return happened.
// MIRROR of ims-1's credit-note.service.ts, kept byte-for-byte identical on
// purpose (same discipline as schema.ts/tax.service.ts). No shared package
// exists between the two repos, so this is copied, not imported.
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { allocateSeriesNumber, financialYearSeriesKey, formatPaise } from "./order.service.js";
import { proportionalSharePaise } from "./tax.service.js";
import { AppError } from "../../api/errors.js";
import { creditNoteItems, creditNotes, paymentTenders, salesOrders } from "../../infrastructure/database/schema.js";
import { formatQuantity } from "../../utils/quantity.js";

const CREDIT_NOTE_SERIES_PREFIX = "CN";

type Tx = Parameters<Parameters<typeof import("../../infrastructure/database/db.js").db.transaction>[0]>[0];

export type ReturnedOrderLine = {
  cgstAmount: string | number | null;
  hsnCode: string | null;
  id: string;
  igstAmount: string | number | null;
  // The line's true sold quantity (sales_order_items.quantity) — the ceiling
  // the cumulative-quantity guard enforces against. Kept distinct from
  // `quantity` below: today's only reachable call path (full-order return)
  // always has quantity === originalQuantity, but a future partial-return
  // caller will not, and conflating the two silently turns
  // proportionalSharePaise's division into a no-op (x/x) and the guard into
  // a comparison against itself.
  originalQuantityMilli: bigint;
  // How much of this line is being credited NOW.
  quantityMilli: bigint;
  restockable: boolean;
  sgstAmount: string | number | null;
  taxableValue: string | number | null;
  taxRatePercent: string | number | null;
  unitPrice: string | number;
  variantId: string;
};

/**
 * Sums quantity already credited against this original order line (across
 * every prior credit note) and refuses a new credit that would push the
 * cumulative total above what was actually sold. Per-line, not per-order —
 * a partial return on one line must not be blocked by a full return already
 * issued on a different line of the same order.
 */
export const assertCreditQuantityWithinSold = async (
  tx: Tx,
  tenantId: string,
  originalOrderItemId: string,
  additionalQtyMilli: bigint,
  originalQtyMilli: bigint,
): Promise<void> => {
  const rows = await tx.execute<{ credited: number | null }>(sql`
    select coalesce(sum(quantity), 0) as credited
    from credit_note_items
    where tenant_id = ${tenantId} and original_order_item_id = ${originalOrderItemId}
  `);
  // BigInt, not Number: this guard decides whether a credit is refused, and
  // a milli-denominated sum loses precision as a double.
  const alreadyCreditedMilli = BigInt(rows.rows[0]?.credited ?? 0);

  if (alreadyCreditedMilli + additionalQtyMilli > originalQtyMilli) {
    throw new AppError(
      409,
      `Credit quantity ${formatQuantity(alreadyCreditedMilli + additionalQtyMilli)} exceeds original quantity ${formatQuantity(originalQtyMilli)} for order item ${originalOrderItemId}`,
    );
  }
};

const toPaise = (value: string | number | null): bigint => {
  if (value === null) {
    return 0n;
  }
  const asString = typeof value === "number" ? value.toFixed(2) : value;
  const [rupees = "0", paise = ""] = asString.split(".");
  return BigInt(rupees) * 100n + BigInt(paise.padEnd(2, "0").slice(0, 2));
};

/**
 * Creates one credit note covering the given returned lines, inheriting
 * gst_treatment and each line's tax split from the original order/items via
 * proportionalSharePaise(line.quantityMilli, line.originalQuantityMilli) — a genuine
 * proportional share when the two differ, and an exact reproduction of the
 * original amount when they don't (today's only reachable call path,
 * returnOrder, always passes them equal — see order.service.ts). Runs
 * inside the caller's existing transaction so the credit note, the stock
 * adjustment, and the order status change commit or fail together.
 */
export const createCreditNoteForReturn = async (
  tx: Tx,
  tenantId: string,
  order: { customerId: string | null; gstTreatment: "b2b" | "b2cl" | "b2cs" | "export" | "exempt" | null; id: string },
  lines: ReturnedOrderLine[],
  reason: "return" | "damage" | "price_adjustment" | "cancellation",
): Promise<{ creditNoteNumber: string; id: string }> => {
  for (const line of lines) {
    await assertCreditQuantityWithinSold(tx, tenantId, line.id, line.quantityMilli, line.originalQuantityMilli);
  }

  const financialYear = financialYearSeriesKey(new Date());
  const seriesKey = `CREDIT/${financialYear}`;
  const { number: creditNoteNumber } = await allocateSeriesNumber(
    tx,
    tenantId,
    seriesKey,
    CREDIT_NOTE_SERIES_PREFIX,
    new Date(),
    financialYear,
  );

  const lineShares = lines.map((line) => {
    const taxableSharePaise = proportionalSharePaise(toPaise(line.taxableValue), line.quantityMilli, line.originalQuantityMilli);
    const cgstSharePaise = proportionalSharePaise(toPaise(line.cgstAmount), line.quantityMilli, line.originalQuantityMilli);
    const sgstSharePaise = proportionalSharePaise(toPaise(line.sgstAmount), line.quantityMilli, line.originalQuantityMilli);
    const igstSharePaise = proportionalSharePaise(toPaise(line.igstAmount), line.quantityMilli, line.originalQuantityMilli);
    return { cgstSharePaise, igstSharePaise, sgstSharePaise, taxableSharePaise };
  });

  const subtotalPaise = lineShares.reduce((sum, share) => sum + share.taxableSharePaise, 0n);
  const taxPaise = lineShares.reduce(
    (sum, share) => sum + share.cgstSharePaise + share.sgstSharePaise + share.igstSharePaise,
    0n,
  );

  const creditNoteId = randomUUID();
  await tx.insert(creditNotes).values({
    creditNoteNumber,
    customerId: order.customerId,
    gstTreatment: order.gstTreatment,
    id: creditNoteId,
    originalOrderId: order.id,
    reason,
    subtotalAmount: formatPaise(subtotalPaise),
    taxAmount: formatPaise(taxPaise),
    tenantId,
  });

  await tx.insert(creditNoteItems).values(
    lines.map((line, i) => ({
      cgstAmount: formatPaise(lineShares[i]!.cgstSharePaise),
      creditNoteId,
      hsnCode: line.hsnCode,
      id: randomUUID(),
      igstAmount: formatPaise(lineShares[i]!.igstSharePaise),
      originalOrderItemId: line.id,
      quantityMilli: line.quantityMilli,
      restockable: line.restockable,
      sgstAmount: formatPaise(lineShares[i]!.sgstSharePaise),
      taxRatePercent:
        line.taxRatePercent === null
          ? null
          : typeof line.taxRatePercent === "number"
            ? line.taxRatePercent.toFixed(2)
            : line.taxRatePercent,
      taxableValue: formatPaise(lineShares[i]!.taxableSharePaise),
      tenantId,
      unitPrice: typeof line.unitPrice === "number" ? line.unitPrice.toFixed(2) : line.unitPrice,
      variantId: line.variantId,
    })),
  );

  return { creditNoteNumber, id: creditNoteId };
};

/**
 * Records a refund against a credit note as a negative-amount
 * payment_tenders row — refunds reuse the existing tender ledger rather
 * than a new table (see migration 0030's comment). amountPaise must be
 * positive; the sign is applied here so callers never hand-format a
 * negative bigint (formatPaise's rupees/cents split relies on truncating
 * division, which is wrong for negative bigints in JS).
 */
export const recordRefund = async (
  tx: Tx,
  tenantId: string,
  input: {
    amountPaise: bigint;
    creditNoteId: string;
    method: "cash" | "UPI";
    orderId: string;
  },
): Promise<void> => {
  if (input.amountPaise <= 0n) {
    throw new AppError(422, "Refund amount must be greater than zero");
  }

  await tx.insert(paymentTenders).values({
    amount: `-${formatPaise(input.amountPaise)}`,
    creditNoteId: input.creditNoteId,
    id: randomUUID(),
    method: input.method,
    orderId: input.orderId,
    tenantId,
  });

  await maybeTransitionToRefunded(tx, tenantId, input.orderId);
};

/**
 * An order whose credit notes fully cover its original total, and whose
 * refund tenders fully settle what was credited, moves to "Refunded". A
 * partially credited order — or one credited but not yet refunded — stays
 * "Returned". Only ever tightens (Returned -> Refunded); never reverses a
 * Refunded order back, and never touches an order in any other status.
 */
const maybeTransitionToRefunded = async (tx: Tx, tenantId: string, orderId: string): Promise<void> => {
  const orderRows = await tx
    .select({ orderStatus: salesOrders.orderStatus, subtotalAmount: salesOrders.subtotalAmount, taxAmount: salesOrders.taxAmount })
    .from(salesOrders)
    .where(and(eq(salesOrders.id, orderId), eq(salesOrders.tenantId, tenantId)))
    .limit(1);
  const order = orderRows[0];
  if (!order || order.orderStatus !== "Returned") {
    return;
  }
  const orderTotalPaise = toPaise(order.subtotalAmount) + toPaise(order.taxAmount);

  const creditedRows = await tx.execute<{ credited: string | null }>(sql`
    select coalesce(sum(subtotal_amount + tax_amount), 0) as credited
    from credit_notes
    where tenant_id = ${tenantId} and original_order_id = ${orderId}
  `);
  const creditedPaise = toPaise(creditedRows.rows[0]?.credited ?? "0");

  const refundedRows = await tx.execute<{ refunded: string | null }>(sql`
    select coalesce(sum(-amount), 0) as refunded
    from payment_tenders
    where tenant_id = ${tenantId} and order_id = ${orderId} and credit_note_id is not null
  `);
  const refundedPaise = toPaise(refundedRows.rows[0]?.refunded ?? "0");

  if (creditedPaise >= orderTotalPaise && refundedPaise >= creditedPaise) {
    await tx.update(salesOrders).set({ orderStatus: "Refunded" }).where(eq(salesOrders.id, orderId));
  }
};

export const getCreditNote = async (tx: Tx, tenantId: string, creditNoteId: string) => {
  const rows = await tx
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, creditNoteId), eq(creditNotes.tenantId, tenantId)))
    .limit(1);
  const creditNote = rows[0];
  if (!creditNote) {
    throw new AppError(404, "Credit note not found");
  }

  const items = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.creditNoteId, creditNoteId));

  return { ...creditNote, items };
};

export const listCreditNotesForOrder = async (tx: Tx, tenantId: string, orderId: string) =>
  tx
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.originalOrderId, orderId), eq(creditNotes.tenantId, tenantId)));
