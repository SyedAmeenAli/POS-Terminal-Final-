// T30 — MIRRORS `FRACTIONAL_UNITS` in `src/utils/quantity.ts`.
//
// Duplicated because the till's server and its web bundle are separate
// TypeScript projects with no shared module. Duplication of a list like this
// drifts, and the drift shows up as a quantity the cart accepts and the
// server refuses AFTER the cashier has finished the sale — so
// `src/tests/units-parity.test.ts` reads BOTH files and fails if they differ.
//
// If you add a unit there, add it here.

/**
 * Units a fraction makes sense in. Half a kilogram is a quantity; half a
 * piece is a data-entry error, and the server refuses it with
 * FRACTIONAL_NOT_ALLOWED rather than rounding it away.
 */
export const FRACTIONAL_UNITS: ReadonlySet<string> = new Set([
  "kg", "g", "litre", "ml", "metre", "cm", "foot", "sqft",
]);

export const isFractionalUnit = (unit: string | undefined): boolean =>
  unit !== undefined && FRACTIONAL_UNITS.has(unit);

/**
 * Parses what a cashier typed, applying the SAME rule the server applies.
 *
 * Returns null when the value is unusable, so the caller decides what to show
 * — this function never guesses and never rounds. Three decimal places,
 * because quantities are stored in thousandths and a fourth cannot be
 * represented; `quantityToMilli` refuses one server-side rather than
 * silently dropping it, and this must not be more permissive.
 */
export const parseCartQuantity = (
  raw: string,
  unit: string | undefined,
): { error: string } | { value: number } => {
  const text = raw.trim();
  if (text === "") return { error: "Enter a quantity." };

  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return { error: "Quantity must be more than zero." };

  const decimals = text.split(".")[1]?.length ?? 0;
  if (decimals > 3) return { error: "At most three decimal places." };

  if (!isFractionalUnit(unit) && !Number.isInteger(value)) {
    return { error: `${unit ?? "This item"} is sold in whole units.` };
  }

  return { value };
};

/** The unit shown beside a quantity. Absent for a plain piece-counted item. */
export const unitLabel = (unit: string | undefined): string =>
  unit && unit !== "piece" ? ` ${unit}` : "";

// BUG FOUND 2026-09-16: an order's own items come back from the server as
// `quantityMilli` (a string, thousandths — confirmed against a real GET
// /orders/:id response: `"quantityMilli":"1000"`, no `quantity` field at
// all). web/src/api/types.ts's `Order["items"]` declared `quantity: number`
// instead — a type that lied about the real response shape, so
// `Number(item.unitPrice) * item.quantity` read `undefined` and every
// receipt line total printed ₹NaN. Found on the first real sale run
// through this till. These two mirror `formatQuantity` and `milliToNumber`
// in the server's own src/utils/quantity.ts — same rounding, same trimmed
// decimal — so a receipt reads the same quantity the ledger recorded.

/** For arithmetic — never for the string shown to a cashier. */
export const milliToUnits = (milli: string | number): number => Number(milli) / 1000;

/** "1" for a whole unit, "1.5" for a fraction — never "1.500". */
export const formatQuantityMilli = (milli: string | number): string => {
  const value = Number(milli);
  if (!Number.isFinite(value)) return "0";

  const negative = value < 0;
  const magnitude = Math.abs(value);
  const whole = Math.trunc(magnitude / 1000);
  const fraction = Math.round(magnitude % 1000);

  if (fraction === 0) return `${negative ? "-" : ""}${whole}`;

  const trimmed = String(fraction).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${trimmed}`;
};
