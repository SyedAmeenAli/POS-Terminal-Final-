import { and, eq, sql } from "drizzle-orm";

import { logAudit } from "./audit-log.service.js";
import {
  type Allocation,
  allocateFefo,
  applyLotDelta,
  clearReservation,
  getReservation,
  lockLotsForVariant,
  rebuildRollup,
  recordReservation,
  releaseWithoutReservation,
  upsertLot,
} from "./lot.service.js";
import {
  allocateSerials,
  lockSerialsForVariant,
  rebuildSerialRollup,
  receiveSerials,
  reservedSerials,
  serialCountFromMilli,
  setSerialStatus,
  type SerialInput,
} from "./serial.service.js";
import { AppError } from "../../api/errors.js";
import { db } from "../../infrastructure/database/db.js";
import {
  categories,
  inventoryStock,
  productTypes,
  products,
  productVariants,
  stockEvents,
  webhookEvents,
} from "../../infrastructure/database/schema.js";
import { formatQuantity } from "../../utils/quantity.js";

export const INTERNAL_IDEMPOTENCY_PROVIDER = "razorpay";

/**
 * Namespaces a caller-supplied idempotency key by tenant.
 *
 * Internal idempotency reuses webhook_events, whose unique index is
 * (provider, external_event_id) — global, correctly so for real providers,
 * whose ids are globally unique. Caller-supplied keys are not: two tenants
 * both sending "adjust-1" collided, and the second was silently reported as a
 * duplicate. That is a lost stock movement returning HTTP success.
 */
export const scopeIdempotencyKey = (tenantId: string, key: string): string =>
  `${tenantId}:${key}`;

type AdjustmentEventType =
  | "SALE"
  | "RESERVE"
  | "RELEASE"
  | "RETURN"
  | "DAMAGE"
  | "PURCHASE_RECEIPT"
  | "ADJUSTMENT";

/** T31 — the batch an INBOUND movement lands in. Batch-tracked items only. */
export type LotInput = {
  batchNumber: string;
  expiryDate?: string | null;
  manufacturingDate?: string | null;
  mrpPaise?: bigint | null;
  size?: string | null;
};

type AdjustStockInput = {
  damageMode?: "increment" | "transfer";
  eventType: AdjustmentEventType;
  idempotencyKey: string;
  // T31 — which batch this receipt/return goes into. Ignored for untracked
  // items; REQUIRED for an inbound movement on a batch-tracked one.
  lot?: LotInput;
  negativeOverride?: boolean;
  // T32 — the units this movement brings IN. Serialised items only.
  serials?: SerialInput[];
  /** T32 — the order line a SALE hands the unit to, for the warranty record. */
  soldOrderItemId?: string;
  // T30 — milli-units. Conversion happens at the edge; everything below is
  // integer arithmetic in one unit.
  qtyDeltaMilli: bigint;
  reason: string;
  // T31 — "<orderId>:<orderItemId>", stable for the order's whole lifetime
  // and deliberately NOT the idempotency key, which embeds the state
  // transition. This is what lets a sale rung HERE honour a reservation made
  // in the admin console.
  reservationRef?: string;
  variantId: string;
};

type ActorInput = {
  actorUserId: string;
};

type LockedInventoryRow = {
  damagedQtyMilli: bigint;
  id: string;
  /** T31 — 'none' | 'batch' | 'serial', read under the same row lock. */
  trackingMode: string;
  onHandQtyMilli: bigint;
  reservedQtyMilli: bigint;
  variantId: string;
};

/** Math.abs has no bigint equivalent. */
const absMilli = (value: bigint): bigint => (value < 0n ? -value : value);

const computeAvailableQtyMilli = (row: Pick<LockedInventoryRow, "damagedQtyMilli" | "onHandQtyMilli" | "reservedQtyMilli">) =>
  row.onHandQtyMilli - row.reservedQtyMilli - row.damagedQtyMilli;

