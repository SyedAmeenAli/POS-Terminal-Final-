import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { loadEnvSync } from "../../env-sync.js";

export const OWNER_SESSION_COOKIE = "pos_owner_session";
export const OWNER_SESSION_TTL_MS = 30 * 60 * 1000;

let fallbackSecret: string | undefined;

const getSessionSecret = (): string => {
  const configured = loadEnvSync().POS_OWNER_SESSION_SECRET;

  if (configured) {
    return configured;
  }

  fallbackSecret ??= randomBytes(32).toString("base64url");
  return fallbackSecret;
};

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

const sign = (payload: string): string =>
  createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");

export const createOwnerSessionToken = (now = Date.now()): string => {
  const expiresAt = now + OWNER_SESSION_TTL_MS;
  const nonce = randomBytes(32).toString("base64url");
  const payload = `${base64url(`${expiresAt}`)}.${nonce}`;

  return `${payload}.${sign(payload)}`;
};

export const getOwnerSessionExpiry = (token: string | undefined): Date | null => {
  if (!token) {
    return null;
  }

  const [encodedExpiry] = token.split(".");
  if (!encodedExpiry) {
    return null;
  }

  const expiresAt = Number(Buffer.from(encodedExpiry, "base64url").toString("utf8"));
  return Number.isFinite(expiresAt) ? new Date(expiresAt) : null;
};

export const verifyOwnerSessionToken = (token: string | undefined, now = Date.now()): boolean => {
  if (!token) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [encodedExpiry, nonce, signature] = parts;
  if (!encodedExpiry || !nonce || !signature) {
    return false;
  }

  const payload = `${encodedExpiry}.${nonce}`;
  const expectedSignature = sign(payload);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }

  const expiresAt = Number(Buffer.from(encodedExpiry, "base64url").toString("utf8"));
  return Number.isFinite(expiresAt) && expiresAt > now;
};

