import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cashierRows: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Asha",
      pinHash: "1234",
      status: "active",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Dev",
      pinHash: "9999",
      status: "disabled",
    },
  ],
  terminalRows: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "Counter 1",
      status: "active",
      tokenHash: "active-token",
      tenantId: "99999999-9999-4999-8999-999999999999",
    },
  ],
  verifyPassword: vi.fn(async (plain: string, hash: string) => plain === hash),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");

  return {
    ...actual,
    and: (...conditions: unknown[]) => ({ conditions, op: "and" }),
    asc: (column: unknown) => column,
    eq: (column: unknown, value: unknown) => ({ column, op: "eq", value }),
  };
});

vi.mock("../infrastructure/adapters/password.adapter.js", () => ({
  hashPassword: vi.fn(async (plain: string) => `hash:${plain}`),
  verifyPassword: state.verifyPassword,
}));

vi.mock("../application/services/order.service.js", () => ({
  cancelOrder: vi.fn(),
  confirmOrder: vi.fn(),
  createOrder: vi.fn(),
  emailOrderReceipt: vi.fn(),
  generatePaymentQr: vi.fn(),
  getOrder: vi.fn(),
  listOrders: vi.fn(async () => []),
  payOrder: vi.fn(),
  returnOrder: vi.fn(),
  voidPaymentQr: vi.fn(),
}));

const predicateValue = (predicate: unknown, column: unknown): unknown => {
  if (typeof predicate !== "object" || predicate === null) {
    return undefined;
  }

  if (
    "op" in predicate &&
    predicate.op === "eq" &&
    "column" in predicate &&
    predicate.column === column
  ) {
    return "value" in predicate ? predicate.value : undefined;
  }

  if ("conditions" in predicate && Array.isArray(predicate.conditions)) {
    for (const condition of predicate.conditions) {
      const value = predicateValue(condition, column);
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
};

const projectRows = <T extends Record<string, unknown>>(
  rows: T[],
  projection: Record<string, unknown>,
): Array<Record<string, unknown>> =>
  rows.map((row) =>
    Object.fromEntries(
      Object.keys(projection).map((key) => [key, row[key]]),
    ),
  );

vi.mock("../infrastructure/database/db.js", async () => {
  const schema = await import("../infrastructure/database/schema.js");

  const makeUserBuilder = () => ({
    orderBy() {
      return this;
    },
    limit() {
      return Promise.resolve([{ id: "99999999-9999-4999-8999-999999999999", role: "admin" }]);
    },
    where() {
      return this;
    },
  });

  const makeCashierBuilder = (projection: Record<string, unknown>) => ({
    filteredRows: state.cashierRows,
    limit() {
      return Promise.resolve(projectRows(this.filteredRows, projection));
    },
    orderBy() {
      return Promise.resolve(projectRows(this.filteredRows, projection));
    },
    where(predicate: unknown) {
      const id = predicateValue(predicate, schema.cashiers.id);
      const status = predicateValue(predicate, schema.cashiers.status);
      this.filteredRows = state.cashierRows.filter(
        (cashier) =>
          (id === undefined || cashier.id === id) &&
          (status === undefined || cashier.status === status),
      );
      return this;
    },
  });

  const selectImpl = (projection: Record<string, unknown>) => ({
    from(table: unknown) {
      if (table === schema.posTerminals) {
        // findTerminalByToken narrows by the indexed token prefix, so the
        // builder must accept .where(). Returning every row is fine here:
        // prefix filtering is Postgres's job, not the mock's.
        return {
          where: () => Promise.resolve(state.terminalRows),
        };
      }

      if (table === schema.users) {
        return makeUserBuilder();
      }

      if (table === schema.cashiers) {
        return makeCashierBuilder(projection);
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
              return Promise.resolve([]);
            },
          };
        },
      })),
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

describe("cashier routes", () => {
  beforeEach(async () => {
    process.env.CASHIER_PIN_MAX_FAILURES = "2";
    process.env.CASHIER_PIN_WINDOW_SECONDS = "300";
    state.verifyPassword.mockClear();

    const { resetAuthStateForTests } = await import("../api/middleware/auth.js");
    const { resetGlobalRateLimit } = await import("../api/middleware/global-rate-limit.js");
    const { resetCashierPinFailuresForTests } = await import(
      "../application/services/cashier.service.js"
    );

    resetAuthStateForTests();
    resetGlobalRateLimit();
    resetCashierPinFailuresForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists active cashiers without hash or status detail", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();
    const response = await server.inject({
      headers: { authorization: "Bearer active-token" },
      method: "GET",
      url: "/cashiers",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      success: true,
      data: [{ id: "11111111-1111-4111-8111-111111111111", name: "Asha" }],
    });
    expect(response.body).not.toContain("pinHash");
    expect(response.body).not.toContain("disabled");
  });

  it("verifies correct PIN and gives identical 401 bodies for wrong or unknown cashier", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();
    const headers = { authorization: "Bearer active-token" };

    const correct = await server.inject({
      headers,
      method: "POST",
      payload: { cashierId: "11111111-1111-4111-8111-111111111111", pin: "1234" },
      url: "/cashiers/verify-pin",
    });
    const wrong = await server.inject({
      headers,
      method: "POST",
      payload: { cashierId: "11111111-1111-4111-8111-111111111111", pin: "0000" },
      url: "/cashiers/verify-pin",
    });
    const unknown = await server.inject({
      headers,
      method: "POST",
      payload: { cashierId: "33333333-3333-4333-8333-333333333333", pin: "0000" },
      url: "/cashiers/verify-pin",
    });

    expect(correct.statusCode).toBe(200);
    expect(JSON.parse(correct.body)).toEqual({
      success: true,
      data: { cashierId: "11111111-1111-4111-8111-111111111111", name: "Asha" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(JSON.parse(wrong.body)).toEqual(JSON.parse(unknown.body));
    expect(state.verifyPassword).toHaveBeenCalledWith("0000", expect.any(String));
  });

  it("locks PIN verification after the configured failure threshold", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer();
    const request = {
      headers: { authorization: "Bearer active-token" },
      method: "POST" as const,
      payload: { cashierId: "11111111-1111-4111-8111-111111111111", pin: "0000" },
      url: "/cashiers/verify-pin",
    };

    expect((await server.inject(request)).statusCode).toBe(401);
    expect((await server.inject(request)).statusCode).toBe(401);

    const locked = await server.inject({
      ...request,
      payload: { cashierId: "11111111-1111-4111-8111-111111111111", pin: "1234" },
    });

    expect(locked.statusCode).toBe(401);
    expect(JSON.parse(locked.body).message).toBe("Cashier PIN not accepted");
  });

  it("rejects disabled cashiers for server-side attribution", async () => {
    const { getActiveCashierForAttribution } = await import(
      "../application/services/cashier.service.js"
    );

    await expect(
      getActiveCashierForAttribution("22222222-2222-4222-8222-222222222222"),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