const applyInventoryChange = (
  row: LockedInventoryRow,
  input: AdjustStockInput,
): LockedInventoryRow => {
  const next = { ...row };

  switch (input.eventType) {
    case "RESERVE":
      next.reservedQtyMilli += input.qtyDeltaMilli;
      break;
    case "RELEASE":
      next.reservedQtyMilli -= input.qtyDeltaMilli;
      break;
    case "RETURN":
      next.onHandQtyMilli += input.qtyDeltaMilli;
      break;
    case "DAMAGE":
      if (input.damageMode === "increment") {
        next.damagedQtyMilli += input.qtyDeltaMilli;
      } else {
        next.onHandQtyMilli -= input.qtyDeltaMilli;
        next.damagedQtyMilli += input.qtyDeltaMilli;
      }
      break;
    case "PURCHASE_RECEIPT":
      next.onHandQtyMilli += input.qtyDeltaMilli;
      break;
    case "ADJUSTMENT":
      next.onHandQtyMilli += input.qtyDeltaMilli;
      break;
    case "SALE":
      next.onHandQtyMilli -= input.qtyDeltaMilli;
      next.reservedQtyMilli -= input.qtyDeltaMilli;
      break;
    default:
      throw new AppError(400, "Unsupported inventory event type");
  }

  return next;
};

const ensureNonNegativeFields = (
  row: LockedInventoryRow,
  input: AdjustStockInput,
): void => {
  if (row.onHandQtyMilli < 0n || row.reservedQtyMilli < 0n || row.damagedQtyMilli < 0n) {
    const message = `Inventory adjustment would create negative stock fields for ${input.eventType}`;
    throw new AppError(409, message, undefined, "INSUFFICIENT_STOCK");
  }
};

const lockVariantAndInventory = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  variantId: string,
): Promise<LockedInventoryRow> => {
  const lockedVariant = await tx.execute<{ id: string; tracking_mode: string }>(
    sql`select id, tracking_mode from product_variants where id = ${variantId}`,
  );

  if (lockedVariant.rows.length === 0) {
    throw new AppError(404, "Variant not found");
  }

  // T30 — TWO hazards here, and the type parameter on `execute` hides both:
  // it is an unchecked ASSERTION, not a check. The compiler would have
  // believed the old aliases still matched after the rename, and believed the
  // values were bigint. Neither is true — node-pg returns a bigint column as
  // a STRING, and raw SQL never passes through Drizzle's codecs, so these
  // arrive as "1500" and `"1500" + 500n` throws.
  const lockedInventory = await tx.execute<{
    damagedQtyMilli: string;
    id: string;
    onHandQtyMilli: string;
    reservedQtyMilli: string;
    variantId: string;
  }>(
    sql`
      select
        id,
        variant_id as "variantId",
        on_hand_qty_milli as "onHandQtyMilli",
        reserved_qty_milli as "reservedQtyMilli",
        damaged_qty_milli as "damagedQtyMilli"
      from inventory_stock
      where variant_id = ${variantId}
      for update
    `,
  );

  if (lockedInventory.rows.length === 0) {
    throw new AppError(404, "Inventory row not found");
  }

  // Coerced HERE, once, at the boundary between raw SQL and the rest of this
  // module.
  const row = lockedInventory.rows[0]!;
  return {
    damagedQtyMilli: BigInt(row.damagedQtyMilli),
    id: row.id,
    onHandQtyMilli: BigInt(row.onHandQtyMilli),
    reservedQtyMilli: BigInt(row.reservedQtyMilli),
    trackingMode: lockedVariant.rows[0]!.tracking_mode,
    variantId: row.variantId,
  } satisfies LockedInventoryRow;
};

// ============================================================================
// T31 — THE LOT FORK. PORTED VERBATIM from ims-1's inventory.service.ts.
//
// Everything below runs ONLY for tracking_mode = 'batch'. An untracked item's
// path through this service is byte-for-byte what it was before, which is
// what makes this safe to ship to a shop selling screwdrivers.
//
// src/tests/lot-parity.test.ts compares these functions against ims-1's and
// fails when they diverge. If you change one, change the other.
// ============================================================================

