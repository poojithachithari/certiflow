// Typed HTTP errors so route handlers can just `throw` and the error middleware
// turns them into consistent JSON responses.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Not signed in") => new HttpError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "You are not allowed to do this") => new HttpError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found") => new HttpError(404, "NOT_FOUND", msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, "CONFLICT", msg, details);
export const unprocessable = (msg: string, details?: unknown) => new HttpError(422, "VALIDATION_FAILED", msg, details);
