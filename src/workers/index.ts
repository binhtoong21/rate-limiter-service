import { startLeaseExpiryWorker } from './lease-expiry.worker';
import { startLoanExpiryWorker } from './loan-expiry.worker';
import { startReconciliationWorker } from './reconciliation.worker';

export const startWorkers = async () => {
  await startLeaseExpiryWorker();
  await startLoanExpiryWorker();
  await startReconciliationWorker();
};
