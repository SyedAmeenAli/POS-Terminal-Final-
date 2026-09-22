import type { FastifyRequest } from "fastify";

import { loadEnvSync } from "../../env-sync.js";
import { AppError } from "../errors.js";

const requestTimestampsByKey = new Map<string, number[]>();

export const enforceGlobalRateLimit = (request: FastifyRequest): void => {
  const env = loadEnvSync();
  const now = Date.now();
  const windowMs = env.GLOBAL_RATE_LIMIT_WINDOW_SECONDS * 1000;
  const key = request.terminal?.id ? `terminal:${request.terminal.id}` : `ip:${request.ip}`;
  const timestamps = requestTimestampsByKey.get(key) ?? [];

  while (timestamps.length > 0 && now - timestamps[0]! >= windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= env.GLOBAL_RATE_LIMIT_MAX_REQUESTS) {
    throw new AppError(429, "Too many requests", undefined, "RATE_LIMITED");
  }

  timestamps.push(now);
  requestTimestampsByKey.set(key, timestamps);
};

export const resetGlobalRateLimit = (): void => {
  requestTimestampsByKey.clear();
};
