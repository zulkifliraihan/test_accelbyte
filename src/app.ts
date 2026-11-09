import express, { type Express } from 'express';
import type { Controllers } from './container';
import { errorHandler, notFoundHandler } from './middlewares/error-handler';
import { httpMetrics } from './middlewares/http-metrics';
import { requestLogger } from './middlewares/request-logger';
import { requireJson } from './middlewares/require-json';
import type { Logger } from './observability/logger';
import type { Metrics } from './observability/metrics';
import { apiRoutes } from './routes';

/** A 64-player match is ~6 KB of JSON; 256 KB leaves ample headroom while bounding memory per request. */
const JSON_BODY_LIMIT = '256kb';

export function createApp(deps: { controllers: Controllers; metrics: Metrics; logger: Logger }): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(requestLogger(deps.logger));
  app.use(httpMetrics(deps.metrics));
  app.use(requireJson);
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

  app.use(apiRoutes(deps.controllers));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
