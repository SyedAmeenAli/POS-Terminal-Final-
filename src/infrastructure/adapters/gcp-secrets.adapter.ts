import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

import {
  localEnvSecretsAdapter,
  MissingSecretError,
} from "./local-env-secrets.adapter.js";
import type { SecretsPort } from "../../application/ports/secrets.port.js";

const GRPC_NOT_FOUND = 5;

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === GRPC_NOT_FOUND;

export class GcpSecretsAdapter implements SecretsPort {
  private readonly client: SecretManagerServiceClient;
  private readonly fallback: SecretsPort;
  private readonly projectId: string;

  constructor(
    projectId: string,
    fallback: SecretsPort = localEnvSecretsAdapter,
    client: SecretManagerServiceClient = new SecretManagerServiceClient(),
  ) {
    this.projectId = projectId;
    this.fallback = fallback;
    this.client = client;
  }

  async getSecret(key: string): Promise<string> {
    const secretId =
      key === "DATABASE_URL" && process.env.DATABASE_URL_SECRET_NAME
        ? process.env.DATABASE_URL_SECRET_NAME
        : key;
    const name = `projects/${this.projectId}/secrets/${secretId}/versions/latest`;

    try {
      const [version] = await this.client.accessSecretVersion({ name });
      const value = version.payload?.data?.toString();

      if (typeof value !== "string" || value.length === 0) {
        throw new MissingSecretError(key);
      }

      return value;
    } catch (error) {
      // Secret not defined in Secret Manager — fall back to local env.
      if (isNotFoundError(error)) {
        return this.fallback.getSecret(key);
      }

      throw error;
    }
  }
}
