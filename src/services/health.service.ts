import type { IHealthRepository } from '../interfaces/health.repository.interface';

export type CheckStatus = 'ok' | 'fail';

export interface ReadinessReport {
  ready: boolean;
  checks: { database: CheckStatus; writeQueue: CheckStatus; shuttingDown: boolean };
}

const DB_PING_TIMEOUT_MS = 1_000;

export class HealthService {
  private shuttingDown = false;

  constructor(
    private readonly healthRepository: IHealthRepository,
    private readonly isAcceptingWrites: () => boolean,
  ) {}

  /** Called on SIGTERM so the orchestrator stops routing traffic before we exit. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  async readiness(): Promise<ReadinessReport> {
    const database = await this.pingDatabase();
    const writeQueue: CheckStatus = this.isAcceptingWrites() ? 'ok' : 'fail';
    return {
      ready: !this.shuttingDown && database === 'ok' && writeQueue === 'ok',
      checks: { database, writeQueue, shuttingDown: this.shuttingDown },
    };
  }

  private async pingDatabase(): Promise<CheckStatus> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.healthRepository.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('database ping timed out')), DB_PING_TIMEOUT_MS);
        }),
      ]);
      return 'ok';
    } catch {
      return 'fail';
    } finally {
      clearTimeout(timer);
    }
  }
}
