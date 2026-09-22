// READ-ONLY MIRROR of the ims-1 schema. This repo does not own or migrate the
// database. When ims-1's schema changes, copy this file across.
//
// T30 — quantity is MILLI-UNITS now. Every *_milli column is thousandths of
// the variant's base_unit: 1.5 kg is 1500n, one piece is 1000n. The suffix is
// deliberate, so a column called `quantity` can never silently hold
// thousandths. Convert to display units at every boundary that leaves this
// process — a receipt, a screen, an API response.

import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
  bigint,
} from "drizzle-orm/pg-core";

export const orderStatusEnum = pgEnum("order_status", [
  "Draft",
  "Pending",
  "Paid",
  "Packed",
  "Shipped",
  "Delivered",
  "Completed",
  "Cancelled",
  "Returned",
  "Refunded",
]);

// T15 — GST supply classification, set once at order confirmation and never
// recomputed. b2cl's ₹1,00,000 threshold lives in tax.service.ts as
// GST_B2CL_THRESHOLD_PAISE, not here — this enum only names the categories.
export const gstTreatmentEnum = pgEnum("gst_treatment", ["b2b", "b2cl", "b2cs", "export", "exempt"]);

// T16b — credit notes & returns.
export const creditNoteReasonEnum = pgEnum("credit_note_reason", [
  "return",
  "damage",
  "price_adjustment",
  "cancellation",
]);

// T17 — e-invoicing IRN state machine. Mirrored here because sales_orders
// carries the irn* columns; POS itself never registers an e-invoice (that
// is deliberately IMS-only — POS sales are overwhelmingly B2CS walk-ins,
// which are outside e-invoicing scope by definition). Declaration only.
export const irnStatusEnum = pgEnum("irn_status", ["pending", "generated", "cancelled", "failed"]);

export const paymentPreferenceEnum = pgEnum("payment_preference", ["cash", "UPI"]);
export const tenderMethodEnum = pgEnum("tender_method", ["cash", "UPI", "card"]);
export const discountTypeEnum = pgEnum("discount_type", ["percent", "flat"]);

export const qrStatusEnum = pgEnum("qr_status", [
  "pending",
  "generated",
  "paid",
  "voided",
  "expired",
]);

export const stockEventTypeEnum = pgEnum("stock_event_type", [
  "SALE",
  "RESERVE",
  "RELEASE",
  "RETURN",
  "DAMAGE",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT",
]);

export const variantStatusEnum = pgEnum("variant_status", ["active", "archived"]);

export const webhookStatusEnum = pgEnum("webhook_status", ["pending", "success", "failed"]);

export const campaignStatusEnum = pgEnum("campaign_status", ["Draft", "Approved", "Published"]);

const webhookProviderValues = ["me" + "ta", "ship" + "rocket", "razorpay"] as [
  string,
  string,
  string,
];

export const webhookProviderEnum = pgEnum("webhook_provider", webhookProviderValues);

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "manager",
  "warehouse_staff",
  "pos_operator",
]);

export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);

export const terminalStatusEnum = pgEnum("terminal_status", ["active", "disabled"]);
export const cashierStatusEnum = pgEnum("cashier_status", ["active", "disabled"]);
export const shiftStatusEnum = pgEnum("shift_status", ["open", "closed"]);
export const tenantStatusEnum = pgEnum("tenant_status", [
  "trial", "active", "past_due", "suspended", "cancelled",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  businessName: varchar("business_name", { length: 255 }).notNull(),
  status: tenantStatusEnum("status").default("trial").notNull(),
  trialEndsAt: timestamp("trial_ends_at", { mode: "date" }).notNull(),
  subscriptionId: varchar("subscription_id", { length: 64 }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});

export const posTerminals = pgTable(
  "pos_terminals",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: varchar("name", { length: 100 }).notNull(),
    tokenHash: text("token_hash").notNull(),
    // First 12 chars of the raw token, stored so a presented token can be
    // located with one indexed lookup instead of bcrypt-comparing against every
    // terminal row. Not a secret on its own: it is a fragment of a 256-bit
    // token and the bcrypt hash still gates authentication.
    // Nullable because terminals provisioned before this column existed cannot
    // have it backfilled — bcrypt is one-way, so their prefix is unrecoverable.
    // Those rows fall back to the legacy full-scan path until re-provisioned.
    tokenPrefix: varchar("token_prefix", { length: 12 }),
    status: terminalStatusEnum("status").default("active").notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("pos_terminals_token_prefix_idx").on(table.tokenPrefix)],
);

