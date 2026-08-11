import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';
import { redis } from '../redis';

// Types for loaded scripts already defined in ioredis module declaration

const scriptShas: Record<string, string> = {};
const scriptContents: Record<string, string> = {};

// Helper to evaluate Lua script with NOSCRIPT retry
async function evalShaWithRetry(
  commandName: string,
  numberOfKeys: number,
  ...args: (string | number)[]
) {
  try {
    return await redis.evalsha(scriptShas[commandName], numberOfKeys, ...args);
  } catch (err: any) {
    if (err.message && err.message.includes('NOSCRIPT')) {
      const sha = await redis.script('LOAD', scriptContents[commandName]) as string;
      scriptShas[commandName] = sha;
      return await redis.evalsha(sha, numberOfKeys, ...args);
    }
    throw err;
  }
}

export const luaScriptsPlugin = fp(async (fastify, opts) => {
  const scriptsDir = path.resolve(process.cwd(), 'src/redis/scripts');

  scriptContents['claimLease'] = fs.readFileSync(path.join(scriptsDir, 'claim_lease.lua'), 'utf8');
  scriptContents['releaseLease'] = fs.readFileSync(path.join(scriptsDir, 'release_lease.lua'), 'utf8');
  scriptContents['getEffectiveLimit'] = fs.readFileSync(path.join(scriptsDir, 'get_effective_limit.lua'), 'utf8');
  scriptContents['setQuotaPool'] = fs.readFileSync(path.join(scriptsDir, 'set_quota_pool.lua'), 'utf8');
  scriptContents['createLoan'] = fs.readFileSync(path.join(scriptsDir, 'create_loan.lua'), 'utf8');
  scriptContents['settleLoan'] = fs.readFileSync(path.join(scriptsDir, 'settle_loan.lua'), 'utf8');
  scriptContents['tokenBucketCheck'] = fs.readFileSync(path.join(scriptsDir, 'token_bucket.lua'), 'utf8');

  for (const cmd in scriptContents) {
    scriptShas[cmd] = await redis.script('LOAD', scriptContents[cmd]) as string;
  }

  // Attach wrappers directly to the redis instance
  (redis as any).claimLease = (...args: any[]) => evalShaWithRetry('claimLease', 4, ...args);
  (redis as any).releaseLease = (...args: any[]) => evalShaWithRetry('releaseLease', 4, ...args);
  (redis as any).getEffectiveLimit = (...args: any[]) => evalShaWithRetry('getEffectiveLimit', 1, ...args);
  (redis as any).setQuotaPool = (...args: any[]) => evalShaWithRetry('setQuotaPool', 3, ...args);
  (redis as any).createLoan = (...args: any[]) => evalShaWithRetry('createLoan', 7, ...args);
  (redis as any).settleLoan = (...args: any[]) => evalShaWithRetry('settleLoan', 7, ...args);
  (redis as any).tokenBucketCheck = (...args: any[]) => evalShaWithRetry('tokenBucketCheck', 1, ...args);

  fastify.log.info('Lua scripts loaded successfully via SCRIPT LOAD');
});
