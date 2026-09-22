// ┌──────────────────────────────────────────────────────────────────────┐
// │ SYNCHRONISED FILE — do not edit this copy.                           │
// │                                                                      │
// │ Canonical source: ims-backend. Regenerate with:                      │
// │     ./node_modules/.bin/tsx scripts/sync-shared.ts                   │
// │                                                                      │
// │ The till and the back office price the same sale and decide which    │
// │ batch a shop sells, against ONE database. A difference here is a     │
// │ difference a customer meets at a counter. Both repos' parity tests   │
// │ compare these files and fail the build when they diverge.            │
// └──────────────────────────────────────────────────────────────────────┘
// T31 — BATCH TRACKING.
//
// Everything in this file is scoped to variants whose tracking_mode is
// 'batch'. An untracked item never reaches these functions, and its stock
// path is byte-for-byte what it was before T31 — that is the property that
// makes this phase safe to ship to a shop that sells screwdrivers.
//
// THREE RULES, and the rest of the file is their consequences:
//
//   1. inventory_stock is a DERIVED ROLLUP over inventory_lots, written in
//      the SAME transaction as the lot write. Never a background job.
//   2. Issue policy is FEFO — first EXPIRY, first out. Not FIFO.
//   3. A reservation names its lot, and RELEASE returns to that same lot.
import { and, asc, eq, sql } from "drizzle-orm";

import { AppError } from "../../api/errors.js";
import { db } from "../../infrastructure/database/db.js";
import { inventoryLots, lotReservations } from "../../infrastructure/database/schema.js";
import { formatQuantity } from "../../utils/quantity.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LotRow = {
  batchNumber: string;
  damagedQtyMilli: bigint;
  expiryDate: string | null;
  id: string;
  onHandQtyMilli: bigint;
  reservedQtyMilli: bigint;
};

/** How many days ahead the near-expiry monitor looks. Vyapar's default. */
export const NEAR_EXPIRY_HORIZON_DAYS = 30;

export const lotAvailableQtyMilli = (lot: {
  damagedQtyMilli: bigint;
  onHandQtyMilli: bigint;
  reservedQtyMilli: bigint;
}): bigint => lot.onHandQtyMilli - lot.reservedQtyMilli - lot.damagedQtyMilli;

/**
 * Locks every lot of a variant in FEFO order and coerces the quantities.
 *
 * FOR UPDATE, and ordered inside the query rather than after it: two
 * concurrent sales of the same variant must take the lot locks in the same
 * sequence or they deadlock. Ordering by expiry gives that sequence for free
 * and is also the issue order, so there is exactly one ordering in the file.
 *
 * NULLS LAST is deliberate and matches the index. A lot with no expiry date
 * is issued only once every dated lot is exhausted — an undated lot cannot
 * be PROVEN older, and guessing wrong here means selling fresh stock while
 * dated stock expires, which is the exact loss FEFO exists to prevent.
 *
 * Coerced at this boundary because node-pg hands back a bigint column as a
 * STRING and raw SQL never passes through Drizzle's column codecs.
 */
export const lockLotsForVariant = async (tx: Tx, variantId: string): Promise<LotRow[]> => {
  const locked = await tx.execute<{
    batchNumber: string;
    damagedQtyMilli: string;
    expiryDate: string | null;
    id: string;
    onHandQtyMilli: string;
    reservedQtyMilli: string;
  }>(
    sql`
      select
        id,
        batch_number as "batchNumber",
        expiry_date as "expiryDate",
        on_hand_qty_milli as "onHandQtyMilli",
        reserved_qty_milli as "reservedQtyMilli",
        damaged_qty_milli as "damagedQtyMilli"
      from inventory_lots
      where variant_id = ${variantId}
      order by expiry_date asc nulls last, created_at asc
      for update
    `,
  );

  return locked.rows.map((row) => ({
    batchNumber: row.batchNumber,
    damagedQtyMilli: BigInt(row.damagedQtyMilli),
    expiryDate: row.expiryDate,
    id: row.id,
    onHandQtyMilli: BigInt(row.onHandQtyMilli),
    reservedQtyMilli: BigInt(row.reservedQtyMilli),
  }));
};

/**
 * True when the lot is past its expiry date as of `asOf`.
 *
 * Date-only comparison on the stored 'YYYY-MM-DD' string, not a timestamp
 * subtraction: a batch expiring today is sellable for the whole of today,
 * which is both the legal position and what a shopkeeper expects. Comparing
 * strings is safe because ISO dates sort lexicographically, and it sidesteps
 * the timezone question entirely — the printed expiry date on a pack is a
 * calendar date in the shop's local sense, not an instant.
 */
export const isExpired = (lot: { expiryDate: string | null }, asOf: Date): boolean =>
  lot.expiryDate !== null && lot.expiryDate < asOf.toISOString().slice(0, 10);

export type Allocation = { lotId: string; qtyMilli: bigint };

