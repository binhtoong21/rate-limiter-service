import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';
import { redis } from '../redis';

// Types for loaded scripts already defined in ioredis module declaration

export const luaScriptsPlugin = fp(async (fastify, opts) => {
  const scriptsDir = path.resolve(process.cwd(), 'src/redis/scripts');

  const claimLeaseScript = fs.readFileSync(path.join(scriptsDir, 'claim_lease.lua'), 'utf8');
  const releaseLeaseScript = fs.readFileSync(path.join(scriptsDir, 'release_lease.lua'), 'utf8');
  const getEffectiveLimitScript = fs.readFileSync(path.join(scriptsDir, 'get_effective_limit.lua'), 'utf8');
  const setQuotaPoolScript = fs.readFileSync(path.join(scriptsDir, 'set_quota_pool.lua'), 'utf8');

  // Define commands on Redis instance
  redis.defineCommand('claimLease', {
    numberOfKeys: 4,
    lua: claimLeaseScript,
  });

  redis.defineCommand('releaseLease', {
    numberOfKeys: 4,
    lua: releaseLeaseScript,
  });

  redis.defineCommand('getEffectiveLimit', {
    numberOfKeys: 1,
    lua: getEffectiveLimitScript,
  });

  redis.defineCommand('setQuotaPool', {
    numberOfKeys: 3,
    lua: setQuotaPoolScript,
  });

  fastify.log.info('Lua scripts loaded successfully');
});
