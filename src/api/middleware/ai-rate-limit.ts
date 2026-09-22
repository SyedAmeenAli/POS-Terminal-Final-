import { AppError } from "../errors.js";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 10; // 10 requests per minute per IP

const ipRequestMap = new Map<string, number[]>();

export const enforceAIRateLimit = (ip: string): void => {
  const now = Date.now();

  if (!ipRequestMap.has(ip)) {
    ipRequestMap.set(ip, []);
  }

  const timestamps = ipRequestMap.get(ip)!;

  // Evict expired timestamps
  while (timestamps.length > 0 && now - timestamps[0]! >= WINDOW_MS) {
    timestamps.shift();
  }

  if (timestamps.length >= MAX_REQUESTS) {
    throw new AppError(
      429,
      "Too many requests. Please wait before asking another question.",
      undefined,
      "RATE_LIMITED"
    );
  }

  timestamps.push(now);
};

export const resetAIRateLimit = (): void => {
  ipRequestMap.clear();
};
