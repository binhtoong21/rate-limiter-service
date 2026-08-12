import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import 'dotenv/config';

// Migration always runs in isolation, uses 1 connection max
// Use port 5433 to match docker-compose mapping for localhost
const connectionString = process.env.DATABASE_URL || 'postgres://root:rootpassword@localhost:5433/rate_limiter';

const migrationClient = postgres(connectionString, { max: 1 });

async function main() {
  console.log('Starting migration...');
  const db = drizzle(migrationClient);
  await migrate(db, { migrationsFolder: 'drizzle' });
  console.log('Migration completed successfully!');
  await migrationClient.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed!');
  console.error(err);
  process.exit(1);
});
