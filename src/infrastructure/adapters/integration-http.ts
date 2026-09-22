type JsonRecord = Record<string, unknown>;

export class IntegrationHttpError extends Error {
  statusCode: number;
  payload: JsonRecord | null;

  constructor(statusCode: number, message: string, payload: JsonRecord | null) {
    super(message);
    this.name = "IntegrationHttpError";
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseResponseBody = async (response: Response): Promise<JsonRecord | null> => {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: text };
  }
};

export const fetchJson = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<JsonRecord | null> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await parseResponseBody(response);

  if (!response.ok) {
    throw new IntegrationHttpError(response.status, `HTTP ${response.status}`, body);
  }

  return body;
};
