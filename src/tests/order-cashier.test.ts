import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getCashier: vi.fn(),
  insertedOrder: undefined as Record<string, unknown> | undefined,
  logAudit: vi.fn(),
  salesOrderSelectCalls: 0,
}));

vi.mock("../application/services/audit-log.service.js", () => ({
  logAudit: state.logAudit,
}));

vi.mock("../application/services/business-settings.service.js", () => ({
  getTaxRatePercent: vi.fn(async () => "0.00"),
}));

vi.mock("../application/services/cashier.service.js", () => ({
  getActiveCashierForAttribution: state.getCashier,
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
  const items = [
    {
      discountType: null,
      discountValue: null,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Black Tee",
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      quantityMilli: 1000n,
      sku: "SKU-1",
      unitPrice: "100.00",
      variantId: "11111111-1111-4111-8111-111111111111",
    },
  ];

  const buildOrder = () => ({
    cashierId: (state.insertedOrder?.cashierId as string | null | undefined) ?? null,
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    discountType: null,
    discountValue: null,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    idempotencyKey: "create-cashier",
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
  });

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
              : Promise.resolve([buildOrder()]);
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

describe("order cashier attribution", () => {
  beforeEach(() => {
    state.getCashier.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Asha",
    });
    state.insertedOrder = undefined;
    state.logAudit.mockClear();
    state.salesOrderSelectCalls = 0;
  });

  it("writes cashier id and audit metadata when a cashier is supplied", async () => {
    const { createOrder } = await import("../application/services/order.service.js");

    await createOrder("99999999-9999-4999-8999-999999999999", {
      actorUserId: "99999999-9999-4999-8999-999999999999",
      cashierId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      idempotencyKey: "create-cashier",
      items: [{ quantity: 1, variantId: "11111111-1111-4111-8111-111111111111" }],
      paymentPreference: "cash",
      terminalId: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
    });

    expect(state.insertedOrder).toEqual(
      expect.objectContaining({ cashierId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    );
    expect(state.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          cashierId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          cashierName: "Asha",
        }),
      }),
      expect.anything(),
    );
  });

  it("rejects a disabled cashier before creating the order", async () => {
    const { AppError } = await import("../api/errors.js");
    state.getCashier.mockRejectedValueOnce(new AppError(401, "Cashier not accepted"));
    const { createOrder } = await import("../application/services/order.service.js");

    await expect(
      createOrder("99999999-9999-4999-8999-999999999999", {
        cashierId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        idempotencyKey: "create-disabled-cashier",
        items: [{ quantity: 1, variantId: "11111111-1111-4111-8111-111111111111" }],
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(state.insertedOrder).toBeUndefined();
  });

  it("allows an order with no cashier and stores null", async () => {
    const { createOrder } = await import("../application/services/order.service.js");

    await createOrder("99999999-9999-4999-8999-999999999999", {
      idempotencyKey: "create-no-cashier",
      items: [{ quantity: 1, variantId: "11111111-1111-4111-8111-111111111111" }],
    });

    expect(state.insertedOrder).toEqual(expect.objectContaining({ cashierId: null }));
  });
});