/**
 * T31 — applies the movement to the variant's LOTS, and returns the lot the
 * stock_event should name.
 *
 * Runs only for tracking_mode = 'batch'. Everything an untracked item does is
 * unchanged by T31, which is the property that makes this safe to ship to a
 * shop selling screwdrivers.
 *
 * Called BEFORE the rollup is rebuilt and AFTER the inventory_stock row lock
 * is held, so the lot locks are taken in a fixed order (FEFO, see
 * lockLotsForVariant) underneath a lock that already serialises this variant.
 *
 * Returns a single lotId only when the movement resolved to exactly one lot.
 * A movement that spans several batches — an order line larger than any one
 * batch — records no lot on the stock_event rather than an arbitrary one of
 * them. Naming the first would read as "this all came from B2401", which is
 * false, and a false audit row is worse than a null one.
 */
const applyLotMovement = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  input: AdjustStockInput,
): Promise<string | null> => {
  const lots = await lockLotsForVariant(tx, input.variantId);
  const qty = absMilli(input.qtyDeltaMilli);
  const asOf = new Date();

  // Inbound. The batch must be named: stock belonging to no batch cannot be
  // issued by FEFO or checked for expiry, and inventing one to hold it would
  // defeat both silently.
  const isInbound =
    input.eventType === "PURCHASE_RECEIPT" ||
    input.eventType === "RETURN" ||
    (input.eventType === "ADJUSTMENT" && input.qtyDeltaMilli > 0n);

  if (isInbound) {
    // A return goes back into the batch it came out of. Not into a new one,
    // and not into whichever batch FEFO would pick — a returned strip of
    // tablets carries the expiry date printed on it, and filing it under a
    // fresher batch would sell it again after it has expired.
    //
    // Resolvable only when the original sale resolved to a SINGLE lot, which
    // is the ordinary case; a sale that spanned batches recorded no lot (see
    // singleLot) and there is nothing here to recover. That return has to
    // name its batch, and saying so is better than guessing.
    const originLotId = input.lot ? null : await findOriginLot(tx, input);

    if (!input.lot && !originLotId) {
      throw new AppError(
        422,
        "This item is batch-tracked, so a batch number is required to add stock.",
        undefined,
        "LOT_REQUIRED",
      );
    }

    const lotId =
      originLotId ?? (await upsertLot(tx, tenantId, { ...input.lot!, variantId: input.variantId }));
    await applyLotDelta(tx, lotId, "onHand", qty);
    return lotId;
  }

  if (input.eventType === "RESERVE") {
    const allocations = allocateFefo(lots, qty, asOf);
    for (const allocation of allocations) {
      await applyLotDelta(tx, allocation.lotId, "reserved", allocation.qtyMilli);
      if (input.reservationRef) {
        await recordReservation(tx, tenantId, {
          lotId: allocation.lotId,
          qtyMilli: allocation.qtyMilli,
          reservationRef: input.reservationRef,
          variantId: input.variantId,
        });
      }
    }
    return singleLot(allocations);
  }

  if (input.eventType === "RELEASE") {
    const held = input.reservationRef ? await getReservation(tx, input.reservationRef) : [];
    const allocations = held.length > 0 ? held : releaseWithoutReservation(lots, qty);
    for (const allocation of allocations) {
      await applyLotDelta(tx, allocation.lotId, "reserved", -allocation.qtyMilli);
    }
    if (input.reservationRef && held.length > 0) {
      await clearReservation(tx, input.reservationRef);
    }
    return singleLot(allocations);
  }

  if (input.eventType === "SALE") {
    // THE reason reservations name their lot. A sale honours what was
    // actually set aside; it does not re-run FEFO and hand over whichever
    // batch happens to be oldest at payment time, which after an overnight
    // delivery is a different batch than the one promised.
    const held = input.reservationRef ? await getReservation(tx, input.reservationRef) : [];
    if (held.length > 0) {
      for (const allocation of held) {
        await applyLotDelta(tx, allocation.lotId, "onHand", -allocation.qtyMilli);
        await applyLotDelta(tx, allocation.lotId, "reserved", -allocation.qtyMilli);
      }
      await clearReservation(tx, input.reservationRef!);
      return singleLot(held);
    }

    // No reservation: a till sale that never passed through confirm. FEFO
    // picks the batches, and the reserved column comes down only as far as
    // each lot actually holds — an unreserved sale must not drive reserved
    // negative and surface as a raw CHECK violation.
    const allocations = allocateFefo(lots, qty, asOf);
    const reservedByLot = new Map(lots.map((lot) => [lot.id, lot.reservedQtyMilli]));
    for (const allocation of allocations) {
      await applyLotDelta(tx, allocation.lotId, "onHand", -allocation.qtyMilli);
      const reserved = reservedByLot.get(allocation.lotId) ?? 0n;
      const unwind = reserved < allocation.qtyMilli ? reserved : allocation.qtyMilli;
      if (unwind > 0n) {
        await applyLotDelta(tx, allocation.lotId, "reserved", -unwind);
      }
    }
    return singleLot(allocations);
  }

  if (input.eventType === "DAMAGE") {
    // Damage the oldest first, same order as issue: the batch nearest expiry
    // is the one that spoils, and it is expired stock a shop writes off.
    // Expired lots are eligible HERE and nowhere else — refusing to let a
    // shopkeeper write off expired stock is the opposite of the point.
    const allocations = allocateDamage(lots, qty);
    for (const allocation of allocations) {
      await applyLotDelta(tx, allocation.lotId, "damaged", allocation.qtyMilli);
      if (input.damageMode !== "increment") {
        await applyLotDelta(tx, allocation.lotId, "onHand", -allocation.qtyMilli);
      }
    }
    return singleLot(allocations);
  }

  // Negative ADJUSTMENT — a stock count coming in short. FEFO, and expired
  // lots ARE eligible: a count correction is not a sale.
  const allocations = allocateDamage(lots, qty);
  for (const allocation of allocations) {
    await applyLotDelta(tx, allocation.lotId, "onHand", -allocation.qtyMilli);
  }
  return singleLot(allocations);
};

