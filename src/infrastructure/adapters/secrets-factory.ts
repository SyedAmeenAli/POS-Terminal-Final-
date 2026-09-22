import { GcpSecretsAdapter } from "./gcp-secrets.adapter.js";
import {
  getLocalEnvSecret,
  localEnvSecretsAdapter,
} from "./local-env-secrets.adapter.js";
import type { SecretsPort } from "../../application/ports/secrets.port.js";

// Reads the flag straight from process.env to dodge the bootstrap chicken/egg
// (env parsing itself depends on the secrets port).
export const createSecretsPort = (): SecretsPort => {
  const enabled = getLocalEnvSecret("GCP_SECRET_MANAGER_ENABLED") === "true";
  if (!enabled) {
    return localEnvSecretsAdapter;
  }

  const projectId = getLocalEnvSecret("GCP_PROJECT_ID");
  return new GcpSecretsAdapter(projectId, localEnvSecretsAdapter);
};
