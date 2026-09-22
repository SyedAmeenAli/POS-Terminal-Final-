import {
  localEnvSecretsAdapter,
  MissingSecretError,
} from "../../infrastructure/adapters/local-env-secrets.adapter.js";
import type { SecretsPort } from "../ports/secrets.port.js";

type IntegrationStatus = "connected" | "error" | "not_configured";

type RuntimeEnv = Partial<Record<string, string | undefined>>;

type IntegrationDescriptor = {
  liveEnabled: boolean;
  name: "email" | "razorpay";
  secretKeys: string[];
};

const parseBooleanFlag = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().toLowerCase() === "true";

const hasSecret = async (secrets: SecretsPort, key: string): Promise<boolean> => {
  try {
    const value = await secrets.getSecret(key);
    return value.trim().length > 0;
  } catch (error) {
    if (error instanceof MissingSecretError) {
      return false;
    }

    throw error;
  }
};

const buildIntegrationStatus = async (
  descriptor: IntegrationDescriptor,
  secrets: SecretsPort,
) => {
  const allSecretsPresent = (
    await Promise.all(descriptor.secretKeys.map((key) => hasSecret(secrets, key)))
  ).every(Boolean);

  const status: IntegrationStatus = descriptor.liveEnabled
    ? allSecretsPresent
      ? "connected"
      : "error"
    : "not_configured";

  return {
    liveEnabled: descriptor.liveEnabled,
    status,
  };
};

export const getIntegrationStatuses = async (
  secrets: SecretsPort = localEnvSecretsAdapter,
  runtimeEnv: RuntimeEnv = process.env,
) => {
  const descriptors: IntegrationDescriptor[] = [
    {
      liveEnabled: parseBooleanFlag(runtimeEnv.RAZORPAY_LIVE_ENABLED),
      name: "razorpay",
      secretKeys: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
    },
    {
      liveEnabled: parseBooleanFlag(runtimeEnv.EMAIL_LIVE_ENABLED),
      name: "email",
      secretKeys: ["EMAIL_API_KEY", "EMAIL_FROM_ADDRESS"],
    },
  ];

  const entries = await Promise.all(
    descriptors.map(async (descriptor) => [
      descriptor.name,
      await buildIntegrationStatus(descriptor, secrets),
    ]),
  );

  return Object.fromEntries(entries) as Record<
    IntegrationDescriptor["name"],
    { liveEnabled: boolean; status: IntegrationStatus }
  >;
};