/**
 * The lot an order line was sold out of, for a return to go back into.
 *
 * Matched on the order id carried in reservationRef ("<orderId>:<itemId>")
 * against the reason string the SALE wrote. Reason strings here are
 * constructed by order.service, never by a user, so LIKE on that prefix is
 * matching this codebase's own output rather than parsing input.
 *
 * Returns null when the sale spanned several batches (lot_id null) or when
 * there was no such sale at all — a purchase receipt, say. Both mean "the
 * caller must name the batch", which is what the caller is then told.
 */
const findOriginLot = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: AdjustStockInput,
): Promise<string | null> => {
  if (!input.reservationRef) return null;
  const orderId = input.reservationRef.split(":")[0];
  if (!orderId) return null;

  const rows = await tx.execute<{ lot_id: string }>(sql`
    select lot_id
    from stock_events
    where variant_id = ${input.variantId}
      and event_type = 'SALE'
      and lot_id is not null
      and reason like ${`ORDER_PAY:${orderId}:%`}
    order by id desc
    limit 1
  `);

  return rows.rows[0]?.lot_id ?? null;
};

/**
 * T32 — applies the movement to the variant's SERIALS.
 *
 * The counterpart to applyLotMovement, and deliberately shaped the same way
 * so a reader who knows one knows the other. What differs follows from a
 * serial being one UNIT rather than a quantity: allocation picks rows, the
 * rollup is a count, and a reservation is a column on the serial itself
 * rather than a separate table.
 *
 * Returns a single serialId only when the movement resolved to exactly one
 * unit — a three-laptop line names none of them on the stock_event, for the
 * same reason a multi-batch sale names no lot. A false audit row is worse
 * than a null one.
 */
