import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { getActiveCashierForAttribution } from "./cashier.service.js";
import { formatPaise, moneyStringToPaise } from "./order.service.js";
import { AppError } from "../../api/errors.js";
import { loadEnvSync } from "../../env-sync.js";
import { db } from "../../infrastructure/database/db.js";
import { posShifts } from "../../infrastructure/database/schema.js";

type ShiftRow = {
  closedAt: Date | null;
  closedByCashierId: string | null;
  countedCash: string | null;
  expectedCash: string | null;
  id: string;
  note: string | null;
  openedAt: Date;
  openedByCashierId: string | null;
  openingFloat: string;
  status: "open" | "closed";
  terminalId: string;
  variance: string | null;
};

type TenderTotals = {
  card: string;
  cash: string;
  UPI: string;
};

type ShiftReport = {
  businessDate: string;
  discounts: number;
  gross: number;
  orderCount: number;
  refunds: number;
  shift: Omit<ShiftRow, "expectedCash" | "variance"> & {
    expectedCash?: string | null;
    variance?: string | null;
  };
  tax: number;
  tenders: TenderTotals;
};

const getLocalDate = (date: Date): string => {
  const timeZone = loadEnvSync().SHOP_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const getPart = (type: string) => parts.find((part) => part.type === type)?.value;

  return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
};

const getOpenShiftForTerminal = async (
  terminalId: string,
  executor: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): Promise<ShiftRow | undefined> => {
  const [shift] = await executor
    .select()
    .from(posShifts)
    .where(sql`${posShifts.terminalId} = ${terminalId} and ${posShifts.status} = 'open'`)
    .limit(1);

  return shift as ShiftRow | undefined;
};

const getShiftById = async (shiftId: string): Promise<ShiftRow> => {
  const [shift] = await db.select().from(posShifts).where(eq(posShifts.id, shiftId)).limit(1);

  if (!shift) {
    throw new AppError(404, "Shift not found");
  }

  return shift as ShiftRow;
};

const moneyNumber = (value: string | number | null | undefined): number => Number(value ?? 0);

const buildReport = async (shift: ShiftRow, options?: { includeExpectedCash?: boolean }) => {
  const [summary] = await db.execute<{
    discounts: string;
    gross: string;
    orderCount: number;
    refunds: string;
    tax: string;
  }>(sql`
    select
      count(*)::int as "orderCount",
      coalesce(sum(coalesce(subtotal_amount, 0) + coalesce(tax_amount, 0)), 0)::text as gross,
      coalesce(sum(coalesce(tax_amount, 0)), 0)::text as tax,
      coalesce(sum(coalesce(discount_value, 0)), 0)::text as discounts,
      coalesce(sum(case when order_status = 'Returned' then coalesce(subtotal_amount, 0) + coalesce(tax_amount, 0) else 0 end), 0)::text as refunds
    from sales_orders
    where shift_id = ${shift.id}
  `).then((result) => result.rows);

  const tenderRows = await db.execute<{
    method: "cash" | "UPI" | "card";
    total: string;
  }>(sql`
    select pt.method, coalesce(sum(pt.amount), 0)::text as total
    from payment_tenders pt
    inner join sales_orders so on so.id = pt.order_id
    where so.shift_id = ${shift.id}
    group by pt.method
  `);
  const tenders = tenderRows.rows.reduce<TenderTotals>(
    (totals, row) => ({ ...totals, [row.method]: row.total }),
    { card: "0.00", cash: "0.00", UPI: "0.00" },
  );

  const reportShift = {
    closedAt: shift.closedAt,
    closedByCashierId: shift.closedByCashierId,
    countedCash: shift.countedCash,
    id: shift.id,
    note: shift.note,
    openedAt: shift.openedAt,
    openedByCashierId: shift.openedByCashierId,
    openingFloat: shift.openingFloat,
    status: shift.status,
    terminalId: shift.terminalId,
    ...(options?.includeExpectedCash
      ? { expectedCash: shift.expectedCash, variance: shift.variance }
      : {}),
  };

  return {
    businessDate: getLocalDate(shift.openedAt),
    discounts: moneyNumber(summary?.discounts),
    gross: moneyNumber(summary?.gross),
    orderCount: summary?.orderCount ?? 0,
    refunds: moneyNumber(summary?.refunds),
    shift: reportShift,
    tax: moneyNumber(summary?.tax),
    tenders,
  } satisfies ShiftReport;
};

