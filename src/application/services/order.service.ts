import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { logAudit } from "./audit-log.service.js";
import { getSellerStateCode, getTaxRatePercent } from "./business-settings.service.js";
import { getActiveCashierForAttribution } from "./cashier.service.js";
import { createCreditNoteForReturn } from "./credit-note.service.js";
import {
  INTERNAL_IDEMPOTENCY_PROVIDER,
  adjustStockInTransaction,
} from "./inventory.service.js";
import {
  assertLineTaxConsistency,
  computeLineTaxSplit,
  deriveGstTreatment,
  resolvePlaceOfSupplyStateCode,
  stateNameToGstCode,
} from "./tax.service.js";
import { AppError } from "../../api/errors.js";
import { loadEnvSync } from "../../env-sync.js";
import { createEmailPort, createPaymentPort } from "../../infrastructure/adapters/integration-factories.js";
import { db } from "../../infrastructure/database/db.js";
import {
  customers,
  invoiceCounters,
  paymentTenders,
  posShifts,
  products,
  productVariants,
  salesOrderItems,
  salesOrders,
  webhookEvents,
} from "../../infrastructure/database/schema.js";
import { formatQuantity, lineTotalPaise, quantityToMilli, roundHalfUp } from "../../utils/quantity.js";
import type { ReceiptEmailData } from "../ports/email.port.js";
import type { StandardizedIntegrationError } from "../ports/errors.js";

type OrderStatus =
  | "Draft"
  | "Pending"
  | "Paid"
  | "Packed"
  | "Shipped"
  | "Delivered"
  | "Completed"
  | "Cancelled"
  | "Returned"
  | "Refunded";

type CreateOrderInput = {
  actorUserId?: string;
  cashierId?: string;
  // T15 — nullable/optional: a POS walk-in genuinely has no customer.
  customerId?: string;
  discountType?: "percent" | "flat";
  discountValue?: number;
  idempotencyKey: string;
  items: Array<{
    discountType?: "percent" | "flat";
    discountValue?: number;
    quantity: number;
    variantId: string;
  }>;
  paymentPreference?: "cash" | "UPI";
  terminalId?: string;
};

type ConfirmOrderInput = {
  cashierId?: string;
  idempotencyKey: string;
  shippingAddressLine1?: string;
  shippingCity?: string;
  shippingPostalCode?: string;
  shippingState?: string;
};

type PayOrderInput = {
  cashierId?: string;
  idempotencyKey: string;
  razorpayPaymentId?: string;
  tenders?: TenderLine[];
};

type TenderLine = {
  amount: string;
  cardApprovalCode?: string;
  cardLast4?: string;
  method: "cash" | "UPI" | "card";
  razorpayPaymentId?: string;
};

type TransitionInput = {
  cashierId?: string;
  idempotencyKey: string;
};

type OrderIntegrationInput = {
  idempotencyKey: string;
};

type ReturnOrderInput = {
  cashierId?: string;
  idempotencyKey: string;
  items: Array<{
    restockable: boolean;
    variantId: string;
  }>;
  // T16b — which credit_note_reason to record; defaults to "return" so
  // existing callers need no change.
  reason?: "return" | "damage" | "price_adjustment" | "cancellation";
};

type ActorInput = {
  actorUserId: string;
};

type OrderListFilters = {
  customerId?: string;
  limit: number;
  offset: number;
  status?: OrderStatus;
};

type OrderRow = {
  cashierId: string | null;
  createdAt: Date;
  // T15
  customerId?: string | null;
  gstTreatment?: "b2b" | "b2cl" | "b2cs" | "export" | "exempt" | null;
  discountType: "percent" | "flat" | null;
  discountValue: number | string | null;
  id: string;
  idempotencyKey: string;
  invoiceNumber: string | null;
  invoicedAt: Date | null;
  orderStatus: OrderStatus;
  paymentPreference: "cash" | "UPI" | null;
  qrGeneratedAt: Date | null;
  qrStatus: "pending" | "generated" | "paid" | "voided" | "expired" | null;
  qrVoidedAt: Date | null;
  razorpayPaymentId: string | null;
  shipmentStatus: string | null;
  shippingAddressLine1: string | null;
  shippingCity: string | null;
  shippingPostalCode: string | null;
  shippingState: string | null;
  shiftId: string | null;
  subtotalAmount: string | null;
  taxAmount: string | null;
  taxRatePercent: string | null;
  tenantId?: string;
  terminalId: string | null;
  trackingNumber: string | null;
};

type OrderItemRow = {
  discountType: "percent" | "flat" | null;
  discountValue: number | string | null;
  id: string;
  name?: string;
  orderId: string;
  quantityMilli: bigint;
  sku: string;
  unitPrice: number | string;
  variantId: string;
  // T15 — snapshotted at confirmation, not joined; null until then.
  hsnCode?: string | null;
  productHsnCode?: string | null;
  taxRatePercent?: string | number | null;
  taxableValue?: string | number | null;
  cgstAmount?: string | number | null;
  sgstAmount?: string | number | null;
  igstAmount?: string | number | null;
};

type PaymentTenderRow = {
  amount: string;
  cardApprovalCode: string | null;
  cardLast4: string | null;
  createdAt: Date;
  id: string;
  method: "cash" | "UPI" | "card";
  orderId: string;
  razorpayPaymentId: string | null;
};

const buildOrderResponse = (
  order: OrderRow,
  items: OrderItemRow[],
  tenders: PaymentTenderRow[] = [],
) => ({
  ...order,
  discountValue: order.discountValue === null ? null : Number(order.discountValue),
  subtotalAmount: order.subtotalAmount === null ? null : Number(order.subtotalAmount),
  taxAmount: order.taxAmount === null ? null : Number(order.taxAmount),
  taxRatePercent: order.taxRatePercent === null ? null : Number(order.taxRatePercent),
  items: items
    .filter((item) => item.orderId === order.id)
    .map((item) => ({
      ...item,
      discountValue: item.discountValue === null ? null : Number(item.discountValue),
      unitPrice: Number(item.unitPrice),
      taxRatePercent: item.taxRatePercent === null || item.taxRatePercent === undefined ? null : Number(item.taxRatePercent),
      taxableValue: item.taxableValue === null || item.taxableValue === undefined ? null : Number(item.taxableValue),
      cgstAmount: item.cgstAmount === null || item.cgstAmount === undefined ? 0 : Number(item.cgstAmount),
      sgstAmount: item.sgstAmount === null || item.sgstAmount === undefined ? 0 : Number(item.sgstAmount),
      igstAmount: item.igstAmount === null || item.igstAmount === undefined ? 0 : Number(item.igstAmount),
    })),
  tenders: tenders
    .filter((tender) => tender.orderId === order.id)
    .map((tender) => ({
      ...tender,
      amount: Number(tender.amount),
    })),
  total:
    order.subtotalAmount !== null && order.taxAmount !== null
      ? Number(order.subtotalAmount) + Number(order.taxAmount)
      : calculateOrderTotalAmount(order, items),
});

type DiscountedAmountInput = {
  amount: number;
  discountType?: "flat" | "percent" | null;
  discountValue?: number | string | null;
};

