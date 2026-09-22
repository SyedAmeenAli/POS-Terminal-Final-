// T15 — shared fixture, run identically in both repos. Proves ims-1's
// tax.service.ts and this repo's mirrored copy produce identical output —
// the equivalence the T15 phase prompt requires in place of a cross-repo
// import (none is possible; see the phase prompt). If a future edit to
// either copy diverges, this file catches it here, independently of the
// other repo's copy passing.
import { describe, expect, it } from "vitest";

import {
  GST_B2CL_THRESHOLD_PAISE,
  assertLineTaxConsistency,
  computeLineTaxSplit,
  deriveGstTreatment,
  isValidGstinChecksum,
  isValidGstinFormat,
  proportionalSharePaise,
  resolvePlaceOfSupplyStateCode,
  stateNameToGstCode,
} from "../application/services/tax.service.js";

describe("isValidGstinFormat", () => {
  it("accepts a well-formed GSTIN", () => {
    expect(isValidGstinFormat("29ABCDE1234F1ZW")).toBe(true);
  });

  it.each([
    ["too short", "29ABCDE1234F1Z"],
    ["too long", "29ABCDE1234F1ZW5"],
    ["lowercase letters", "29abcde1234f1z5"],
    ["entity code cannot be 0", "29ABCDE1234F0Z5"],
    ["missing Z marker", "29ABCDE1234F1A5"],
  ])("rejects %s", (_label, value) => {
    expect(isValidGstinFormat(value)).toBe(false);
  });
});

// T22 — shared fixture, run identically in both repos (see the mirror
// notice in POS's copy of this file). Every case here is a real GSTIN
// checksum computed by the mod-36 algorithm, not a guess — a passing
// "known-good" case here is the ONLY thing that actually proves the
// algorithm is right, since GSTN publishes the algorithm but not a public
// test-vector list.
describe("isValidGstinChecksum", () => {
  it("accepts a GSTIN whose 15th character is the correct checksum", () => {
    // 27AAPFU0939F1ZV — a real, widely-published GSTIN (Uber India
    // Systems Pvt Ltd), used here purely as an external checksum oracle.
    expect(isValidGstinChecksum("27AAPFU0939F1ZV")).toBe(true);
    // Computed by this same algorithm — see the fixed-literal note in
    // this session's T22 build: the pre-T22 codebase used
    // "27AAAAA0000A1Z5" everywhere as a placeholder, which is
    // format-valid but checksum-invalid; Z2 is the correct check digit
    // for that same 14-character prefix.
    expect(isValidGstinChecksum("27AAAAA0000A1Z2")).toBe(true);
  });

  it("rejects a format-valid GSTIN with the wrong checksum — a typo", () => {
    // Same prefix as the accepted case above, wrong check digit.
    expect(isValidGstinChecksum("27AAAAA0000A1Z5")).toBe(false);
    // Single-digit-transposed-looking neighbour of the real Uber GSTIN.
    expect(isValidGstinChecksum("27AAPFU0939F1Z5")).toBe(false);
  });

  it("rejects anything that isn't format-valid first", () => {
    expect(isValidGstinChecksum("not-a-gstin")).toBe(false);
    expect(isValidGstinChecksum("27AAPFU0939F1Z")).toBe(false);
  });
});

describe("stateNameToGstCode", () => {
  it("maps a known state name, case/whitespace-insensitive", () => {
    expect(stateNameToGstCode("Karnataka")).toBe("29");
    expect(stateNameToGstCode("  karnataka  ")).toBe("29");
    expect(stateNameToGstCode("KARNATAKA")).toBe("29");
  });

  it("passes through a value that already looks like a code", () => {
    expect(stateNameToGstCode("29")).toBe("29");
  });

  it("returns null for null or unrecognised input", () => {
    expect(stateNameToGstCode(null)).toBeNull();
    expect(stateNameToGstCode("Atlantis")).toBeNull();
  });
});

