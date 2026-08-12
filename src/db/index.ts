import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || 'postgres://root:rootpassword@localhost:5433/rate_limiter';

// For queries
const maxPool = process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10;
const queryClient = postgres(connectionString, { max: maxPool });
export const db = drizzle(queryClient, { schema });
