-- Sliding Window Rate Limiting Script
--
-- KEYS[1] = current window key (e.g., rl:sw:{org_id}:current_timestamp)
-- KEYS[2] = previous window key (e.g., rl:sw:{org_id}:previous_timestamp)
--
-- ARGV[1] = limit (number)
-- ARGV[2] = window size in milliseconds
-- ARGV[3] = current time in milliseconds
-- ARGV[4] = percentage of previous window elapsed (0 to 1)

local current_key = KEYS[1]
local previous_key = KEYS[2]
local active_sum_key = KEYS[3]

local base_limit = tonumber(ARGV[1])
local window_size = tonumber(ARGV[2])
local current_time = tonumber(ARGV[3])
local previous_weight = tonumber(ARGV[4]) -- How much of the current window has elapsed, meaning how much weight the previous window has. Wait, normally previous_weight = 1 - (elapsed / window_size)

local active_sum = tonumber(redis.call('GET', active_sum_key) or '0')
local limit = base_limit + active_sum

local previous_count = tonumber(redis.call("GET", previous_key) or "0")
local current_count = tonumber(redis.call("GET", current_key) or "0")

-- Calculate estimated count
local estimated_count = math.floor((previous_count * previous_weight) + current_count)

if estimated_count >= limit then
  -- Rate limit exceeded
  return { 0, estimated_count, limit }
else
  -- Allow request
  redis.call("INCR", current_key)
  if current_count == 0 then
    -- Set TTL on the first increment. TTL is 2x window_size to cover previous_key overlap
    redis.call("PEXPIRE", current_key, window_size * 2)
  end
  return { 1, estimated_count + 1, limit }
end
