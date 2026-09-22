import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TERMINAL_TOKEN_PREFIX_LENGTH,
  terminalTokenPrefix,
} from "../application/services/terminal-token.js";

describe("terminal token prefix", () => {
  // The prefix is a lookup key, not a credential. It exists so a presented
  // token can be found with one indexed query instead of a bcrypt compare
  // against every terminal row.
  it("takes a fixed-length leading slice of the token", () => {
    const token = "abcdefghijklmnopqrstuvwxyz";

    expect(terminalTokenPrefix(token)).toBe("abcdefghijkl");
    expect(terminalTokenPrefix(token)).toHaveLength(TERMINAL_TOKEN_PREFIX_LENGTH);
  });

  it("matches the slice provision-terminal.ts writes to the database", () => {
    // provision-terminal.ts stores token.slice(0, 12). If either side changes
    // independently, every newly provisioned terminal silently fails to
    // authenticate, so this asserts the two stay identical.
    const token = randomBytes(32).toString("base64url");

    expect(terminalTokenPrefix(token)).toBe(token.slice(0, 12));
  });

  it("leaves the overwhelming majority of the token unexposed", () => {
    const token = randomBytes(32).toString("base64url");

    expect(terminalTokenPrefix(token).length).toBeLessThan(token.length / 2);
  });

  it("is stable for the same token and differs across tokens", () => {
    const a = randomBytes(32).toString("base64url");
    const b = randomBytes(32).toString("base64url");

    expect(terminalTokenPrefix(a)).toBe(terminalTokenPrefix(a));
    expect(terminalTokenPrefix(a)).not.toBe(terminalTokenPrefix(b));
  });
});