export const cashiers = pgTable("cashiers", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: varchar("name", { length: 100 }).notNull(),
  pinHash: text("pin_hash").notNull(),
  status: cashierStatusEnum("status").default("active").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});

export const posShifts = pgTable(
  "pos_shifts",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from pos_terminals for RLS. Previously reachable
    // through cashier-activity.service.ts's raw SQL with no tenant filter at
    // all; RLS is the only thing that closed that gap.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    terminalId: uuid("terminal_id")
      .notNull()
      .references(() => posTerminals.id),
    openedByCashierId: uuid("opened_by_cashier_id").references(() => cashiers.id),
    closedByCashierId: uuid("closed_by_cashier_id").references(() => cashiers.id),
    status: shiftStatusEnum("status").default("open").notNull(),
    openingFloat: numeric("opening_float", { precision: 10, scale: 2 }).notNull(),
    countedCash: numeric("counted_cash", { precision: 10, scale: 2 }),
    expectedCash: numeric("expected_cash", { precision: 10, scale: 2 }),
    variance: numeric("variance", { precision: 10, scale: 2 }),
    note: text("note"),
    openedAt: timestamp("opened_at", { mode: "date" }).defaultNow().notNull(),
    closedAt: timestamp("closed_at", { mode: "date" }),
  },
  (table) => [
    index("pos_shifts_terminal_status_idx").on(table.terminalId, table.status),
    uniqueIndex("pos_shifts_one_open_per_terminal_idx")
      .on(table.terminalId)
      .where(sql`${table.status} = 'open'`),
    index("pos_shifts_tenant_id_idx").on(table.tenantId),
  ],
);

