import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getBusinessSettings: vi.fn(),
  getIntegrationStatuses: vi.fn(),
  updateBusinessSettings: vi.fn(),
}));

vi.mock("../application/services/integration-settings.service.js", () => state);
vi.mock("../application/services/business-settings.service.js", () => state);

describe("Settings routes", () => {
  beforeEach(() => {
    state.getIntegrationStatuses.mockResolvedValue({
      email: { liveEnabled: false, status: "not_configured" },
      razorpay: { liveEnabled: true, status: "error" },
    });
    state.getBusinessSettings.mockResolvedValue({ taxRatePercent: "0.00" });
    state.updateBusinessSettings.mockResolvedValue({ taxRatePercent: "18.00" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns integration statuses without secrets", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const response = await server.inject({
      method: "GET",
      url: "/settings/integrations",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.razorpay.status).toBe("error");
    expect(JSON.stringify(body)).not.toContain("RAZORPAY_KEY_SECRET");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("gets and updates business tax settings", async () => {
    const { buildServer } = await import("../api/server.js");
    const server = buildServer({ authEnabled: false });
    const getResponse = await server.inject({
      method: "GET",
      url: "/settings/business",
    });
    const patchResponse = await server.inject({
      method: "PATCH",
      url: "/settings/business",
      payload: { taxRatePercent: 18 },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(JSON.parse(getResponse.body).data.taxRatePercent).toBe("0.00");
    expect(patchResponse.statusCode).toBe(200);
    // authEnabled: false means resolveTenantHook never runs, so
    // request.tenantId is genuinely undefined here — this test is for route
    // wiring, not tenant resolution.
    expect(state.updateBusinessSettings).toHaveBeenCalledWith(undefined, { taxRatePercent: 18 });
  });
});
