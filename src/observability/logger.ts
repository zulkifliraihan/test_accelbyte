import pino, { type Logger } from 'pino';

export type { Logger };

function prettyTransportAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Structured JSON logger. In production every line is a single JSON object
 * (easy to ship to Loki/ELK/CloudWatch); in development it is pretty-printed.
 */
export function createLogger(options: { level: string; pretty: boolean }): Logger {
  const usePretty = options.pretty && prettyTransportAvailable();

  return pino({
    level: options.level,
    base: { service: 'match-stats-service' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      remove: true,
    },
    ...(usePretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  });
}
