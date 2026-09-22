import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  auditRows: [] as Array<{ action: string; metadata?: Record<string, unknown> }>,
  cancelOrder: vi.fn(),
  createOrderRequiresOwnerOverride: vi.fn(),
  getOwnerPasswordHash: vi.fn(),
  getOrderStatus: vi.fn(),
  listOrders: vi.fn(),
  orderDiscountRequiresOwnerOverride: vi.fn(),
  returnOrder: vi.fn(),
  terminalRows: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Counter 1",
      status: "active",
      tokenHash: "active-token",
      tenantId: "99999999-9999-4999-8999-999999999999",
    },
  ],
  verifyPassword: vi.fn(),
}));

vi.mock("../application/services/audit-log.service.js", () => ({
  logAudit: vi.fn(async (input: { action: string; metadata?: Record<string, unknown> }) => {
    state.auditRows.push(input);
    return input;
  }),
}));

vi.mock("../application/services/owner-credentials.service.js", () => ({
  getBusinessSettings: vi.fn(async () => ({ taxRatePercent: "0.00" })),
  getOwnerPasswordHash: state.getOwnerPasswordHash,
  getTaxRatePercent: vi.fn(async () => "0.00"),
}));

vi.mock("../infrastructure/adapters/password.adapter.js", () => ({
  verifyPassword: state.verifyPassword,
}));

vi.mock("../application/services/order.service.js", () => ({
  cancelOrder: state.cancelOrder,
  confirmOrder: vi.fn(),
  createOrder: vi.fn(),
  createOrderRequiresOwnerOverride: state.createOrderRequiresOwnerOverride,
  emailOrderReceipt: vi.fn(),
  generatePaymentQr: vi.fn(),
  getOrder: vi.fn(),
  getOrderStatus: state.getOrderStatus,
  listOrders: state.listOrders,
  orderDiscountRequiresOwnerOverride: state.orderDiscountRequiresOwnerOverride,
  payOrder: vi.fn(),
  returnOrder: state.returnOrder,
  voidPaymentQr: vi.fn(),
}));

vi.mock("../infrastructure/database/db.js", async () => {
  const schema = await import("../infrastructure/database/schema.js");
  const makeUserBuilder = () => ({
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      return Promise.resolve([{ id: "99999999-9999-4999-8999-999999999999", role: "admin" }]);
    },
  });

  const selectImpl = () => ({
    from(table: unknown) {
      // findTerminalByToken narrows by the indexed token prefix, so the
      // builder must accept .where(). Returning every row is fine here:
      // prefix filtering is Postgres's job, not the mock's.
      if (table === schema.posTerminals) {
        return { where: () => Promise.resolve(state.terminalRows) };
      }
      if (table === schema.users) return makeUserBuilder();
      return Promise.resolve([]);
    },
  });

  return {
    db: {
      select: vi.fn(selectImpl),
      update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })),
    },
    // requireTerminal's terminal-token lookup now runs on the T1b bootstrap
    // connection instead of the main one — same mocked posTerminals shape.
    getBootstrapDb: () => ({
      select: vi.fn(selectImpl),
      // last_seen_at is stamped through this connection in requireTerminal.
      update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })),
    }),
  };
});

const headers = { authorization: "Bearer active-token" };
const orderId = "33333333-3333-4333-8333-333333333333";

const validOwnerCookie = async () => {
  const { createOwnerSessionToken, OWNER_SESSION_COOKIE } = await import("../application/services/owner-session.service.js");
  return `${OWNER_SESSION_COOKIE}=${createOwnerSessionToken()}`;
};

const build = async () => {
  const { buildServer } = await import("../api/server.js");
  return buildServer();
};