const applySerialMovement = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  input: AdjustStockInput,
): Promise<string | null> => {
  const count = serialCountFromMilli(absMilli(input.qtyDeltaMilli));

  const isInbound =
    input.eventType === "PURCHASE_RECEIPT" ||
    input.eventType === "RETURN" ||
    (input.eventType === "ADJUSTMENT" && input.qtyDeltaMilli > 0n);

  if (isInbound) {
    // A RETURN puts a specific unit back, and the caller knows which one —
    // it is the serial the customer walked in with. PURCHASE_RECEIPT names
    // the units being received. Either way the serials must be named.
    if (!input.serials || input.serials.length === 0) {
      throw new AppError(
        422,
        "This item is tracked by serial number, so each unit must be identified.",
        undefined,
        "SERIALS_REQUIRED",
      );
    }
    if (input.serials.length !== count) {
      throw new AppError(
        422,
        `${count} unit(s) are being added but ${input.serials.length} serial number(s) were given.`,
        undefined,
        "SERIAL_COUNT_MISMATCH",
      );
    }

    if (input.eventType === "RETURN") {
      // Returning a unit this shop sold: flip it back rather than creating a
      // second row for the same physical laptop.
      const existing = await lockSerialsForVariant(tx, input.variantId);
      const byNumber = new Map(existing.map((serial) => [serial.serialNumber, serial]));
      const ids: string[] = [];
      for (const incoming of input.serials) {
        const match = byNumber.get(incoming.serialNumber.trim().toUpperCase());
        if (!match) {
          // THE warranty refusal, reached through the return path.
          throw new AppError(
            422,
            `Serial ${incoming.serialNumber} was not sold by this shop, so it cannot be returned here.`,
            undefined,
            "SERIAL_NOT_SOLD_HERE",
          );
        }
        await setSerialStatus(tx, match.id, "returned");
        ids.push(match.id);
      }
      return ids.length === 1 ? ids[0]! : null;
    }

    const ids = await receiveSerials(tx, tenantId, input.variantId, input.serials);
    return ids.length === 1 ? ids[0]! : null;
  }

  const serials = await lockSerialsForVariant(tx, input.variantId);

  if (input.eventType === "RESERVE") {
    const chosen = allocateSerials(serials, count);
    for (const serial of chosen) {
      await setSerialStatus(tx, serial.id, "reserved", { reservationRef: input.reservationRef ?? null });
    }
    return chosen.length === 1 ? chosen[0]!.id : null;
  }

  if (input.eventType === "RELEASE") {
    const held = input.reservationRef ? reservedSerials(serials, input.reservationRef) : [];
    // No reservation rows: an order confirmed before serials existed. Release
    // whatever this variant has reserved, clamped to the count, so the
    // release cannot strand units nobody can sell.
    const chosen = held.length > 0
      ? held
      : serials.filter((serial) => serial.status === "reserved").slice(0, count);
    for (const serial of chosen) {
      await setSerialStatus(tx, serial.id, "in_stock");
    }
    return chosen.length === 1 ? chosen[0]!.id : null;
  }

  if (input.eventType === "SALE") {
    // THE reason a reservation names its serial. A sale hands over the unit
    // that was actually promised; it does not re-pick at payment time and
    // give the customer a different laptop from the one they were shown.
    const held = input.reservationRef ? reservedSerials(serials, input.reservationRef) : [];
    const chosen = held.length > 0 ? held : allocateSerials(serials, count);
    for (const serial of chosen) {
      await setSerialStatus(tx, serial.id, "sold", { soldOrderItemId: input.soldOrderItemId ?? null });
    }
    return chosen.length === 1 ? chosen[0]!.id : null;
  }

  // DAMAGE, or a negative ADJUSTMENT. Both take units out of sellable stock;
  // neither is a sale, so neither records a sale reference.
  const chosen = allocateSerials(serials, count);
  for (const serial of chosen) {
    await setSerialStatus(tx, serial.id, "damaged");
  }
  return chosen.length === 1 ? chosen[0]!.id : null;
};