describe("resolvePlaceOfSupplyStateCode", () => {
  it("prefers the customer's place-of-supply code first", () => {
    expect(
      resolvePlaceOfSupplyStateCode({
        customerPlaceOfSupplyStateCode: "29",
        shippingStateCode: "27",
        sellerStateCode: "27",
      }),
    ).toBe("29");
  });

  it("falls back to shipping state when the customer has none", () => {
    expect(
      resolvePlaceOfSupplyStateCode({
        customerPlaceOfSupplyStateCode: null,
        shippingStateCode: "27",
        sellerStateCode: "29",
      }),
    ).toBe("27");
  });

  it("falls back to the seller's own state as the final default (a walk-in POS sale)", () => {
    expect(
      resolvePlaceOfSupplyStateCode({
        customerPlaceOfSupplyStateCode: null,
        shippingStateCode: null,
        sellerStateCode: "29",
      }),
    ).toBe("29");
  });
});

describe("computeLineTaxSplit", () => {
  it("splits intra-state tax evenly into CGST + SGST", () => {
    // ₹1000.00 at 18% = ₹180.00 total → ₹90 + ₹90
    const split = computeLineTaxSplit(100_000n, "18.00", false);
    expect(split.cgstAmountPaise).toBe(9_000n);
    expect(split.sgstAmountPaise).toBe(9_000n);
    expect(split.igstAmountPaise).toBe(0n);
    expect(split.totalTaxPaise).toBe(18_000n);
  });

  it("puts the whole amount into IGST for inter-state", () => {
    const split = computeLineTaxSplit(100_000n, "18.00", true);
    expect(split.cgstAmountPaise).toBe(0n);
    expect(split.sgstAmountPaise).toBe(0n);
    expect(split.igstAmountPaise).toBe(18_000n);
    expect(split.totalTaxPaise).toBe(18_000n);
  });

  it("never loses a paisa of rounding remainder in the CGST/SGST split", () => {
    // ₹333.33 (33333 paise) at 18% = 5999.94 -> rounds to 6000 paise total tax,
    // which is odd once halved: CGST must absorb the remainder.
    const split = computeLineTaxSplit(33_333n, "18.00", false);
    expect(split.cgstAmountPaise + split.sgstAmountPaise).toBe(split.totalTaxPaise);
    expect(split.cgstAmountPaise - split.sgstAmountPaise).toBeLessThanOrEqual(1n);
  });

  it("produces all-zero amounts for a zero rate — legal for GST-exempt / zero-rated lines, never rejected", () => {
    const split = computeLineTaxSplit(50_000n, "0.00", false);
    expect(split.cgstAmountPaise).toBe(0n);
    expect(split.sgstAmountPaise).toBe(0n);
    expect(split.igstAmountPaise).toBe(0n);
    expect(split.totalTaxPaise).toBe(0n);
  });

  it("produces zero tax for a zero taxable value regardless of rate", () => {
    const split = computeLineTaxSplit(0n, "18.00", false);
    expect(split.totalTaxPaise).toBe(0n);
  });
});

describe("assertLineTaxConsistency", () => {
  it("does not throw for a zero-rated line with zero tax — the constraint's easiest failure mode", () => {
    expect(() =>
      assertLineTaxConsistency("0.00", { cgstAmountPaise: 0n, sgstAmountPaise: 0n, igstAmountPaise: 0n }),
    ).not.toThrow();
  });

  it("does not throw when a non-zero rate produced non-zero tax", () => {
    expect(() =>
      assertLineTaxConsistency("18.00", { cgstAmountPaise: 90n, sgstAmountPaise: 90n, igstAmountPaise: 0n }),
    ).not.toThrow();
  });

  it("throws when a non-zero rate produced zero tax — a real computation error, not a legitimate exempt line", () => {
    expect(() =>
      assertLineTaxConsistency("18.00", { cgstAmountPaise: 0n, sgstAmountPaise: 0n, igstAmountPaise: 0n }),
    ).toThrow();
  });
});

