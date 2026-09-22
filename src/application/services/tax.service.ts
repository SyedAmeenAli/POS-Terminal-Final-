// MIRROR of ims-1's tax.service.ts, kept byte-for-byte identical on purpose.
// No shared package exists between the two repos (verified — see the T15
// phase prompt), so this cannot be imported across repos; it is copied
// instead, with the equivalence proven by a shared fixture table run in
// both repos' test suites (tax.service.test.ts). When ims-1's tax.service.ts
// changes, copy this file across, the same discipline schema.ts already
// follows.
//
// T15 — tax foundation. Pure, dependency-free functions: no database access,
// fully unit-testable in isolation. GST treatment and the CGST/SGST/IGST
// split are computed here and nowhere else — order.service.ts calls into
// this module rather than reimplementing the rules inline.
//
// Money is integer paise throughout, following the same bigint discipline
// order.service.ts already established (calculateTaxAmountPaise). No float
// arithmetic anywhere in this file.

// GSTIN: 2-digit state code + 10-char PAN + 1-digit entity number + 'Z' +
// 1 checksum char. Format-only here — no live government lookup, no
// registry check. That is an external integration with its own port, flag
// and failure modes, and does not belong here (see gstin-verification.
// service.ts). T22 adds the one piece of GSTIN correctness that IS pure and
// offline: the checksum (isValidGstinChecksum below).
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const isValidGstinFormat = (gstin: string): boolean => GSTIN_FORMAT.test(gstin);

// T22 — GSTIN's 15th character is a checksum over the preceding 14, mod-36
// weighted (the standard algorithm GSTN itself uses). Pure, dependency-free,
// deterministic arithmetic — catches most typos at zero cost before any
// network call. Kept as a SEPARATE opt-in function from isValidGstinFormat,
// not folded into it: existing callers keep their current (format-only)
// semantics, and a caller that wants the stronger check opts in explicitly.
// Silently strengthening a validator that already guards live data risks
// rejecting rows that are already stored.
const GSTIN_CHECKSUM_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const isValidGstinChecksum = (gstin: string): boolean => {
  if (!isValidGstinFormat(gstin)) {
    return false;
  }

  let factor = 2;
  let sum = 0;

  for (let i = gstin.length - 2; i >= 0; i--) {
    const codePoint = GSTIN_CHECKSUM_ALPHABET.indexOf(gstin[i]!);
    let digit = factor * codePoint;
    digit = Math.floor(digit / 36) + (digit % 36);
    sum += digit;
    factor = factor === 2 ? 1 : 2;
  }

  const expectedCheckCodePoint = (36 - (sum % 36)) % 36;
  return GSTIN_CHECKSUM_ALPHABET[expectedCheckCodePoint] === gstin[14];
};

// B2CL threshold — supplies to unregistered buyers, inter-state, above this
// value. Currently ₹1,00,000 (reduced from ₹2,50,000 by Central Tax
// Notification 12/2024, effective 1 Aug 2024). A named constant because
// this number has already changed once and will again — grep for this name
// rather than a literal when the next notification lands. Shared with
// T19's GSTR-1 B2CL section builder.
export const GST_B2CL_THRESHOLD_PAISE = 100_000_00n; // ₹1,00,000.00