const normalizeDiscountValue = (value: number | string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

export const calculateDiscountedAmount = ({
  amount,
  discountType,
  discountValue,
}: DiscountedAmountInput): number => {
  const normalizedAmount = Math.max(amount, 0);

  if (!discountType) {
    return normalizedAmount;
  }

  const normalizedDiscountValue = normalizeDiscountValue(discountValue);

  if (discountType === "percent") {
    return Math.max(normalizedAmount * (1 - normalizedDiscountValue / 100), 0);
  }

  return Math.max(normalizedAmount - normalizedDiscountValue, 0);
};

/**
 * A line's total, in integer paise.
 *
 * T30 — MUST match ims-1's calculateLineItemTotalPaise exactly. The till and
 * the back office price the same sale; rounding it two slightly different
 * ways is how a shop gets an invoice that disagrees with its own books.
 *
 * The old form was `Number(item.unitPrice) * item.quantityMilli` in rupees as a
 * float, which broke twice once quantity became milli-denominated: 95 x 1500
 * is Rs 142,500 where the answer is Rs 142.50, and Rs 95/kg x 0.333 kg is
 * Rs 31.635 — sub-paise, reachable for the first time.
 *
 * Rounded ONCE, here, at the line. Never again at the total.
 */
export const calculateLineItemTotalPaise = (
  item: Pick<OrderItemRow, "discountType" | "discountValue" | "quantityMilli" | "unitPrice">,
): bigint => {
  const unitPricePaise = signedMoneyToPaise(item.unitPrice);
  const grossPaise = lineTotalPaise(unitPricePaise, item.quantityMilli);
  return applyDiscountPaise(grossPaise, item.discountType, item.discountValue);
};

/** Discount in integer paise. Mirrors ims-1 exactly — see above. */
export const applyDiscountPaise = (
  amountPaise: bigint,
  discountType: "percent" | "flat" | null | undefined,
  discountValue: number | string | null | undefined,
): bigint => {
  const base = amountPaise < 0n ? 0n : amountPaise;
  if (!discountType) return base;

  const normalized = normalizeDiscountValue(discountValue);

  if (discountType === "percent") {
    const pctHundredths = BigInt(Math.round(normalized * 100));
    const result = roundHalfUp(base * (10000n - pctHundredths), 10000n);
    return result < 0n ? 0n : result;
  }

  const flatPaise = signedMoneyToPaise(normalized.toFixed(2));
  const result = base - flatPaise;
  return result < 0n ? 0n : result;
};

export const calculateEffectiveDiscountPercent = (subtotal: number, discountedTotal: number): number => {
  if (subtotal <= 0) {
    return 0;
  }

  return ((subtotal - discountedTotal) / subtotal) * 100;
};

/**
 * Parses a decimal money string that may be negative, into paise.
 *
 * T30 — mirrors ims-1's helper of the same name. moneyStringToPaise
 * deliberately refuses negatives and zero (it guards tender amounts); a
 * unit PRICE read back from the database is a different quantity and must
 * accept both.
 */
export const signedMoneyToPaise = (value: string | number | null | undefined): bigint => {
  if (value === null || value === undefined) return 0n;

  const text = typeof value === "number" ? value.toFixed(2) : String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new AppError(500, `Cannot parse "${value}" as a money amount`);
  }

  const [, sign, rupees = "0", paise = ""] = match;
  const magnitude = BigInt(rupees) * 100n + BigInt(paise.padEnd(2, "0"));
  return sign === "-" ? -magnitude : magnitude;
};

export const moneyStringToPaise = (value: string, options?: { allowZero?: boolean }): bigint => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new AppError(422, "Tender amount must be a positive decimal amount");
  }

  const [rupees = "0", paise = ""] = value.split(".");
  const normalizedPaise = paise.padEnd(2, "0");
  const total = BigInt(rupees) * 100n + BigInt(normalizedPaise);

  if (total < 0n || (!options?.allowZero && total === 0n)) {
    throw new AppError(422, "Tender amount must be greater than zero");
  }

  return total;
};

export const formatPaise = (paise: bigint): string => {
  const sign = paise < 0n ? "-" : "";
  const absolute = paise < 0n ? -paise : paise;
  const rupees = absolute / 100n;
  const cents = absolute % 100n;
  return `${sign}${rupees}.${cents.toString().padStart(2, "0")}`;
};

export const orderTotalToPaise = (
  order: Pick<OrderRow, "discountType" | "discountValue" | "subtotalAmount" | "taxAmount">,
  items: OrderItemRow[],
): bigint => {
  if (order.subtotalAmount !== null && order.taxAmount !== null) {
    return (
      moneyStringToPaise(order.subtotalAmount, { allowZero: true }) +
      moneyStringToPaise(order.taxAmount, { allowZero: true })
    );
  }

  return moneyStringToPaise(calculateOrderTotalAmount(order, items).toFixed(2), {
    allowZero: true,
  });
};

const transitionKey = (orderId: string, transition: string, idempotencyKey: string): string =>
  `order:${orderId}:${transition}:${idempotencyKey}`;

const getOrderItems = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  orderId: string,
): Promise<OrderItemRow[]> =>
  tx
    .select({
      id: salesOrderItems.id,
      name: products.name,
      orderId: salesOrderItems.orderId,
      quantityMilli: salesOrderItems.quantityMilli,
      sku: productVariants.sku,
      discountType: salesOrderItems.discountType,
      discountValue: salesOrderItems.discountValue,
      unitPrice: salesOrderItems.unitPrice,
      variantId: salesOrderItems.variantId,
      hsnCode: salesOrderItems.hsnCode,
      productHsnCode: products.hsnCode,
      taxRatePercent: salesOrderItems.taxRatePercent,
      taxableValue: salesOrderItems.taxableValue,
      cgstAmount: salesOrderItems.cgstAmount,
      sgstAmount: salesOrderItems.sgstAmount,
      igstAmount: salesOrderItems.igstAmount,
    })
    .from(salesOrderItems)
    .innerJoin(productVariants, eq(productVariants.id, salesOrderItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(salesOrderItems.orderId, orderId));

const getOrderPaymentTenders = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  orderId: string,
): Promise<PaymentTenderRow[]> =>
  tx
    .select({
      amount: paymentTenders.amount,
      createdAt: paymentTenders.createdAt,
      id: paymentTenders.id,
      cardApprovalCode: paymentTenders.cardApprovalCode,
      cardLast4: paymentTenders.cardLast4,
      method: paymentTenders.method,
      orderId: paymentTenders.orderId,
      razorpayPaymentId: paymentTenders.razorpayPaymentId,
    })
    .from(paymentTenders)
    .where(eq(paymentTenders.orderId, orderId));

const getOrderById = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  tenantId: string,
  orderId: string,
): Promise<OrderRow> => {
  const orderRows = await tx
    .select({
      cashierId: salesOrders.cashierId,
      createdAt: salesOrders.createdAt,
      customerId: salesOrders.customerId,
      gstTreatment: salesOrders.gstTreatment,
      discountType: salesOrders.discountType,
      discountValue: salesOrders.discountValue,
      id: salesOrders.id,
      idempotencyKey: salesOrders.idempotencyKey,
      invoiceNumber: salesOrders.invoiceNumber,
      invoicedAt: salesOrders.invoicedAt,
      orderStatus: salesOrders.orderStatus,
      paymentPreference: salesOrders.paymentPreference,
      qrGeneratedAt: salesOrders.qrGeneratedAt,
      qrStatus: salesOrders.qrStatus,
      qrVoidedAt: salesOrders.qrVoidedAt,
      razorpayPaymentId: salesOrders.razorpayPaymentId,
      shipmentStatus: salesOrders.shipmentStatus,
      shippingAddressLine1: salesOrders.shippingAddressLine1,
      shippingCity: salesOrders.shippingCity,
      shippingPostalCode: salesOrders.shippingPostalCode,
      shippingState: salesOrders.shippingState,
      shiftId: salesOrders.shiftId,
      subtotalAmount: salesOrders.subtotalAmount,
      taxAmount: salesOrders.taxAmount,
      taxRatePercent: salesOrders.taxRatePercent,
      terminalId: salesOrders.terminalId,
      trackingNumber: salesOrders.trackingNumber,
    })
    .from(salesOrders)
    .where(and(eq(salesOrders.id, orderId), eq(salesOrders.tenantId, tenantId)))
    .limit(1);

  const order = orderRows[0];

  if (!order) {
    throw new AppError(404, "Order not found");
  }

  return order as OrderRow;
};

