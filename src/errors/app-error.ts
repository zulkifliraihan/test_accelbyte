/**
 * Expected, client-facing errors. Anything that is NOT an AppError is treated
 * as an unexpected failure by the error middleware and mapped to HTTP 500
 * without leaking internals.
 */
export interface ErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetail[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Content-Type must be application/json') {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, retryAfterSeconds = 1) {
    super(503, 'SERVICE_UNAVAILABLE', message, undefined, { 'Retry-After': String(retryAfterSeconds) });
  }
}
