export interface SingleFlightOptions {
  maxWaiters?: number;
  timeoutMs?: number;
}

export class SingleFlight {
  private inFlight = new Map<string, { promise: Promise<any>; waiterCount: number }>();
  private maxWaiters: number;
  private timeoutMs: number;

  constructor(options?: SingleFlightOptions) {
    this.maxWaiters = options?.maxWaiters || 100;
    this.timeoutMs = options?.timeoutMs || 5000;
  }

  async do<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const existing = this.inFlight.get(key);
    
    if (existing) {
      if (existing.waiterCount >= this.maxWaiters) {
        throw new Error('SINGLEFLIGHT_TOO_MANY_WAITERS');
      }
      existing.waiterCount++;
      
      // Wait for existing promise with timeout and signal
      return this.withTimeoutAndSignal(existing.promise, this.timeoutMs, signal).finally(() => {
        const current = this.inFlight.get(key);
        if (current) {
          current.waiterCount--;
        }
      });
    }

    const primaryPromise = fn().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, { promise: primaryPromise, waiterCount: 1 });
    return this.withTimeoutAndSignal(primaryPromise, this.timeoutMs, signal);
  }

  private withTimeoutAndSignal<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      
      const abortHandler = () => {
        if (timer) clearTimeout(timer);
        reject(new Error('SINGLEFLIGHT_ABORTED'));
      };

      if (signal) {
        if (signal.aborted) return abortHandler();
        signal.addEventListener('abort', abortHandler);
      }

      if (ms > 0) {
        timer = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', abortHandler);
          reject(new Error('SINGLEFLIGHT_TIMEOUT'));
        }, ms);
      }
      
      promise.then((val) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortHandler);
        resolve(val);
      }).catch((err) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortHandler);
        reject(err);
      });
    });
  }
}

// Global instance for Auth DB lookups (timeout 3000ms for fast fail)
export const authSingleFlight = new SingleFlight({ maxWaiters: 100, timeoutMs: 3000 });