const getOrderDetail = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  tenantId: string,
  orderId: string,
) => {
  const order = await getOrderById(tx, tenantId, orderId);
  const items = await getOrderItems(tx, orderId);
  const tenders = await getOrderPaymentTenders(tx, orderId);
  return buildOrderResponse(order, items, tenders);
};

const getDuplicateTransition = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  orderId: string,
  transition: string,
  idempotencyKey: string,
) =>
  tx.execute<{ id: number }>(
    sql`
      select id
      from webhook_events
      where provider = ${INTERNAL_IDEMPOTENCY_PROVIDER}
        and external_event_id = ${transitionKey(orderId, transition, idempotencyKey)}
      for update
    `,
  );

const assertStatus = (
  currentStatus: OrderStatus,
  allowed: OrderStatus[],
  transition: string,
): void => {
  if (!allowed.includes(currentStatus)) {
    throw new AppError(
      409,
      `Cannot ${transition} order from ${currentStatus} status`,
    );
  }
};

const providerTransitionKey = (
  provider: "razorpay",
  orderId: string,
  transition: string,
  idempotencyKey: string,
): string => `${provider}:${orderId}:${transition}:${idempotencyKey}`;

const ensureShippingAddress = (
  existing: OrderRow,
  incoming: Omit<ConfirmOrderInput, "idempotencyKey">,
) => {
  const shippingAddressLine1 = incoming.shippingAddressLine1 ?? existing.shippingAddressLine1;
  const shippingCity = incoming.shippingCity ?? existing.shippingCity;
  const shippingState = incoming.shippingState ?? existing.shippingState;
  const shippingPostalCode = incoming.shippingPostalCode ?? existing.shippingPostalCode;

  if (!shippingAddressLine1 || !shippingCity || !shippingState || !shippingPostalCode) {
    throw new AppError(
      422,
      "Shipping address line1, city, state, and postal code are required before confirming order",
    );
  }

  return {
    shippingAddressLine1,
    shippingCity,
    shippingPostalCode,
    shippingState,
  };
};

const lockOrderForUpdate = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  orderId: string,
): Promise<OrderRow> => {
  const rows = await tx.execute<OrderRow>(
    sql`
      select
        id,
        idempotency_key as "idempotencyKey",
        customer_id as "customerId",
        gst_treatment as "gstTreatment",
        invoice_number as "invoiceNumber",
        invoiced_at as "invoicedAt",
        payment_preference as "paymentPreference",
        discount_type as "discountType",
        discount_value as "discountValue",
        shipping_address_line1 as "shippingAddressLine1",
        shipping_city as "shippingCity",
        shipping_state as "shippingState",
        shipping_postal_code as "shippingPostalCode",
        subtotal_amount as "subtotalAmount",
        tax_amount as "taxAmount",
        tax_rate_percent as "taxRatePercent",
        razorpay_payment_id as "razorpayPaymentId",
        qr_status as "qrStatus",
        qr_generated_at as "qrGeneratedAt",
        qr_voided_at as "qrVoidedAt",
        order_status as "orderStatus",
        shipment_status as "shipmentStatus",
        shift_id as "shiftId",
        terminal_id as "terminalId",
        cashier_id as "cashierId",
        created_at as "createdAt",
        tracking_number as "trackingNumber"
      from sales_orders
      where id = ${orderId} and tenant_id = ${tenantId}
      for update
    `,
  );

  const order = rows.rows[0] as OrderRow | undefined;

  if (!order) {
    throw new AppError(404, "Order not found");
  }

  return order;
};

const lockOrderByPaymentIdForUpdate = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  paymentId: string,
): Promise<OrderRow> => {
  const rows = await tx.execute<OrderRow>(
    sql`
      select
        id,
        tenant_id as "tenantId",
        idempotency_key as "idempotencyKey",
        invoice_number as "invoiceNumber",
        invoiced_at as "invoicedAt",
        payment_preference as "paymentPreference",
        discount_type as "discountType",
        discount_value as "discountValue",
        shipping_address_line1 as "shippingAddressLine1",
        shipping_city as "shippingCity",
        shipping_state as "shippingState",
        shipping_postal_code as "shippingPostalCode",
        subtotal_amount as "subtotalAmount",
        tax_amount as "taxAmount",
        tax_rate_percent as "taxRatePercent",
        razorpay_payment_id as "razorpayPaymentId",
        qr_status as "qrStatus",
        qr_generated_at as "qrGeneratedAt",
        qr_voided_at as "qrVoidedAt",
        order_status as "orderStatus",
        shipment_status as "shipmentStatus",
        shift_id as "shiftId",
        terminal_id as "terminalId",
        cashier_id as "cashierId",
        created_at as "createdAt",
        tracking_number as "trackingNumber"
      from sales_orders
      where razorpay_payment_id = ${paymentId}
      for update
    `,
  );

  const order = rows.rows[0] as OrderRow | undefined;

  if (!order) {
    throw new AppError(404, "Order not found");
  }

  return order;
};

const getDuplicateProviderEvent = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  provider: "razorpay",
  externalEventId: string,
) =>
  tx.execute<{ id: number }>(
    sql`
      select id
      from webhook_events
      where provider = ${provider}
        and external_event_id = ${externalEventId}
      for update
    `,
  );

const releaseReservedStock = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  orderId: string,
  items: OrderItemRow[],
  transition: string,
  idempotencyKey: string,
) => {
  for (const item of items) {
    await adjustStockInTransaction(tx, tenantId, {
      eventType: "RELEASE",
      idempotencyKey: `${transitionKey(orderId, transition, idempotencyKey)}:${item.id}`,
      qtyDeltaMilli: item.quantityMilli,
      reason: `ORDER_${transition.toUpperCase()}:${orderId}:${item.sku}`,
      reservationRef: `${orderId}:${item.id}`,
      variantId: item.variantId,
    });
  }
};

export const calculateOrderTotalAmount = (
  order: Pick<OrderRow, "discountType" | "discountValue">,
  items: OrderItemRow[],
): number => {
  // Summed in integer paise, converted to rupees ONCE at the end, so the
  // invoice total is the exact sum of its lines.
  const subtotalPaise = items.reduce((total, item) => total + calculateLineItemTotalPaise(item), 0n);
  const subtotal = Number(subtotalPaise) / 100;

  return calculateDiscountedAmount({
    amount: subtotal,
    discountType: order.discountType,
    discountValue: order.discountValue,
  });
};

export const createOrderRequiresOwnerOverride = async (
  input: Pick<CreateOrderInput, "discountType" | "discountValue" | "items">,
): Promise<boolean> => {
  const variantIds = [...new Set(input.items.map((item) => item.variantId))];
  const variants = await getVariantSnapshots(db, variantIds);
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  let subtotal = 0;
  let afterLineDiscounts = 0;

  for (const item of input.items) {
    const variant = variantById.get(item.variantId);
    if (!variant) {
      throw new AppError(404, "One or more variants not found");
    }

    // The API sends whole/decimal units; price in integer paise, then back to
    // rupees for this preview total.
    const lineSubtotal = Number(
      lineTotalPaise(signedMoneyToPaise(String(variant.retailPrice)), quantityToMilli(String(item.quantity), { unit: variant.baseUnit ?? "piece" })),
    ) / 100;
    subtotal += lineSubtotal;
    afterLineDiscounts += calculateDiscountedAmount({
      amount: lineSubtotal,
      discountType: item.discountType,
      discountValue: item.discountValue,
    });
  }

  const discountedTotal = calculateDiscountedAmount({
    amount: afterLineDiscounts,
    discountType: input.discountType,
    discountValue: input.discountValue,
  });

  return calculateEffectiveDiscountPercent(subtotal, discountedTotal) > loadEnvSync().OVERRIDE_DISCOUNT_PERCENT_THRESHOLD;
};

