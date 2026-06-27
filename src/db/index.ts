import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || 'postgres://root:rootpassword@localhost:5432/rate_limiter';

// For queries
const queryClient = postgres(connectionString, { max: 10 });
export const db = drizzle(queryClient, { schema });
