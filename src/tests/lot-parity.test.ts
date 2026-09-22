// THE GUARD THAT MAKES "PORT INSTEAD OF EXTRACT" DEFENSIBLE.
//
// lot.service.ts exists TWICE — here and in ims-1 — because the till is a
// separate service with its own copy of the domain against the same database.
// Proposal 02 §0 chose to port and guard rather than extract a shared
// package, and this file is the guard. Without it that decision is just
// duplication with a comment on top.
//
// WHAT DIVERGENCE COSTS, concretely. These two files decide which batch a
// shop sells and whether expired stock reaches a customer. If the till's
// sortFefo tie-breaks differently from the console's, the two services sell
// DIFFERENT BATCHES for the same cart. If the till's isExpired uses <=
// instead of <, it refuses a lawful sale on the last day of a batch's life.
// If the lock orders differ, two concurrent sales deadlock. None of that
// shows up in either repository's own tests, because each is internally
// consistent.
//
// Compared on the RULE-BEARING BODY, not byte-for-byte: the header comment
// legitimately differs (this copy says where it came from). Anything that can
// change behaviour must match exactly.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The sibling checkout. Absolute paths are unavoidable across two
// repositories that share no package; when the sibling is not present — a CI
// runner that checked out one repo — the test SKIPS rather than fails, and
// says so, because a red build for a missing directory teaches people to
// ignore red builds.
const IMS_ROOT = join(process.cwd(), "..", "ims - 1 ");

/**
 * Every file scripts/sync-shared.ts synchronises. Kept in step with that
 * list deliberately: a file added there and not here is a rule that can
 * drift with nothing watching.
 */
const SHARED = [
  "src/utils/quantity.ts",
  "src/application/services/lot.service.ts",
] as const;

const IMS_LOT_SERVICE = join(IMS_ROOT, "src/application/services/lot.service.ts");
const OWN_LOT_SERVICE = join(process.cwd(), "src/application/services/lot.service.ts");

/** Everything from the first import onward — the code, without the preamble. */
const body = (source: string): string => {
  const start = source.indexOf("import ");
  if (start === -1) throw new Error("no imports found; file shape changed");
  return source.slice(start).trim();
};

/** One function's source, so a failure names the rule that drifted. */
const fn = (source: string, name: string): string => {
  const start = source.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? undefined : end).trim();
};

const available = existsSync(IMS_LOT_SERVICE);

describe.skipIf(!available)("every synchronised file is byte-identical to its canonical copy", () => {
  // The whole file, banner aside — not just the functions named below.
  // scripts/sync-shared.ts writes these, so any difference at all means
  // someone edited the copy by hand or forgot to re-run the sync.
  for (const relative of SHARED) {
    it(`${relative} matches ims-backend exactly`, () => {
      const canonical = readFileSync(join(IMS_ROOT, relative), "utf8");
      const copy = readFileSync(join(process.cwd(), relative), "utf8");
      // The banner is the only permitted difference: it names the canonical
      // source and tells a reader not to edit the copy.
      expect(copy.endsWith(canonical)).toBe(true);
    });
  }
});

describe.skipIf(!available)("the till's lot rules match the console's", () => {
  const ims = available ? readFileSync(IMS_LOT_SERVICE, "utf8") : "";
  const own = readFileSync(OWN_LOT_SERVICE, "utf8");

  // Named individually so a failure says WHICH rule drifted, rather than
  // handing someone a 364-line diff.
  for (const name of [
    "sortFefo",
    "allocateFefo",
    "isExpired",
    "lotAvailableQtyMilli",
    "releaseWithoutReservation",
    "lockLotsForVariant",
    "rebuildRollup",
    "applyLotDelta",
    "recordReservation",
    "getReservation",
    "upsertLot",
  ]) {
    it(`${name} is identical in both services`, () => {
      expect(fn(own, name)).toBe(fn(ims, name));
    });
  }

  it("the whole rule-bearing body is identical", () => {
    // Catches a rule added to one side and not the other, which the
    // per-function checks above cannot see.
    expect(body(own)).toBe(body(ims));
  });
});

describe.skipIf(available)("sibling checkout not present", () => {
  it("skips rather than fails, and says why", () => {
    // Deliberately passing. A red build for a missing sibling directory
    // teaches people to ignore red builds, which is worse than the drift this
    // file exists to catch.
    expect(available).toBe(false);
  });
});