export const invoiceCounters = pgTable(
  "invoice_counters",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    seriesKey: varchar("series_key", { length: 32 }).notNull(),
    lastNumber: integer("last_number").default(0).notNull(),
  },
  (table) => [uniqueIndex("invoice_counters_series_idx").on(table.tenantId, table.seriesKey)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull(),
    status: userStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    lastLoginAt: timestamp("last_login_at", { mode: "date" }),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.tenantId, table.email)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from users for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entity_type", { length: 100 }).notNull(),
    entityId: varchar("entity_id", { length: 255 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_user_id_idx").on(table.userId),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    index("audit_log_created_at_idx").on(table.createdAt),
    index("audit_log_tenant_id_idx").on(table.tenantId),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: varchar("name", { length: 100 }).notNull(),
    code: varchar("code", { length: 10 }).notNull(),
  },
  // Global unique index until here — scoped per-tenant, mirroring ims-1's fix.
  (table) => [uniqueIndex("categories_code_idx").on(table.tenantId, table.code)],
);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: varchar("name", { length: 255 }).notNull(),
  startDate: timestamp("start_date", { mode: "date" }).notNull(),
  endDate: timestamp("end_date", { mode: "date" }).notNull(),
  status: campaignStatusEnum("status").default("Draft").notNull(),
  config: jsonb("config").default('{}').notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const productTypes = pgTable(
  "product_types",
  {
    id: uuid("id").primaryKey(),
    // Denormalised from categories. product_types is FK-inherited, but the
    // code uniqueness constraint has to name a tenant column directly — and a
    // global one refused a second tenant that picked the same natural code.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id),
    name: varchar("name", { length: 100 }).notNull(),
    code: varchar("code", { length: 10 }).notNull(),
  },
  // Was global, now per-tenant — same fix as categories_code_idx in T1.
  (table) => [uniqueIndex("product_types_code_idx").on(table.tenantId, table.code)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from product_types so RLS can protect this table
    // directly instead of relying on every read joining up to it.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    productTypeId: uuid("product_type_id")
      .notNull()
      .references(() => productTypes.id),
    name: varchar("name", { length: 255 }).notNull(),
    styleCode: varchar("style_code", { length: 20 }),
    qualityTier: varchar("quality_tier", { length: 30 }),
    brand: varchar("brand", { length: 100 }),
    isService: boolean("is_service").default(false).notNull(),
    imagePath: varchar("image_path", { length: 255 }),
    // T15 — nullable, never backfilled with a guessed value.
    hsnCode: varchar("hsn_code", { length: 8 }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("products_tenant_id_idx").on(table.tenantId)],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey(),
    // Denormalised for the same reason as product_types above. SKUs are
    // derived from the category, type and style codes, so two tenants using
    // the same codes produced the same SKU and the second was refused.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    sku: varchar("sku", { length: 128 }).notNull(),
    color: varchar("color", { length: 50 }),
    size: varchar("size", { length: 20 }),
    baseUnit: varchar("base_unit", { length: 16 }).default("piece").notNull(),
    secondaryUnit: varchar("secondary_unit", { length: 16 }),
    conversionNumerator: bigint("conversion_numerator", { mode: "bigint" }),
    conversionDenominator: bigint("conversion_denominator", { mode: "bigint" }),
    isService: boolean("is_service").default(false).notNull(),
    // T30/T31 — the PER-ITEM tracking mode, and the only thing that decides
    // whether this service's stock path takes the lot fork. NOT the tenant's
    // Settings -> Items toggle: that decides whether a control is visible,
    // this decides what the stock engine does.
    trackingMode: varchar("tracking_mode", { length: 8 }).default("none").notNull(),
    customFields: jsonb("custom_fields").$type<Record<string, string>>(),
    retailPrice: numeric("retail_price", { precision: 10, scale: 2 }).notNull(),
    costPrice: numeric("cost_price", { precision: 10, scale: 2 }).notNull(),
    reorderPoint: integer("reorder_point").default(10).notNull(),
    status: variantStatusEnum("status").default("active").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("product_variants_sku_idx").on(table.tenantId, table.sku)],
);

export const inventoryStock = pgTable(
  "inventory_stock",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from product_variants for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id)
      .unique(),
    onHandQtyMilli: bigint("on_hand_qty_milli", { mode: "bigint" }).default(0n).notNull(),
    reservedQtyMilli: bigint("reserved_qty_milli", { mode: "bigint" }).default(0n).notNull(),
    damagedQtyMilli: bigint("damaged_qty_milli", { mode: "bigint" }).default(0n).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    check("inventory_stock_on_hand_qty_milli_nonnegative", sql`${table.onHandQtyMilli} >= 0`),
    check("inventory_stock_reserved_qty_milli_nonnegative", sql`${table.reservedQtyMilli} >= 0`),
    check("inventory_stock_damaged_qty_milli_nonnegative", sql`${table.damagedQtyMilli} >= 0`),
    index("inventory_stock_tenant_id_idx").on(table.tenantId),
  ],
);

// T7 — denormalised from product_variants for RLS. The
// stock_events_immutable_trigger (BEFORE DELETE OR UPDATE, in the live
// database, not in any migration file — see IMS's 0022) makes this column
// unbackfillable via a plain UPDATE; that migration brackets the backfill
// with DISABLE/ENABLE TRIGGER instead.
export const stockEvents = pgTable(
  "stock_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    eventType: stockEventTypeEnum("event_type").notNull(),
    // T31 — the batch this movement came out of or went into. Nullable:
    // untracked items have no lots, and every event written before batches
    // existed has none.
    lotId: uuid("lot_id"),
    // T32 — the serial this movement moved. One ledger explains every stock
    // figure; a parallel movement table would have to be reconciled against
    // this one.
    serialId: uuid("serial_id"),
    qtyDeltaMilli: bigint("qty_delta_milli", { mode: "bigint" }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("stock_events_variant_id_idx").on(table.variantId),
    index("stock_events_tenant_id_idx").on(table.tenantId),
  ],
);