/** FEFO order, expiry ignored. For write-offs and count corrections. */
const allocateDamage = (
  lots: Awaited<ReturnType<typeof lockLotsForVariant>>,
  qtyMilli: bigint,
): Allocation[] => {
  const allocations: Allocation[] = [];
  let remaining = qtyMilli;

  for (const lot of lots) {
    if (remaining === 0n) break;
    const available = lot.onHandQtyMilli - lot.damagedQtyMilli;
    if (available <= 0n) continue;
    const take = available < remaining ? available : remaining;
    allocations.push({ lotId: lot.id, qtyMilli: take });
    remaining -= take;
  }

  if (remaining > 0n) {
    throw new AppError(
      409,
      `Insufficient stock across batches. Short by ${formatQuantity(remaining)}.`,
      undefined,
      "INSUFFICIENT_STOCK",
    );
  }

  return allocations;
};

/**
 * Refuses a lot movement whose rollup disagrees with the arithmetic.
 *
 * 500, not 409: a mismatch is never something the caller did wrong and never
 * something they can correct by retrying with different input. It means the
 * lots and the stock row have diverged inside this transaction, and the only
 * safe response is to abort and be loud about it.
 */
const assertRollupMatches = (
  variantId: string,
  rolledUp: Pick<LockedInventoryRow, "damagedQtyMilli" | "onHandQtyMilli" | "reservedQtyMilli"> | undefined,
  expected: LockedInventoryRow,
): void => {
  if (!rolledUp) {
    throw new AppError(500, "Inventory update failed");
  }

  const mismatch =
    rolledUp.onHandQtyMilli !== expected.onHandQtyMilli ||
    rolledUp.reservedQtyMilli !== expected.reservedQtyMilli ||
    rolledUp.damagedQtyMilli !== expected.damagedQtyMilli;

  if (mismatch) {
    throw new AppError(
      500,
      `Batch totals do not reconcile for variant ${variantId}. ` +
        `Lots give on-hand ${formatQuantity(rolledUp.onHandQtyMilli)}, reserved ${formatQuantity(rolledUp.reservedQtyMilli)}, damaged ${formatQuantity(rolledUp.damagedQtyMilli)}; ` +
        `the movement expected ${formatQuantity(expected.onHandQtyMilli)}, ${formatQuantity(expected.reservedQtyMilli)}, ${formatQuantity(expected.damagedQtyMilli)}. ` +
        `No stock was changed.`,
      undefined,
      "LOT_ROLLUP_MISMATCH",
    );
  }
};

const singleLot = (allocations: Allocation[]): string | null =>
  allocations.length === 1 ? allocations[0]!.lotId : null;