export const orderDiscountRequiresOwnerOverride = async (
  tenantId: string,
  orderId: string,
): Promise<boolean> => {
  const order = await getOrderById(db, tenantId, orderId);
  const items = await getOrderItems(db, orderId);
  const subtotal = Number(items.reduce((total, item) => total + calculateLineItemTotalPaise(item), 0n)) / 100;
  const discountedTotal = calculateOrderTotalAmount(order, items);

  return calculateEffectiveDiscountPercent(subtotal, discountedTotal) > loadEnvSync().OVERRIDE_DISCOUNT_PERCENT_THRESHOLD;
};

export const getOrderStatus = async (tenantId: string, orderId: string): Promise<OrderStatus> =>
  (await getOrderById(db, tenantId, orderId)).orderStatus;

const localDateParts = (
  date: Date,
  timeZone: string,
): { day: number; month: number; year: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const getPart = (type: string) => Number(parts.find((part) => part.type === type)?.value);

  return {
    day: getPart("day"),
    month: getPart("month"),
    year: getPart("year"),
  };
};

export const financialYearSeriesKey = (
  date: Date,
  timeZone = loadEnvSync().SHOP_TIMEZONE,
): string => {
  const { month, year } = localDateParts(date, timeZone);
  const startYear = month >= 4 ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");

  return `${startYear}-${endYearShort}`;
};

// T16b — generalized from a bare allocateInvoiceNumber (invoices only) so
// credit-note.service.ts's CN/ series can share the same counter mechanism
// without colliding with invoice numbers. Mirrors ims-1's T16
// generalization: the counter ROW is keyed on `seriesKey` (unique per
// document type), while the printed NUMBER embeds `displaySegment`
// (defaults to `seriesKey`, so this call site's original behaviour is
// unchanged — the invoice call below passes no displaySegment).
export const allocateSeriesNumber = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  seriesKey: string,
  prefix: string,
  now = new Date(),
  displaySegment: string = seriesKey,
): Promise<{ number: string; allocatedAt: Date }> => {
  await tx.execute(sql`
    insert into invoice_counters (id, tenant_id, series_key, last_number)
    values (${randomUUID()}, ${tenantId}, ${seriesKey}, 0)
    on conflict (tenant_id, series_key) do nothing
  `);

  const counterRows = await tx.execute<{ id: string; lastNumber: number }>(sql`
    select id, last_number as "lastNumber"
    from invoice_counters
    where tenant_id = ${tenantId} and series_key = ${seriesKey}
    for update
  `);
  const counter = counterRows.rows[0];

  if (!counter) {
    throw new AppError(500, "Invoice counter unavailable");
  }

  const nextNumber = Number(counter.lastNumber) + 1;
  await tx
    .update(invoiceCounters)
    .set({ lastNumber: nextNumber })
    .where(eq(invoiceCounters.id, counter.id));

  return {
    number: `${prefix}/${displaySegment}/${String(nextNumber).padStart(6, "0")}`,
    allocatedAt: now,
  };
};

const allocateInvoiceNumber = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  now = new Date(),
): Promise<{ invoiceNumber: string; invoicedAt: Date }> => {
  const seriesKey = financialYearSeriesKey(now);
  const { number, allocatedAt } = await allocateSeriesNumber(tx, tenantId, seriesKey, "INV", now);
  return { invoiceNumber: number, invoicedAt: allocatedAt };
};

const getOpenShiftIdForTerminal = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  terminalId: string | undefined,
): Promise<string | null> => {
  if (!terminalId) {
    return null;
  }

  const [shift] = await tx
    .select({ id: posShifts.id })
    .from(posShifts)
    .where(sql`${posShifts.terminalId} = ${terminalId} and ${posShifts.status} = 'open'`)
    .limit(1);

  return shift?.id ?? null;
};

const getTenderRowsForPayment = (
  order: OrderRow,
  items: OrderItemRow[],
  input: PayOrderInput,
) => {
  const orderTotalPaise = orderTotalToPaise(order, items);
  const paymentId = input.razorpayPaymentId ?? order.razorpayPaymentId;

  if (!input.tenders) {
    return [
      {
        amount: formatPaise(orderTotalPaise),
        cardApprovalCode: null,
        cardLast4: null,
        id: randomUUID(),
        method: order.paymentPreference ?? (paymentId ? "UPI" : "cash"),
        orderId: order.id,
        razorpayPaymentId: paymentId,
      },
    ];
  }

  if (input.tenders.length === 0) {
    throw new AppError(422, "At least one tender is required");
  }

  for (const tender of input.tenders) {
    if (tender.method !== "card") {
      if (tender.cardLast4 || tender.cardApprovalCode) {
        throw new AppError(422, "Card details are only accepted for card tenders");
      }
      continue;
    }

    if (!tender.cardLast4 || !tender.cardApprovalCode) {
      throw new AppError(
        422,
        "Card last-4 and approval code are required for card tenders",
        undefined,
        "CARD_DETAILS_REQUIRED",
      );
    }
  }

  const tenderTotalPaise = input.tenders.reduce(
    (total, tender) => total + moneyStringToPaise(tender.amount),
    0n,
  );

  if (tenderTotalPaise !== orderTotalPaise) {
    throw new AppError(
      422,
      "Tender amounts do not sum to order total",
      undefined,
      "TENDER_AMOUNT_MISMATCH",
    );
  }

  return input.tenders.map((tender) => ({
    amount: formatPaise(moneyStringToPaise(tender.amount)),
    cardApprovalCode: tender.cardApprovalCode ?? null,
    cardLast4: tender.cardLast4 ?? null,
    id: randomUUID(),
    method: tender.method,
    orderId: order.id,
    razorpayPaymentId: tender.razorpayPaymentId ?? null,
  }));
};

const finalizePaidOrderInTransaction = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  order: OrderRow,
  paymentId: string | null,
  stockTransition: string,
  stockIdempotencyKey: string,
  options?: {
    syncQrPaid?: boolean;
  },
) => {
  if (order.orderStatus !== "Pending" && order.orderStatus !== "Paid") {
    throw new AppError(409, `Cannot mark order paid from ${order.orderStatus} status`);
  }

  if (order.orderStatus === "Pending") {
  const items = await getOrderItems(tx, order.id);

    for (const item of items) {
      await adjustStockInTransaction(tx, tenantId, {
        eventType: "SALE",
        idempotencyKey: `${transitionKey(order.id, stockTransition, stockIdempotencyKey)}:${item.id}`,
        qtyDeltaMilli: item.quantityMilli,
        reason: `ORDER_PAY:${order.id}:${item.sku}`,
        reservationRef: `${order.id}:${item.id}`,
        variantId: item.variantId,
      });
    }
  }

  await tx
    .update(salesOrders)
    .set({
      ...(order.invoiceNumber
        ? {}
        : await allocateInvoiceNumber(tx, tenantId).then((invoice) => ({
            invoiceNumber: invoice.invoiceNumber,
            invoicedAt: invoice.invoicedAt,
          }))),
      orderStatus: "Paid",
      qrStatus: options?.syncQrPaid ? "paid" : order.qrStatus,
      razorpayPaymentId: paymentId,
    })
    .where(eq(salesOrders.id, order.id));
};

