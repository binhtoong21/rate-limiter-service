-- set_quota_pool.lua
-- KEYS: [pool_total, pool_available, pool_reserved, pool_loaned_out]
-- ARGV: [new_total_amount]

local pool_total = KEYS[1]
local pool_available = KEYS[2]
local pool_reserved = KEYS[3]
local pool_loaned_out = KEYS[4]
local new_total = tonumber(ARGV[1])

local reserved = tonumber(redis.call('GET', pool_reserved) or '0')
local loaned_out = tonumber(redis.call('GET', pool_loaned_out) or '0')

if not new_total or new_total < 0 then
  return redis.error_reply('INVALID_TOTAL')
end

if new_total < (reserved + loaned_out) then
  return redis.error_reply('RESERVED_EXCEEDS_TOTAL')
end

-- Compute new available
local new_available = new_total - reserved - loaned_out

-- Update atomically
redis.call('SET', pool_total, tostring(new_total))
redis.call('SET', pool_available, tostring(new_available))

return tostring(new_available)
