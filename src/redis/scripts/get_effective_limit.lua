-- get_effective_limit.lua
-- KEYS: [lease_active_set]  -- quota:lease:active:{org_id}
-- ARGV: [default_limit]     -- fallback nếu không có lease nào

local lease_active_set = KEYS[1]
local default_limit = tonumber(ARGV[1])

local lease_ids = redis.call('SMEMBERS', lease_active_set)
if #lease_ids == 0 then return default_limit end

local total = 0
for _, lease_id in ipairs(lease_ids) do
  local amount = redis.call('HGET', 'quota:lease:' .. lease_id, 'amount')
  if amount then total = total + tonumber(amount) end
end
return total
