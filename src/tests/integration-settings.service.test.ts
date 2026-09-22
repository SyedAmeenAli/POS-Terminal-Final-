import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SecretsPort } from "../application/ports/secrets.port.js";
import { MissingSecretError } from "../infrastructure/adapters/local-env-secrets.adapter.js";

describe("integration settings service", () => {
  let secrets: SecretsPort;

  beforeEach(() => {
    secrets = {
      getSecret: vi.fn(async (key: string) => {
        const values: Record<string, string> = {
          EMAIL_API_KEY: "email-secret",
          EMAIL_FROM_ADDRESS: "receipts@example.com",
          RAZORPAY_KEY_ID: "razor-id",
          RAZORPAY_KEY_SECRET: "razor-secret",
          RAZORPAY_WEBHOOK_SECRET: "razor-webhook",
        };

        if (!(key in values)) {
          throw new MissingSecretError(key);
        }

        return values[key];
      }) as SecretsPort["getSecret"],
    };
  });

  it("returns connected/not_configured/error without secret values", async () => {
    const { getIntegrationStatuses } = await import("../application/services/integration-settings.service.js");
    const result = await getIntegrationStatuses(secrets, {
      EMAIL_LIVE_ENABLED: "true",
      RAZORPAY_LIVE_ENABLED: "true",
    });

    expect(result.email.status).toBe("connected");
    expect(result.razorpay.status).toBe("connected");
    expect(JSON.stringify(result)).not.toContain("razor-secret");
  });

  it("returns error when live enabled but secret missing", async () => {
    const getSecretMock = vi.fn(async (key: string) => {
      if (key === "RAZORPAY_KEY_SECRET") {
        throw new MissingSecretError(key);
      }

      return "present";
    }) as SecretsPort["getSecret"];
    secrets = { getSecret: getSecretMock };

    const { getIntegrationStatuses } = await import("../application/services/integration-settings.service.js");
    const result = await getIntegrationStatuses(secrets, {
      EMAIL_LIVE_ENABLED: "false",
      RAZORPAY_LIVE_ENABLED: "true",
    });

    expect(result.razorpay.status).toBe("error");
  });
});
