import { loadEnvSync } from "../../env-sync.js";
import { AppError } from "../errors.js";

type FailureEntry = {
  count: number;
  expiresAt: number;
};

const failures = new Map<string, FailureEntry>();

const getWindowMs = (): number => loadEnvSync().OWNER_OVERRIDE_WINDOW_SECONDS * 1000;

const getMaxFailures = (): number => loadEnvSync().OWNER_OVERRIDE_MAX_FAILURES;

const getEntry = (key: string): FailureEntry | undefined => {
  const entry = failures.get(key);

  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    failures.delete(key);
    return undefined;
  }

  return entry;
};

export const assertOwnerOverrideAllowed = (key: string): void => {
  if ((getEntry(key)?.count ?? 0) >= getMaxFailures()) {
    throw new AppError(429, "Too many owner override attempts", undefined, "RATE_LIMITED");
  }
};

export const recordOwnerOverrideFailure = (key: string): void => {
  const existing = getEntry(key);
  failures.set(key, {
    count: (existing?.count ?? 0) + 1,
    expiresAt: existing?.expiresAt ?? Date.now() + getWindowMs(),
  });
};

export const clearOwnerOverrideFailures = (key: string): void => {
  failures.delete(key);
};

export const resetOwnerOverrideRateLimit = (): void => {
  failures.clear();
};

