-- Token Bucket Rate Limiting
--
-- KEYS[1] = rl:tb:{org_id}  (Hash)
--
-- ARGV[1] = capacity (max tokens / bucket size)
-- ARGV[2] = refill_rate (tokens per second)
-- ARGV[3] = now_ms (current time in milliseconds)
--
-- Hash fields:
--   tokens   — current token count (float string)
--   last_ts  — last refill timestamp in ms
--
-- Returns: { allowed (0|1), remaining_tokens }

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

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

if tokens < 1 then
  -- Not enough tokens — reject
  redis.call('HSET', key, 'tokens', tostring(tokens), 'last_ts', tostring(now))
  redis.call('PEXPIRE', key, 120000)
  return { 0, math.floor(tokens) }
end

-- Consume one token — allow
tokens = tokens - 1
redis.call('HSET', key, 'tokens', tostring(tokens), 'last_ts', tostring(now))
redis.call('PEXPIRE', key, 120000)
return { 1, math.floor(tokens) }
