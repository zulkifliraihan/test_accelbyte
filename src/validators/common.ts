import type { z } from 'zod';
import { ValidationError } from '../errors/app-error';

/**
 * Identifiers are opaque to this service (the spec shows UUIDs, the test cases use
 * "player-A"), so any printable, whitespace-free ASCII string up to 128 chars is accepted.
 */
export const ID_PATTERN = /^[\x21-\x7E]+$/;
export const ID_MAX_LENGTH = 128;

/** Parses `input` with `schema`, converting Zod issues into a 400 ValidationError. */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown, message: string): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
    message: issue.message,
  }));
  throw new ValidationError(message, details);
}
