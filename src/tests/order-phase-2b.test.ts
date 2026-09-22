import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  counter: 0,
  duplicateNextPay: false,
  executePhase: 0,
  insertedTenders: [] as Array<Record<string, unknown>>,
  lastInvoiceNumber: null as string | null,
  order: {
    cashierId: null,
    createdAt: new Date("2026-07-29T00:00:00.000Z"),
    discountType: null,
    discountValue: null,
    id: "order-1",
    idempotencyKey: "create-1",
    invoiceNumber: null as string | null,
    invoicedAt: null as Date | null,
    orderStatus: "Pending",
    paymentPreference: "cash",
    qrGeneratedAt: null,
    qrStatus: null,
    qrVoidedAt: null,
    razorpayPaymentId: null,
    shipmentStatus: null,
    shiftId: null,
    shippingAddressLine1: "Line 1",
    shippingCity: "City",
    shippingPostalCode: "560001",
    shippingState: "State",
    subtotalAmount: "1200.00",
    taxAmount: "0.00",
    taxRatePercent: "0.00",
    terminalId: "terminal-1",
    trackingNumber: null,
  },
  stockFails: false,
}));

vi.mock("../application/services/audit-log.service.js", () => ({
  logAudit: vi.fn(),
}));

vi.mock("../application/services/cashier.service.js", () => ({
  getActiveCashierForAttribution: vi.fn(),
}));

vi.mock("../application/services/inventory.service.js", () => ({
  INTERNAL_IDEMPOTENCY_PROVIDER: "razorpay",
  adjustStockInTransaction: vi.fn(async () => {
    if (state.stockFails) {
      throw new Error("stock failure");
    }
  }),
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
      id: "item-1",
      name: "Black Tee",
      orderId: state.order.id,
      quantityMilli: 1000n,
      sku: "SKU-1",
      unitPrice: "1200.00",
      variantId: "variant-1",
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
        if (selectedTable === schema.salesOrders) {
          return builder;
        }

        if (selectedTable === schema.salesOrderItems || joined) {
          return Promise.resolve(items);
        }

        if (selectedTable === schema.paymentTenders) {
          return Promise.resolve(state.insertedTenders);
        }

        return builder;
      },
    };

    return builder;
  };

  const tx = {
    execute: vi.fn(async () => {
      state.executePhase += 1;
      if (state.executePhase === 1) {
        return { rows: state.duplicateNextPay ? [{ id: 1 }] : [] };
      }

      if (state.executePhase === 2) {
        return { rows: [state.order] };
      }

      if (state.executePhase === 3) {
        return { rows: [] };
      }

      return { rows: [{ id: "counter-1", lastNumber: state.counter }] };
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        if (table === schema.paymentTenders) {
          state.insertedTenders.push(...(Array.isArray(values) ? values : [values]));
        }
      }),
    })),
    select: vi.fn(makeSelect),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          if (table === schema.invoiceCounters) {
            state.counter = Number(values.lastNumber);
            return;
          }

          if (table === schema.salesOrders) {
            state.order = { ...state.order, ...values };
            state.lastInvoiceNumber = state.order.invoiceNumber;
          }
        }),
      })),
    })),
  };

  return {
    db: {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    },
  };
});

