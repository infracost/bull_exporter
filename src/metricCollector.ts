import { Queue, QueueEvents, QueueOptions } from 'bullmq';
import * as Logger from 'bunyan';
import IoRedis, { RedisOptions } from 'ioredis';
import { register as globalRegister, Registry } from 'prom-client';

import { logger as globalLogger } from './logger';
import { getJobCompleteStats, getStats, makeGuages, QueueGauges } from './queueGauges';

export interface MetricCollectorOptions extends Omit<QueueOptions, 'redis'> {
  metricPrefix: string;
  redis: string;
  autoDiscover: boolean;
  logger: Logger;
}

export interface QueueData<T = unknown> {
  queue: Queue<T>;
  name: string;
  prefix: string;
}

export class MetricCollector {

  private readonly logger: Logger;

  private conn: IoRedis | undefined;
  private readonly redisUri: string;
  private readonly bullOpts: Omit<QueueOptions, 'redis'>;
  private readonly queuesByName: Map<string, QueueData<unknown>> = new Map();

  private get queues(): QueueData<unknown>[] {
    return [...this.queuesByName.values()];
  }

  private readonly queueEvents: Set<QueueEvents> = new Set();

  private readonly guages: QueueGauges;

  constructor(
    queueNames: string[],
    opts: MetricCollectorOptions,
    registers: Registry[] = [globalRegister],
  ) {
    const { logger, autoDiscover, redis, metricPrefix, ...bullOpts } = opts;
    this.redisUri = redis;
    this.bullOpts = bullOpts;
    this.logger = logger || globalLogger;
    this.addToQueueSet(queueNames);
    this.guages = makeGuages(metricPrefix, registers);
  }

  private connection(): IoRedis {
    if (this.conn) {
      return this.conn;
    }

    const connOpts: RedisOptions = {
      maxRetriesPerRequest: null,
    };

    this.conn = new IoRedis(this.redisUri, connOpts);

    return this.conn;
  }

  private addToQueueSet(names: string[]): void {
    for (const name of names) {
      if (this.queuesByName.has(name)) {
        continue;
      }
      this.logger.info('added queue', name);
      this.queuesByName.set(name, {
        name,
        queue: new Queue(name, {
          ...this.bullOpts,
          connection: this.connection(),
        }),
        prefix: this.bullOpts.prefix || 'bull',
      });
    }
  }

  public async discoverAll(): Promise<void> {
    const keyPattern = new RegExp(`^${this.bullOpts.prefix}:([^:]+):(id|failed|active|waiting|stalled-check)$`);
    this.logger.info({ pattern: keyPattern.source }, 'running queue discovery');

    const keyStream = this.connection().scanStream({
      match: `${this.bullOpts.prefix}:*:*`,
    });
    // tslint:disable-next-line:await-promise tslint does not like Readable's here
    for await (const keyChunk of keyStream) {
      for (const key of keyChunk) {
        const match = keyPattern.exec(key);
        if (match && match[1]) {
          this.addToQueueSet([match[1]]);
        }
      }
    }
  }

  private async onJobComplete(queue: QueueData, { jobId }: { jobId: string }): Promise<void> {
    try {
      const job = await queue.queue.getJob(jobId);
      if (!job) {
        this.logger.warn({ job: jobId }, 'unable to find job from id');
        return;
      }
      await getJobCompleteStats(queue.prefix, queue.name, job, this.guages);
    } catch (err) {
      this.logger.error({ err, job: jobId }, 'unable to fetch completed job');
    }
  }

  public collectJobCompletions(): void {
    for (const q of this.queues) {
      const cb = this.onJobComplete.bind(this, q);
      const queueEvents = new QueueEvents(q.name, { connection: this.connection() });
      this.queueEvents.add(queueEvents);
      queueEvents.on('completed', cb);
    }
  }

  public async updateAll(): Promise<void> {
    const updatePromises = this.queues.map(q => getStats(q.prefix, q.name, q.queue, this.guages));
    await Promise.all(updatePromises);
  }

  public async ping(): Promise<void> {
    await this.connection().ping();
  }

  public async close(): Promise<void> {
    this.connection().disconnect();
    await Promise.all([...this.queueEvents].map(qe => qe.close()));
    await Promise.all(this.queues.map(q => q.queue.close()));
  }

}