describe("owner override routes", () => {
  beforeEach(async () => {
    state.auditRows = [];
    state.cancelOrder.mockResolvedValue({ duplicate: false, order: { id: orderId } });
    state.createOrderRequiresOwnerOverride.mockResolvedValue(false);
    state.getOrderStatus.mockResolvedValue("Paid");
    state.getOwnerPasswordHash.mockResolvedValue("owner-hash");
    state.listOrders.mockResolvedValue([]);
    state.orderDiscountRequiresOwnerOverride.mockResolvedValue(false);
    state.returnOrder.mockResolvedValue({ duplicate: false, order: { id: orderId } });
    state.verifyPassword.mockImplementation(
      async (plain: string, hash: string) =>
        plain === hash || (plain === "correct" && hash === "owner-hash"),
    );

    const { resetAuthStateForTests } = await import("../api/middleware/auth.js");
    const { resetGlobalRateLimit } = await import("../api/middleware/global-rate-limit.js");
    const { resetOwnerOverrideRateLimit } = await import("../api/middleware/owner-rate-limit.js");
    resetAuthStateForTests();
    resetGlobalRateLimit();
    resetOwnerOverrideRateLimit();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires owner override for cancelling a paid order", async () => {
    const server = await build();
    const response = await server.inject({
      headers,
      method: "PATCH",
      payload: { idempotencyKey: "cancel-1" },
      url: `/orders/${orderId}/cancel`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorType: "OWNER_LOGIN_REQUIRED" });
    expect(state.cancelOrder).not.toHaveBeenCalled();
    expect(state.auditRows.some((row) => row.action === "owner.override.failed")).toBe(true);
  });

  it("allows paid cancel with a POS owner session", async () => {
    const server = await build();
    const response = await server.inject({
      headers: { ...headers, cookie: await validOwnerCookie() },
      method: "PATCH",
      payload: { idempotencyKey: "cancel-1" },
      url: `/orders/${orderId}/cancel`,
    });

    expect(response.statusCode).toBe(200);
    expect(state.cancelOrder).toHaveBeenCalled();
    expect(state.auditRows.some((row) => row.action === "owner.override.authorised")).toBe(true);
  });

  it("allows pending cancel without owner override", async () => {
    state.getOrderStatus.mockResolvedValue("Pending");
    const server = await build();
    const response = await server.inject({
      headers,
      method: "PATCH",
      payload: { idempotencyKey: "cancel-1" },
      url: `/orders/${orderId}/cancel`,
    });

    expect(response.statusCode).toBe(200);
    expect(state.cancelOrder).toHaveBeenCalled();
  });

  it("fails closed when owner_password_hash is unset", async () => {
    state.getOwnerPasswordHash.mockResolvedValue(null);
    const server = await build();
    const response = await server.inject({
      headers: { ...headers, cookie: await validOwnerCookie() },
      method: "PATCH",
      payload: { idempotencyKey: "cancel-1" },
      url: `/orders/${orderId}/cancel`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorType: "OWNER_PASSWORD_NOT_SET" });
    expect(state.cancelOrder).not.toHaveBeenCalled();
  });

  it("rejects IMS-issued owner session cookies", async () => {
    const server = await build();
    const response = await server.inject({
      headers: { ...headers, cookie: "ims_owner_session=not-a-pos-session" },
      method: "PATCH",
      payload: { idempotencyKey: "cancel-1" },
      url: `/orders/${orderId}/cancel`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorType: "OWNER_LOGIN_REQUIRED" });
  });

  it("requires owner override for returns", async () => {
    const server = await build();
    const denied = await server.inject({
      headers,
      method: "PATCH",
      payload: {
        idempotencyKey: "return-1",
        items: [{ restockable: true, variantId: "22222222-2222-4222-8222-222222222222" }],
      },
      url: `/orders/${orderId}/return`,
    });
    const allowed = await server.inject({
      headers: { ...headers, cookie: await validOwnerCookie() },
      method: "PATCH",
      payload: {
        idempotencyKey: "return-1",
        items: [{ restockable: true, variantId: "22222222-2222-4222-8222-222222222222" }],
      },
      url: `/orders/${orderId}/return`,
    });

    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(state.returnOrder).toHaveBeenCalled();
  });

  it("rejects wrong owner password and locks out after repeated failures", async () => {
    const server = await build();

    for (let index = 0; index < 5; index += 1) {
      const response = await server.inject({
        headers,
        method: "POST",
        payload: { password: "wrong" },
        url: "/owner/verify",
      });
      expect(response.statusCode).toBe(401);
    }

    const locked = await server.inject({
      headers,
      method: "POST",
      payload: { password: "wrong" },
      url: "/owner/verify",
    });

    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ errorType: "RATE_LIMITED" });
    expect(JSON.stringify(state.auditRows)).not.toContain(':"wrong"');
  });

  it("uses the current shared owner hash without restarting", async () => {
    const server = await build();

    const first = await server.inject({
      headers,
      method: "POST",
      payload: { password: "correct" },
      url: "/owner/verify",
    });

    state.getOwnerPasswordHash.mockResolvedValue("new-owner-hash");
    const second = await server.inject({
      headers,
      method: "POST",
      payload: { password: "new-owner-hash" },
      url: "/owner/verify",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(state.getOwnerPasswordHash).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.auditRows)).not.toContain("correct");
    expect(JSON.stringify(state.auditRows)).not.toContain("new-owner-hash");
  });
});
