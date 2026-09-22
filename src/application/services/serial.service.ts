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
// T32 / PROPOSAL 03 — SERIAL TRACKING.
//
// A lot holds a QUANTITY; a serial IS one unit. Everything that differs from
// lot.service.ts follows from that sentence:
//
//   allocation      picks ROWS, not amounts — three laptops is three rows
//   the rollup      is a COUNT, not a sum
//   a reservation   holds a specific serial, on the serial row itself
//   quantity        is always whole; there is no fractional laptop
//
// SHARED FILE. This is written into pos-terminal by scripts/sync-shared.ts
// and compared byte-for-byte by its parity test. The till and the back office
// must decide which unit leaves the shop identically, or the two disagree
// about what a customer was handed.
import { and, asc, eq, sql } from "drizzle-orm";

import { AppError } from "../../api/errors.js";
import { db } from "../../infrastructure/database/db.js";
import { inventorySerials } from "../../infrastructure/database/schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const SERIAL_STATUSES = ["in_stock", "reserved", "sold", "returned", "damaged"] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];

export type SerialRow = {
  id: string;
  reservationRef: string | null;
  serialNumber: string;
  status: string;
};

/** A whole number of units, from a milli quantity. Refuses a fraction. */
export const serialCountFromMilli = (qtyMilli: bigint): number => {
  if (qtyMilli % 1000n !== 0n) {
    throw new AppError(
      422,
      "A serialised item is counted in whole units — half a unit is not a quantity.",
      undefined,
      "FRACTIONAL_NOT_ALLOWED",
    );
  }
  const count = qtyMilli / 1000n;
  if (count <= 0n) {
    throw new AppError(422, "Quantity must be more than zero.", undefined, "INVALID_QUANTITY");
  }
  return Number(count);
};

/**
 * Locks this variant's serials in ALLOCATION ORDER and returns them.
 *
 * FIFO by receipt, not FEFO: a serial has no expiry, so the ordering that
 * matters is "clear older stock first". A warranty period that started
 * earlier should also leave the shop earlier, which falls out of the same
 * order.
 *
 * FOR UPDATE, ordered inside the query, for the same reason lot.service.ts
 * does it: two concurrent sales of one variant must take the row locks in the
 * same sequence or they deadlock.
 */
export const lockSerialsForVariant = async (tx: Tx, variantId: string): Promise<SerialRow[]> => {
  const locked = await tx.execute<{
    id: string;
    reservation_ref: string | null;
    serial_number: string;
    status: string;
  }>(
    sql`
      select id, serial_number, status, reservation_ref
      from inventory_serials
      where variant_id = ${variantId}
      order by created_at asc, id asc
      for update
    `,
  );

  return locked.rows.map((row) => ({
    id: row.id,
    reservationRef: row.reservation_ref,
    serialNumber: row.serial_number,
    status: row.status,
  }));
};

/**
 * Picks `count` units to issue, oldest first.
 *
 * Only 'in_stock' units are eligible. A 'reserved' one is promised to someone
 * else, and taking it would make a reservation mean nothing.
 */
export const allocateSerials = (serials: SerialRow[], count: number): SerialRow[] => {
  const available = serials.filter((serial) => serial.status === "in_stock");

  if (available.length < count) {
    throw new AppError(
      409,
      `Not enough units in stock. ${available.length} available, ${count} needed.`,
      undefined,
      "INSUFFICIENT_STOCK",
    );
  }

  return available.slice(0, count);
};

/** The serials a reservation is holding, so a sale can honour exactly those. */
export const reservedSerials = (serials: SerialRow[], reservationRef: string): SerialRow[] =>
  serials.filter((serial) => serial.status === "reserved" && serial.reservationRef === reservationRef);

/**
 * Rewrites inventory_stock from the serials. THE rollup.
 *
 * A COUNT, not a sum — one row is one unit. Written in the same transaction
 * as the serial write, so nothing outside it can observe the two disagreeing.
 *
 * damaged_qty_milli counts write-offs, and reserved_qty_milli counts promises,
 * mirroring exactly what the columns mean for an untracked item. on_hand
 * includes reserved and damaged units for the same reason a lot's on-hand
 * does: they are still physically in the shop.
 */
