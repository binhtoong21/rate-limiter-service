-- set_quota_pool.lua
-- KEYS: [pool_total, pool_available, pool_reserved]
-- ARGV: [new_total_amount]

local pool_total = KEYS[1]
local pool_available = KEYS[2]
local pool_reserved = KEYS[3]
local new_total = tonumber(ARGV[1])

-- Read current reserved (default 0)
local reserved = tonumber(redis.call('GET', pool_reserved) or '0')

-- Compute new available
local new_available = new_total - reserved

-- Update atomically
redis.call('SET', pool_total, tostring(new_total))
redis.call('SET', pool_available, tostring(new_available))

return tostring(new_available)
