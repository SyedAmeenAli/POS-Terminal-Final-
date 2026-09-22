// ┌──────────────────────────────────────────────────────────────────────┐
// │ SYNCHRONISED FILE — do not edit this copy.                           │
// │                                                                      │
// │ Canonical source: ims-backend. Regenerate with:                      │
// │     ./node_modules/.bin/tsx scripts/sync-shared.ts                   │
// │                                                                      │
// │ The till and the back office price the same sale and decide which    │
// │ batch a shop sells, against ONE database. A difference here is a     │
// │ difference a customer meets at a counter. Both repos' parity tests   │
// │ compare these files and fail the build when they diverge.            │
// └──────────────────────────────────────────────────────────────────────┘
// T30 — quantity, stored the way money is stored.
//
// The money path settled this argument years ago: rupees as a float is a
// representable-values problem, so money is bigint paise. Quantity has the
// same problem — a grocery sells 1.5 kg, a hardware shop 2.75 m — and gets
// the same answer rather than a different one.
//
//   1 unit = 1000 milli-units.  1.5 kg -> 1500.  2.75 m -> 2750.  1 piece -> 1000.
//
// Three decimal places is enough for every unit this system sells in,
// including grams for jewellery (1 milli-gram of resolution).

import { AppError } from "../api/errors.js";

export const MILLI = 1000n;

/**
 * Units an item can be stocked or traded in.
 *
 * `piece` is special and is the default: it is the only unit for which a
 * fractional quantity is a data-entry error rather than a normal sale. Half a
 * shirt is a typo; half a kilogram is Tuesday.
 */
export const UNITS = [
  "piece", "box", "pack", "dozen", "pair", "set",
  "kg", "g", "litre", "ml",
  "metre", "cm", "foot", "sqft",
] as const;

export type Unit = (typeof UNITS)[number];

export const FRACTIONAL_UNITS: ReadonlySet<Unit> = new Set<Unit>([
  "kg", "g", "litre", "ml", "metre", "cm", "foot", "sqft",
]);

export const isFractionalUnit = (unit: string): boolean => FRACTIONAL_UNITS.has(unit as Unit);

/**
 * Parses a quantity written by a human into milli-units.
 *
 * As strict as moneyStringToPaise, and for the same reason: this is the edge
 * where a float would otherwise enter the system. More than three decimal
 * places is REFUSED rather than rounded — silently dropping a digit gives a
 * shop a stock figure they cannot reconcile and cannot explain.
 */
export const quantityToMilli = (
  value: string | number,
  options: { allowZero?: boolean; unit?: string } = {},
): bigint => {
  const text = typeof value === "number" ? String(value) : value.trim();

  if (!/^-?\d+(?:\.\d{1,3})?$/.test(text)) {
    // Four decimals lands here deliberately: a quantity we cannot represent
    // exactly must be refused, not rounded into one we can.
    throw new AppError(
      422,
      `"${value}" is not a valid quantity. Use up to three decimal places.`,
      undefined,
      "INVALID_QUANTITY",
    );
  }

  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const milli = BigInt(whole) * MILLI + BigInt(fraction.padEnd(3, "0"));
  const signed = negative ? -milli : milli;

  if (signed === 0n && !options.allowZero) {
    throw new AppError(422, "Quantity must not be zero", undefined, "INVALID_QUANTITY");
  }

  // The one rule that makes `piece` different from every other unit.
  if (options.unit !== undefined && !isFractionalUnit(options.unit) && signed % MILLI !== 0n) {
    throw new AppError(
      422,
      `A quantity in ${options.unit} must be a whole number — "${value}" is not.`,
      undefined,
      "FRACTIONAL_NOT_ALLOWED",
    );
  }

  return signed;
};

/**
 * Milli-units back to something a person reads, with trailing zeros trimmed.
 *
 * Used at EVERY boundary that leaves this system — invoices, e-invoice and
 * e-way bill payloads, GST returns, receipts, exports. Emitting 1500 where
 * the document means 1.5 kg would be a statutory misfiling on a customer's
 * behalf, so this is not a display nicety.
 */
export const formatQuantity = (milli: bigint): string => {
  const negative = milli < 0n;
  const magnitude = negative ? -milli : milli;
  const whole = magnitude / MILLI;
  const fraction = magnitude % MILLI;

  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;

  const trimmed = fraction.toString().padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${trimmed}`;
};

/** For the arithmetic that still deals in whole units — never for money. */
export const milliToNumber = (milli: bigint): number => Number(milli) / 1000;

/**
 * A unit conversion, held as an INTEGER RATIO rather than a decimal.
 *
 * `1 box = 100 pieces` is exact either way. `1 bag = 33.33 kg` is not, and a
 * decimal factor loses a little on every conversion — so stock drifts, slowly,
 * in a way nobody notices until a stock-take. As a ratio the arithmetic stays
 * exact, and the one rounding that remains happens once, where it is visible.
 */
export type UnitConversion = {
  /** How many BASE units one secondary unit is worth: numerator / denominator. */
  denominator: bigint;
  numerator: bigint;
};

export const convertToBase = (secondaryMilli: bigint, conversion: UnitConversion): bigint => {
  if (conversion.denominator === 0n) {
    throw new AppError(500, "Unit conversion has a zero denominator", undefined, "BAD_CONVERSION");
  }
  return roundHalfUp(secondaryMilli * conversion.numerator, conversion.denominator);
};

/**
 * Integer division rounding half away from zero.
 *
 * Shared by quantity conversion and the money path so both round the same
 * way. Half-up is what an Indian shopkeeper and their CA both expect; the
 * alternative (banker's rounding) is defensible and would surprise them.
 */
export const roundHalfUp = (numerator: bigint, denominator: bigint): bigint => {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
};

/**
 * The money-path half of fractional quantity.
 *
 * `unitPricePaise` is per WHOLE unit; `quantityMilli` is thousandths of one.
 * So the product is divided by 1000, and that division is where sub-paise
 * amounts appear for the first time in this codebase — ₹95/kg × 0.333 kg is
 * ₹31.635, which is not a payable amount.
 *
 * Rounded ONCE, here, at the line. Never again at the invoice total: rounding
 * twice makes the lines stop summing to the total, and a shopkeeper who adds
 * up their own invoice and gets a different answer stops trusting the system.
 */
export const lineTotalPaise = (unitPricePaise: bigint, quantityMilli: bigint): bigint =>
  roundHalfUp(unitPricePaise * quantityMilli, MILLI);
