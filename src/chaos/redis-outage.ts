/**
 * Development-only chaos drill: the rate limiter acts as if Redis were unreachable,
 * so the fail-open / fail-closed fallback can be demonstrated. In-process state only.
 */
const CHAOS_ALLOWED = process.env.NODE_ENV !== 'production';
let outageUntil = 0;

export const chaosAllowed = () => CHAOS_ALLOWED;

export function startRedisOutage(seconds: number): number {
  if (!CHAOS_ALLOWED) throw new Error('Chaos drills are disabled in production');
  outageUntil = Date.now() + seconds * 1000;
  return outageUntil;
}

export function stopRedisOutage(): void {
  outageUntil = 0;
}

export function redisOutageActive(): boolean {
  return CHAOS_ALLOWED && outageUntil > Date.now();
}

export function redisOutageEndsAt(): number | null {
  return redisOutageActive() ? outageUntil : null;
}
