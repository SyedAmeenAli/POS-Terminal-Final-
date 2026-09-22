import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cancelOrder: vi.fn(),
  confirmOrder: vi.fn(),
  createOrder: vi.fn(),
  createOrderRequiresOwnerOverride: vi.fn(),
  emailOrderReceipt: vi.fn(),
  generatePaymentQr: vi.fn(),
  getOwnerPasswordHash: vi.fn(),
  getOrder: vi.fn(),
  getOrderStatus: vi.fn(),
  listOrders: vi.fn(),
  orderDiscountRequiresOwnerOverride: vi.fn(),
  payOrder: vi.fn(),
  returnOrder: vi.fn(),
  voidPaymentQr: vi.fn(),
}));

vi.mock("../application/services/order.service.js", () => state);
vi.mock("../application/services/owner-credentials.service.js", () => ({
  getOwnerPasswordHash: state.getOwnerPasswordHash,
}));

describe("order route discount validation", () => {
  beforeEach(() => {
    state.createOrder.mockResolvedValue({
      duplicate: false,
      order: { id: "o1", items: [] },
    });
    state.createOrderRequiresOwnerOverride.mockResolvedValue(false);
    state.orderDiscountRequiresOwnerOverride.mockResolvedValue(false);
    state.getOrderStatus.mockResolvedValue("Pending");
    state.getOwnerPasswordHash.mockResolvedValue(null);
    state.emailOrderReceipt.mockResolvedValue({
      data: { messageId: "email_1" },
      success: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accepts line and order discounts on create", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const response = await server.inject({
      method: "POST",
      url: "/orders",
      payload: {
        idempotencyKey: "idemp-1",
        paymentPreference: "cash",
        discountType: "flat",
        discountValue: 10,
        items: [
          {
            variantId: "11111111-1111-4111-8111-111111111111",
            quantity: 2,
            discountType: "percent",
            discountValue: 10,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(state.createOrder).toHaveBeenCalledWith(undefined, {
      idempotencyKey: "idemp-1",
      paymentPreference: "cash",
      discountType: "flat",
      discountValue: 10,
      items: [
        {
          variantId: "11111111-1111-4111-8111-111111111111",
          quantity: 2,
          discountType: "percent",
          discountValue: 10,
        },
      ],
    });
  });

  it("rejects percent discount over 100", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const response = await server.inject({
      method: "POST",
      url: "/orders",
      payload: {
        idempotencyKey: "idemp-2",
        items: [
          {
            variantId: "11111111-1111-4111-8111-111111111111",
            quantity: 1,
            discountType: "percent",
            discountValue: 120,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(state.createOrder).not.toHaveBeenCalled();
  });

  it("requires owner override when create discount exceeds threshold", async () => {
    state.createOrderRequiresOwnerOverride.mockResolvedValue(true);
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const response = await server.inject({
      method: "POST",
      url: "/orders",
      payload: {
        idempotencyKey: "idemp-owner",
        items: [{ quantity: 1, variantId: "11111111-1111-4111-8111-111111111111" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorType: "OWNER_PASSWORD_NOT_SET" });
    expect(state.createOrder).not.toHaveBeenCalled();
  });

  it("requires owner override when persisted order discount exceeds threshold on confirm", async () => {
    state.orderDiscountRequiresOwnerOverride.mockResolvedValue(true);
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const response = await server.inject({
      method: "PATCH",
      url: "/orders/11111111-1111-4111-8111-111111111111/confirm",
      payload: { idempotencyKey: "confirm-owner" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorType: "OWNER_PASSWORD_NOT_SET" });
    expect(state.confirmOrder).not.toHaveBeenCalled();
  });

  it("sends receipt email for paid orders", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const response = await server.inject({
      method: "POST",
      url: "/orders/11111111-1111-4111-8111-111111111111/email-receipt",
      payload: { email: "customer@example.com" },
    });

    expect(response.statusCode).toBe(200);
    expect(state.emailOrderReceipt).toHaveBeenCalledWith(
      undefined,
      "11111111-1111-4111-8111-111111111111",
      "customer@example.com",
    );
  });

  it("maps receipt email delivery failures as soft integration errors", async () => {
    state.emailOrderReceipt.mockResolvedValueOnce({
      errorType: "EMAIL_DELIVERY_FAILED",
      message: "Email provider request failed.",
      success: false,
    });
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const response = await server.inject({
      method: "POST",
      url: "/orders/11111111-1111-4111-8111-111111111111/email-receipt",
      payload: { email: "customer@example.com" },
    });

    expect(response.statusCode).toBe(502);
  });
});
