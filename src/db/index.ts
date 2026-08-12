import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || 'postgres://root:rootpassword@localhost:5433/rate_limiter';

// For queries
const maxPool = process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10;
const statementTimeout = process.env.DB_STATEMENT_TIMEOUT ? parseInt(process.env.DB_STATEMENT_TIMEOUT, 10) : 3000;

const queryClient = postgres(connectionString, { 
  max: maxPool,
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    statement_timeout: statementTimeout
  }
});
export const db = drizzle(queryClient, { schema });
