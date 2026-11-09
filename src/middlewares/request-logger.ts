import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../observability/logger';

const REQUEST_ID_HEADER = 'x-request-id';
const QUIET_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Access log + request correlation.
 * Every request gets an id (propagated from `X-Request-Id` if the caller sent a sane one),
 * echoed back in the response header and attached to every log line as `req.id`.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id = typeof incoming === 'string' && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: (req) => QUIET_PATHS.has((req.url ?? '').split('?')[0] ?? '') },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
