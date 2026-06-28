import { redis } from '../redis';
import { db } from '../db';
import { quotaEvents } from '../db/schema';
import { eq } from 'drizzle-orm';

export class IdempotencyService {
  /**
   * Check if an operation has already been executed.
   */
  async check(key: string, expectedFingerprint?: string): Promise<{ exists: boolean; cachedResult?: any }> {
    const cachedData = await redis.get(`idem:${key}`);
    
    if (cachedData) {
      let eventId = cachedData;
      
      if (cachedData.includes(':')) {
        const parts = cachedData.split(':');
        eventId = parts[0];
        const cachedFingerprint = parts[1];
        
        if (expectedFingerprint && cachedFingerprint !== expectedFingerprint) {
          throw new Error('DUPLICATE_IDEMPOTENCY_KEY');
        }
      }
      
      // Event exists in Redis, fetch from PG
      const [event] = await db
        .select()
        .from(quotaEvents)
        .where(eq(quotaEvents.id, eventId))
        .limit(1);
        
      if (event) {
        return { exists: true, cachedResult: event };
      }
    }
    
    return { exists: false };
  }

  /**
   * Mark an operation as completed by storing the event ID.
   */
  async mark(key: string, eventId: string, fingerprint?: string): Promise<void> {
    const value = fingerprint ? `${eventId}:${fingerprint}` : eventId;
    // Set idempotency key with 24 hours TTL
    await redis.set(`idem:${key}`, value, 'EX', 86400);
  }

  /**
   * Handle UNIQUE violation from PostgreSQL.
   * This happens when process crashes after PG COMMIT but before Redis mark().
   * The transaction should already be aborted/rolled back before calling this.
   */
  async handleUniqueViolation(idempotencyKey: string): Promise<typeof quotaEvents.$inferSelect> {
    const [event] = await db
      .select()
      .from(quotaEvents)
      .where(eq(quotaEvents.idempotencyKey, idempotencyKey))
      .limit(1);
      
    if (!event) {
      throw new Error('Idempotency key violation but record not found');
    }
    
    return event;
  }
}

export const idempotencyService = new IdempotencyService();
