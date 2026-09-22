// The rule that decides whether a cashier can sell 1.5 of something.
//
// T30 made fractional quantities representable in the database, both APIs and
// the IMS. The till's cart was +1/-1 buttons with a display-only span, so a
// grocery could not ring up loose rice and a hardware shop could not sell
// cable — the capability existed everywhere except the counter.
//
// This mirrors quantityToMilli's rule server-side. It must not be MORE
// permissive: anything this accepts and the server refuses becomes an error
// the cashier meets after the sale is finished.
import { describe, expect, it } from "vitest";

import { formatQuantityMilli, isFractionalUnit, milliToUnits, parseCartQuantity, unitLabel } from "./quantity";

const ok = (r: ReturnType<typeof parseCartQuantity>) => ("value" in r ? r.value : `ERROR: ${r.error}`);

describe("parseCartQuantity", () => {
  it("accepts 1.5 kg — loose rice", () => {
    expect(ok(parseCartQuantity("1.5", "kg"))).toBe(1.5);
  });

  it("accepts 2.75 m — cable off a reel", () => {
    expect(ok(parseCartQuantity("2.75", "metre"))).toBe(2.75);
  });

  it("REFUSES 2.5 pieces", () => {
    // Half a piece is a data-entry error, not a quantity. The server refuses
    // it with FRACTIONAL_NOT_ALLOWED; the cashier should hear it sooner.
    const result = parseCartQuantity("2.5", "piece");
    expect("error" in result).toBe(true);
    expect("error" in result && result.error).toContain("whole units");
  });

  it("accepts whole pieces", () => {
    expect(ok(parseCartQuantity("3", "piece"))).toBe(3);
  });

  it("refuses a FOURTH decimal place", () => {
    // Quantities are stored in thousandths. A fourth decimal cannot be
    // represented, and the server refuses rather than rounding it away — so
    // this must refuse too, not round.
    expect("error" in parseCartQuantity("1.2345", "kg")).toBe(true);
    expect(ok(parseCartQuantity("1.234", "kg"))).toBe(1.234);
  });

  it("refuses zero and negatives", () => {
    // A zero-quantity line is a line that should have been removed, and it
    // reaches the server as a validation error on something the cashier
    // cannot see.
    expect("error" in parseCartQuantity("0", "kg")).toBe(true);
    expect("error" in parseCartQuantity("-1", "kg")).toBe(true);
  });

  it("refuses empty and non-numeric input", () => {
    expect("error" in parseCartQuantity("", "kg")).toBe(true);
    expect("error" in parseCartQuantity("abc", "kg")).toBe(true);
  });

  it("treats an unknown unit as whole-only", () => {
    // Fails CLOSED. An item whose unit did not reach the till is more safely
    // sold in whole numbers than fractionally, because the server may refuse
    // the fraction and the cashier finds out last.
    expect("error" in parseCartQuantity("1.5", undefined)).toBe(true);
  });
});

describe("isFractionalUnit", () => {
  it("allows weight, volume and length", () => {
    for (const unit of ["kg", "g", "litre", "ml", "metre", "cm", "foot", "sqft"]) {
      expect(isFractionalUnit(unit)).toBe(true);
    }
  });

  it("refuses countable units", () => {
    for (const unit of ["piece", "box", "pack", "dozen", "pair", "set"]) {
      expect(isFractionalUnit(unit)).toBe(false);
    }
  });
});

// BUG FOUND 2026-09-16, on the first real sale run through this till: the
// receipt printed "1 x ₹150.00  ₹NaN" — the fetched order's items carry
// `quantityMilli`, never the `quantity` the old type claimed, so
// `Number(unitPrice) * item.quantity` read `undefined`. These two
// functions are the fix; this locks in the exact real-world case.
describe("milliToUnits", () => {
  it("turns the exact milli value a real order returned into a usable number", () => {
    // A real GET /orders/:id response carried "quantityMilli":"1000" for
    // one T-shirt — this is that string, verbatim.
    expect(milliToUnits("1000")).toBe(1);
  });

  it("handles a fraction — loose rice, half a kilo", () => {
    expect(milliToUnits("500")).toBe(0.5);
  });

  it("never produces NaN for the shapes the server actually sends", () => {
    for (const milli of ["1000", "0", "1500", "3000"]) {
      expect(Number.isNaN(milliToUnits(milli))).toBe(false);
    }
  });
});

describe("formatQuantityMilli", () => {
  it("prints a whole unit without decimals", () => {
    expect(formatQuantityMilli("1000")).toBe("1");
  });

  it("prints a fraction trimmed, not padded", () => {
    expect(formatQuantityMilli("1500")).toBe("1.5");
    expect(formatQuantityMilli("1234")).toBe("1.234");
  });

  it("is what a receipt line total is computed from, not what NaN came from", () => {
    // The exact regression: unitPrice 150, quantityMilli "1000" (one
    // T-shirt) must read as a real ₹150.00 line, not ₹NaN.
    const gross = 150 * milliToUnits("1000");
    expect(gross).toBe(150);
    expect(Number.isNaN(gross)).toBe(false);
  });
});

describe("unitLabel", () => {
  it("labels a unit the cashier needs to see", () => {
    // "1.5" alone means kilograms or metres or pieces, and the cashier
    // cannot tell which.
    expect(unitLabel("kg")).toBe(" kg");
  });

  it("stays silent for plain pieces", () => {
    // Most tills sell countable things. Labelling every line "piece" is
    // noise on the screen a cashier reads fastest.
    expect(unitLabel("piece")).toBe("");
    expect(unitLabel(undefined)).toBe("");
  });
});
