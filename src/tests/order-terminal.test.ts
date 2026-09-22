import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  insertedOrder: undefined as Record<string, unknown> | undefined,
  salesOrderSelectCalls: 0,
}));

vi.mock("../application/services/audit-log.service.js", () => ({
  logAudit: vi.fn(),
}));

vi.mock("../application/services/business-settings.service.js", () => ({
  getTaxRatePercent: vi.fn(async () => "0.00"),
}));

vi.mock("../application/services/inventory.service.js", () => ({
  INTERNAL_IDEMPOTENCY_PROVIDER: "razorpay",
  adjustStockInTransaction: vi.fn(),
}));

vi.mock("../infrastructure/adapters/integration-factories.js", () => ({
  createEmailPort: vi.fn(),
  createPaymentPort: vi.fn(),
}));

vi.mock("../infrastructure/database/db.js", async () => {
  const schema = await import("../infrastructure/database/schema.js");
  const order = {
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    discountType: null,
    discountValue: null,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    idempotencyKey: "create-terminal",
    orderStatus: "Draft",
    paymentPreference: "cash",
    qrGeneratedAt: null,
    qrStatus: null,
    qrVoidedAt: null,
    razorpayPaymentId: null,
    shipmentStatus: null,
    shippingAddressLine1: null,
    shippingCity: null,
    shippingPostalCode: null,
    shippingState: null,
    subtotalAmount: null,
    taxAmount: null,
    taxRatePercent: null,
    terminalId: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
    trackingNumber: null,
  };
  const items = [
    {
      discountType: null,
      discountValue: null,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Black Tee",
      orderId: order.id,
      quantityMilli: 1000n,
      sku: "SKU-1",
      unitPrice: "100.00",
      variantId: "11111111-1111-4111-8111-111111111111",
    },
  ];

  const tx = {
    insert: vi.fn((table: unknown) => ({
      values(value: Record<string, unknown> | Array<Record<string, unknown>>) {
        if (table === schema.salesOrders) {
          state.insertedOrder = value as Record<string, unknown>;
        }

        return Promise.resolve([]);
      },
    })),
    select: vi.fn(() => ({
      from(table: unknown) {
        return {
          innerJoin() {
            return this;
          },
          limit() {
            return table === schema.salesOrders && state.salesOrderSelectCalls++ === 0
              ? Promise.resolve([])
              : Promise.resolve([order]);
          },
          where() {
            if (table === schema.productVariants) {
              return Promise.resolve([
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  retailPrice: "100.00",
                  sku: "SKU-1",
                },
              ]);
            }

            if (table === schema.salesOrderItems) {
              return Promise.resolve(items);
            }

            if (table === schema.paymentTenders) {
              return Promise.resolve([]);
            }

            return this;
          },
        };
      },
    })),
  };

  return {
    db: {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    },
  };
});

describe("order terminal persistence", () => {
  it("writes terminal id on order creation", async () => {
    const { createOrder } = await import("../application/services/order.service.js");

    await createOrder("99999999-9999-4999-8999-999999999999", {
      idempotencyKey: "create-terminal",
      items: [{ quantity: 1, variantId: "11111111-1111-4111-8111-111111111111" }],
      paymentPreference: "cash",
      terminalId: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
    });

    expect(state.insertedOrder).toEqual(
      expect.objectContaining({ terminalId: "tttttttt-tttt-4ttt-8ttt-tttttttttttt" }),
    );
  });
});
