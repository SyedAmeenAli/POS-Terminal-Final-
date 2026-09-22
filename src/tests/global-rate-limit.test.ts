import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enforceGlobalRateLimit, resetGlobalRateLimit } from "../api/middleware/global-rate-limit.js";

// T5 item 2. The counters live in an in-memory Map, so the limit this asserts
// is the PER-INSTANCE limit: the effective ceiling across the service is
// (configured limit x running instances). pos-terminal's maxScale is capped
// at 2 to bound that multiplier — see docs/runbook.md. Moving the
// counters to Memorystore is the only way to make the limit global, and it
// costs ~$25/mo against an explicit project cost constraint.

const request = (over: Partial<FastifyRequest> = {}) =>
  ({ ip: "203.0.113.10", ...over }) as FastifyRequest;

describe("global rate limit", () => {
  beforeEach(() => {
    resetGlobalRateLimit();
    process.env.GLOBAL_RATE_LIMIT_MAX_REQUESTS = "5";
    process.env.GLOBAL_RATE_LIMIT_WINDOW_SECONDS = "60";
  });

  afterEach(() => {
    resetGlobalRateLimit();
    delete process.env.GLOBAL_RATE_LIMIT_MAX_REQUESTS;
    delete process.env.GLOBAL_RATE_LIMIT_WINDOW_SECONDS;
  });

  it("rejects at exactly the configured threshold, within one instance", () => {
    for (let index = 0; index < 5; index += 1) {
      expect(() => enforceGlobalRateLimit(request())).not.toThrow();
    }

    expect(() => enforceGlobalRateLimit(request())).toThrowError(/Too many requests/);
  });

  it("answers 429 RATE_LIMITED rather than a generic failure", () => {
    for (let index = 0; index < 5; index += 1) enforceGlobalRateLimit(request());

    try {
      enforceGlobalRateLimit(request());
      throw new Error("expected the limiter to reject");
    } catch (error) {
      expect(error).toMatchObject({ errorType: "RATE_LIMITED", statusCode: 429 });
    }
  });

  it("counts each caller separately, so one noisy IP cannot lock everyone out", () => {
    for (let index = 0; index < 5; index += 1) enforceGlobalRateLimit(request());

    expect(() => enforceGlobalRateLimit(request({ ip: "198.51.100.7" }))).not.toThrow();
  });

  it("keys on the terminal when there is one, not the shared egress IP", () => {
    // Terminals in one shop share a public IP. Keying on the IP would let a
    // busy till exhaust the budget for every other till in the same store.
    const terminal = { id: "terminal-a" } as FastifyRequest["terminal"];
    for (let index = 0; index < 5; index += 1) {
      enforceGlobalRateLimit(request({ terminal }));
    }

    expect(() => enforceGlobalRateLimit(request({ terminal }))).toThrow();
    expect(() =>
      enforceGlobalRateLimit(request({ terminal: { id: "terminal-b" } as FastifyRequest["terminal"] })),
    ).not.toThrow();
  });

  it("lets a caller through again once the window has passed", () => {
    process.env.GLOBAL_RATE_LIMIT_WINDOW_SECONDS = "1";
    resetGlobalRateLimit();

    const start = Date.now();
    const nowSpy = () => start + 2000;
    for (let index = 0; index < 5; index += 1) enforceGlobalRateLimit(request());

    const original = Date.now;
    Date.now = nowSpy;
    try {
      expect(() => enforceGlobalRateLimit(request())).not.toThrow();
    } finally {
      Date.now = original;
    }
  });
});
