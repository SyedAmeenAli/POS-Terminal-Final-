import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  executeCall: 0,
  openShift: undefined as Record<string, unknown> | undefined,
  updatedShift: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../application/services/cashier.service.js", () => ({
  getActiveCashierForAttribution: vi.fn(async (cashierId: string) => ({
    id: cashierId,
    name: "Asha",
  })),
}));

vi.mock("../infrastructure/database/db.js", async () => {
  const schema = await import("../infrastructure/database/schema.js");

  const makeShiftBuilder = () => ({
    limit() {
      return Promise.resolve(state.openShift ? [state.openShift] : []);
    },
    where() {
      return this;
    },
  });

  const dbLike = {
    execute: vi.fn(async () => {
      state.executeCall += 1;

      if (state.executeCall === 1 && state.openShift?.status === "open") {
        return { rows: [{ cashRefunds: "80.00", cashSales: "250.00" }] };
      }

      if (state.executeCall === 1 || state.executeCall === 2) {
        return {
          rows: [
            {
              discounts: "0.00",
              gross: "500.00",
              orderCount: 2,
              refunds: "80.00",
              tax: "0.00",
            },
          ],
        };
      }

      return { rows: [{ method: "cash", total: "250.00" }, { method: "card", total: "200.00" }, { method: "UPI", total: "50.00" }] };
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          if (table === schema.posShifts) {
            state.openShift = {
              ...values,
              closedAt: null,
              closedByCashierId: null,
              countedCash: null,
              expectedCash: null,
              id: "shift-1",
              note: null,
              openedAt: new Date("2026-03-31T18:31:00.000Z"),
              status: "open",
              variance: null,
            };
          }

          return [state.openShift];
        }),
      })),
    })),
    select: vi.fn(() => ({
      from(table: unknown) {
        if (table === schema.posShifts) {
          return makeShiftBuilder();
        }

        return makeShiftBuilder();
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (table === schema.posShifts) {
              state.updatedShift = { ...state.openShift, ...values };
              state.openShift = undefined;
            }

            return [state.updatedShift];
          }),
        })),
      })),
    })),
  };

  return {
    db: {
      ...dbLike,
      transaction: vi.fn(async (callback: (transaction: typeof dbLike) => unknown) =>
        callback(dbLike),
      ),
    },
  };
});

describe("shift service", () => {
  beforeEach(() => {
    state.executeCall = 0;
    state.openShift = undefined;
    state.updatedShift = undefined;
  });

  it("rejects opening a second shift for the same terminal", async () => {
    const { openShift } = await import("../application/services/shift.service.js");

    await openShift("tenant-1", { openingFloat: "100.00", terminalId: "terminal-1" });

    await expect(openShift("tenant-1", { openingFloat: "100.00", terminalId: "terminal-1" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("keeps expectedCash out of the current X report and uses SHOP_TIMEZONE business date", async () => {
    const { getCurrentShift, openShift } = await import("../application/services/shift.service.js");
    await openShift("tenant-1", { openingFloat: "100.00", terminalId: "terminal-1" });
    state.executeCall = 0;

    const report = await getCurrentShift("terminal-1");

    expect(report?.businessDate).toBe("2026-04-01");
    expect(report?.shift).not.toHaveProperty("expectedCash");
  });

  it("computes expected cash from cash only and stores negative variance as-is", async () => {
    const { closeShift, openShift } = await import("../application/services/shift.service.js");
    await openShift("tenant-1", { openingFloat: "100.00", terminalId: "terminal-1" });
    state.executeCall = 0;

    const report = await closeShift({
      countedCash: "250.00",
      terminalId: "terminal-1",
    });

    expect(report.shift.expectedCash).toBe("270.00");
    expect(report.shift.variance).toBe("-20.00");
    expect(state.updatedShift).toEqual(
      expect.objectContaining({ expectedCash: "270.00", variance: "-20.00" }),
    );
  });
});
