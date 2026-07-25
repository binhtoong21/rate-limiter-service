-- create_loan.lua
-- KEYS[1] : Lender available key (quota:pool:{org_id}:available)
-- KEYS[2] : Lender loaned_out key (quota:pool:{org_id}:loaned_out)
-- KEYS[3] : Borrower received key (quota:pool:{org_id}:received)
-- KEYS[4] : Borrower available key (quota:pool:{org_id}:available)
-- KEYS[5] : Lender active loans set (quota:loan:active:lender:{org_id})
-- KEYS[6] : Borrower active loans set (quota:loan:active:borrower:{org_id})
-- KEYS[7] : Loan hash key (quota:loan:{loan_id})

-- ARGV[1] : amount to loan
-- ARGV[2] : loan_id
-- ARGV[3] : lender_org_id
-- ARGV[4] : borrower_org_id
-- ARGV[5] : expires_at (timestamp ms)
-- ARGV[6] : ttl_seconds

local lender_available_key = KEYS[1]
local lender_loaned_out_key = KEYS[2]
local borrower_received_key = KEYS[3]
local borrower_available_key = KEYS[4]
local active_loans_lender_key = KEYS[5]
local active_loans_borrower_key = KEYS[6]

local amount = tonumber(ARGV[1])
local loan_id = ARGV[2]

-- Check if lender has sufficient available quota
local lender_available = tonumber(redis.call('GET', lender_available_key) or '0')

if lender_available < amount then
  return { err = "INSUFFICIENT_QUOTA" }
end

-- Deduct from lender
redis.call('DECRBY', lender_available_key, amount)
redis.call('INCRBY', lender_loaned_out_key, amount)

-- Add to borrower
redis.call('INCRBY', borrower_received_key, amount)
redis.call('INCRBY', borrower_available_key, amount)

-- Add to active loan sets
redis.call('SADD', active_loans_lender_key, loan_id)
redis.call('SADD', active_loans_borrower_key, loan_id)

-- Create loan hash
redis.call('HSET', KEYS[7], 
  'lender_org_id', ARGV[3], 
  'borrower_org_id', ARGV[4], 
  'amount', ARGV[1], 
  'expires_at', ARGV[5]
)
redis.call('EXPIRE', KEYS[7], tonumber(ARGV[6]) + 60)

-- Return new balances for audit events
local new_lender_available = lender_available - amount
local new_borrower_available = tonumber(redis.call('GET', borrower_available_key) or '0')

return { tostring(new_lender_available), tostring(new_borrower_available) }
