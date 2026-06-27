import 'dotenv/config';
import { buildApp } from './app';

const start = async () => {
  const app = buildApp();
  
  try {
    await app.listen({ port: Number(process.env.PORT) || 3000, host: '0.0.0.0' });
    app.log.info(`Server listening at http://0.0.0.0:${process.env.PORT || 3000}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