/**
 * First expiry first, undated last.
 *
 * lockLotsForVariant already returns the lots in this order, and has to —
 * the lock order is what stops two concurrent sales of the same variant from
 * deadlocking. Sorting AGAIN here is not redundancy for its own sake: it
 * makes FEFO a property of the allocation function rather than of a SQL
 * ORDER BY three calls away, so the rule can be tested, and so a future
 * caller that assembles lots some other way cannot silently get FIFO.
 *
 * Undated last, in both places. A lot with no expiry date cannot be PROVEN
 * older, and issuing it first means selling fresh stock while dated stock
 * expires on the shelf — the exact loss FEFO exists to prevent.
 */
export const sortFefo = (lots: LotRow[]): LotRow[] =>
  [...lots].sort((a, b) => {
    if (a.expiryDate === b.expiryDate) return 0;
    if (a.expiryDate === null) return 1;
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  });

/**
 * Picks lots to satisfy `qtyMilli`, first expiry first, skipping expired.
 *
 * EXPIRED STOCK IS REFUSED, NOT SKIPPED-AND-FORGOTTEN. If the variant holds
 * enough stock overall but not enough unexpired stock, this throws
 * EXPIRED_STOCK rather than the generic INSUFFICIENT_STOCK, because the two
 * demand different actions from the shopkeeper: one is "order more", the
 * other is "pull these off the shelf". Reporting the second as the first
 * sends someone to reorder stock they are already standing next to.
 */
export const allocateFefo = (
  lots: LotRow[],
  qtyMilli: bigint,
  asOf: Date,
): Allocation[] => {
  const allocations: Allocation[] = [];
  let remaining = qtyMilli;
  let expiredAvailable = 0n;

  for (const lot of sortFefo(lots)) {
    const available = lotAvailableQtyMilli(lot);
    if (available <= 0n) continue;

    if (isExpired(lot, asOf)) {
      expiredAvailable += available;
      continue;
    }

    const take = available < remaining ? available : remaining;
    allocations.push({ lotId: lot.id, qtyMilli: take });
    remaining -= take;
    if (remaining === 0n) break;
  }

  if (remaining > 0n) {
    if (expiredAvailable >= remaining) {
      throw new AppError(
        409,
        `Cannot sell expired stock. ${formatQuantity(expiredAvailable)} on hand is past its expiry date.`,
        undefined,
        "EXPIRED_STOCK",
      );
    }
    throw new AppError(
      409,
      `Insufficient unexpired stock. Short by ${formatQuantity(remaining)}.`,
      undefined,
      "INSUFFICIENT_STOCK",
    );
  }

  return allocations;
};

/** Applies a signed delta to one lot's on-hand, or to its reserved column. */
export const applyLotDelta = async (
  tx: Tx,
  lotId: string,
  column: "onHand" | "reserved" | "damaged",
  deltaMilli: bigint,
): Promise<void> => {
  const set =
    column === "onHand"
      ? { onHandQtyMilli: sql`${inventoryLots.onHandQtyMilli} + ${deltaMilli}` }
      : column === "reserved"
        ? { reservedQtyMilli: sql`${inventoryLots.reservedQtyMilli} + ${deltaMilli}` }
        : { damagedQtyMilli: sql`${inventoryLots.damagedQtyMilli} + ${deltaMilli}` };

  await tx.update(inventoryLots).set(set).where(eq(inventoryLots.id, lotId));
};

/**
 * Rewrites inventory_stock from the lots. THE rollup.
 *
 * Called in the same transaction as every lot write, immediately after it.
 * A single UPDATE ... FROM (select sum ...) rather than reading and writing
 * from application code, so the rollup cannot be computed from a snapshot
 * taken before a concurrent transaction's lot write — the lots are already
 * row-locked by lockLotsForVariant when this runs.
 */
export const rebuildRollup = async (tx: Tx, variantId: string): Promise<void> => {
  await tx.execute(sql`
    update inventory_stock
    set
      on_hand_qty_milli = coalesce(agg.on_hand, 0),
      reserved_qty_milli = coalesce(agg.reserved, 0),
      damaged_qty_milli = coalesce(agg.damaged, 0),
      updated_at = now()
    from (
      select
        sum(on_hand_qty_milli) as on_hand,
        sum(reserved_qty_milli) as reserved,
        sum(damaged_qty_milli) as damaged
      from inventory_lots
      where variant_id = ${variantId}
    ) as agg
    where inventory_stock.variant_id = ${variantId}
  `);
};

/** Records that `ref` holds `qtyMilli` against `lotId`. Additive on replay. */
export const recordReservation = async (
  tx: Tx,
  tenantId: string,
  input: { lotId: string; qtyMilli: bigint; reservationRef: string; variantId: string },
): Promise<void> => {
  await tx
    .insert(lotReservations)
    .values({
      id: crypto.randomUUID(),
      lotId: input.lotId,
      qtyMilli: input.qtyMilli,
      reservationRef: input.reservationRef,
      tenantId,
      variantId: input.variantId,
    })
    .onConflictDoUpdate({
      target: [lotReservations.reservationRef, lotReservations.lotId],
      set: { qtyMilli: sql`${lotReservations.qtyMilli} + ${input.qtyMilli}` },
    });
};

