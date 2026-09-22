import { afterEach, describe, expect, it, vi } from "vitest";

import type { SecretsPort } from "../application/ports/secrets.port.js";
import { EmailAdapter } from "../infrastructure/adapters/email.adapter.js";
import { EmailStubAdapter } from "../infrastructure/adapters/email.stub.adapter.js";

const receiptData = {
  items: [{ name: "Black Tee", quantity: 2, sku: "TEE-BLK-M", unitPrice: "500.00" }],
  orderId: "11111111-1111-4111-8111-111111111111",
  paidAt: "2026-07-29T00:00:00.000Z",
  subtotal: "1000.00",
  taxAmount: "180.00",
  taxRatePercent: "18.00",
  to: "customer@example.com",
  total: "1180.00",
};

describe("Email adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stub mode returns INTEGRATION_DISABLED without network call", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new EmailStubAdapter().sendReceipt(receiptData);

    expect(result).toMatchObject({
      errorType: "INTEGRATION_DISABLED",
      success: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("live mode sends Resend-compatible payload shape", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "email_123" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const secrets: SecretsPort = {
      getSecret: vi.fn(async () => "resend-key"),
    };

    const result = await new EmailAdapter(secrets, {
      baseUrl: "https://api.resend.com",
      fromAddress: "receipts@example.com",
      liveEnabled: true,
      timeoutMs: 5000,
    }).sendReceipt(receiptData);

    expect(result).toEqual({ data: { messageId: "email_123" }, success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer resend-key",
          "content-type": "application/json",
        }),
      }),
    );
    const [, requestInit] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({
      from: "receipts@example.com",
      subject: "Receipt for order 11111111-1111-4111-8111-111111111111",
      to: ["customer@example.com"],
    });
    expect(body.text).toContain("Black Tee");
    expect(body.text).toContain("Subtotal: INR 1000.00");
    expect(body.text).toContain("Tax (18.00%): INR 180.00");
    expect(body.text).toContain("Total: INR 1180.00");
    expect(body.html).toContain("TEE-BLK-M");
  });
});
