/**
 * Demo-only chaos drill: the rate limiter acts as if Redis were unreachable,
 * so the fail-open / fail-closed fallback can be demonstrated. In-process state only.
 */
import { demoEnabled } from '../config/demo';

let outageUntil = 0;

export const chaosAllowed = demoEnabled;

export function startRedisOutage(seconds: number): number {
  if (!chaosAllowed()) throw new Error('Chaos drills are disabled');
  outageUntil = Date.now() + seconds * 1000;
  return outageUntil;
}

export function stopRedisOutage(): void {
  outageUntil = 0;
}

export function redisOutageActive(): boolean {
  return chaosAllowed() && outageUntil > Date.now();
}

export function redisOutageEndsAt(): number | null {
  return redisOutageActive() ? outageUntil : null;
}
