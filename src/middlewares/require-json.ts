import type { NextFunction, Request, Response } from 'express';
import { UnsupportedMediaTypeError } from '../errors/app-error';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/** Rejects bodies that are not JSON with 415 instead of silently treating them as empty. */
export function requireJson(req: Request, _res: Response, next: NextFunction): void {
  if (METHODS_WITH_BODY.has(req.method) && !req.is('application/json')) {
    next(new UnsupportedMediaTypeError());
    return;
  }
  next();
}