// GST state codes are two-digit; shipping addresses store a free-text state
// NAME (used for courier/label purposes, not tax purposes — see
// sales_orders.shippingState). This maps the common name spellings to their
// GST code so place-of-supply resolution can compare codes consistently
// rather than comparing a name to a code. Unmapped/unrecognised names
// resolve to null, which resolvePlaceOfSupplyStateCode then falls through
// past — never silently miscompares a name against a code.
const STATE_NAME_TO_GST_CODE: Record<string, string> = {
  "andaman and nicobar islands": "35",
  "andhra pradesh": "37",
  "arunachal pradesh": "12",
  assam: "18",
  bihar: "10",
  chandigarh: "04",
  chhattisgarh: "22",
  "dadra and nagar haveli and daman and diu": "26",
  delhi: "07",
  goa: "30",
  gujarat: "24",
  haryana: "06",
  "himachal pradesh": "02",
  "jammu and kashmir": "01",
  jharkhand: "20",
  karnataka: "29",
  kerala: "32",
  ladakh: "38",
  lakshadweep: "31",
  "madhya pradesh": "23",
  maharashtra: "27",
  manipur: "14",
  meghalaya: "17",
  mizoram: "15",
  nagaland: "13",
  odisha: "21",
  puducherry: "34",
  punjab: "03",
  rajasthan: "08",
  sikkim: "11",
  "tamil nadu": "33",
  telangana: "36",
  tripura: "16",
  "uttar pradesh": "09",
  uttarakhand: "05",
  "west bengal": "19",
};

/**
 * Resolves a free-text state name (as stored on shippingState) to its
 * two-digit GST code, or the value unchanged if it already looks like a
 * code, or null if neither recognisable. Case/whitespace-insensitive.
 */
export const stateNameToGstCode = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (/^[0-9]{2}$/.test(trimmed)) {
    return trimmed;
  }

  return STATE_NAME_TO_GST_CODE[trimmed.toLowerCase()] ?? null;
};

export type GstTreatment = "b2b" | "b2cl" | "b2cs" | "export" | "exempt";

export type GstTreatmentInput = {
  /** Buyer GSTIN, if any. Presence alone determines B2B — no separate flag. */
  customerGstin: string | null;
  /** Two-digit state code the supply is deemed made to. */
  placeOfSupplyStateCode: string | null;
  /** Seller's own two-digit state code, from business_settings. */
  sellerStateCode: string | null;
  /** Order total in integer paise. */
  orderTotalPaise: bigint;
  /** True when the supply is an export (place of supply outside India). */
  isExport?: boolean;
};

/**
 * Classifies a confirmed order into its GST supply category. Pure: same
 * inputs always produce the same output. Called once, at confirmation, and
 * the result is stored — never recomputed at read or filing time (T15's
 * central architectural bet; see the phase prompt's WHY section).
 *
 * Boundary rule for b2cl, tested explicitly: exactly ₹1,00,000 is b2cs,
 * only strictly above it is b2cl.
 */
export const deriveGstTreatment = (input: GstTreatmentInput): GstTreatment => {
  if (input.isExport) {
    return "export";
  }

  if (input.customerGstin && isValidGstinFormat(input.customerGstin)) {
    return "b2b";
  }

  const isInterState =
    input.placeOfSupplyStateCode !== null &&
    input.sellerStateCode !== null &&
    input.placeOfSupplyStateCode !== input.sellerStateCode;

  if (isInterState && input.orderTotalPaise > GST_B2CL_THRESHOLD_PAISE) {
    return "b2cl";
  }

  return "b2cs";
};

/**
 * Resolves which state a line item's supply is deemed made in, in the
 * fallback order the T15 phase prompt specifies: the customer's own
 * place-of-supply state, then the order's shipping state, then the seller's
 * own state (a walk-in POS sale is intra-state by definition).
 */
export const resolvePlaceOfSupplyStateCode = (input: {
  customerPlaceOfSupplyStateCode: string | null;
  shippingStateCode: string | null;
  sellerStateCode: string | null;
}): string | null =>
  input.customerPlaceOfSupplyStateCode ?? input.shippingStateCode ?? input.sellerStateCode;

export type LineTaxSplit = {
  cgstAmountPaise: bigint;
  sgstAmountPaise: bigint;
  igstAmountPaise: bigint;
  totalTaxPaise: bigint;
};