export const rebuildSerialRollup = async (tx: Tx, variantId: string): Promise<void> => {
  await tx.execute(sql`
    update inventory_stock
    set
      on_hand_qty_milli = agg.on_hand,
      reserved_qty_milli = agg.reserved,
      damaged_qty_milli = agg.damaged,
      updated_at = now()
    from (
      select
        (count(*) filter (where status in ('in_stock','reserved','damaged')) * 1000)::bigint as on_hand,
        (count(*) filter (where status = 'reserved') * 1000)::bigint as reserved,
        (count(*) filter (where status = 'damaged') * 1000)::bigint as damaged
      from inventory_serials
      where variant_id = ${variantId}
    ) as agg
    where inventory_stock.variant_id = ${variantId}
  `);
};

export type SerialInput = {
  imei?: string | null;
  serialNumber: string;
  warrantyMonths?: number | null;
};

/**
 * Takes serials into stock.
 *
 * Refuses a duplicate within the tenant with a message naming the number,
 * rather than letting the unique index raise. A shop receiving fifty phones
 * needs to know WHICH one it has already recorded.
 */
export const receiveSerials = async (
  tx: Tx,
  tenantId: string,
  variantId: string,
  serials: SerialInput[],
): Promise<string[]> => {
  const ids: string[] = [];

  for (const serial of serials) {
    const serialNumber = serial.serialNumber.trim().toUpperCase();

    const existing = await tx
      .select({ id: inventorySerials.id, status: inventorySerials.status })
      .from(inventorySerials)
      .where(
        and(
          eq(inventorySerials.tenantId, tenantId),
          eq(inventorySerials.serialNumber, serialNumber),
        ),
      );

    if (existing[0]) {
      throw new AppError(
        409,
        `Serial ${serialNumber} is already recorded in this shop (${existing[0].status}).`,
        undefined,
        "SERIAL_ALREADY_EXISTS",
      );
    }

    const id = crypto.randomUUID();
    await tx.insert(inventorySerials).values({
      id,
      imei: serial.imei?.trim() ?? null,
      serialNumber,
      status: "in_stock",
      tenantId,
      variantId,
      warrantyMonths: serial.warrantyMonths ?? null,
    });
    ids.push(id);
  }

  return ids;
};

/** Moves one serial to a new status, carrying the fields that status implies. */
export const setSerialStatus = async (
  tx: Tx,
  serialId: string,
  status: SerialStatus,
  extra: { reservationRef?: string | null; soldOrderItemId?: string | null } = {},
): Promise<void> => {
  await tx
    .update(inventorySerials)
    .set({
      // Both CHECK constraints in 0052 are two-way: a sold serial MUST name
      // its order line and a non-sold one must NOT, and the same for a
      // reservation. So these are cleared explicitly rather than left, or the
      // database refuses the write.
      reservationRef: status === "reserved" ? (extra.reservationRef ?? null) : null,
      soldAt: status === "sold" ? new Date() : null,
      soldOrderItemId: status === "sold" ? (extra.soldOrderItemId ?? null) : null,
      status,
      warrantyStart: status === "sold" ? new Date().toISOString().slice(0, 10) : null,
    })
    .where(eq(inventorySerials.id, serialId));
};

/**
 * THE WARRANTY REFUSAL, and the whole commercial argument for this phase.
 *
 * Returns the serial only if THIS shop sold it. A serial that was never sold
 * here — a counterfeit, a grey import, another dealer's unit — has no sale
 * reference, and saying so is what lets a shop decline a claim it does not
 * owe.
 *
 * An implementation that accepts any serial on return has delivered the
 * paperwork and none of the value.
 */
export const findSoldSerial = async (
  tenantId: string,
  serialNumber: string,
): Promise<{ id: string; soldAt: Date | null; variantId: string; warrantyMonths: number | null } | null> => {
  const rows = await db
    .select({
      id: inventorySerials.id,
      soldAt: inventorySerials.soldAt,
      status: inventorySerials.status,
      variantId: inventorySerials.variantId,
      warrantyMonths: inventorySerials.warrantyMonths,
    })
    .from(inventorySerials)
    .where(
      and(
        eq(inventorySerials.tenantId, tenantId),
        eq(inventorySerials.serialNumber, serialNumber.trim().toUpperCase()),
      ),
    );

  const serial = rows[0];
  if (!serial || serial.status !== "sold") return null;

  return {
    id: serial.id,
    soldAt: serial.soldAt,
    variantId: serial.variantId,
    warrantyMonths: serial.warrantyMonths,
  };
};

