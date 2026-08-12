import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || 'postgres://root:rootpassword@localhost:5433/rate_limiter';

// For queries
function getPositiveSafeInt(val: string | undefined, defaultVal: number): number {
  if (val === undefined) return defaultVal;
  if (!/^[1-9]\d*$/.test(val)) {
    throw new Error(`Invalid positive integer for DB connection setting: ${val}`);
  }
  const num = Number(val);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`Invalid positive safe integer for DB connection setting: ${val}`);
  }
  return num;
}

const maxPool = getPositiveSafeInt(process.env.DB_POOL_MAX, 10);
const statementTimeout = getPositiveSafeInt(process.env.DB_STATEMENT_TIMEOUT, 3000);

const queryClient = postgres(connectionString, { 
  max: maxPool,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    statement_timeout: statementTimeout
  }
});
export const db = drizzle(queryClient, { schema });
