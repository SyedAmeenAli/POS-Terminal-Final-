import { describe, expect, it } from "vitest";

import {
  createOwnerSessionToken,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_TTL_MS,
  verifyOwnerSessionToken,
} from "../application/services/owner-session.service.js";

describe("POS owner session", () => {
  it("uses a POS-specific cookie name", () => {
    expect(OWNER_SESSION_COOKIE).toBe("pos_owner_session");
  });

  it("expires after the short till TTL", () => {
    const now = Date.now();
    const token = createOwnerSessionToken(now);

    expect(verifyOwnerSessionToken(token, now + OWNER_SESSION_TTL_MS - 1)).toBe(true);
    expect(verifyOwnerSessionToken(token, now + OWNER_SESSION_TTL_MS + 1)).toBe(false);
  });
});

