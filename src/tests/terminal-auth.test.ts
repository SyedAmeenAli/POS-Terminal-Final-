import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createOrder: vi.fn(),
  lastSeenUpdates: 0,
  terminalWhereCalls: 0,
  listOrders: vi.fn(),
  terminalRows: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Counter 1",
      status: "active",
      tokenHash: "active-token",
      tenantId: "99999999-9999-4999-8999-999999999999",
    },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "Counter 2",
      status: "disabled",
      tokenHash: "disabled-token",
      tenantId: "99999999-9999-4999-8999-999999999999",
    },
  ],
}));

vi.mock("../infrastructure/adapters/password.adapter.js", () => ({
  hashPassword: vi.fn(async (plain: string) => `hash:${plain}`),
  verifyPassword: vi.fn(async (plain: string, hash: string) => plain === hash),
}));

vi.mock("../application/services/order.service.js", () => ({
  cancelOrder: vi.fn(),
  confirmOrder: vi.fn(),
  createOrder: state.createOrder,
  createOrderRequiresOwnerOverride: vi.fn(async () => false),
  emailOrderReceipt: vi.fn(),
  generatePaymentQr: vi.fn(),
  getOrder: vi.fn(),
  getOrderStatus: vi.fn(async () => "Pending"),
  listOrders: state.listOrders,
  orderDiscountRequiresOwnerOverride: vi.fn(async () => false),
  payOrder: vi.fn(),
  returnOrder: vi.fn(),
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
      if (table === schema.posTerminals) {
        // findTerminalByToken now narrows by the indexed token prefix, so
        // the builder has to accept .where(). The mock still returns every
        // row: prefix filtering is Postgres's job, and these tests cover
        // auth outcomes rather than query planning.
        return {
          where() {
            state.terminalWhereCalls += 1;
            return Promise.resolve(state.terminalRows);
          },
        };
      }

      if (table === schema.users) {
        return makeUserBuilder();
      }

      return Promise.resolve([]);
    },
  });

  return {
    db: {
      select: vi.fn(selectImpl),
      update: vi.fn(() => ({
        set() {
          return {
            where() {
              state.lastSeenUpdates += 1;
              return Promise.resolve([]);
            },
          };
        },
      })),
    },
    // requireTerminal's token lookup AND its last_seen_at stamp both run on
    // the T1b bootstrap connection now, so the counter that backs the
    // "at most once per minute" assertion lives here.
    getBootstrapDb: () => ({
      select: vi.fn(selectImpl),
      update: vi.fn(() => ({
        set: () => ({
          where: () => {
            state.lastSeenUpdates += 1;
            return Promise.resolve([]);
          },
        }),
      })),
    }),
  };
});

describe("terminal authentication", () => {
  beforeEach(async () => {
    state.createOrder.mockResolvedValue({
      duplicate: false,
      order: { id: "order-1" },
    });
    state.listOrders.mockResolvedValue([]);
    state.lastSeenUpdates = 0;
    state.terminalWhereCalls = 0;
    state.terminalRows[0]!.status = "active";
    state.terminalRows[1]!.status = "disabled";

    const { resetAuthStateForTests } = await import("../api/middleware/auth.js");
    const { resetGlobalRateLimit } = await import("../api/middleware/global-rate-limit.js");
    resetAuthStateForTests();
    resetGlobalRateLimit();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("allows health without a terminal token", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();
    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ success: true, data: { status: "ok" } });
  });

  // BUG FOUND 2026-09-16: globalAuthenticationHook (auth.ts) exempted these
  // paths correctly, but resolveTenantHook (tenant.ts) ran right after it
  // with its OWN separate exemption list — just "/health" — saw no
  // request.terminal for an exempted path, and threw anyway. The till's own
  // login page could never load, for anyone, with or without a token: a
  // brand-new terminal had no way to reach the screen that asks for one.
  // No route for these paths exists without web/dist present (as in this
  // mocked test server), so the assertion that matters is the STATUS CODE
  // never being the auth failure — 401 with this exact message was the
  // symptom; 404 (route genuinely absent here) or 200 are both fine.
  it("does not throw 'Terminal not authorised' for a static-asset path with no token", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();

    for (const url of ["/", "/index.html", "/favicon.ico", "/manifest.json", "/robots.txt", "/assets/app.js"]) {
      const response = await server.inject({ method: "GET", url });
      const body = response.statusCode === 401 ? JSON.parse(response.body) : null;

      expect(body?.message, url).not.toBe("Terminal not authorised");
    }
  });

  it("rejects missing, unknown, and disabled terminal tokens", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();

    const missing = await server.inject({ method: "GET", url: "/orders" });
    const unknown = await server.inject({
      headers: { authorization: "Bearer missing-token" },
      method: "GET",
      url: "/orders",
    });
    const disabled = await server.inject({
      headers: { authorization: "Bearer disabled-token" },
      method: "GET",
      url: "/orders",
    });

    for (const response of [missing, unknown, disabled]) {
      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).message).toBe("Terminal not authorised");
    }
  });

  it("allows an active terminal token and records lastSeenAt at most once per minute", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();

    const first = await server.inject({
      headers: { authorization: "Bearer active-token" },
      method: "GET",
      url: "/orders",
    });
    const second = await server.inject({
      headers: { authorization: "Bearer active-token" },
      method: "GET",
      url: "/orders",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(state.lastSeenUpdates).toBe(1);
  });

  it("passes terminal id into order creation", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();
    const response = await server.inject({
      headers: { authorization: "Bearer active-token" },
      method: "POST",
      payload: {
        idempotencyKey: "order-key-1",
        items: [{ quantity: 1, variantId: "11111111-1111-4111-8111-111111111111" }],
      },
      url: "/orders",
    });

    expect(response.statusCode).toBe(201);
    expect(state.createOrder).toHaveBeenCalledWith(
      "99999999-9999-4999-8999-999999999999",
      expect.objectContaining({
        idempotencyKey: "order-key-1",
        terminalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );
  });

  it("flushes cached terminal authentication for immediate revocation", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();
    const headers = { authorization: "Bearer active-token" };

    expect((await server.inject({ headers, method: "GET", url: "/orders" })).statusCode).toBe(200);
    state.terminalRows[0]!.status = "disabled";
    expect((await server.inject({ headers, method: "GET", url: "/orders" })).statusCode).toBe(200);

    const flush = await server.inject({
      headers,
      method: "POST",
      remoteAddress: "127.0.0.1",
      url: "/internal/flush-auth-cache",
    });
    const revoked = await server.inject({ headers, method: "GET", url: "/orders" });

    expect(flush.statusCode).toBe(200);
    expect(revoked.statusCode).toBe(401);
  });

  it("rejects a disallowed CORS origin", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();
    const response = await server.inject({
      headers: {
        authorization: "Bearer active-token",
        origin: "http://evil.example",
      },
      method: "GET",
      url: "/orders",
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).message).toBe("Origin not allowed");
  });
});
