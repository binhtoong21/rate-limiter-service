-- Token Bucket Rate Limiting
--
-- KEYS[1] = rl:tb:{org_id}  (Hash)
-- KEYS[2] = quota:lease:active_sum:{org_id}
--
-- ARGV[1] = base_limit (default limit)
-- ARGV[2] = window_size_ms
-- ARGV[3] = now_ms (current time in milliseconds)
--
-- Hash fields:
--   tokens   — current token count (float string)
--   last_ts  — last refill timestamp in ms
--
-- Returns: { allowed (0|1), remaining_tokens, effective_limit }

local key = KEYS[1]
local active_sum_key = KEYS[2]
local base_limit = tonumber(ARGV[1])
local window_size_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

if base_limit == nil or base_limit <= 0 or window_size_ms == nil or window_size_ms <= 0 or now == nil then
  return { "INVALID_TOKEN_BUCKET_ARGUMENTS" }
end

local active_sum = tonumber(redis.call('GET', active_sum_key) or '0')
local capacity = base_limit + active_sum
local refill_rate = capacity / (window_size_ms / 1000)

local data = redis.call('HMGET', key, 'tokens', 'last_ts')
local tokens = tonumber(data[1])
local last_ts = tonumber(data[2])

if tokens == nil then
  -- First request: initialize bucket to full capacity
  tokens = capacity
  last_ts = now
end

-- Refill tokens based on elapsed time since last request
local elapsed_s = (now - last_ts) / 1000.0
local refill = elapsed_s * refill_rate
tokens = math.min(capacity, tokens + refill)

local ttl_ms = math.ceil((capacity / refill_rate) * 1000)

if tokens < 1 then
  -- Not enough tokens — reject
  redis.call('HSET', key, 'tokens', tostring(tokens), 'last_ts', tostring(now))
  redis.call('PEXPIRE', key, ttl_ms)
  return { 0, math.floor(tokens), capacity }
end

-- Consume one token — allow
tokens = tokens - 1
redis.call('HSET', key, 'tokens', tostring(tokens), 'last_ts', tostring(now))
redis.call('PEXPIRE', key, ttl_ms)
return { 1, math.floor(tokens), capacity }
