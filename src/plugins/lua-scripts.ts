import fp from 'fastify-plugin';
import fs from 'fs';
import path from 'path';
import { redis } from '../redis';

declare module 'fastify' {
  interface FastifyInstance {
    luaScripts: {
      claimLeaseSha: string;
      releaseLeaseSha: string;
      getEffectiveLimitSha: string;
      setQuotaPoolSha: string;
    };
  }
}

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

  // Also load them explicitly to get the SHA for manual evaluation if needed
  // Note: ioredis handles script loading automatically when using the defined commands
  const claimLeaseSha = await redis.script('LOAD', claimLeaseScript) as string;
  const releaseLeaseSha = await redis.script('LOAD', releaseLeaseScript) as string;
  const getEffectiveLimitSha = await redis.script('LOAD', getEffectiveLimitScript) as string;
  const setQuotaPoolSha = await redis.script('LOAD', setQuotaPoolScript) as string;

  fastify.decorate('luaScripts', {
    claimLeaseSha,
    releaseLeaseSha,
    getEffectiveLimitSha,
    setQuotaPoolSha,
  });

  fastify.log.info('Lua scripts loaded successfully');
});
