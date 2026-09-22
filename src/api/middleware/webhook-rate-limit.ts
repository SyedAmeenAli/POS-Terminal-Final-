import { AppError } from "../errors.js";

const GLOBAL_WEBHOOK_LIMIT = 500;
const WINDOW_MS = 60_000;

const globalRequestTimestamps: number[] = [];

export const enforceGlobalWebhookRateLimit = (): void => {
  const now = Date.now();

  while (
    globalRequestTimestamps.length > 0 &&
    now - globalRequestTimestamps[0]! >= WINDOW_MS
  ) {
    globalRequestTimestamps.shift();
  }

  if (globalRequestTimestamps.length >= GLOBAL_WEBHOOK_LIMIT) {
    throw new AppError(
      429,
      "Webhook rate limit exceeded",
      undefined,
      "RATE_LIMITED",
    );
  }

  globalRequestTimestamps.push(now);
};
