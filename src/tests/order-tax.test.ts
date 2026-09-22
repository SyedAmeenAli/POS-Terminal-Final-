import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executeCalls: 0,
  getTaxRatePercent: vi.fn(),
  // T15 — confirmOrder now also resolves the seller's GST state code. No
  // seller state configured (null) means every order in this test is
  // treated as intra-state, matching the pre-T15 behaviour these tests
  // already assert.
  getSellerStateCode: vi.fn(),
  order: {
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    discountType: null,
    discountValue: null,
    id: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "create-1",
    orderStatus: "Draft",
    paymentPreference: "cash",
    qrGeneratedAt: null,
    qrStatus: null,
    qrVoidedAt: null,
    razorpayPaymentId: null,
    shipmentStatus: null,
    shippingAddressLine1: "Line 1",
    shippingCity: "City",
    shippingPostalCode: "560001",
    shippingState: "State",
    subtotalAmount: null as string | null,
    taxAmount: null as string | null,
    taxRatePercent: null as string | null,
    trackingNumber: null,
  },
}));

vi.mock("../application/services/business-settings.service.js", () => ({
  getSellerStateCode: state.getSellerStateCode,
  getTaxRatePercent: state.getTaxRatePercent,
}));

vi.mock("../application/services/audit-log.service.js", () => ({
  logAudit: vi.fn(),
}));

vi.mock("../application/services/inventory.service.js", () => ({
  INTERNAL_IDEMPOTENCY_PROVIDER: "razorpay",
  adjustStockInTransaction: vi.fn(),
}));

vi.mock("../infrastructure/database/db.js", async () => {
  const schema = await import("../infrastructure/database/schema.js");
  const items = [
    {
      discountType: null,
      discountValue: null,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Black Tee",
      orderId: state.order.id,
      quantityMilli: 1000n,
      sku: "TEE-BLK-M",
      unitPrice: "1000.00",
      variantId: "33333333-3333-4333-8333-333333333333",
    },
  ];

  const makeSelect = () => {
    let selectedTable: unknown;
    let joined = false;
    const builder = {
      from(table: unknown) {
        selectedTable = table;
        return builder;
      },
      innerJoin() {
        joined = true;
        return builder;
      },
      limit() {
        return Promise.resolve([state.order]);
      },
      where() {
        if (selectedTable === schema.salesOrders) return builder;
        if (selectedTable === schema.salesOrderItems || joined) return Promise.resolve(items);
        if (selectedTable === schema.paymentTenders) return Promise.resolve([]);
        return Promise.resolve([]);
      },
    };
    return builder;
  };

  const tx = {
    execute: vi.fn(async () => {
      state.executeCalls += 1;
      return { rows: state.executeCalls === 1 ? [] : [state.order] };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
    select: vi.fn(makeSelect),
    update: vi.fn(() => ({
      set: vi.fn((patch: Partial<typeof state.order>) => ({
        where: vi.fn(async () => {
          state.order = { ...state.order, ...patch };
        }),
      })),
    })),
  };

  return {
    db: {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
      select: vi.fn(makeSelect),
    },
  };
});

describe("confirmOrder GST tax capture", () => {
  beforeEach(() => {
    state.order = {
      ...state.order,
      orderStatus: "Draft",
      subtotalAmount: null,
      taxAmount: null,
      taxRatePercent: null,
    };
    state.executeCalls = 0;
    state.getTaxRatePercent.mockResolvedValue("18.00");
    state.getSellerStateCode.mockResolvedValue(null);
  });

  it("writes 18% tax for a 1000 subtotal", async () => {
    const { confirmOrder } = await import("../application/services/order.service.js");

    const result = await confirmOrder("55555555-5555-4555-8555-555555555555", state.order.id, {
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "confirm-tax",
    });

    expect(result.order.subtotalAmount).toBe(1000);
    expect(result.order.taxRatePercent).toBe(18);
    expect(result.order.taxAmount).toBe(180);
    expect(result.order.total).toBe(1180);
  });

  it("defaults unset tax rate to zero", async () => {
    state.getTaxRatePercent.mockResolvedValueOnce("0.00");
    const { confirmOrder } = await import("../application/services/order.service.js");

    const result = await confirmOrder("55555555-5555-4555-8555-555555555555", state.order.id, {
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "confirm-zero-tax",
    });

    expect(result.order.taxAmount).toBe(0);
    expect(result.order.total).toBe(1000);
  });

  it("freezes stored tax when global rate later changes", async () => {
    const { confirmOrder, getOrder } = await import("../application/services/order.service.js");
    await confirmOrder("55555555-5555-4555-8555-555555555555", state.order.id, {
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "confirm-freeze-tax",
    });
    state.getTaxRatePercent.mockResolvedValue("28.00");

    const fetched = await getOrder("55555555-5555-4555-8555-555555555555", state.order.id);

    expect(fetched.taxRatePercent).toBe(18);
    expect(fetched.taxAmount).toBe(180);
    expect(fetched.total).toBe(1180);
  });
});