describe("Phase 2B order payment behaviour", () => {
  beforeEach(() => {
    state.counter = 0;
    state.duplicateNextPay = false;
    state.executePhase = 0;
    state.insertedTenders = [];
    state.lastInvoiceNumber = null;
    state.stockFails = false;
    state.order = {
      ...state.order,
      id: "order-1",
      invoiceNumber: null,
      invoicedAt: null,
      orderStatus: "Pending",
    };
  });

  it("allocates sequential gapless invoice numbers across 50 pays", async () => {
    const { payOrder } = await import("../application/services/order.service.js");
    const invoiceNumbers: string[] = [];

    for (let index = 0; index < 50; index += 1) {
      state.executePhase = 0;
      state.order = {
        ...state.order,
        id: `order-${index}`,
        invoiceNumber: null,
        invoicedAt: null,
        orderStatus: "Pending",
      };
      await payOrder("99999999-9999-4999-8999-999999999999", state.order.id, {
        actorUserId: "owner-1",
        idempotencyKey: `pay-${index}`,
      });
      invoiceNumbers.push(state.lastInvoiceNumber!);
    }

    expect(invoiceNumbers).toEqual(
      Array.from({ length: 50 }, (_, index) => `INV/2026-27/${String(index + 1).padStart(6, "0")}`),
    );
  });

  it("does not allocate an invoice when tender validation fails", async () => {
    const { payOrder } = await import("../application/services/order.service.js");

    await expect(
      payOrder("99999999-9999-4999-8999-999999999999", state.order.id, {
        actorUserId: "owner-1",
        idempotencyKey: "pay-short",
        tenders: [{ amount: "10.00", method: "cash" }],
      }),
    ).rejects.toMatchObject({ errorType: "TENDER_AMOUNT_MISMATCH" });

    expect(state.counter).toBe(0);
    expect(state.lastInvoiceNumber).toBeNull();
  });

  it("does not allocate an invoice when payment rolls back before allocation", async () => {
    const { payOrder } = await import("../application/services/order.service.js");
    state.stockFails = true;

    await expect(
      payOrder("99999999-9999-4999-8999-999999999999", state.order.id, {
        actorUserId: "owner-1",
        idempotencyKey: "pay-stock-fail",
      }),
    ).rejects.toThrow("stock failure");

    expect(state.counter).toBe(0);
    expect(state.lastInvoiceNumber).toBeNull();
  });

  it("replayed pay returns the existing invoice without allocating another", async () => {
    const { payOrder } = await import("../application/services/order.service.js");

    await payOrder("99999999-9999-4999-8999-999999999999", state.order.id, {
      actorUserId: "owner-1",
      idempotencyKey: "pay-replay",
    });
    const firstInvoice = state.lastInvoiceNumber;
    state.executePhase = 0;
    state.duplicateNextPay = true;
    const replay = await payOrder("99999999-9999-4999-8999-999999999999", state.order.id, {
      actorUserId: "owner-1",
      idempotencyKey: "pay-replay",
    });

    expect(replay.duplicate).toBe(true);
    expect(replay.order.invoiceNumber).toBe(firstInvoice);
    expect(state.counter).toBe(1);
  });

  it("uses SHOP_TIMEZONE for financial-year rollover", async () => {
    const { financialYearSeriesKey } = await import("../application/services/order.service.js");

    expect(financialYearSeriesKey(new Date("2026-03-31T18:29:00.000Z"))).toBe("2025-26");
    expect(financialYearSeriesKey(new Date("2026-03-31T18:31:00.000Z"))).toBe("2026-27");
  });

  it("accepts card tender with last-4 and approval code, and rejects card without them", async () => {
    const { payOrder } = await import("../application/services/order.service.js");

    await expect(
      payOrder("99999999-9999-4999-8999-999999999999", state.order.id, {
        actorUserId: "owner-1",
        idempotencyKey: "pay-card-missing",
        tenders: [{ amount: "1200.00", method: "card" }],
      }),
    ).rejects.toMatchObject({ errorType: "CARD_DETAILS_REQUIRED" });

    state.executePhase = 0;
    await payOrder("99999999-9999-4999-8999-999999999999", state.order.id, {
      actorUserId: "owner-1",
      idempotencyKey: "pay-card",
      tenders: [
        {
          amount: "1200.00",
          cardApprovalCode: "APPROVED42",
          cardLast4: "1234",
          method: "card",
        },
      ],
    });

    expect(state.insertedTenders).toEqual([
      expect.objectContaining({
        cardApprovalCode: "APPROVED42",
        cardLast4: "1234",
        method: "card",
      }),
    ]);
  });
});
