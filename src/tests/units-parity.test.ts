// FRACTIONAL_UNITS exists TWICE in this repository — once in
// src/utils/quantity.ts, where the server enforces it, and once in
// web/src/utils/quantity.ts, where the cart checks it before submitting.
//
// Two projects, no shared module, so the duplication is structural. The
// failure it produces is specific and bad: a unit the cart believes is
// fractional and the server does not means the cashier types 1.5, the cart
// accepts it, and the sale is refused with FRACTIONAL_NOT_ALLOWED after the
// customer is standing there. Nothing else in the build would catch it.
//
// Read from disk rather than imported: the web bundle is a separate
// TypeScript project and is not in this program.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FRACTIONAL_UNITS } from "../utils/quantity.js";

const WEB_QUANTITY = join(process.cwd(), "web/src/utils/quantity.ts");

const parseList = (source: string, name: string): string[] => {
  const start = source.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${name} not found in ${WEB_QUANTITY}`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  return [...source.slice(open, close).matchAll(/['"]([a-z]+)['"]/g)].map((m) => m[1]!);
};

describe("the till's cart and its server agree on which units allow a fraction", () => {
  it("lists exactly the same units", () => {
    const web = parseList(readFileSync(WEB_QUANTITY, "utf8"), "FRACTIONAL_UNITS");
    expect(web.sort()).toEqual([...FRACTIONAL_UNITS].sort());
  });
});