const voidOrderQrInTransaction = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  orderId: string,
  order: OrderRow,
  externalEventId: string,
  stockTransition: string,
  stockIdempotencyKey: string,
  nextOrderStatus: OrderStatus,
  actorUserId?: string,
) => {
  if (!order.razorpayPaymentId) {
    throw new AppError(409, "Order does not have a Razorpay payment QR to void");
  }

  const paymentPort = createPaymentPort();
  const voidResult = await paymentPort.voidQr(order.razorpayPaymentId);

  if (voidResult.success === false) {
    if (voidResult.errorType !== "INTEGRATION_DISABLED") {
      return voidResult;
    }
  }

  const items = await getOrderItems(tx, orderId);
  await releaseReservedStock(tx, tenantId, orderId, items, stockTransition, stockIdempotencyKey);

  await tx
    .update(salesOrders)
    .set({
      orderStatus: nextOrderStatus,
      qrStatus: "voided",
      qrVoidedAt: new Date(),
    })
    .where(eq(salesOrders.id, orderId));

  await tx.insert(webhookEvents).values({
    externalEventId,
    provider: "razorpay",
  });
  if (actorUserId) {
    await logAudit(
      {
        action: "order.void_payment_qr",
        entityId: orderId,
        entityType: "order",
        metadata: {
          idempotencyKey: stockIdempotencyKey,
          nextOrderStatus,
          paymentId: order.razorpayPaymentId,
          previousStatus: order.orderStatus,
        },
        tenantId,
        userId: actorUserId,
      },
      tx,
    );
  }

  return {
    duplicate: false,
    order: await getOrderDetail(tx, tenantId, orderId),
  };
};

const getVariantSnapshots = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db,
  variantIds: string[],
) =>
  tx
    .select({
      // T30 — the unit decides whether a fractional quantity is allowed on
      // this line, so it comes back with the price.
      baseUnit: productVariants.baseUnit,
      id: productVariants.id,
      retailPrice: productVariants.retailPrice,
      sku: productVariants.sku,
      status: productVariants.status,
    })
    .from(productVariants)
    .where(
      variantIds.length === 1
        ? eq(productVariants.id, variantIds[0]!)
        : inArray(productVariants.id, variantIds),
    );

type CashierAttribution = {
  id: string;
  name: string;
};

const resolveCashierAttribution = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  cashierId: string | undefined,
): Promise<CashierAttribution | undefined> => {
  if (!cashierId) {
    return undefined;
  }

  return getActiveCashierForAttribution(cashierId, tx);
};

const cashierAuditMetadata = (
  cashier: CashierAttribution | undefined,
): Record<string, unknown> =>
  cashier ? { cashierId: cashier.id, cashierName: cashier.name } : {};

export const createOrder = async (tenantId: string, input: CreateOrderInput) =>
  db.transaction(async (tx) => {
    const existingRows = await tx
      .select({ id: salesOrders.id })
      .from(salesOrders)
      .where(
        and(
          eq(salesOrders.idempotencyKey, input.idempotencyKey),
          eq(salesOrders.tenantId, tenantId),
        ),
      )
      .limit(1);

    if (existingRows[0]) {
      return {
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, existingRows[0].id),
      };
    }

    const variantIds = [...new Set(input.items.map((item) => item.variantId))];
    const variants = await getVariantSnapshots(tx, variantIds);
    const cashier = await resolveCashierAttribution(tx, input.cashierId);
    const shiftId = await getOpenShiftIdForTerminal(tx, input.terminalId);

    if (variants.length !== variantIds.length) {
      throw new AppError(404, "One or more variants not found");
    }

    // Archiving is how a discontinued SKU is retired. Without this guard the
    // status is only a label: the till would keep selling a variant the owner
    // believes has been withdrawn.
    const archived = variants.filter((variant) => variant.status === "archived");

    if (archived.length > 0) {
      throw new AppError(
        409,
        `Archived variants cannot be sold: ${archived.map((variant) => variant.sku).join(", ")}`,
      );
    }

    const variantById = new Map(
      variants.map((variant) => [variant.id, variant]),
    );

    // T15 — an FK constraint alone does not enforce tenant isolation (see
    // ims-1's order.service.ts createOrder for the full reasoning); a
    // client-supplied customerId from another tenant must be rejected
    // explicitly.
    if (input.customerId) {
      const customerRows = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)))
        .limit(1);

      if (!customerRows[0]) {
        throw new AppError(404, "Customer not found");
      }
    }

    const orderId = randomUUID();
    await tx.insert(salesOrders).values({
      customerId: input.customerId ?? null,
      discountType: input.discountType ?? null,
      discountValue: input.discountValue?.toFixed(2) ?? null,
      id: orderId,
      idempotencyKey: input.idempotencyKey,
      orderStatus: "Draft",
      paymentPreference: input.paymentPreference ?? null,
      cashierId: cashier?.id ?? null,
      shiftId,
      tenantId,
      terminalId: input.terminalId ?? null,
    });

    await tx.insert(salesOrderItems).values(
      input.items.map((item) => {
        const variant = variantById.get(item.variantId);

        if (!variant) {
          throw new AppError(404, "One or more variants not found");
        }

        return {
          discountType: item.discountType ?? null,
          discountValue: item.discountValue?.toFixed(2) ?? null,
          id: randomUUID(),
          orderId,
          // API boundary: the till sends 1.5, storage is milli-units. The
          // unit decides whether a fraction is allowed at all.
          quantityMilli: quantityToMilli(String(item.quantity), { unit: variant.baseUnit ?? "piece" }),
          tenantId,
          unitPrice: String(variant.retailPrice),
          variantId: item.variantId,
        };
      }),
    );

    if (input.actorUserId) {
      await logAudit(
        {
          action: "order.create",
          entityId: orderId,
          entityType: "order",
          metadata: {
            ...cashierAuditMetadata(cashier),
            idempotencyKey: input.idempotencyKey,
          },
          tenantId,
          userId: input.actorUserId,
        },
        tx,
      );
    }

    return {
      duplicate: false,
      order: await getOrderDetail(tx, tenantId, orderId),
    };
  });

