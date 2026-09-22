import { EmailAdapter } from "./email.adapter.js";
import { EmailStubAdapter } from "./email.stub.adapter.js";
import { GcpSecretsAdapter } from "./gcp-secrets.adapter.js";
import { localEnvSecretsAdapter } from "./local-env-secrets.adapter.js";
import { RazorpayAdapter } from "./razorpay.adapter.js";
import { RazorpayStubAdapter } from "./razorpay.stub.adapter.js";
import type { EmailPort } from "../../application/ports/email.port.js";
import type { PaymentPort } from "../../application/ports/payment.port.js";
import type { SecretsPort } from "../../application/ports/secrets.port.js";
import { loadEnvSync } from "../../env-sync.js";

const env = loadEnvSync();

const activeSecretsAdapter: SecretsPort =
  env.GCP_SECRET_MANAGER_ENABLED && env.GCP_PROJECT_ID
    ? new GcpSecretsAdapter(env.GCP_PROJECT_ID)
    : localEnvSecretsAdapter;

export const createPaymentPort = (secrets: SecretsPort = activeSecretsAdapter): PaymentPort =>
  env.RAZORPAY_LIVE_ENABLED
    ? new RazorpayAdapter(secrets, {
        baseUrl: env.RAZORPAY_API_BASE_URL ?? "https://api.razorpay.com",
        liveEnabled: true,
        timeoutMs: env.RAZORPAY_TIMEOUT_MS ?? 5000,
      })
    : new RazorpayStubAdapter();

export const createEmailPort = (secrets: SecretsPort = activeSecretsAdapter): EmailPort =>
  env.EMAIL_LIVE_ENABLED
    ? new EmailAdapter(secrets, {
        baseUrl: env.EMAIL_PROVIDER_BASE_URL ?? "https://api.resend.com",
        fromAddress: env.EMAIL_FROM_ADDRESS ?? "",
        liveEnabled: true,
        timeoutMs: env.EMAIL_TIMEOUT_MS ?? 5000,
      })
    : new EmailStubAdapter();
