import type { NextFunction, Request, Response } from 'express';
import { AppError, NotFoundError } from '../errors/app-error';

interface ErrorBody {
  error: { code: string; message: string; details?: { field: string; message: string }[]; request_id?: string };
}

/** Errors raised by body-parser (malformed JSON, payload too large, bad charset, ...). */
interface HttpParserError extends Error {
  type: string;
  status: number;
  expose?: boolean;
}

const PARSER_ERROR_CODES: Record<string, string> = {
  'entity.parse.failed': 'INVALID_JSON',
  'entity.too.large': 'PAYLOAD_TOO_LARGE',
  'encoding.unsupported': 'UNSUPPORTED_ENCODING',
  'charset.unsupported': 'UNSUPPORTED_CHARSET',
  'request.aborted': 'REQUEST_ABORTED',
};

function isParserError(err: unknown): err is HttpParserError {
  return (
    err instanceof Error &&
    typeof (err as Partial<HttpParserError>).type === 'string' &&
    typeof (err as Partial<HttpParserError>).status === 'number'
  );
}

function requestId(req: Request): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined;
}

/** 404 for any route that is not registered. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}

/**
 * Last line of defence: every error ends up here and is turned into a JSON response.
 * Express 5 forwards rejected promises from async handlers automatically, so a
 * throwing handler can never crash the process.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    req.log?.error({ err }, 'error after response headers were sent');
    res.end();
    return;
  }

  let status = 500;
  let body: ErrorBody;

  if (err instanceof AppError) {
    status = err.statusCode;
    body = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
    if (err.headers) res.set(err.headers);
  } else if (isParserError(err) && err.status >= 400 && err.status < 500) {
    status = err.status;
    const code = PARSER_ERROR_CODES[err.type] ?? 'BAD_REQUEST';
    const message = code === 'INVALID_JSON' ? 'Request body is not valid JSON' : err.message;
    body = { error: { code, message } };
  } else {
    // Unexpected: log with stack, return an opaque message.
    req.log?.error({ err }, 'unhandled error while processing request');
    body = { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } };
  }

  const id = requestId(req);
  if (id) body.error.request_id = id;
  res.status(status).json(body);
}