/**
 * Computes one line's CGST/SGST/IGST split. Intra-state (seller state ==
 * place of supply) splits the rate into CGST + SGST, each exactly half;
 * inter-state puts the whole amount into IGST. A zero rate produces all
 * three amounts at zero — legal and common (GST-exempt / zero-rated goods)
 * — never rejected.
 *
 * Rounding follows order.service.ts's calculateTaxAmountPaise convention
 * exactly (basis points, +5000n before the /10000n divide) so a line total
 * and an order total computed the same way never drift by a paisa from
 * inconsistent rounding.
 */
export const computeLineTaxSplit = (
  taxableValuePaise: bigint,
  taxRatePercent: string,
  isInterState: boolean,
): LineTaxSplit => {
  const [whole = "0", fractional = ""] = taxRatePercent.split(".");
  const basisPoints = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0").slice(0, 2));
  const totalTaxPaise = (taxableValuePaise * basisPoints + 5000n) / 10000n;

  if (totalTaxPaise === 0n) {
    return { cgstAmountPaise: 0n, sgstAmountPaise: 0n, igstAmountPaise: 0n, totalTaxPaise: 0n };
  }

  if (isInterState) {
    return { cgstAmountPaise: 0n, sgstAmountPaise: 0n, igstAmountPaise: totalTaxPaise, totalTaxPaise };
  }

  // Split as evenly as an integer allows; any single paisa of rounding
  // remainder goes to CGST rather than being lost, so cgst + sgst always
  // reconstructs totalTaxPaise exactly.
  const half = totalTaxPaise / 2n;
  const remainder = totalTaxPaise - half * 2n;
  return {
    cgstAmountPaise: half + remainder,
    sgstAmountPaise: half,
    igstAmountPaise: 0n,
    totalTaxPaise,
  };
};

/**
 * The stronger invariant a CHECK constraint cannot express (it cannot see
 * the rate): a line with a non-zero rate must have non-zero tax somewhere.
 * Call this at the service boundary, where the rate is in scope, not at
 * the database — see the migration's comment on why this isn't a CHECK.
 */
export const assertLineTaxConsistency = (
  taxRatePercent: string,
  split: Pick<LineTaxSplit, "cgstAmountPaise" | "sgstAmountPaise" | "igstAmountPaise">,
): void => {
  const rate = Number(taxRatePercent);
  const totalTax = split.cgstAmountPaise + split.sgstAmountPaise + split.igstAmountPaise;

  if (rate > 0 && totalTax === 0n) {
    throw new Error(
      `Tax rate ${taxRatePercent}% produced zero tax — this indicates a computation error, not a legitimate exempt line`,
    );
  }
};

/**
 * T16b — scales an original line amount (taxable value, or any single tax
 * component) down to the share a partial return actually covers. A credit
 * note MIRRORS the original line's tax, it never recomputes it (see
 * deriveGstTreatment's own doc comment on why treatment is inherited, not
 * recomputed — this is the same discipline applied to the amounts
 * themselves). Round-half-up in integer paise, matching the convention
 * computeLineTaxSplit already uses, so a full-quantity return (the only
 * path reachable today — see credit-note.service.ts) reproduces the
 * original amount exactly: returnedQty === originalQty implies the result
 * equals originalAmountPaise to the paisa, not an approximation of it.
 */
export const proportionalSharePaise = (
  originalAmountPaise: bigint,
  // T30 — bigint milli. The ratio is unit-agnostic, so the arithmetic is
  // unchanged; taking bigint avoids a Number() round-trip on a money path.
  returnedQtyMilli: bigint,
  originalQtyMilli: bigint,
): bigint => {
  if (originalQtyMilli <= 0n) {
    throw new Error(`originalQty must be positive, got ${originalQtyMilli}`);
  }
  if (returnedQtyMilli < 0n || returnedQtyMilli > originalQtyMilli) {
    throw new Error(`returnedQty (${returnedQtyMilli}) must be between 0 and originalQty (${originalQtyMilli})`);
  }

  const returnedQtyBig = returnedQtyMilli;
  const originalQtyBig = originalQtyMilli;

  return (originalAmountPaise * returnedQtyBig + originalQtyBig / 2n) / originalQtyBig;
};