export const listOrders = async (tenantId: string, filters: OrderListFilters) => {
  const orders = await db
    .select({
      cashierId: salesOrders.cashierId,
      createdAt: salesOrders.createdAt,
      customerId: salesOrders.customerId,
      gstTreatment: salesOrders.gstTreatment,
      discountType: salesOrders.discountType,
      discountValue: salesOrders.discountValue,
      id: salesOrders.id,
      idempotencyKey: salesOrders.idempotencyKey,
      invoiceNumber: salesOrders.invoiceNumber,
      invoicedAt: salesOrders.invoicedAt,
      orderStatus: salesOrders.orderStatus,
      paymentPreference: salesOrders.paymentPreference,
      qrGeneratedAt: salesOrders.qrGeneratedAt,
      qrStatus: salesOrders.qrStatus,
      qrVoidedAt: salesOrders.qrVoidedAt,
      razorpayPaymentId: salesOrders.razorpayPaymentId,
      shipmentStatus: salesOrders.shipmentStatus,
      shippingAddressLine1: salesOrders.shippingAddressLine1,
      shippingCity: salesOrders.shippingCity,
      shippingPostalCode: salesOrders.shippingPostalCode,
      shippingState: salesOrders.shippingState,
      shiftId: salesOrders.shiftId,
      subtotalAmount: salesOrders.subtotalAmount,
      taxAmount: salesOrders.taxAmount,
      taxRatePercent: salesOrders.taxRatePercent,
      terminalId: salesOrders.terminalId,
      trackingNumber: salesOrders.trackingNumber,
    })
    .from(salesOrders)
    .where(
      and(
        eq(salesOrders.tenantId, tenantId),
        filters.status ? eq(salesOrders.orderStatus, filters.status) : undefined,
        filters.customerId ? eq(salesOrders.customerId, filters.customerId) : undefined,
      ),
    )
    .limit(filters.limit)
    .offset(filters.offset)
    .orderBy(salesOrders.createdAt);

  if (orders.length === 0) {
    return [];
  }

  const orderIds = orders.map((order) => order.id);
  const items = await db
    .select({
      id: salesOrderItems.id,
      name: products.name,
      orderId: salesOrderItems.orderId,
      quantityMilli: salesOrderItems.quantityMilli,
      sku: productVariants.sku,
      discountType: salesOrderItems.discountType,
      discountValue: salesOrderItems.discountValue,
      unitPrice: salesOrderItems.unitPrice,
      variantId: salesOrderItems.variantId,
      hsnCode: salesOrderItems.hsnCode,
      productHsnCode: products.hsnCode,
      taxRatePercent: salesOrderItems.taxRatePercent,
      taxableValue: salesOrderItems.taxableValue,
      cgstAmount: salesOrderItems.cgstAmount,
      sgstAmount: salesOrderItems.sgstAmount,
      igstAmount: salesOrderItems.igstAmount,
    })
    .from(salesOrderItems)
    .innerJoin(productVariants, eq(productVariants.id, salesOrderItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      orderIds.length === 1
        ? eq(salesOrderItems.orderId, orderIds[0]!)
        : inArray(salesOrderItems.orderId, orderIds),
    );
  const tenders = await db
    .select({
      amount: paymentTenders.amount,
      cardApprovalCode: paymentTenders.cardApprovalCode,
      cardLast4: paymentTenders.cardLast4,
      createdAt: paymentTenders.createdAt,
      id: paymentTenders.id,
      method: paymentTenders.method,
      orderId: paymentTenders.orderId,
      razorpayPaymentId: paymentTenders.razorpayPaymentId,
    })
    .from(paymentTenders)
    .where(
      orderIds.length === 1
        ? eq(paymentTenders.orderId, orderIds[0]!)
        : inArray(paymentTenders.orderId, orderIds),
    );

  return orders.map((order) => buildOrderResponse(order as OrderRow, items, tenders));
};

export const getOrder = async (tenantId: string, orderId: string) =>
  getOrderDetail(db, tenantId, orderId);

const buildReceiptEmailData = (
  order: Awaited<ReturnType<typeof getOrderDetail>>,
  email: string,
): ReceiptEmailData => {
  const subtotal = (order.subtotalAmount ?? calculateOrderTotalAmount(order, order.items)).toFixed(2);
  const taxAmount = (order.taxAmount ?? 0).toFixed(2);

  return {
    items: order.items.map((item) => ({
      name: item.name ?? item.sku,
      // A BOUNDARY — this is what gets PRINTED ON THE RECEIPT. 1.5, never
      // 1500.
      quantity: Number(formatQuantity(item.quantityMilli)),
      sku: item.sku,
      unitPrice: Number(item.unitPrice).toFixed(2),
    })),
    orderId: order.id,
    paidAt: new Date().toISOString(),
    subtotal,
    taxAmount,
    taxRatePercent: (order.taxRatePercent ?? 0).toFixed(2),
    to: email,
    total: (order.total ?? Number(subtotal) + Number(taxAmount)).toFixed(2),
  };
};

export const emailOrderReceipt = async (tenantId: string, orderId: string, email: string) => {
  const order = await getOrderDetail(db, tenantId, orderId);

  if (order.orderStatus !== "Paid") {
    throw new AppError(409, "Receipt email can only be sent for paid orders");
  }

  return createEmailPort().sendReceipt(buildReceiptEmailData(order, email));
};

export const confirmOrder = async (
  tenantId: string,
  orderId: string,
  input: ConfirmOrderInput & ActorInput,
) =>
  db.transaction(async (tx) => {
    const duplicate = await getDuplicateTransition(tx, orderId, "confirm", input.idempotencyKey);

    if (duplicate.rows.length > 0) {
      return {
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    const order = await lockOrderForUpdate(tx, tenantId, orderId);
    const cashier = await resolveCashierAttribution(tx, input.cashierId);
    assertStatus(order.orderStatus, ["Draft"], "confirm");
    const shipping = ensureShippingAddress(order, input);
    const items = await getOrderItems(tx, orderId);
    const subtotalAmount = calculateOrderTotalAmount(order, items).toFixed(2);
    const taxRatePercent = await getTaxRatePercent(tenantId, tx);

    // T15 — classification + per-line tax, computed once here at
    // confirmation and stored, never recomputed at read or filing time.
    // Mirrors ims-1/order.service.ts's confirmOrder exactly (both write the
    // same sales_orders/sales_order_items rows and must classify the same
    // way — see the T15 phase prompt's note that both repos originate
    // orders). Seller GSTIN itself is not needed for classification.
    const sellerStateCode = await getSellerStateCode(tenantId, tx);
    const customer = order.customerId
      ? (
          await tx
            .select({ gstin: customers.gstin, placeOfSupplyStateCode: customers.placeOfSupplyStateCode })
            .from(customers)
            .where(and(eq(customers.id, order.customerId), eq(customers.tenantId, tenantId)))
            .limit(1)
        )[0]
      : undefined;

    const placeOfSupplyStateCode = resolvePlaceOfSupplyStateCode({
      customerPlaceOfSupplyStateCode: customer?.placeOfSupplyStateCode ?? null,
      shippingStateCode: stateNameToGstCode(shipping.shippingState),
      sellerStateCode,
    });
    const isInterState =
      placeOfSupplyStateCode !== null &&
      sellerStateCode !== null &&
      placeOfSupplyStateCode !== sellerStateCode;

    // The order-level discount applies on top of each line's own discounted
    // total, so allocate it pro-rata in integer paise, remainder to the
    // last line — see ims-1's confirmOrder for the full reasoning. This is
    // what makes sum(line tax) == order tax provable, not merely likely.
    // Already integer paise, rounded once at the line — no rupee round-trip
    // through a float, which is what let the old form drift against the
    // order subtotal.
    const lineTotalsPaise = items.map((item) => calculateLineItemTotalPaise(item));
    const sumLineTotalsPaise = lineTotalsPaise.reduce((sum, value) => sum + value, 0n);
    const orderSubtotalPaise = moneyStringToPaise(subtotalAmount, { allowZero: true });

    const taxableValuesPaise: bigint[] = [];
    let allocatedSoFar = 0n;
    for (let i = 0; i < items.length; i++) {
      if (i === items.length - 1) {
        taxableValuesPaise.push(orderSubtotalPaise - allocatedSoFar);
        break;
      }
      const share =
        sumLineTotalsPaise === 0n
          ? 0n
          : (lineTotalsPaise[i]! * orderSubtotalPaise) / sumLineTotalsPaise;
      taxableValuesPaise.push(share);
      allocatedSoFar += share;
    }

    let totalTaxPaise = 0n;
    const lineTaxUpdates = items.map((item, i) => {
      const taxableValuePaise = taxableValuesPaise[i]!;
      const split = computeLineTaxSplit(taxableValuePaise, taxRatePercent, isInterState);
      assertLineTaxConsistency(taxRatePercent, split);
      totalTaxPaise += split.totalTaxPaise;

      return {
        cgstAmount: formatPaise(split.cgstAmountPaise),
        hsnCode: item.productHsnCode ?? null,
        id: item.id,
        igstAmount: formatPaise(split.igstAmountPaise),
        sgstAmount: formatPaise(split.sgstAmountPaise),
        taxableValue: formatPaise(taxableValuePaise),
        taxRatePercent,
      };
    });

    const taxAmount = formatPaise(totalTaxPaise);
    const gstTreatment = deriveGstTreatment({
      customerGstin: customer?.gstin ?? null,
      orderTotalPaise: orderSubtotalPaise + totalTaxPaise,
      placeOfSupplyStateCode,
      sellerStateCode,
    });

    for (const lineUpdate of lineTaxUpdates) {
      await tx
        .update(salesOrderItems)
        .set({
          cgstAmount: lineUpdate.cgstAmount,
          hsnCode: lineUpdate.hsnCode,
          igstAmount: lineUpdate.igstAmount,
          sgstAmount: lineUpdate.sgstAmount,
          taxableValue: lineUpdate.taxableValue,
          taxRatePercent: lineUpdate.taxRatePercent,
        })
        .where(eq(salesOrderItems.id, lineUpdate.id));
    }

    for (const item of items) {
      try {
        await adjustStockInTransaction(tx, tenantId, {
          eventType: "RESERVE",
          idempotencyKey: `${transitionKey(orderId, "confirm", input.idempotencyKey)}:${item.id}`,
          qtyDeltaMilli: item.quantityMilli,
          reason: `ORDER_CONFIRM:${orderId}:${item.sku}`,
          reservationRef: `${orderId}:${item.id}`,
          variantId: item.variantId,
        });
      } catch (error) {
        if (error instanceof AppError && error.errorType === "INSUFFICIENT_STOCK") {
          throw new AppError(
            409,
            `Insufficient stock while confirming order for SKU ${item.sku}`,
            undefined,
            "INSUFFICIENT_STOCK",
          );
        }

        throw error;
      }
    }

    await tx
      .update(salesOrders)
      .set({
        gstTreatment,
        orderStatus: "Pending",
        shippingAddressLine1: shipping.shippingAddressLine1,
        shippingCity: shipping.shippingCity,
        shippingPostalCode: shipping.shippingPostalCode,
        shippingState: shipping.shippingState,
        cashierId: cashier?.id ?? order.cashierId,
        subtotalAmount,
        taxAmount,
        taxRatePercent,
      })
      .where(eq(salesOrders.id, orderId));

    await tx.insert(webhookEvents).values({
      externalEventId: transitionKey(orderId, "confirm", input.idempotencyKey),
      provider: INTERNAL_IDEMPOTENCY_PROVIDER,
    });
    await logAudit(
      {
        action: "order.confirm",
        entityId: orderId,
        entityType: "order",
        metadata: {
          ...cashierAuditMetadata(cashier),
          idempotencyKey: input.idempotencyKey,
          previousStatus: order.orderStatus,
        },
        tenantId,
        userId: input.actorUserId,
      },
      tx,
    );

    return {
      duplicate: false,
      order: await getOrderDetail(tx, tenantId, orderId),
    };
  });

export const payOrder = async (
  tenantId: string,
  orderId: string,
  input: PayOrderInput & ActorInput,
) =>
  db.transaction(async (tx) => {
    const duplicate = await getDuplicateTransition(tx, orderId, "pay", input.idempotencyKey);

    if (duplicate.rows.length > 0) {
      return {
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    const order = await lockOrderForUpdate(tx, tenantId, orderId);
    const cashier = await resolveCashierAttribution(tx, input.cashierId);
    assertStatus(order.orderStatus, ["Pending"], "pay");
    const items = await getOrderItems(tx, orderId);
    const tenderRows = getTenderRowsForPayment(order, items, input);
    await tx.insert(paymentTenders).values(tenderRows.map((row) => ({ ...row, tenantId })));
    await finalizePaidOrderInTransaction(
      tx,
      tenantId,
      order,
      input.razorpayPaymentId ?? order.razorpayPaymentId,
      "pay",
      input.idempotencyKey,
    );

    if (cashier) {
      await tx
        .update(salesOrders)
        .set({ cashierId: cashier.id })
        .where(eq(salesOrders.id, orderId));
    }

    await tx.insert(webhookEvents).values({
      externalEventId: transitionKey(orderId, "pay", input.idempotencyKey),
      provider: INTERNAL_IDEMPOTENCY_PROVIDER,
    });
    await logAudit(
      {
        action: "order.pay",
        entityId: orderId,
        entityType: "order",
        metadata: {
          ...cashierAuditMetadata(cashier),
          idempotencyKey: input.idempotencyKey,
          previousStatus: order.orderStatus,
          razorpayPaymentId: input.razorpayPaymentId ?? order.razorpayPaymentId,
        },
        tenantId,
        userId: input.actorUserId,
      },
      tx,
    );

    return {
      duplicate: false,
      order: await getOrderDetail(tx, tenantId, orderId),
    };
  });

// Triggered by the Razorpay webhook, not an authenticated caller — no tenant
// context exists yet, only a payment id issued by the provider. That id is
// globally unique, so looking the order up by it alone is not a
// cross-tenant access path the way a client-supplied orderId would be.
export const captureOrderPaymentFromWebhook = async (
  paymentId: string,
  externalEventId: string,
) =>
  db.transaction(async (tx) => {
    const order = await lockOrderByPaymentIdForUpdate(tx, paymentId);
    await finalizePaidOrderInTransaction(
      tx,
      order.tenantId!,
      order,
      paymentId,
      "pay-webhook",
      externalEventId,
      { syncQrPaid: true },
    );

    return getOrderDetail(tx, order.tenantId!, order.id);
  });

export const cancelOrder = async (
  tenantId: string,
  orderId: string,
  input: TransitionInput & ActorInput,
) =>
  db.transaction(async (tx) => {
    const duplicate = await getDuplicateTransition(tx, orderId, "cancel", input.idempotencyKey);

    if (duplicate.rows.length > 0) {
      return {
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    const order = await lockOrderForUpdate(tx, tenantId, orderId);
    const cashier = await resolveCashierAttribution(tx, input.cashierId);
    assertStatus(order.orderStatus, ["Pending", "Paid"], "cancel");
    const items = await getOrderItems(tx, orderId);

    for (const item of items) {
      await adjustStockInTransaction(tx, tenantId, {
        eventType: order.orderStatus === "Pending" ? "RELEASE" : "ADJUSTMENT",
        idempotencyKey: `${transitionKey(orderId, "cancel", input.idempotencyKey)}:${item.id}`,
        qtyDeltaMilli: item.quantityMilli,
        reason: `ORDER_CANCEL:${orderId}:${item.sku}`,
        reservationRef: `${orderId}:${item.id}`,
        variantId: item.variantId,
      });
    }

    await tx
      .update(salesOrders)
      .set({ cashierId: cashier?.id ?? order.cashierId, orderStatus: "Cancelled" })
      .where(eq(salesOrders.id, orderId));

    await tx.insert(webhookEvents).values({
      externalEventId: transitionKey(orderId, "cancel", input.idempotencyKey),
      provider: INTERNAL_IDEMPOTENCY_PROVIDER,
    });
    await logAudit(
      {
        action: "order.cancel",
        entityId: orderId,
        entityType: "order",
        metadata: {
          ...cashierAuditMetadata(cashier),
          idempotencyKey: input.idempotencyKey,
          previousStatus: order.orderStatus,
        },
        tenantId,
        userId: input.actorUserId,
      },
      tx,
    );

    return {
      duplicate: false,
      order: await getOrderDetail(tx, tenantId, orderId),
    };
  });

export const returnOrder = async (
  tenantId: string,
  orderId: string,
  input: ReturnOrderInput & ActorInput,
) =>
  db.transaction(async (tx) => {
    const duplicate = await getDuplicateTransition(tx, orderId, "return", input.idempotencyKey);

    if (duplicate.rows.length > 0) {
      return {
        creditNote: undefined,
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    const order = await lockOrderForUpdate(tx, tenantId, orderId);
    const cashier = await resolveCashierAttribution(tx, input.cashierId);
    assertStatus(order.orderStatus, ["Paid", "Delivered"], "return");
    const items = await getOrderItems(tx, orderId);
    const returnByVariantId = new Map(
      input.items.map((item) => [item.variantId, item.restockable]),
    );

    if (returnByVariantId.size !== items.length) {
      throw new AppError(409, "Return request must include every order item");
    }

    for (const item of items) {
      const restockable = returnByVariantId.get(item.variantId);

      if (typeof restockable !== "boolean") {
        throw new AppError(409, `Missing return condition for SKU ${item.sku}`);
      }

      await adjustStockInTransaction(tx, tenantId, {
        damageMode: restockable ? undefined : "increment",
        eventType: restockable ? "RETURN" : "DAMAGE",
        idempotencyKey: `${transitionKey(orderId, "return", input.idempotencyKey)}:${item.id}`,
        qtyDeltaMilli: item.quantityMilli,
        reason: `ORDER_RETURN:${orderId}:${item.sku}:${restockable ? "RESTOCK" : "DAMAGE"}`,
        // T31 — the ref is identical to the one ims-1 writes, so a return
        // rung here lands in the batch the sale took it from even when that
        // sale went through the admin console.
        reservationRef: `${orderId}:${item.id}`,
        variantId: item.variantId,
      });
    }

    await tx
      .update(salesOrders)
      .set({ cashierId: cashier?.id ?? order.cashierId, orderStatus: "Returned" })
      .where(eq(salesOrders.id, orderId));

    // T16b — one credit note per return, covering every returned line in
    // the same transaction as the stock adjustment above and the status
    // change above: all three commit or fail together.
    const creditNote = await createCreditNoteForReturn(
      tx,
      tenantId,
      { customerId: order.customerId ?? null, gstTreatment: order.gstTreatment ?? null, id: orderId },
      items.map((item) => ({
        cgstAmount: item.cgstAmount ?? null,
        hsnCode: item.hsnCode ?? item.productHsnCode ?? null,
        id: item.id,
        igstAmount: item.igstAmount ?? null,
        // Full-order return: the entire original quantity is what's being
        // credited, so both fields are the same value here.
        originalQuantityMilli: item.quantityMilli,
        quantityMilli: item.quantityMilli,
        restockable: returnByVariantId.get(item.variantId) === true,
        sgstAmount: item.sgstAmount ?? null,
        taxableValue: item.taxableValue ?? null,
        taxRatePercent: item.taxRatePercent ?? null,
        unitPrice: item.unitPrice,
        variantId: item.variantId,
      })),
      input.reason ?? "return",
    );

    await tx.insert(webhookEvents).values({
      externalEventId: transitionKey(orderId, "return", input.idempotencyKey),
      provider: INTERNAL_IDEMPOTENCY_PROVIDER,
    });
    await logAudit(
      {
        action: "order.return",
        entityId: orderId,
        entityType: "order",
        metadata: {
          ...cashierAuditMetadata(cashier),
          creditNoteId: creditNote.id,
          creditNoteNumber: creditNote.creditNoteNumber,
          idempotencyKey: input.idempotencyKey,
          previousStatus: order.orderStatus,
          returnedItems: input.items,
        },
        tenantId,
        userId: input.actorUserId,
      },
      tx,
    );

    return {
      creditNote,
      duplicate: false,
      order: await getOrderDetail(tx, tenantId, orderId),
    };
  });

export const generatePaymentQr = async (
  tenantId: string,
  orderId: string,
  input: OrderIntegrationInput & ActorInput,
): Promise<
  | {
      duplicate: boolean;
      order: Awaited<ReturnType<typeof getOrderDetail>>;
    }
  | StandardizedIntegrationError
> =>
  db.transaction(async (tx) => {
    const externalEventId = providerTransitionKey(
      "razorpay",
      orderId,
      "generate-payment-qr",
      input.idempotencyKey,
    );
    const duplicate = await getDuplicateProviderEvent(tx, "razorpay", externalEventId);

    if (duplicate.rows.length > 0) {
      return {
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    const order = await lockOrderForUpdate(tx, tenantId, orderId);
    assertStatus(order.orderStatus, ["Pending"], "generate payment QR for");
    const items = await getOrderItems(tx, orderId);
    const paymentPort = createPaymentPort();
    const qrResult = await paymentPort.generateQr(
      orderId,
      Number(formatPaise(orderTotalToPaise(order, items))),
    );

    if (qrResult.success === false) {
      return qrResult;
    }

    await tx
      .update(salesOrders)
      .set({
        qrGeneratedAt: new Date(),
        qrStatus: "generated",
        razorpayPaymentId: qrResult.data.paymentId,
      })
      .where(eq(salesOrders.id, orderId));

    await tx.insert(webhookEvents).values({
      externalEventId,
      provider: "razorpay",
    });
    await logAudit(
      {
        action: "order.generate_payment_qr",
        entityId: orderId,
        entityType: "order",
        metadata: { idempotencyKey: input.idempotencyKey, paymentId: qrResult.data.paymentId },
        tenantId,
        userId: input.actorUserId,
      },
      tx,
    );

    return {
      duplicate: false,
      order: await getOrderDetail(tx, tenantId, orderId),
    };
  });

export const voidPaymentQr = async (
  tenantId: string,
  orderId: string,
  input: OrderIntegrationInput & ActorInput,
): Promise<
  | {
      duplicate: boolean;
      order: Awaited<ReturnType<typeof getOrderDetail>>;
    }
  | StandardizedIntegrationError
> =>
  db.transaction(async (tx) => {
    const externalEventId = providerTransitionKey(
      "razorpay",
      orderId,
      "void-payment-qr",
      input.idempotencyKey,
    );
    const duplicate = await getDuplicateProviderEvent(tx, "razorpay", externalEventId);

    if (duplicate.rows.length > 0) {
      return {
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    const order = await lockOrderForUpdate(tx, tenantId, orderId);
    assertStatus(order.orderStatus, ["Pending"], "void payment QR for");
    return voidOrderQrInTransaction(
      tx,
      tenantId,
      orderId,
      order,
      externalEventId,
      "void-payment-qr",
      input.idempotencyKey,
      "Draft",
      input.actorUserId,
    );
  });

export const expirePaymentQr = async (
  tenantId: string,
  orderId: string,
  idempotencyKey: string,
): Promise<
  | {
      duplicate: boolean;
      order: Awaited<ReturnType<typeof getOrderDetail>>;
    }
  | StandardizedIntegrationError
> =>
  db.transaction(async (tx) => {
    const externalEventId = providerTransitionKey(
      "razorpay",
      orderId,
      "expire-payment-qr",
      idempotencyKey,
    );
    const duplicate = await getDuplicateProviderEvent(tx, "razorpay", externalEventId);

    if (duplicate.rows.length > 0) {
      return {
        duplicate: true,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    const order = await lockOrderForUpdate(tx, tenantId, orderId);

    if (order.qrStatus !== "pending" && order.qrStatus !== "generated") {
      return {
        duplicate: false,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    if (!order.qrGeneratedAt || order.orderStatus !== "Pending") {
      return {
        duplicate: false,
        order: await getOrderDetail(tx, tenantId, orderId),
      };
    }

    return voidOrderQrInTransaction(
      tx,
      tenantId,
      orderId,
      order,
      externalEventId,
      "expire-payment-qr",
      idempotencyKey,
      "Draft",
    );
  });
