/**
 * Rate limit applied to the demo hot path `POST /api/ping`.
 * The effective limit per org is PING_BASE_LIMIT + the org's active lease sum
 * (Redis key `quota:lease:active_sum:{orgId}`), computed in sliding_window_check.lua.
 */
export const PING_BASE_LIMIT = 5;
export const PING_WINDOW_MS = 10_000;
