export class AppError extends Error {
  errorType?: string;
  statusCode: number;
  errors?: unknown;

  constructor(statusCode: number, message: string, errors?: unknown, errorType?: string) {
    super(message);
    this.name = "AppError";
    this.errorType = errorType;
    this.statusCode = statusCode;
    this.errors = errors;
  }
}

type PgErrorLike = {
  cause?: unknown;
  code?: string;
  detail?: string;
};

const findPgConflictError = (error: unknown): PgErrorLike | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  if ("code" in error && error.code === "23505") {
    return error as PgErrorLike;
  }

  if ("cause" in error) {
    return findPgConflictError(error.cause);
  }

  return null;
};

export const isPgConflictError = (error: unknown): error is PgErrorLike =>
  findPgConflictError(error) !== null;

export const getPgConflictMessage = (
  error: unknown,
  fallback: string,
): string => findPgConflictError(error)?.detail ?? fallback;
