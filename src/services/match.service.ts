import { ConflictError, ServiceUnavailableError } from '../errors/app-error';
import type {
  IMatchRepository,
  MatchRecord,
  MatchResult,
  MatchWriteResult,
} from '../interfaces/match.repository.interface';
import type { Logger } from '../observability/logger';
import type { Metrics } from '../observability/metrics';
import { BatchQueue, QueueClosedError, QueueFullError } from '../utils/batch-queue';
import { hashMatchPayload } from '../utils/payload-hash';

export type SubmitMatchStatus = 'recorded' | 'duplicate';

export interface SubmitMatchResult {
  matchId: string;
  status: SubmitMatchStatus;
}

export interface MatchServiceOptions {
  maxBatchSize: number;
  maxPending: number;
}

export class MatchService {
  private readonly queue: BatchQueue<MatchRecord, MatchWriteResult>;

  constructor(
    private readonly matchRepository: IMatchRepository,
    options: MatchServiceOptions,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {
    this.queue = new BatchQueue<MatchRecord, MatchWriteResult>({
      maxBatchSize: options.maxBatchSize,
      maxPending: options.maxPending,
      process: (items) => this.matchRepository.recordMatches(items),
      onBatch: ({ size, durationMs, ok, error }) => {
        this.metrics.writeBatchSize.observe(size);
        this.metrics.writeBatchDuration.observe({ result: ok ? 'ok' : 'error' }, durationMs / 1000);
        if (!ok) this.logger.error({ err: error, batchSize: size }, 'write batch failed');
        else this.logger.debug({ batchSize: size, durationMs: Math.round(durationMs * 100) / 100 }, 'write batch committed');
      },
    });
    this.metrics.setQueueDepthProvider(() => this.queue.depth);
  }

  /**
   * Records a finished match exactly once.
   *
   * - New match_id                         -> stored + aggregated      -> `recorded`
   * - Known match_id, identical payload    -> no-op (idempotent retry) -> `duplicate`
   * - Known match_id, different payload    -> rejected                 -> ConflictError (409)
   *
   * The promise settles only after the transaction containing this match has
   * committed, so a success response always means the stats are durable and visible.
   */
  async submitMatch(match: MatchResult): Promise<SubmitMatchResult> {
    const record: MatchRecord = { ...match, payloadHash: hashMatchPayload(match) };

    let result: MatchWriteResult;
    try {
      result = await this.queue.push(record);
    } catch (error) {
      if (error instanceof QueueFullError) {
        this.metrics.writeQueueRejections.inc({ reason: 'queue_full' });
        this.metrics.matchSubmissions.inc({ outcome: 'rejected' });
        throw new ServiceUnavailableError('Too many match submissions in flight, please retry shortly', 1);
      }
      if (error instanceof QueueClosedError) {
        this.metrics.writeQueueRejections.inc({ reason: 'shutting_down' });
        this.metrics.matchSubmissions.inc({ outcome: 'rejected' });
        throw new ServiceUnavailableError('Service is shutting down, please retry', 5);
      }
      this.metrics.matchSubmissions.inc({ outcome: 'error' });
      throw error;
    }

    if (result.inserted) {
      this.metrics.matchSubmissions.inc({ outcome: 'recorded' });
      this.metrics.playersAggregated.inc(match.players.length);
      return { matchId: match.matchId, status: 'recorded' };
    }

    if (result.existingPayloadHash === record.payloadHash) {
      this.metrics.matchSubmissions.inc({ outcome: 'duplicate' });
      this.logger.info({ matchId: match.matchId }, 'duplicate match submission ignored (idempotent retry)');
      return { matchId: match.matchId, status: 'duplicate' };
    }

    this.metrics.matchSubmissions.inc({ outcome: 'conflict' });
    this.logger.warn({ matchId: match.matchId }, 'match_id re-submitted with a different payload');
    throw new ConflictError(
      'MATCH_ID_CONFLICT',
      `match_id '${match.matchId}' has already been recorded with a different result`,
    );
  }

  get isAcceptingWrites(): boolean {
    return !this.queue.isClosed;
  }

  /** Stops accepting submissions and waits until every queued match is committed. */
  async shutdown(): Promise<void> {
    await this.queue.close();
  }
}
