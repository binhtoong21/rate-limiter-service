import { startLeaseExpiryWorker } from './lease-expiry.worker';

export const startWorkers = async () => {
  await startLeaseExpiryWorker();
};
