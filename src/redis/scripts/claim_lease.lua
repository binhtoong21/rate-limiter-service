-- claim_lease.lua
local pool_available   = KEYS[1]  -- quota:pool:{org_id}:available
local pool_reserved    = KEYS[2]  -- quota:pool:{org_id}:reserved
local lease_hash       = KEYS[3]  -- quota:lease:{lease_id}
local lease_active_set = KEYS[4]  -- quota:lease:active:{org_id}
local lease_active_sum = KEYS[5]  -- quota:lease:active_sum:{org_id}

local lease_id    = ARGV[1]
local org_id      = ARGV[2]
local service_id  = ARGV[3]
local amount      = tonumber(ARGV[4])
local expires_at  = ARGV[5]
local ttl         = tonumber(ARGV[6])

if not amount or amount <= 0 then
  return redis.error_reply('INVALID_AMOUNT')
end

if not ttl or ttl <= 0 then
  return redis.error_reply('INVALID_TTL')
end

-- Guard: check available balance
local available = tonumber(redis.call('GET', pool_available) or '0')
if available < amount then
  return redis.error_reply('INSUFFICIENT_QUOTA')
end

-- Atomic update pool state
redis.call('DECRBY', pool_available, amount)
redis.call('INCRBY', pool_reserved, amount)

-- Create lease entry
redis.call('HSET', lease_hash,
  'org_id',     org_id,
  'service_id', service_id,
  'amount',     tostring(amount),
  'expires_at', expires_at
)
redis.call('EXPIRE', lease_hash, ttl + 60)  -- +60s buffer

-- Track in active set
redis.call('SADD', lease_active_set, lease_id)
-- Track active sum for O(1) effective limit computation
redis.call('INCRBY', lease_active_sum, amount)

return redis.status_reply('OK')
