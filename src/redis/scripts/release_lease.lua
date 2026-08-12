-- release_lease.lua
local pool_available   = KEYS[1]
local pool_reserved    = KEYS[2]
local lease_hash       = KEYS[3]
local lease_active_set = KEYS[4]
local lease_active_sum = KEYS[5]

local lease_id = ARGV[1]
local amount   = tonumber(ARGV[2])

if redis.call('SISMEMBER', lease_active_set, lease_id) == 0 then
  if redis.call('EXISTS', lease_hash) == 0 then
    return redis.status_reply('OK')
  end
end

-- Return quota về pool
redis.call('INCRBY', pool_available, amount)
redis.call('DECRBY', pool_reserved, amount)

-- Xóa lease
redis.call('DEL', lease_hash)
redis.call('SREM', lease_active_set, lease_id)

-- Update active sum
local current_sum = redis.call('DECRBY', lease_active_sum, amount)
if current_sum < 0 then
  redis.call('SET', lease_active_sum, 0)
  return redis.status_reply('OK_UNDERFLOW')
end

return redis.status_reply('OK')
