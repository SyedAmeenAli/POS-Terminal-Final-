// SELLING EXPIRED STOCK IS AN OFFENCE, NOT A POLICY.
//
// Proposal 06 §0 requires that the refusal is not overridable by ANY role —
// not manager, not admin, not the owner override that exists for other
// refusals — and that it is TESTED to be so rather than assumed.
//
// THE COPY THAT MATTERS. The refusal in ims-backend proves nothing about the
// counter — the counter is a separate service, and until proposal 02 it
// bypassed this check entirely. A pharmacy is served at the counter.
//
// This file is that test. It is written now, ahead of the rest of proposal
// 06, because it is the one part of that phase which needs no expert review:
// it asserts an existing guarantee rather than implementing a regulated one.
//
// WHY THE GUARANTEE HOLDS, structurally. The refusal lives in allocateFefo,
// which takes no override parameter at all. `negativeOverride` — the only
// override on the stock path — guards a DIFFERENT check, the generic
// availability one in adjustStockInTransaction, and it cannot reach here. A
// future change that threaded an override into this function would have to
// delete a test that says out loud why it must not.
import { describe, expect, it } from "vitest";

import { AppError } from "../api/errors.js";
import { allocateFefo, type LotRow } from "../application/services/lot.service.js";

const TODAY = new Date("2026-06-15T10:00:00Z");

const expiredLot: LotRow = {
  batchNumber: "EXPIRED",
  damagedQtyMilli: 0n,
  expiryDate: "2026-01-01",
  id: "expired",
  onHandQtyMilli: 10_000n,
  reservedQtyMilli: 0n,
};

describe("the expired-stock refusal is absolute", () => {
  it("refuses, with plenty of expired stock physically present", () => {
    // The shop HAS the goods. That is the whole point: this is not a
    // stock-availability check, it is a legal one.
    try {
      allocateFefo([expiredLot], 1_000n, TODAY);
      expect.unreachable("expected the sale to be refused");
    } catch (error) {
      expect((error as AppError).errorType).toBe("EXPIRED_STOCK");
    }
  });

  it("takes NO override parameter — there is no argument that permits it", () => {
    // The strongest available assertion at this level: a refusal that can be
    // switched off is a refusal someone will switch off at five o'clock on a
    // Friday. allocateFefo's signature is (lots, qty, asOf) and nothing else.
    expect(allocateFefo.length).toBe(3);
  });

  it("refuses even when the caller asks for less than the expired stock held", () => {
    // A partial sale out of an expired batch is still a sale of expired
    // stock. There is no quantity small enough to make it lawful.
    expect(() => allocateFefo([expiredLot], 1n, TODAY)).toThrow(AppError);
  });

  it("still sells UNEXPIRED stock beside an expired batch", () => {
    // The refusal must not become a blanket block on the item — a chemist
    // with one bad batch and three good ones must still be able to trade.
    const good: LotRow = { ...expiredLot, expiryDate: "2030-01-01", id: "good" };
    expect(allocateFefo([expiredLot, good], 1_000n, TODAY)).toEqual([
      { lotId: "good", qtyMilli: 1_000n },
    ]);
  });

  it("reports EXPIRED_STOCK, not INSUFFICIENT_STOCK", () => {
    // The two demand opposite actions. "Insufficient" sends a pharmacist to
    // reorder; "expired" sends them to the shelf to pull it. Reporting the
    // wrong one leaves the expired packs where they are.
    try {
      allocateFefo([expiredLot], 1_000n, TODAY);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as AppError).errorType).not.toBe("INSUFFICIENT_STOCK");
    }
  });

  it("treats a batch expiring TODAY as sellable — the refusal is not overreach", () => {
    // A pack stamped 15 June is lawful for the whole of 15 June. An
    // off-by-one here refuses a sale a pharmacy is entitled to make, and a
    // compliance feature that blocks lawful trade gets switched off.
    const today: LotRow = { ...expiredLot, expiryDate: "2026-06-15", id: "today" };
    expect(allocateFefo([today], 1_000n, TODAY)).toEqual([{ lotId: "today", qtyMilli: 1_000n }]);
  });
});