export const adjustStockInTransaction = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  input: AdjustStockInput,
) => {
  const duplicate = await tx.execute<{ id: number }>(
    sql`
      select id
      from webhook_events
      where provider = ${INTERNAL_IDEMPOTENCY_PROVIDER}
        and external_event_id = ${input.idempotencyKey}
      for update
    `,
  );

  if (duplicate.rows.length > 0) {
    return {
      duplicate: true,
    };
  }

  const lockedInventory = await lockVariantAndInventory(tx, input.variantId);
  const currentAvailableQtyMilli = computeAvailableQtyMilli(lockedInventory);
  const nextInventory = applyInventoryChange(lockedInventory, input);
  const nextAvailableQtyMilli = computeAvailableQtyMilli(nextInventory);

  ensureNonNegativeFields(nextInventory, input);

  if (nextAvailableQtyMilli < 0 && !input.negativeOverride) {
    throw new AppError(
      409,
      `Insufficient stock for ${input.eventType}. Available quantity is ${currentAvailableQtyMilli}.`,
      undefined,
      "INSUFFICIENT_STOCK",
    );
  }

  // T31 — THE FORK. A batch-tracked item's stock lives in inventory_lots, and
  // inventory_stock is rebuilt FROM those lots in this same transaction: the
  // rollup is an invariant, not a cache, and nothing outside this transaction
  // may observe the two disagreeing.
  //
  // Before this existed, a sale rung at this till decremented inventory_stock,
  // wrote a stock_events row with a NULL lot_id, and never touched the lots —
  // so FEFO was bypassed at the one place it operates, expired stock sold, and
  // the rollup drifted on every sale.
  const lotId =
    lockedInventory.trackingMode === "batch"
      ? await applyLotMovement(tx, tenantId, input)
      : null;

  // T32 — the serial fork, alongside the batch one. Mutually exclusive by
  // construction: tracking_mode holds one value.
  const serialId =
    lockedInventory.trackingMode === "serial"
      ? await applySerialMovement(tx, tenantId, input)
      : null;

  let updatedRows;
  if (lockedInventory.trackingMode === "serial") {
    // A COUNT, not a sum: one row is one unit.
    await rebuildSerialRollup(tx, input.variantId);
    updatedRows = await tx
      .select()
      .from(inventoryStock)
      .where(eq(inventoryStock.variantId, input.variantId));
    assertRollupMatches(input.variantId, updatedRows[0], nextInventory);
  } else if (lockedInventory.trackingMode === "batch") {
    await rebuildRollup(tx, input.variantId);
    updatedRows = await tx
      .select()
      .from(inventoryStock)
      .where(eq(inventoryStock.variantId, input.variantId));

    // The rollup agrees with the lots BY CONSTRUCTION after a rebuild, so the
    // hourly reconciliation job can never see a discrepancy this path created
    // — the rebuild destroys its own evidence. The invariant is therefore
    // checked HERE, against what the untracked path would have written.
    assertRollupMatches(input.variantId, updatedRows[0], nextInventory);
  } else {
    updatedRows = await tx
      .update(inventoryStock)
      .set({
        damagedQtyMilli: nextInventory.damagedQtyMilli,
        onHandQtyMilli: nextInventory.onHandQtyMilli,
        reservedQtyMilli: nextInventory.reservedQtyMilli,
        updatedAt: new Date(),
      })
      .where(eq(inventoryStock.variantId, input.variantId))
      .returning();
  }

  await tx.insert(stockEvents).values({
    tenantId,
    eventType: input.eventType,
    qtyDeltaMilli:
      input.eventType === "ADJUSTMENT"
        ? input.qtyDeltaMilli
        : input.eventType === "RELEASE" ||
            input.eventType === "SALE" ||
            input.eventType === "DAMAGE"
          ? -absMilli(input.qtyDeltaMilli)
          : absMilli(input.qtyDeltaMilli),
    lotId,
    reason: input.reason,
    serialId,
    variantId: input.variantId,
  });

  await tx.insert(webhookEvents).values({
    externalEventId: input.idempotencyKey,
    provider: INTERNAL_IDEMPOTENCY_PROVIDER,
  });

  const updatedInventory = updatedRows[0];

  if (!updatedInventory) {
    throw new AppError(500, "Inventory update failed");
  }

  return {
    currentAvailableQtyMilli,
    duplicate: false,
    inventory: {
      ...updatedInventory,
      availableQtyMilli: computeAvailableQtyMilli(updatedInventory),
    },
    stockEventRecorded: true,
  };
};

