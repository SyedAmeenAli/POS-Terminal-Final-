import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  order: {
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    discountType: null,
    discountValue: null,
    id: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "create-1",
    orderStatus: "Paid",
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
    subtotalAmount: "1000.00",
    taxAmount: "180.00",
    taxRatePercent: "18.00",
    trackingNumber: null,
  },
  sendReceipt: vi.fn(),
}));

vi.mock("../application/services/audit-log.service.js", () => ({
  logAudit: vi.fn(),
}));

vi.mock("../application/services/inventory.service.js", () => ({
  INTERNAL_IDEMPOTENCY_PROVIDER: "razorpay",
  adjustStockInTransaction: vi.fn(),
}));

vi.mock("../infrastructure/adapters/integration-factories.js", () => ({
  createEmailPort: vi.fn(() => ({
    sendReceipt: state.sendReceipt,
  })),
  createPaymentPort: vi.fn(),
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

  return {
    db: {
      select: vi.fn(makeSelect),
      transaction: vi.fn(),
    },
  };
});

describe("emailOrderReceipt", () => {
  beforeEach(() => {
    state.order = { ...state.order, orderStatus: "Paid" };
    state.sendReceipt.mockResolvedValue({
      errorType: "EMAIL_DELIVERY_FAILED",
      message: "Email provider request failed.",
      success: false,
    });
  });

  it("email send failure does not mutate paid order status", async () => {
    const { emailOrderReceipt } = await import("../application/services/order.service.js");

    const result = await emailOrderReceipt(
      "99999999-9999-4999-8999-999999999999",
      state.order.id,
      "customer@example.com",
    );

    expect(result).toMatchObject({
      errorType: "EMAIL_DELIVERY_FAILED",
      success: false,
    });
    expect(state.order.orderStatus).toBe("Paid");
    expect(state.sendReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ name: "Black Tee", sku: "TEE-BLK-M" })],
        to: "customer@example.com",
        taxAmount: "180.00",
        taxRatePercent: "18.00",
        total: "1180.00",
      }),
    );
  });
});
