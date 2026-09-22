// Dev: "/api" is rewritten to the backend root by the Vite proxy.
// Production: the built UI is served by the backend itself, so requests go to
// the same origin at root — build with VITE_API_BASE="".
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const TOKEN_KEY = "pos_terminal_token";

export type ApiErrorType =
  | "AUTH"
  | "BACKEND_UNREACHABLE"
  | "DATABASE_DOWN"
  | "INSUFFICIENT_STOCK"
  | "OWNER_LOGIN_REQUIRED"
  | "OWNER_PASSWORD_NOT_SET"
  | "VALIDATION"
  | "UNKNOWN";

export class ApiError extends Error {
  readonly errorType: ApiErrorType;
  readonly status: number;

  constructor(message: string, options: { errorType?: ApiErrorType; status: number }) {
    super(message);
    this.name = "ApiError";
    this.errorType = options.errorType ?? "UNKNOWN";
    this.status = options.status;
  }
}

export const getStoredTerminalToken = () => localStorage.getItem(TOKEN_KEY) ?? "";

export const setStoredTerminalToken = (token: string) => {
  localStorage.setItem(TOKEN_KEY, token.trim());
};

export const getTerminalAuthHeader = () => {
  const token = getStoredTerminalToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export async function extractErrorMessage(res: Response): Promise<{ errorType: ApiErrorType; message: string }> {
  try {
    const body = await res.json();
    const serverType = typeof body?.errorType === "string" ? body.errorType : "";
    const message = typeof body?.message === "string" ? body.message : JSON.stringify(body);

    if (serverType === "OWNER_LOGIN_REQUIRED") return { errorType: "OWNER_LOGIN_REQUIRED", message };
    if (serverType === "OWNER_PASSWORD_NOT_SET") return { errorType: "OWNER_PASSWORD_NOT_SET", message };
    if (res.status === 401) return { errorType: "AUTH", message };
    if (serverType === "INSUFFICIENT_STOCK" || message.includes("INSUFFICIENT_STOCK")) {
      return { errorType: "INSUFFICIENT_STOCK", message };
    }
    if (res.status >= 500) return { errorType: "DATABASE_DOWN", message };
    if (res.status === 422) return { errorType: "VALIDATION", message };
    return { errorType: "UNKNOWN", message };
  } catch {
    if (res.status === 401) return { errorType: "AUTH", message: "Terminal not authorised" };
    if (res.status >= 500) return { errorType: "DATABASE_DOWN", message: `${res.status} ${res.statusText}` };
    return { errorType: "UNKNOWN", message: `${res.status} ${res.statusText}` };
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const authHeader = getTerminalAuthHeader();
  if (authHeader.Authorization) headers.set("Authorization", authHeader.Authorization);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "Backend unreachable", {
      errorType: "BACKEND_UNREACHABLE",
      status: 0,
    });
  }

  if (!res.ok) {
    const details = await extractErrorMessage(res);
    throw new ApiError(details.message, { errorType: details.errorType, status: res.status });
  }

  return (await res.json()) as T;
};

export const apiGet = <T>(path: string, options?: RequestInit) => request<T>(path, options);

export const apiPost = <T>(path: string, body: unknown) =>
  request<T>(path, { body: JSON.stringify(body), method: "POST" });

export const apiPatch = <T>(path: string, body: unknown) =>
  request<T>(path, { body: JSON.stringify(body), method: "PATCH" });