/** Today as YYYY-MM-DD, for comparing against a stored date column. */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Adds whole months to a YYYY-MM-DD date, clamping the day.
 *
 * 31 January plus one month is 28 February, not 3 March. Date's own setMonth
 * rolls over instead, which is how a warranty quietly gains days.
 */
const addMonths = (isoDate: string, months: number): string => {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTarget);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/**
 * The warranty desk's question, answered in the three states it actually has.
 *
 * findSoldSerial above returns null for BOTH "we never sold this" and "we sold
 * it but the warranty has run out", because it exists to gate a RETURN, where
 * those two collapse correctly — neither is returnable against a sale we can
 * point at.
 *
 * A person at a counter needs them apart. "Not ours" and "ours, expired" are
 * different conversations with a customer, and telling someone their genuine
 * unit was never sold here is worse than telling them nothing.
 *
 * WARRANTY EXPIRY IS COMPUTED HERE, not handed to a screen as two fields to
 * subtract. warranty_start is stamped at the moment of sale and warranty_months
 * is per unit; a caller doing that arithmetic itself would get month-length
 * wrong the first time it met the 31st.
 */
export type SerialWarrantyLookup =
  | { status: "not_sold_here" }
  | {
      expiresOn: string | null;
      id: string;
      imei: string | null;
      serialNumber: string;
      soldAt: Date | null;
      status: "sold_here";
      variantId: string;
      warrantyExpired: boolean | null;
      warrantyMonths: number | null;
      warrantyStart: string | null;
    };

export const lookupSerialWarranty = async (
  tenantId: string,
  serialNumber: string,
): Promise<SerialWarrantyLookup> => {
  const rows = await db
    .select({
      id: inventorySerials.id,
      imei: inventorySerials.imei,
      serialNumber: inventorySerials.serialNumber,
      soldAt: inventorySerials.soldAt,
      status: inventorySerials.status,
      variantId: inventorySerials.variantId,
      warrantyMonths: inventorySerials.warrantyMonths,
      warrantyStart: inventorySerials.warrantyStart,
    })
    .from(inventorySerials)
    .where(
      and(
        eq(inventorySerials.tenantId, tenantId),
        eq(inventorySerials.serialNumber, serialNumber.trim().toUpperCase()),
      ),
    );

  const serial = rows[0];

  // A unit still IN STOCK is deliberately "not sold here" too. It has not left
  // the shop, so a customer holding one did not get it from this counter — and
  // saying "yes, that is ours" about a unit sitting on the shelf would be a
  // different and worse mistake.
  if (!serial || serial.status !== "sold") return { status: "not_sold_here" };

  // No months recorded means no warranty was promised, which is not the same
  // as an expired one — hence null rather than true.
  const expiresOn =
    serial.warrantyStart && serial.warrantyMonths != null
      ? addMonths(serial.warrantyStart, serial.warrantyMonths)
      : null;

  return {
    expiresOn,
    id: serial.id,
    imei: serial.imei,
    serialNumber: serial.serialNumber,
    soldAt: serial.soldAt,
    status: "sold_here",
    variantId: serial.variantId,
    warrantyExpired: expiresOn === null ? null : expiresOn < todayIso(),
    warrantyMonths: serial.warrantyMonths,
    warrantyStart: serial.warrantyStart,
  };
};

export const listSerialsForVariant = async (tenantId: string, variantId: string) =>
  db
    .select({
      id: inventorySerials.id,
      imei: inventorySerials.imei,
      serialNumber: inventorySerials.serialNumber,
      soldAt: inventorySerials.soldAt,
      status: inventorySerials.status,
      warrantyMonths: inventorySerials.warrantyMonths,
      warrantyStart: inventorySerials.warrantyStart,
    })
    .from(inventorySerials)
    .where(
      and(eq(inventorySerials.tenantId, tenantId), eq(inventorySerials.variantId, variantId)),
    )
    .orderBy(asc(inventorySerials.createdAt));