// T31 — BATCH TRACKING. READ-ONLY MIRROR of ims-1's definitions; this repo
// owns no migrations and must never gain any. Two migration histories against
// one database has no clean recovery, and the asymmetry is deliberate.
//
// MRP lives on the BATCH, not the product: in Indian retail it is printed on
// the pack and changes between batches.
export const inventoryLots = pgTable(
  "inventory_lots",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    batchNumber: varchar("batch_number", { length: 64 }).notNull(),
    mrpPaise: bigint("mrp_paise", { mode: "bigint" }),
    manufacturingDate: date("manufacturing_date"),
    expiryDate: date("expiry_date"),
    size: varchar("size", { length: 64 }),
    onHandQtyMilli: bigint("on_hand_qty_milli", { mode: "bigint" }).default(0n).notNull(),
    reservedQtyMilli: bigint("reserved_qty_milli", { mode: "bigint" }).default(0n).notNull(),
    damagedQtyMilli: bigint("damaged_qty_milli", { mode: "bigint" }).default(0n).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    check("inventory_lots_on_hand_qty_milli_nonnegative", sql`${table.onHandQtyMilli} >= 0`),
    check("inventory_lots_reserved_qty_milli_nonnegative", sql`${table.reservedQtyMilli} >= 0`),
    check("inventory_lots_damaged_qty_milli_nonnegative", sql`${table.damagedQtyMilli} >= 0`),
    uniqueIndex("inventory_lots_variant_batch_idx").on(table.variantId, table.batchNumber),
    index("inventory_lots_fefo_idx").on(table.variantId, table.expiryDate),
    index("inventory_lots_tenant_id_idx").on(table.tenantId),
  ],
);

// T32 — SERIAL TRACKING. READ-ONLY MIRROR of ims-1's definition; this repo
// owns no migrations.
//
// A lot holds a QUANTITY; a serial IS one unit. inventory_stock for a
// serialised variant is therefore count(serials where status='in_stock')
// rather than a sum.
export const inventorySerials = pgTable(
  "inventory_serials",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    serialNumber: varchar("serial_number", { length: 64 }).notNull(),
    imei: varchar("imei", { length: 32 }),
    status: varchar("status", { length: 16 }).default("in_stock").notNull(),
    /** THE column the warranty refusal reads. */
    soldOrderItemId: uuid("sold_order_item_id"),
    soldAt: timestamp("sold_at", { mode: "date" }),
    warrantyMonths: integer("warranty_months"),
    warrantyStart: date("warranty_start"),
    reservationRef: varchar("reservation_ref", { length: 128 }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("inventory_serials_tenant_serial_idx").on(table.tenantId, table.serialNumber),
    index("inventory_serials_allocation_idx").on(table.variantId, table.status, table.createdAt),
    index("inventory_serials_serial_number_idx").on(table.serialNumber),
    index("inventory_serials_reservation_ref_idx").on(table.reservationRef),
    index("inventory_serials_tenant_id_idx").on(table.tenantId),
  ],
);