export const getInventoryByVariantId = async (tenantId: string, variantId: string) => {
  const rows = await db
    .select({
      damagedQtyMilli: inventoryStock.damagedQtyMilli,
      id: inventoryStock.id,
      onHandQtyMilli: inventoryStock.onHandQtyMilli,
      reservedQtyMilli: inventoryStock.reservedQtyMilli,
      variantId: inventoryStock.variantId,
    })
    .from(inventoryStock)
    .innerJoin(productVariants, eq(productVariants.id, inventoryStock.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
    .innerJoin(categories, eq(categories.id, productTypes.categoryId))
    .where(and(eq(inventoryStock.variantId, variantId), eq(categories.tenantId, tenantId)))
    .limit(1);

  if (!rows[0]) {
    throw new AppError(404, "Inventory row not found");
  }

  return {
    ...rows[0],
    availableQtyMilli: computeAvailableQtyMilli(rows[0]),
  };
};

export const adjustStock = async (tenantId: string, input: AdjustStockInput & ActorInput) =>
  db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(productTypes, eq(productTypes.id, products.productTypeId))
      .innerJoin(categories, eq(categories.id, productTypes.categoryId))
      .where(and(eq(productVariants.id, input.variantId), eq(categories.tenantId, tenantId)))
      .limit(1);

    if (!owned[0]) {
      throw new AppError(404, "Variant not found");
    }

    const result = await adjustStockInTransaction(tx, tenantId, {
      ...input,
      idempotencyKey: scopeIdempotencyKey(tenantId, input.idempotencyKey),
    });

    if (!result.duplicate) {
      await logAudit(
        {
          action: "inventory.adjust",
          entityId: input.variantId,
          entityType: "inventory_stock",
          tenantId,
          metadata: {
            eventType: input.eventType,
            idempotencyKey: input.idempotencyKey,
            negativeOverride: input.negativeOverride ?? false,
            qtyDeltaMilli: input.qtyDeltaMilli.toString(),
            reason: input.reason,
          },
          userId: input.actorUserId,
        },
        tx,
      );
    }

    return result;
  });

export const countStockEventsForVariant = async (variantId: string) => {
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(stockEvents)
    .where(eq(stockEvents.variantId, variantId));

  return rows[0]?.count ?? 0;
};

export const getLatestStockEventReason = async (variantId: string) => {
  const rows = await db
    .select({
      reason: stockEvents.reason,
    })
    .from(stockEvents)
    .where(eq(stockEvents.variantId, variantId))
    .orderBy(sql`${stockEvents.id} desc`)
    .limit(1);

  return rows[0]?.reason ?? null;
};

export const getStagnantStock = async (tenantId: string, thresholdDays = 90) => {
  const result = await db.execute<{
    variantId: string;
    productName: string;
    sku: string;
    retailPrice: string;
    costPrice: string;
    onHandQty: string;
    daysSinceLastSale: number | null;
  }>(sql`
    SELECT
      pv.id as "variantId",
      p.name as "productName",
      pv.sku as "sku",
      pv.retail_price as "retailPrice",
      pv.cost_price as "costPrice",
      -- Reported to a human, so out of milli here.
      (i.on_hand_qty_milli / 1000.0) as "onHandQty",
      EXTRACT(DAY FROM CURRENT_TIMESTAMP - COALESCE(MAX(so.created_at), pv.created_at)) as "daysSinceLastSale"
    FROM inventory_stock i
    INNER JOIN product_variants pv ON i.variant_id = pv.id
    INNER JOIN products p ON pv.product_id = p.id
    INNER JOIN product_types pt ON pt.id = p.product_type_id
    INNER JOIN categories c ON c.id = pt.category_id
    LEFT JOIN sales_order_items soi ON soi.variant_id = pv.id
    LEFT JOIN sales_orders so ON soi.order_id = so.id
    WHERE i.on_hand_qty_milli > 0 AND c.tenant_id = ${tenantId}
    GROUP BY pv.id, p.name, pv.sku, pv.retail_price, pv.cost_price, i.on_hand_qty_milli, pv.created_at
    HAVING (MAX(so.created_at) IS NULL AND pv.created_at < CURRENT_TIMESTAMP - INTERVAL '1 day' * ${thresholdDays})
       OR (MAX(so.created_at) < CURRENT_TIMESTAMP - INTERVAL '1 day' * ${thresholdDays})
    ORDER BY "daysSinceLastSale" DESC
  `);

  return result.rows;
};
