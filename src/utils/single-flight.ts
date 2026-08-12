export interface SingleFlightOptions {
  maxWaiters?: number;
}

export class SingleFlight {
  private inFlight = new Map<string, { promise: Promise<any>; waiterCount: number }>();
  private maxWaiters: number;

  constructor(options?: SingleFlightOptions) {
    this.maxWaiters = options?.maxWaiters || 100;
  }

  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    
    if (existing) {
      if (existing.waiterCount >= this.maxWaiters) {
        throw new Error('SINGLEFLIGHT_TOO_MANY_WAITERS');
      }
      existing.waiterCount++;
      return existing.promise;
    }

    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, { promise, waiterCount: 1 });
    return promise;
  }
}

// Global instance for Auth DB lookups
export const authSingleFlight = new SingleFlight({ maxWaiters: 100 });