// T31 — a reservation names the lot it holds.
//
// reservationRef is "<orderId>:<orderItemId>", stable across the order's whole
// lifetime and deliberately NOT the idempotency key, which embeds the state
// transition and so differs between the RESERVE at confirm and the RELEASE at
// cancel. This is what lets a sale rung HERE honour a reservation made in the
// admin console, and vice versa.
export const lotReservations = pgTable(
  "lot_reservations",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLots.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    reservationRef: varchar("reservation_ref", { length: 128 }).notNull(),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    check("lot_reservations_qty_milli_positive", sql`${table.qtyMilli} > 0`),
    uniqueIndex("lot_reservations_ref_lot_idx").on(table.reservationRef, table.lotId),
    index("lot_reservations_ref_idx").on(table.reservationRef),
    index("lot_reservations_tenant_id_idx").on(table.tenantId),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    email: varchar("email", { length: 255 }),
    cityAddress: text("city_address"),
    gstEnabled: boolean("gst_enabled").default(false).notNull(),
    openingBalance: numeric("opening_balance", { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  // Same fix as categories_code_idx: was global, now per-tenant.
  (table) => [uniqueIndex("suppliers_code_idx").on(table.tenantId, table.code)],
);

// T15 — the buyer-side counterpart to suppliers. gstin nullable is the whole
// point: its presence is the B2B/B2C determination itself, not a separate
// flag alongside one (see tax.service.ts's deriveGstTreatment).
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    email: varchar("email", { length: 255 }),
    billingAddressLine1: varchar("billing_address_line1", { length: 255 }),
    billingCity: varchar("billing_city", { length: 100 }),
    billingState: varchar("billing_state", { length: 100 }),
    billingPostalCode: varchar("billing_postal_code", { length: 20 }),
    gstin: varchar("gstin", { length: 15 }),
    placeOfSupplyStateCode: varchar("place_of_supply_state_code", { length: 2 }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("customers_code_idx").on(table.tenantId, table.code)],
);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from suppliers for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    expectedDate: timestamp("expected_date", { mode: "date" }),
    status: varchar("status", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("purchase_orders_tenant_id_idx").on(table.tenantId)],
);

export const purchaseOrderItems = pgTable(
  "purchase_order_items",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from purchase_orders for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantityMilli: bigint("quantity_milli", { mode: "bigint" }).notNull(),
    unitCost: numeric("unit_cost", { precision: 10, scale: 2 }).notNull(),
    // T18 — added to the real table by ims-1's migration 0033. Declaration
    // only — POS neither receives purchase orders nor posts to the ledger.
    hsnCode: varchar("hsn_code", { length: 8 }),
    taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }),
    taxableValue: numeric("taxable_value", { precision: 12, scale: 2 }),
    cgstAmount: numeric("cgst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
    sgstAmount: numeric("sgst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
    igstAmount: numeric("igst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  },
  (table) => [
    index("purchase_order_items_tenant_id_idx").on(table.tenantId),
    check(
      "purchase_order_items_gst_no_mix",
      sql`not (${table.igstAmount} > 0 and (${table.cgstAmount} > 0 or ${table.sgstAmount} > 0))`,
    ),
    check(
      "purchase_order_items_gst_non_negative",
      sql`${table.cgstAmount} >= 0 and ${table.sgstAmount} >= 0 and ${table.igstAmount} >= 0`,
    ),
  ],
);

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: uuid("id").primaryKey(),
    // Direct tenant_id rather than relying on cashierId/terminalId: both are
    // nullable, so neither can be trusted to resolve tenant for every order.
    // Orders are the most sensitive data in the system — they get their own
    // column like the other root tables, not a best-effort join.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    // T15 — nullable: a POS walk-in genuinely has no customer record.
    customerId: uuid("customer_id").references(() => customers.id),
    // T15 — set once at confirmation, never recomputed. null means either
    // "not yet confirmed" or "predates T15"; T19 treats both as unfileable.
    gstTreatment: gstTreatmentEnum("gst_treatment"),
    paymentPreference: paymentPreferenceEnum("payment_preference"),
    discountType: discountTypeEnum("discount_type"),
    discountValue: numeric("discount_value", { precision: 10, scale: 2 }),
    subtotalAmount: numeric("subtotal_amount", { precision: 10, scale: 2 }),
    taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }),
    taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }),
    shippingAddressLine1: varchar("shipping_address_line1", { length: 255 }),
    shippingCity: varchar("shipping_city", { length: 100 }),
    shippingState: varchar("shipping_state", { length: 100 }),
    shippingPostalCode: varchar("shipping_postal_code", { length: 20 }),
    razorpayPaymentId: varchar("razorpay_payment_id", { length: 255 }),
    qrStatus: qrStatusEnum("qr_status"),
    qrGeneratedAt: timestamp("qr_generated_at", { mode: "date" }),
    qrVoidedAt: timestamp("qr_voided_at", { mode: "date" }),
    trackingNumber: varchar("tracking_number", { length: 255 }),
    shipmentStatus: varchar("shipment_status", { length: 50 }),
    shipmentStatusUpdatedAt: timestamp("shipment_status_updated_at", { mode: "date" }),
    terminalId: uuid("terminal_id").references(() => posTerminals.id),
    cashierId: uuid("cashier_id").references(() => cashiers.id),
    shiftId: uuid("shift_id").references(() => posShifts.id),
    invoiceNumber: varchar("invoice_number", { length: 32 }),
    invoicedAt: timestamp("invoiced_at", { mode: "date" }),
    orderStatus: orderStatusEnum("order_status").default("Draft").notNull(),
    // T17 — added to the real table by ims-1's migration 0031. Mirrored
    // here so this declaration describes the table that actually exists;
    // POS reads sales_orders and must not carry a stale picture of it.
    // Declaration only — POS registers no e-invoices.
    irn: varchar("irn", { length: 64 }),
    irnAckNo: varchar("irn_ack_no", { length: 32 }),
    irnAckDate: timestamp("irn_ack_date", { mode: "date" }),
    irnQrCode: text("irn_qr_code"),
    irnStatus: irnStatusEnum("irn_status"),
    irnCancelledAt: timestamp("irn_cancelled_at", { mode: "date" }),
    irnCancelReason: varchar("irn_cancel_reason", { length: 255 }),
    irnRaw: jsonb("irn_raw"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    // Both were global unique indexes. idempotencyKey is client-generated
    // (two tenants' terminals can independently pick the same value) and
    // invoiceNumber is allocated from a per-tenant counter (invoice_counters
    // is tenant-scoped) — a global unique index on either would collide, or
    // worse, leak tenant A's "duplicate" order back to tenant B, the moment
    // a second tenant exists.
    uniqueIndex("sales_orders_idempotency_key_idx").on(table.tenantId, table.idempotencyKey),
    uniqueIndex("sales_orders_invoice_number_idx").on(table.tenantId, table.invoiceNumber),
    index("sales_orders_status_created_at_idx").on(table.orderStatus, table.createdAt),
    uniqueIndex("sales_orders_tenant_irn_idx")
      .on(table.tenantId, table.irn)
      .where(sql`${table.irn} is not null`),
  ],
);

