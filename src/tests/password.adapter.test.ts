import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../infrastructure/adapters/password.adapter.js";

describe("password adapter", () => {
  it("hashes with argon2 and verifies the correct password", async () => {
    const plain = "correct horse battery staple";
    const hash = await hashPassword(plain);

    expect(hash).not.toBe(plain);
    expect(hash).not.toContain(plain);
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(plain, hash)).resolves.toBe(true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");

    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("returns false for malformed hashes", async () => {
    await expect(verifyPassword("password", "not-a-password-hash")).resolves.toBe(false);
  });
});
