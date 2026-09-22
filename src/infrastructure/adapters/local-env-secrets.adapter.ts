import { config as loadEnvFile } from "dotenv";

import type { SecretsPort } from "../../application/ports/secrets.port.js";

export class MissingSecretError extends Error {
  constructor(key: string) {
    super(`Missing environment variable: ${key}`);
    this.name = "MissingSecretError";
  }
}

let dotenvLoaded = false;

const ensureDotenvLoaded = (): void => {
  if (dotenvLoaded) {
    return;
  }

  loadEnvFile();
  dotenvLoaded = true;
};

export class LocalEnvSecretsAdapter implements SecretsPort {
  async getSecret(key: string): Promise<string> {
    return getLocalEnvSecret(key);
  }
}

export const getLocalEnvSecret = (key: string): string => {
    ensureDotenvLoaded();

    const value = process.env[key];

    if (typeof value !== "string") {
      throw new MissingSecretError(key);
    }

    return value;
};

export const localEnvSecretsAdapter = new LocalEnvSecretsAdapter();
