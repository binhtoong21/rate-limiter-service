import 'dotenv/config';
import { buildApp } from './app';
import { startWorkers } from './workers';

const start = async () => {
  const app = buildApp();
  
  try {
    await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
    app.log.info(`Server listening at http://0.0.0.0:${process.env.PORT || 3000}`);
    
    // Start background workers only after app is successfully listening
    await startWorkers();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