describe("deriveGstTreatment", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof deriveGstTreatment>[0];
    expected: ReturnType<typeof deriveGstTreatment>;
  }> = [
    {
      name: "customer with a valid GSTIN is always B2B, regardless of amount or state",
      input: {
        customerGstin: "29ABCDE1234F1ZW",
        placeOfSupplyStateCode: "29",
        sellerStateCode: "29",
        orderTotalPaise: 1_00n,
      },
      expected: "b2b",
    },
    {
      name: "no GSTIN, intra-state, any amount is B2CS",
      input: {
        customerGstin: null,
        placeOfSupplyStateCode: "29",
        sellerStateCode: "29",
        orderTotalPaise: 1_000_000_00n,
      },
      expected: "b2cs",
    },
    {
      name: "no GSTIN, inter-state, at or below ₹1,00,000 is B2CS",
      input: {
        customerGstin: null,
        placeOfSupplyStateCode: "27",
        sellerStateCode: "29",
        orderTotalPaise: GST_B2CL_THRESHOLD_PAISE,
      },
      expected: "b2cs",
    },
    {
      name: "no GSTIN, inter-state, strictly above ₹1,00,000 is B2CL — the boundary that actually matters",
      input: {
        customerGstin: null,
        placeOfSupplyStateCode: "27",
        sellerStateCode: "29",
        orderTotalPaise: GST_B2CL_THRESHOLD_PAISE + 1n,
      },
      expected: "b2cl",
    },
    {
      name: "export flag overrides everything else",
      input: {
        customerGstin: "29ABCDE1234F1ZW",
        placeOfSupplyStateCode: null,
        sellerStateCode: "29",
        orderTotalPaise: 1_00n,
        isExport: true,
      },
      expected: "export",
    },
    {
      name: "malformed GSTIN does not count as B2B",
      input: {
        customerGstin: "not-a-real-gstin",
        placeOfSupplyStateCode: "29",
        sellerStateCode: "29",
        orderTotalPaise: 1_00n,
      },
      expected: "b2cs",
    },
    {
      name: "unknown place of supply (neither state known) is treated as not inter-state — falls to B2CS",
      input: {
        customerGstin: null,
        placeOfSupplyStateCode: null,
        sellerStateCode: null,
        orderTotalPaise: GST_B2CL_THRESHOLD_PAISE + 1n,
      },
      expected: "b2cs",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(deriveGstTreatment(input)).toBe(expected);
  });
});

describe("proportionalSharePaise", () => {
  it("returns the original amount exactly on a full-quantity return (the only reachable path today)", () => {
    expect(proportionalSharePaise(12345n, 3000n, 3000n)).toBe(12345n);
  });

  it("returns zero when nothing is returned", () => {
    expect(proportionalSharePaise(12345n, 0n, 3000n)).toBe(0n);
  });

  it("splits proportionally for a partial return, rounding half up", () => {
    // 100 paise over 3 units = 33.33 per unit; 1 of 3 returned rounds to 33.
    expect(proportionalSharePaise(100n, 1000n, 3000n)).toBe(33n);
    // 2 of 3 returned: 200/3 = 66.67, rounds to 67.
    expect(proportionalSharePaise(100n, 2000n, 3000n)).toBe(67n);
  });

  it("rejects a non-positive originalQty", () => {
    expect(() => proportionalSharePaise(100n, 0n, 0n)).toThrow(/originalQty must be positive/);
  });

  it.each([
    ["negative returnedQty", -1000n, 3000n],
    ["returnedQty exceeding originalQty", 4000n, 3000n],
  ])("rejects %s", (_name, returnedQtyMilli, originalQtyMilli) => {
    expect(() => proportionalSharePaise(100n, returnedQtyMilli, originalQtyMilli)).toThrow(/must be between 0 and originalQty/);
  });
});
