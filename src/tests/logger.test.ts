import { describe, expect, it } from "vitest";

import { REDACTED, redactLogFields } from "../utils/logger.js";

describe("log field redaction", () => {
  it("redacts sensitive keys regardless of casing or separators", () => {
    const result = redactLogFields({
      terminalToken: "abc123",
      API_KEY: "k-live-1",
      "api-key": "k-live-2",
      password: "hunter2",
      DATABASE_URL: "postgresql://u:p@host:5432/db",
      authorization: "Bearer xyz",
      pinHash: "$2b$10$abcdefg",
    });

    expect(result).toEqual({
      terminalToken: REDACTED,
      API_KEY: REDACTED,
      "api-key": REDACTED,
      password: REDACTED,
      DATABASE_URL: REDACTED,
      authorization: REDACTED,
      pinHash: REDACTED,
    });
  });

  it("redacts short sensitive keys by exact match only", () => {
    const result = redactLogFields({ pin: "1234", cvv: "999", cardNumber: "4111111111111111" });

    expect(result).toEqual({ pin: REDACTED, cvv: REDACTED, cardNumber: REDACTED });
  });

  it("does not redact benign keys that merely contain a short sensitive word", () => {
    // "shipping" contains "pin"; "company" and "panel" contain "pan". Substring
    // matching on short keys would wrongly redact all three.
    const result = redactLogFields({
      shippingCity: "Bengaluru",
      company: "Acme",
      panelId: "left",
      cardLast4: "4242",
      cardApprovalCode: "APPR123",
    });

    expect(result).toEqual({
      shippingCity: "Bengaluru",
      company: "Acme",
      panelId: "left",
      cardLast4: "4242",
      cardApprovalCode: "APPR123",
    });
  });

  it("scrubs credentials embedded in connection strings inside values", () => {
    const result = redactLogFields({
      errorMessage: 'connect ETIMEDOUT postgresql://pos_app:s3cr3t@10.0.0.5:5432/final_ims_build',
    });

    expect(result.errorMessage).toBe(
      `connect ETIMEDOUT postgresql://pos_app:${REDACTED}@10.0.0.5:5432/final_ims_build`,
    );
    expect(result.errorMessage).not.toContain("s3cr3t");
  });

  it("scrubs bearer tokens appearing inside free-text values", () => {
    const result = redactLogFields({
      detail: "upstream rejected header Bearer aGVsbG8td29ybGQtdG9rZW4 for terminal",
    });

    expect(result.detail).toBe(`upstream rejected header Bearer ${REDACTED} for terminal`);
    expect(result.detail).not.toContain("aGVsbG8td29ybGQtdG9rZW4");
  });

  it("redacts recursively through nested objects and arrays", () => {
    const result = redactLogFields({
      context: {
        terminalId: "t-1",
        auth: { token: "leak-me" },
        attempts: [{ password: "p1" }, { note: "ok" }],
      },
    });

    expect(result).toEqual({
      context: {
        terminalId: "t-1",
        auth: { token: REDACTED },
        attempts: [{ password: REDACTED }, { note: "ok" }],
      },
    });
  });

  it("survives circular references without throwing", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => redactLogFields({ circular })).not.toThrow();
    expect(JSON.stringify(redactLogFields({ circular }))).toContain("[CIRCULAR]");
  });

  it("leaves ordinary operational fields untouched", () => {
    const result = redactLogFields({
      terminalId: "t-1",
      cashierId: "c-9",
      status: 200,
      path: "/orders",
      durationMs: 12,
    });

    expect(result).toEqual({
      terminalId: "t-1",
      cashierId: "c-9",
      status: 200,
      path: "/orders",
      durationMs: 12,
    });
  });
});
