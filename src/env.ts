import { z } from "zod";

import type { SecretsPort } from "./application/ports/secrets.port.js";
import {
  getLocalEnvSecret,
  localEnvSecretsAdapter,
  MissingSecretError,
} from "./infrastructure/adapters/local-env-secrets.adapter.js";
import { createSecretsPort } from "./infrastructure/adapters/secrets-factory.js";

const booleanFlagSchema = z
  .string()
  .trim()
  .transform((value) => value.toLowerCase())
  .refine((value): value is "true" | "false" => value === "true" || value === "false", {
    message: "Expected 'true' or 'false'",
  })
  .transform((value) => value === "true");

const envSchema = z
  .object({
    DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required"),
    // T1b bootstrap role — see ims-1/src/env.ts for the full explanation.
    BOOTSTRAP_DATABASE_URL: z.string().trim().optional(),
    // T1b runtime role (app_runtime) — non-owner, no BYPASSRLS, so RLS
    // policies apply. Used only by the per-request transaction pool.
    RUNTIME_DATABASE_URL: z.string().trim().optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    SHOP_TIMEZONE: z.string().trim().min(1).default("Asia/Kolkata"),
    GCP_PROJECT_ID: z.string().trim().optional(),
    GCP_SECRET_MANAGER_ENABLED: booleanFlagSchema,
    CORS_ALLOWED_ORIGINS: z.string().trim().optional().default(""),
    // Bounds how long a revoked terminal token keeps working on an instance
    // that already cached it. Cheap to keep low now that terminal lookup is an
    // indexed prefix query rather than a bcrypt compare per row; 60s meant a
    // stolen token stayed live for a full minute after being disabled.
    TERMINAL_AUTH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(10),
    GLOBAL_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
    GLOBAL_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    CASHIER_PIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    CASHIER_PIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
    OWNER_OVERRIDE_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    OWNER_OVERRIDE_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
    OVERRIDE_DISCOUNT_PERCENT_THRESHOLD: z.coerce.number().positive().max(100).default(25),
    POS_OWNER_SESSION_SECRET: z.string().trim().min(32).optional(),
    RAZORPAY_LIVE_ENABLED: booleanFlagSchema,
    RAZORPAY_KEY_ID: z.string().trim().optional(),
    RAZORPAY_KEY_SECRET: z.string().trim().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().trim().optional(),
    RAZORPAY_API_BASE_URL: z.string().trim().url().optional(),
    RAZORPAY_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    EMAIL_LIVE_ENABLED: booleanFlagSchema.default(false),
    EMAIL_API_KEY: z.string().trim().optional(),
    EMAIL_FROM_ADDRESS: z.string().trim().email().optional(),
    EMAIL_PROVIDER_BASE_URL: z.string().trim().url().optional(),
    EMAIL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.CORS_ALLOWED_ORIGINS.split(",").some((origin) => origin.trim() === "*")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CORS_ALLOWED_ORIGINS must not contain '*'",
        path: ["CORS_ALLOWED_ORIGINS"],
      });
    }

    type IntegrationSecretKey =
      | "GCP_PROJECT_ID"
      | "RAZORPAY_KEY_ID"
      | "RAZORPAY_KEY_SECRET"
      | "RAZORPAY_WEBHOOK_SECRET"
      | "EMAIL_API_KEY"
      | "EMAIL_FROM_ADDRESS";

    const requiredWhenLive: Array<{
      enabled: boolean;
      fields: IntegrationSecretKey[];
      label: string;
    }> = [
      {
        enabled: value.GCP_SECRET_MANAGER_ENABLED,
        fields: ["GCP_PROJECT_ID"],
        label: "GCP Secret Manager",
      },
      {
        enabled: value.RAZORPAY_LIVE_ENABLED,
        fields: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
        label: "Razorpay",
      },
      {
        enabled: value.EMAIL_LIVE_ENABLED,
        fields: ["EMAIL_API_KEY", "EMAIL_FROM_ADDRESS"],
        label: "Receipt Email",
      },
    ];

    for (const integration of requiredWhenLive) {
      if (!integration.enabled) {
        continue;
      }

      for (const field of integration.fields) {
        if (value[field]?.trim()) {
          continue;
        }

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is required when ${integration.label} live mode is enabled`,
          path: [field],
        });
      }
    }
  });

const requiredKeys = [
  "DATABASE_URL",
  "NODE_ENV",
  "GCP_SECRET_MANAGER_ENABLED",
  "RAZORPAY_LIVE_ENABLED",
] as const;

const optionalKeys = [
  "BOOTSTRAP_DATABASE_URL",
  "RUNTIME_DATABASE_URL",
  "HOST",
  "SHOP_TIMEZONE",
  "GCP_PROJECT_ID",
  "CORS_ALLOWED_ORIGINS",
  "TERMINAL_AUTH_CACHE_TTL_SECONDS",
  "GLOBAL_RATE_LIMIT_MAX_REQUESTS",
  "GLOBAL_RATE_LIMIT_WINDOW_SECONDS",
  "CASHIER_PIN_MAX_FAILURES",
  "CASHIER_PIN_WINDOW_SECONDS",
  "OWNER_OVERRIDE_MAX_FAILURES",
  "OWNER_OVERRIDE_WINDOW_SECONDS",
  "OVERRIDE_DISCOUNT_PERCENT_THRESHOLD",
  "POS_OWNER_SESSION_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_API_BASE_URL",
  "RAZORPAY_TIMEOUT_MS",
  "EMAIL_LIVE_ENABLED",
  "EMAIL_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_PROVIDER_BASE_URL",
  "EMAIL_TIMEOUT_MS",
] as const;

type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

const readOptionalSecret = async (
  secrets: SecretsPort,
  key: (typeof optionalKeys)[number],
): Promise<string | undefined> => {
  try {
    return await secrets.getSecret(key);
  } catch (error) {
    if (error instanceof MissingSecretError) {
      return undefined;
    }

    throw error;
  }
};

const readRawEnv = async (
  secrets: SecretsPort,
): Promise<Record<(typeof requiredKeys)[number] | (typeof optionalKeys)[number], string | undefined>> => {
  const requiredEntries = await Promise.all(
    requiredKeys.map(async (key) => [key, await secrets.getSecret(key)] as const),
  );
  const optionalEntries = await Promise.all(
    optionalKeys.map(async (key) => [key, await readOptionalSecret(secrets, key)] as const),
  );

  return Object.fromEntries([...requiredEntries, ...optionalEntries]) as Record<
    (typeof requiredKeys)[number] | (typeof optionalKeys)[number],
    string | undefined
  >;
};

const parseEnv = (
  rawEnv: Record<(typeof requiredKeys)[number] | (typeof optionalKeys)[number], string | undefined>,
): Env => {
  const parsedEnv = envSchema.safeParse(rawEnv);

  if (!parsedEnv.success) {
    const issues = parsedEnv.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsedEnv.data;
};

export const loadEnv = async (secrets: SecretsPort = localEnvSecretsAdapter): Promise<Env> => {
  if (cachedEnv) {
    return cachedEnv;
  }

  let rawEnv: Record<
    (typeof requiredKeys)[number] | (typeof optionalKeys)[number],
    string | undefined
  >;

  try {
    rawEnv = await readRawEnv(secrets);
  } catch (error) {
    if (error instanceof MissingSecretError) {
      const issues = `${error.message.replace("Missing environment variable: ", "")}: Missing required value`;
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }

    throw error;
  }

  cachedEnv = parseEnv(rawEnv);
  return cachedEnv;
};

export const loadEnvSync = (): Env => {
  if (cachedEnv) {
    return cachedEnv;
  }

  try {
    const rawEnv = Object.fromEntries([
      ...requiredKeys.map((key) => [key, getLocalEnvSecret(key)] as const),
      ...optionalKeys.map((key) => {
        try {
          return [key, getLocalEnvSecret(key)] as const;
        } catch (error) {
          if (error instanceof MissingSecretError) {
            return [key, undefined] as const;
          }

          throw error;
        }
      }),
    ]) as Record<(typeof requiredKeys)[number] | (typeof optionalKeys)[number], string | undefined>;

    cachedEnv = parseEnv(rawEnv);
    return cachedEnv;
  } catch (error) {
    if (error instanceof MissingSecretError) {
      const issues = `${error.message.replace("Missing environment variable: ", "")}: Missing required value`;
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }

    throw error;
  }
};

export const env = await loadEnv(createSecretsPort());
export type { Env };