const calculateExpectedCash = async (shift: ShiftRow): Promise<string> => {
  const [row] = await db.execute<{ cashSales: string; cashRefunds: string }>(sql`
    select
      coalesce(sum(case when so.order_status <> 'Returned' and pt.method = 'cash' then pt.amount else 0 end), 0)::text as "cashSales",
      coalesce(sum(case when so.order_status = 'Returned' and pt.method = 'cash' then pt.amount else 0 end), 0)::text as "cashRefunds"
    from payment_tenders pt
    inner join sales_orders so on so.id = pt.order_id
    where so.shift_id = ${shift.id}
  `).then((result) => result.rows);

  return formatPaise(
    moneyStringToPaise(shift.openingFloat, { allowZero: true }) +
      moneyStringToPaise(row?.cashSales ?? "0.00", { allowZero: true }) -
      moneyStringToPaise(row?.cashRefunds ?? "0.00", { allowZero: true }),
  );
};

export const openShift = async (
  tenantId: string,
  input: {
    cashierId?: string;
    openingFloat: string;
    terminalId: string;
  },
) =>
  db.transaction(async (tx) => {
    const existing = await getOpenShiftForTerminal(input.terminalId, tx);

    if (existing) {
      throw new AppError(409, "A shift is already open for this terminal");
    }

    const cashier = input.cashierId
      ? await getActiveCashierForAttribution(input.cashierId, tx)
      : undefined;
    const [shift] = await tx
      .insert(posShifts)
      .values({
        id: randomUUID(),
        openingFloat: formatPaise(moneyStringToPaise(input.openingFloat, { allowZero: true })),
        openedByCashierId: cashier?.id ?? null,
        tenantId,
        terminalId: input.terminalId,
      })
      .returning();

    return shift as ShiftRow;
  });

export const getCurrentShift = async (terminalId: string) => {
  const shift = await getOpenShiftForTerminal(terminalId);

  if (!shift) {
    return null;
  }

  return buildReport(shift, { includeExpectedCash: false });
};

export const closeShift = async (input: {
  cashierId?: string;
  countedCash: string;
  note?: string;
  terminalId: string;
}) => {
  const shift = await getOpenShiftForTerminal(input.terminalId);

  if (!shift) {
    throw new AppError(404, "No open shift for this terminal");
  }

  const cashier = input.cashierId
    ? await getActiveCashierForAttribution(input.cashierId)
    : undefined;
  const countedCash = formatPaise(moneyStringToPaise(input.countedCash, { allowZero: true }));
  const expectedCash = await calculateExpectedCash(shift);
  const variance = formatPaise(
    moneyStringToPaise(countedCash, { allowZero: true }) -
      moneyStringToPaise(expectedCash, { allowZero: true }),
  );
  const [closedShift] = await db
    .update(posShifts)
    .set({
      closedAt: new Date(),
      closedByCashierId: cashier?.id ?? null,
      countedCash,
      expectedCash,
      note: input.note ?? null,
      status: "closed",
      variance,
    })
    .where(eq(posShifts.id, shift.id))
    .returning();

  return buildReport(closedShift as ShiftRow, { includeExpectedCash: true });
};

export const getShiftReport = async (shiftId: string) => {
  const shift = await getShiftById(shiftId);
  return buildReport(shift, { includeExpectedCash: shift.status === "closed" });
};