/** The lots a reservation is holding, so RELEASE and SALE can honour it. */
export const getReservation = async (tx: Tx, reservationRef: string): Promise<Allocation[]> => {
  const rows = await tx
    .select({ lotId: lotReservations.lotId, qtyMilli: lotReservations.qtyMilli })
    .from(lotReservations)
    .where(eq(lotReservations.reservationRef, reservationRef))
    .orderBy(asc(lotReservations.createdAt));

  return rows.map((row) => ({ lotId: row.lotId, qtyMilli: row.qtyMilli }));
};

export const clearReservation = async (tx: Tx, reservationRef: string): Promise<void> => {
  await tx.delete(lotReservations).where(eq(lotReservations.reservationRef, reservationRef));
};

/**
 * Finds or creates the lot a receipt goes into.
 *
 * Receiving the same batch number twice adds to the existing lot rather than
 * creating a second row — that is what makes "how much of B2401 is left" a
 * single row and not a sum, and it is why the unique index exists.
 */
export const upsertLot = async (
  tx: Tx,
  tenantId: string,
  input: {
    batchNumber: string;
    expiryDate?: string | null;
    manufacturingDate?: string | null;
    mrpPaise?: bigint | null;
    size?: string | null;
    variantId: string;
  },
): Promise<string> => {
  const existing = await tx
    .select({ id: inventoryLots.id })
    .from(inventoryLots)
    .where(
      and(
        eq(inventoryLots.variantId, input.variantId),
        eq(inventoryLots.batchNumber, input.batchNumber),
      ),
    );

  if (existing[0]) {
    // A second receipt of a known batch may carry a corrected MRP or expiry
    // — the supplier reprinted the pack. Only non-null values overwrite, so
    // a receipt that simply omits a field does not erase what is known.
    const patch: Record<string, unknown> = {};
    if (input.mrpPaise != null) patch.mrpPaise = input.mrpPaise;
    if (input.expiryDate != null) patch.expiryDate = input.expiryDate;
    if (input.manufacturingDate != null) patch.manufacturingDate = input.manufacturingDate;
    if (input.size != null) patch.size = input.size;
    if (Object.keys(patch).length > 0) {
      await tx.update(inventoryLots).set(patch).where(eq(inventoryLots.id, existing[0].id));
    }
    return existing[0].id;
  }

  const id = crypto.randomUUID();
  await tx.insert(inventoryLots).values({
    batchNumber: input.batchNumber,
    expiryDate: input.expiryDate ?? null,
    id,
    manufacturingDate: input.manufacturingDate ?? null,
    mrpPaise: input.mrpPaise ?? null,
    size: input.size ?? null,
    tenantId,
    variantId: input.variantId,
  });
  return id;
};

export const listLotsForVariant = async (tenantId: string, variantId: string) =>
  db
    .select({
      availableQtyMilli: sql<string>`${inventoryLots.onHandQtyMilli} - ${inventoryLots.reservedQtyMilli} - ${inventoryLots.damagedQtyMilli}`,
      batchNumber: inventoryLots.batchNumber,
      damagedQtyMilli: inventoryLots.damagedQtyMilli,
      expiryDate: inventoryLots.expiryDate,
      id: inventoryLots.id,
      manufacturingDate: inventoryLots.manufacturingDate,
      mrpPaise: inventoryLots.mrpPaise,
      onHandQtyMilli: inventoryLots.onHandQtyMilli,
      reservedQtyMilli: inventoryLots.reservedQtyMilli,
      size: inventoryLots.size,
    })
    .from(inventoryLots)
    .where(and(eq(inventoryLots.tenantId, tenantId), eq(inventoryLots.variantId, variantId)))
    .orderBy(asc(inventoryLots.expiryDate), asc(inventoryLots.createdAt));

/**
 * Releases `qtyMilli` of reservation from lots that actually hold some.
 *
 * The fallback path when a RELEASE arrives with no reservation rows — an
 * order confirmed before T31 shipped, or one whose reservation was already
 * cleared by a prior release. Reverse-FEFO would be wrong here: what matters
 * is only that the reserved column comes down on lots that have it, and
 * clamping per lot is what keeps the non-negative CHECK from firing as a raw
 * database error instead of a domain one.
 */
export const releaseWithoutReservation = (lots: LotRow[], qtyMilli: bigint): Allocation[] => {
  const allocations: Allocation[] = [];
  let remaining = qtyMilli;

  for (const lot of lots) {
    if (remaining === 0n) break;
    if (lot.reservedQtyMilli <= 0n) continue;
    const take = lot.reservedQtyMilli < remaining ? lot.reservedQtyMilli : remaining;
    allocations.push({ lotId: lot.id, qtyMilli: take });
    remaining -= take;
  }

  return allocations;
};
