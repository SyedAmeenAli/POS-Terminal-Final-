type LogLevel = "debug" | "error" | "info" | "warn";

type LogFields = Record<string, unknown>;

export const REDACTED = "[REDACTED]";

const MAX_REDACTION_DEPTH = 6;

/**
 * Keys whose values are never safe to log. Matched as substrings against a
 * normalised (lowercased, non-alphanumeric stripped) key, so `API_KEY`,
 * `apiKey` and `api-key` all match `apikey`.
 */
const SENSITIVE_KEY_PATTERNS = [
  "token",
  "password",
  "passwd",
  "secret",
  "authorization",
  "credential",
  "apikey",
  "privatekey",
  "databaseurl",
  "connectionstring",
  "cookie",
  "sessionid",
  "pinhash",
];

/**
 * Short keys that must match exactly. Substring matching is unsafe for these —
 * "shipping" contains "pin", and "panel"/"company" contain "pan".
 */
const SENSITIVE_KEY_EXACT = new Set(["pin", "cvv", "otp", "pan", "cardnumber"]);

/** Credentials embedded in connection strings, e.g. postgresql://user:pw@host. */
const CONNECTION_STRING_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@\s]+)@/gi;

/** Bearer tokens appearing inside free-text strings such as error messages. */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

const isSensitiveKey = (key: string): boolean => {
  const normalised = normaliseKey(key);

  if (SENSITIVE_KEY_EXACT.has(normalised)) {
    return true;
  }

  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalised.includes(pattern));
};

const scrubString = (value: string): string =>
  value
    .replace(CONNECTION_STRING_CREDENTIALS, `$1$2:${REDACTED}@`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`);

const redactValue = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") {
    return scrubString(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_REDACTION_DEPTH) {
    return "[TRUNCATED]";
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1, seen));
  }

  if (value instanceof Error) {
    return {
      errorMessage: scrubString(value.message),
      errorName: value.name,
    };
  }

  return redactFields(value as LogFields, depth + 1, seen);
};

const redactFields = (
  fields: LogFields,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): LogFields =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactValue(value, depth, seen),
    ]),
  );

/** Exported for tests. */
export const redactLogFields = (fields: LogFields): LogFields => redactFields(fields);

const serializeError = (error: unknown): LogFields => {
  if (error instanceof Error) {
    return {
      errorMessage: error.message,
      errorName: error.name,
    };
  }

  return { errorMessage: String(error) };
};

export const logJson = (
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redactFields(fields),
  };
  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.info(line);
};

export const logError = (
  event: string,
  error: unknown,
  fields: LogFields = {},
): void => {
  logJson("error", event, { ...fields, ...serializeError(error) });
};
