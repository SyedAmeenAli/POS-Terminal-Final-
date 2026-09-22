import { beforeEach, describe, expect, it, vi } from "vitest";

const txState = vi.hoisted(() => ({
  executeCalls: 0,
  insertedTenders: [] as unknown[],
  order: {
    createdAt: new Date("2026-07-28T00:00:00.000Z"),
    discountType: null,
    discountValue: null,
    id: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "create-1",
    orderStatus: "Pending",
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
    subtotalAmount: "1200.00",
    taxAmount: "0.00",
    taxRatePercent: "0.00",
    trackingNumber: null,
  },
  stockAdjustments: 0,
}));

vi.mock("../application/services/audit-log.service.js", () => ({
  logAudit: vi.fn(),
}));

vi.mock("../application/services/inventory.service.js", () => ({
  INTERNAL_IDEMPOTENCY_PROVIDER: "razorpay",
  adjustStockInTransaction: vi.fn(async () => {
    txState.stockAdjustments += 1;
  }),
}));

vi.mock("../infrastructure/database/db.js", async () => {
  const schema = await import("../infrastructure/database/schema.js");
  const items = [
    {
      discountType: null,
      discountValue: null,
      id: "22222222-2222-4222-8222-222222222222",
      orderId: txState.order.id,
      quantityMilli: 1000n,
      sku: "SKU-1",
      unitPrice: "1200.00",
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
        return Promise.resolve([txState.order]);
      },
      offset() {
        return builder;
      },
      orderBy() {
        return Promise.resolve([txState.order]);
      },
      where() {
        if (selectedTable === schema.salesOrders) {
          return builder;
        }

        if (selectedTable === schema.salesOrderItems || joined) {
          return Promise.resolve(items);
        }

        if (selectedTable === schema.paymentTenders) {
          return Promise.resolve(txState.insertedTenders);
        }

        return Promise.resolve([txState.order]);
      },
    };

    return builder;
  };

  const tx = {
    execute: vi.fn(async () => {
      txState.executeCalls += 1;
      if (txState.executeCalls === 1) return { rows: [] };
      return { rows: [txState.order] };
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        if (table === schema.paymentTenders) {
          txState.insertedTenders.push(...(Array.isArray(values) ? values : [values]));
        }
      }),
    })),
    select: vi.fn(makeSelect),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => {
          txState.order = { ...txState.order, orderStatus: "Paid" };
        }),
      })),
    })),
  };

  return {
    db: {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    },
  };
});

describe("payOrder split tenders", () => {
  beforeEach(() => {
    txState.executeCalls = 0;
    txState.insertedTenders = [];
    txState.stockAdjustments = 0;
    txState.order = {
      ...txState.order,
      orderStatus: "Pending",
      paymentPreference: "cash",
      razorpayPaymentId: null,
    };
  });

  it("records three tender rows and marks the order Paid", async () => {
    const { payOrder } = await import("../application/services/order.service.js");

    const result = await payOrder("99999999-9999-4999-8999-999999999999", txState.order.id, {
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "pay-split",
      tenders: [
        { amount: "500.00", method: "cash" },
        { amount: "600.00", method: "UPI", razorpayPaymentId: "upi-1" },
        { amount: "100.00", method: "cash" },
      ],
    });

    expect(result.order.orderStatus).toBe("Paid");
    expect(txState.insertedTenders).toHaveLength(3);
    expect(txState.insertedTenders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: "500.00", method: "cash" }),
        expect.objectContaining({ amount: "600.00", method: "UPI", razorpayPaymentId: "upi-1" }),
        expect.objectContaining({ amount: "100.00", method: "cash" }),
      ]),
    );
  });

  it("rejects a short split without inserting partial tender rows", async () => {
    const { payOrder } = await import("../application/services/order.service.js");

    await expect(
      payOrder("99999999-9999-4999-8999-999999999999", txState.order.id, {
        actorUserId: "44444444-4444-4444-8444-444444444444",
        idempotencyKey: "pay-short",
        tenders: [
          { amount: "500.00", method: "cash" },
          { amount: "699.00", method: "UPI" },
        ],
      }),
    ).rejects.toMatchObject({
      errorType: "TENDER_AMOUNT_MISMATCH",
      statusCode: 422,
    });

    expect(txState.order.orderStatus).toBe("Pending");
    expect(txState.insertedTenders).toHaveLength(0);
    expect(txState.stockAdjustments).toBe(0);
  });

  it("omitted tenders insert one synthetic tender matching paymentPreference", async () => {
    const { payOrder } = await import("../application/services/order.service.js");

    await payOrder("99999999-9999-4999-8999-999999999999", txState.order.id, {
      actorUserId: "44444444-4444-4444-8444-444444444444",
      idempotencyKey: "pay-legacy",
    });

    expect(txState.insertedTenders).toHaveLength(1);
    expect(txState.insertedTenders[0]).toEqual(
      expect.objectContaining({
        amount: "1200.00",
        method: "cash",
        orderId: txState.order.id,
      }),
    );
  });
});
