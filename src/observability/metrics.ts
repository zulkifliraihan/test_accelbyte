import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * All Prometheus metrics exposed by the service, scoped to their own registry
 * so that tests can create isolated instances without global state.
 */
export class Metrics {
  readonly registry: Registry;

  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  readonly matchSubmissions: Counter<'outcome'>;
  readonly playersAggregated: Counter;
  readonly writeBatchSize: Histogram;
  readonly writeBatchDuration: Histogram<'result'>;
  readonly writeQueueDepth: Gauge;
  readonly writeQueueRejections: Counter<'reason'>;

  private queueDepthProvider?: () => number;

  constructor(options: { collectDefault?: boolean } = {}) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: 'match-stats-service' });

    if (options.collectDefault ?? true) {
      // Event-loop lag, heap, GC, CPU, open handles, ...
      collectDefaultMetrics({ register: this.registry });
    }

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });

    this.matchSubmissions = new Counter({
      name: 'match_submissions_total',
      help: 'Match result submissions by outcome (recorded, duplicate, conflict, invalid, rejected, error)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.playersAggregated = new Counter({
      name: 'match_player_results_aggregated_total',
      help: 'Number of per-player results folded into career stats',
      registers: [this.registry],
    });

    this.writeBatchSize = new Histogram({
      name: 'write_batch_size',
      help: 'Number of match results committed per SQLite transaction (group commit)',
      buckets: [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000],
      registers: [this.registry],
    });

    this.writeBatchDuration = new Histogram({
      name: 'write_batch_duration_seconds',
      help: 'Time spent committing one write batch',
      labelNames: ['result'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });

    const depth = () => this.queueDepthProvider?.() ?? 0;
    this.writeQueueDepth = new Gauge({
      name: 'write_queue_depth',
      help: 'Match results waiting to be committed',
      registers: [this.registry],
      collect() {
        this.set(depth());
      },
    });

    this.writeQueueRejections = new Counter({
      name: 'write_queue_rejections_total',
      help: 'Submissions rejected before reaching the database (queue full / shutting down)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
  }

  /** The gauge is sampled lazily on every scrape. */
  setQueueDepthProvider(provider: () => number): void {
    this.queueDepthProvider = provider;
  }

  contentType(): string {
    return this.registry.contentType;
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
