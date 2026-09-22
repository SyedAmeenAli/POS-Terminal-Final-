export type ApiEnvelope<T> = {
  data: T;
  duplicate?: boolean;
  success: boolean;
};

export type DiscountType = "percent" | "flat";

export type Product = {
  brand: string;
  createdAt?: string;
  id: string;
  imagePath?: string | null;
  name: string;
  productTypeId: string;
  qualityTier?: string;
  styleCode?: string;
};

export type ProductVariant = {
  // NULLABLE. T30 relaxed these columns so a hardware shop need not invent a
  // colour for a screwdriver, and the IMS now creates such items. Typed
  // `string` they render as the literal text "null" in a template literal —
  // "Cable null null CB-001" on the cart line at a live counter.
  color: string | null;
  costPrice?: string | number;
  id: string;
  productId: string;
  retailPrice: string | number;
  size: string | null;
  sku: string;
  status: "active" | "archived";
  // T30 — the unit this item is STOCKED in. Without it a cart line reading
  // "1.5" means kilograms or metres or pieces and the cashier cannot tell.
  baseUnit?: string;
};

// T30 — what GET /inventory/:variantId ACTUALLY returns. Quantities are
// bigint milli-units, and the reply serialiser renders every bigint as a
// string, so these arrive as "5000" and not 5000.
//
// This type used to read `{ availableQty: number, productVariantId, reservedQty,
// soldQty }` — three of those four names the server has never sent, and
// `soldQty` it never sent at all. Nothing failed, because an interface
// describing a fetch result is an assertion nobody checks: the POS read
// `stock.availableQty`, got undefined, and showed a blank stock figure for
// every variant on the counter screen.
//
// Note POSPage already handled LOTS correctly — `Number(lot.availableQtyMilli)`
// — so only the per-variant path was left behind.
export type InventoryStockWire = {
  id: string;
  variantId: string;
  onHandQtyMilli: string;
  reservedQtyMilli: string;
  damagedQtyMilli: string;
  availableQtyMilli: string;
};

/** The same figures in the units a cashier reads. */
export type InventoryStock = {
  availableQty: number;
  damagedQty: number;
  onHandQty: number;
  reservedQty: number;
  variantId: string;
};

export type Cashier = {
  cashierId?: string;
  id: string;
  name: string;
};

export type TenderMethod = "cash" | "UPI" | "card";

export type TenderInput = {
  amount: string;
  cardApprovalCode?: string;
  cardLast4?: string;
  method: TenderMethod;
};

export type Order = {
  cashierId?: string | null;
  cashierName?: string | null;
  createdAt: string;
  discountType?: DiscountType | null;
  discountValue?: number | null;
  id: string;
  invoiceNumber?: string | null;
  invoicedAt?: string | null;
  items: Array<{
    discountType?: DiscountType | null;
    discountValue?: number | null;
    id: string;
    name?: string;
    orderId: string;
    // BUG FOUND 2026-09-16: this said `quantity: number` and the server has
    // never sent that field on a fetched order — confirmed against a real
    // GET /orders/:id response. `quantityMilli` is a STRING (thousandths),
    // matching the server's own bigint-serialized-to-string convention
    // everywhere else. Use web/src/utils/quantity.ts's `milliToUnits` /
    // `formatQuantityMilli` to read it, never `Number(item.quantity)`.
    quantityMilli: string;
    sku: string;
    unitPrice: number;
    variantId: string;
  }>;
  orderStatus: string;
  paymentPreference: "cash" | "UPI" | null;
  shiftId?: string | null;
  subtotalAmount?: number | null;
  taxAmount?: number | null;
  taxRatePercent?: number | null;
  tenders?: Array<TenderInput & { id: string; orderId: string }>;
  terminalId?: string | null;
  terminalName?: string | null;
  total: number;
};

export type CreateOrderBody = {
  cashierId?: string;
  discountType?: DiscountType;
  discountValue?: number;
  idempotencyKey: string;
  items: Array<{
    discountType?: DiscountType;
    discountValue?: number;
    quantity: number;
    variantId: string;
  }>;
  paymentPreference?: "cash" | "UPI";
};

export type ConfirmOrderBody = {
  cashierId?: string;
  idempotencyKey: string;
  shippingAddressLine1?: string;
  shippingCity?: string;
  shippingPostalCode?: string;
  shippingState?: string;
};

export type PayOrderBody = {
  cashierId?: string;
  idempotencyKey: string;
  tenders?: TenderInput[];
};

export type OrderTransitionResponse = ApiEnvelope<Order>;

export type OwnerStatus = {
  authorised: boolean;
  expiresAt: string | null;
};

export type ShiftReport = {
  businessDate: string;
  discounts: number;
  gross: number;
  orderCount: number;
  refunds: number;
  shift: {
    closedAt: string | null;
    countedCash: string | null;
    expectedCash?: string | null;
    id: string;
    openedAt: string;
    openingFloat: string;
    status: "open" | "closed";
    variance?: string | null;
  };
  tax: number;
  tenders: Record<TenderMethod, string>;
};