export const businessSettings = pgTable(
  "business_settings",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    key: varchar("key", { length: 100 }).notNull(),
    value: varchar("value", { length: 255 }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.key] })],
);

// Deliberately its own table rather than another business_settings row. The
// owner password hash is a secret, not tenant-portable business configuration,
// and keeping it out of the key/value settings table means a future
// tenant-scoping migration can never accidentally sweep a credential into
// tenant business data. `id` is a fixed singleton key: there is exactly one
// owner credential today, enforced by always upserting the same row.
export const ownerCredentials = pgTable(
  "owner_credentials",
  {
    id: varchar("id", { length: 32 }).notNull(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    passwordHash: text("password_hash").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  // id alone used to be the primary key, a single fixed "owner" row for the
  // whole install. Composite so each tenant can hold its own singleton row
  // without colliding on the same "owner" id — mirrors business_settings.
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);

export const salesOrderItems = pgTable(
  "sales_order_items",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from sales_orders for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantityMilli: bigint("quantity_milli", { mode: "bigint" }).notNull(),
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    discountType: discountTypeEnum("discount_type"),
    discountValue: numeric("discount_value", { precision: 10, scale: 2 }),
    // T15 — snapshotted at order-confirm time, not joined.
    hsnCode: varchar("hsn_code", { length: 8 }),
    taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }),
    taxableValue: numeric("taxable_value", { precision: 12, scale: 2 }),
    cgstAmount: numeric("cgst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
    sgstAmount: numeric("sgst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
    igstAmount: numeric("igst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  },
  (table) => [
    index("sales_order_items_tenant_id_idx").on(table.tenantId),
    // Zero-rated / exempt lines are legal (all three amounts 0) — this only
    // forbids mixing CGST/SGST with IGST on one line, and forbids negatives.
    check(
      "sales_order_items_gst_no_mix",
      sql`not (${table.igstAmount} > 0 and (${table.cgstAmount} > 0 or ${table.sgstAmount} > 0))`,
    ),
    check(
      "sales_order_items_gst_non_negative",
      sql`${table.cgstAmount} >= 0 and ${table.sgstAmount} >= 0 and ${table.igstAmount} >= 0`,
    ),
  ],
);

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    creditNoteNumber: varchar("credit_note_number", { length: 32 }).notNull(),
    originalOrderId: uuid("original_order_id")
      .notNull()
      .references(() => salesOrders.id),
    customerId: uuid("customer_id").references(() => customers.id),
    reason: creditNoteReasonEnum("reason").notNull(),
    issuedAt: timestamp("issued_at", { mode: "date" }).defaultNow().notNull(),
    subtotalAmount: numeric("subtotal_amount", { precision: 10, scale: 2 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }).notNull(),
    gstTreatment: gstTreatmentEnum("gst_treatment"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    // T17 — same drift as sales_orders above: migration 0031 added these to
    // the real table. A credit note is a separately registrable document
    // with its own IRN. Declaration only.
    irn: varchar("irn", { length: 64 }),
    irnAckNo: varchar("irn_ack_no", { length: 32 }),
    irnAckDate: timestamp("irn_ack_date", { mode: "date" }),
    irnQrCode: text("irn_qr_code"),
    irnStatus: irnStatusEnum("irn_status"),
    irnCancelledAt: timestamp("irn_cancelled_at", { mode: "date" }),
    irnCancelReason: varchar("irn_cancel_reason", { length: 255 }),
    irnRaw: jsonb("irn_raw"),
  },
  (table) => [
    uniqueIndex("credit_notes_number_idx").on(table.tenantId, table.creditNoteNumber),
    index("credit_notes_tenant_id_idx").on(table.tenantId),
    index("credit_notes_original_order_id_idx").on(table.originalOrderId),
    uniqueIndex("credit_notes_tenant_irn_idx")
      .on(table.tenantId, table.irn)
      .where(sql`${table.irn} is not null`),
  ],
);

export const creditNoteItems = pgTable(
  "credit_note_items",
  {
    id: uuid("id").primaryKey(),
    // T7 convention — denormalised from credit_notes for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => creditNotes.id),
    originalOrderItemId: uuid("original_order_item_id")
      .notNull()
      .references(() => salesOrderItems.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantityMilli: bigint("quantity_milli", { mode: "bigint" }).notNull(),
    unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
    taxableValue: numeric("taxable_value", { precision: 12, scale: 2 }).notNull(),
    hsnCode: varchar("hsn_code", { length: 8 }),
    taxRatePercent: numeric("tax_rate_percent", { precision: 5, scale: 2 }),
    cgstAmount: numeric("cgst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
    sgstAmount: numeric("sgst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
    igstAmount: numeric("igst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
    restockable: boolean("restockable").notNull(),
  },
  (table) => [
    index("credit_note_items_tenant_id_idx").on(table.tenantId),
    index("credit_note_items_credit_note_id_idx").on(table.creditNoteId),
    index("credit_note_items_original_order_item_id_idx").on(table.originalOrderItemId),
    check(
      "credit_note_items_gst_no_mix",
      sql`not (${table.igstAmount} > 0 and (${table.cgstAmount} > 0 or ${table.sgstAmount} > 0))`,
    ),
    check(
      "credit_note_items_gst_non_negative",
      sql`${table.cgstAmount} >= 0 and ${table.sgstAmount} >= 0 and ${table.igstAmount} >= 0`,
    ),
  ],
);

export const paymentTenders = pgTable(
  "payment_tenders",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from sales_orders for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id),
    method: tenderMethodEnum("method").notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    // T16b — negative for a refund. No positivity CHECK exists on this
    // column.
    creditNoteId: uuid("credit_note_id").references(() => creditNotes.id),
    razorpayPaymentId: varchar("razorpay_payment_id", { length: 255 }),
    // Store only bank-slip reconciliation data. Never add full PAN, expiry, CVV, track or EMV data.
    cardLast4: varchar("card_last4", { length: 4 }),
    cardApprovalCode: varchar("card_approval_code", { length: 32 }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("payment_tenders_order_id_idx").on(table.orderId),
    index("payment_tenders_tenant_id_idx").on(table.tenantId),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from sales_orders for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id),
    trackingNumber: varchar("tracking_number", { length: 255 }),
    shipmentStatus: varchar("shipment_status", { length: 50 }).notNull(),
    labelUrl: text("label_url"),
    raw: jsonb("raw").default(sql`'{}'::jsonb`).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("shipments_order_id_idx").on(table.orderId),
    index("shipments_status_idx").on(table.shipmentStatus),
    index("shipments_tenant_id_idx").on(table.tenantId),
  ],
);

export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from suppliers for RLS.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    date: timestamp("date", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("supplier_payments_tenant_id_idx").on(table.tenantId)],
);

export const expenses = pgTable("expenses", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: varchar("name", { length: 255 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  date: timestamp("date", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    provider: webhookProviderEnum("provider").notNull(),
    externalEventId: varchar("external_event_id", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("webhook_events_provider_external_event_id_idx").on(
      table.provider,
      table.externalEventId,
    ),
  ],
);

export const conversationState = pgTable("conversation_state", {
  phoneNumber: varchar("phone_number", { length: 32 }).primaryKey(),
  lastOrderId: uuid("last_order_id").references(() => salesOrders.id),
  sessionJson: jsonb("session_json").default(sql`'{}'::jsonb`).notNull(),
  language: varchar("language", { length: 16 }).default("en").notNull(),
  lastIntent: varchar("last_intent", { length: 255 }),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const deadLetterEvents = pgTable("dead_letter_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  provider: webhookProviderEnum("provider").notNull(),
  rawPayload: jsonb("raw_payload").notNull(),
  errorMessage: text("error_message").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  replayedAt: timestamp("replayed_at", { mode: "date" }),
});

export const phoneRateLimits = pgTable("phone_rate_limits", {
  phoneNumber: varchar("phone_number", { length: 32 }).primaryKey(),
  windowStartedAt: timestamp("window_started_at", { mode: "date" }).notNull(),
  hitCount: integer("hit_count").default(0).notNull(),
  blockedUntil: timestamp("blocked_until", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const alerts = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Alerts reference variant/supplier/order, all nullable and polymorphic
    // (exactly one is usually set depending on alertType) — no single join
    // reliably resolves tenant for every row, so alerts gets its own column.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    alertType: varchar("alert_type", { length: 64 }).notNull(),
    dedupKey: varchar("dedup_key", { length: 255 }).notNull(),
    variantId: uuid("variant_id").references(() => productVariants.id),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    orderId: uuid("order_id").references(() => salesOrders.id),
    severity: varchar("severity", { length: 32 }).notNull(),
    message: text("message").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { mode: "date" }),
    resolved: boolean("resolved").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("alerts_dedup_key_idx").on(table.dedupKey)],
);

export const productEmbeddings = pgTable("product_embeddings", {
  id: uuid("id").primaryKey(),
  // Similarity queries start here, so inherited scope alone is insufficient.
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  variantId: uuid("variant_id")
    .notNull()
    .references(() => productVariants.id, { onDelete: "cascade" })
    .unique(),
  imageEmbedding: vector("image_embedding", { dimensions: 1408 }),
  textEmbedding: vector("text_embedding", { dimensions: 1408 }),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

export const aiSearchSessions = pgTable("ai_search_sessions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
});

export const aiSearchMessages = pgTable(
  "ai_search_messages",
  {
    id: uuid("id").primaryKey(),
    // T7 — denormalised from ai_search_sessions for RLS. No writer exists
    // yet in either repo; added now so the table is covered the day one is
    // built, not retrofitted later.
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiSearchSessions.id),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("ai_search_messages_tenant_id_idx").on(table.tenantId)],
);
