import { Worker, Queue } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { db } from '../db';
import { organizations } from '../db/schema';
import { reconcileOrg } from '../services/reconciliation.service';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export const startReconciliationWorker = async () => {
  const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });

  const queue = new Queue('reconciliation', { connection: connection as any });

  const worker = new Worker('reconciliation', async (job) => {
    const orgs = await db.select().from(organizations);
    let processed = 0;

    for (const org of orgs) {
      try {
        const result = await reconcileOrg(org);
        if (result.drifted) processed++;
      } catch (err) {
        logger.error({ err, orgId: org.id }, 'Failed to process org in reconciliation');
      }
    }

    if (processed > 0) {
      logger.info(`Corrected ${processed} orgs in reconciliation batch`);
    }

    return { processed };
  }, { connection: connection as any });

  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Reconciliation job failed');
  });

  await queue.add('run-reconciliation', {}, {
    repeat: {
      every: 60000,
    }
  });
};
