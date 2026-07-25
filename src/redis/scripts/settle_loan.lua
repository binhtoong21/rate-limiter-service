-- KEYS[1] = quota:pool:{lender_org_id}:available
-- KEYS[2] = quota:pool:{lender_org_id}:loaned_out
-- KEYS[3] = quota:pool:{borrower_org_id}:received
-- KEYS[4] = quota:pool:{borrower_org_id}:available
-- KEYS[5] = quota:loan:active:lender:{lender_org_id}
-- KEYS[6] = quota:loan:active:borrower:{borrower_org_id}
-- KEYS[7] = quota:loan:{loan_id}
-- ARGV[1] = amount
-- ARGV[2] = loan_id

local lender_available_key = KEYS[1]
local lender_loaned_out_key = KEYS[2]
local borrower_received_key = KEYS[3]
local borrower_available_key = KEYS[4]
local active_loans_lender_key = KEYS[5]
local active_loans_borrower_key = KEYS[6]

local amount = tonumber(ARGV[1])
local loan_id = ARGV[2]

-- Idempotency / EXISTS guard (race condition safety net)
if redis.call('SISMEMBER', active_loans_lender_key, loan_id) == 0 then
  return { err = "LOAN_ALREADY_SETTLED" }
end

-- Reverse operations of create_loan
redis.call('DECRBY', borrower_received_key, amount)
redis.call('DECRBY', borrower_available_key, amount)

redis.call('DECRBY', lender_loaned_out_key, amount)
redis.call('INCRBY', lender_available_key, amount)

-- Remove from active sets
redis.call('SREM', active_loans_lender_key, loan_id)
redis.call('SREM', active_loans_borrower_key, loan_id)

redis.call('DEL', KEYS[7])

-- Return new balances for audit events
local new_lender_available = tonumber(redis.call('GET', lender_available_key) or '0')
local new_borrower_available = tonumber(redis.call('GET', borrower_available_key) or '0')

return { tostring(new_lender_available), tostring(new_borrower_available) }
