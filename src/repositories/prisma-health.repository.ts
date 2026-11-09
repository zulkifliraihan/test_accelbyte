import type { PrismaClient } from '../generated/prisma/client';
import type { IHealthRepository } from '../interfaces/health.repository.interface';

export class PrismaHealthRepository implements IHealthRepository {
  constructor(private readonly reader: PrismaClient) {}

  async ping(): Promise<void> {
    await this.reader.$queryRaw`SELECT 1`;
  }
}
