import type { NextFunction, Request, Response } from 'express';
import type { Metrics } from '../observability/metrics';

/**
 * Records latency per (method, route template, status). The route template
 * (e.g. "/leaderboard") is used instead of the raw URL to keep label cardinality bounded.
 */
export function httpMetrics(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const end = metrics.httpRequestDuration.startTimer();
    res.on('finish', () => {
      const routePath = (req.route as { path?: string } | undefined)?.path;
      let route = 'unmatched';
      if (routePath !== undefined) route = routePath === '/' && req.baseUrl ? req.baseUrl : `${req.baseUrl}${routePath}`;
      end({ method: req.method, route, status_code: String(res.statusCode) });
    });
    next();
  };
}
