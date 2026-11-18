import { parentPort, workerData } from 'node:worker_threads';
import { CustomerOperatingRefused } from './local-customer-operating.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { openDevelopmentStart } from './start-development.mjs';

let db, customer;
const stopped = new Promise(resolve => parentPort.once('message', resolve));
try {
  if (workerData.customerConfig) {
    const { startAttachedCustomer } = await import('./local-customer-attach.mjs');
    customer = await startAttachedCustomer(workerData.plan, workerData.customerConfig);
  } else {
    db = openDevelopmentStart(workerData.plan, { profile: 'hosted' });
    customer = await startLocalCustomer(workerData.plan, db, { ntasksOrigin: workerData.ntasksOrigin,
      startSchedules: startLocalCustomerSchedules });
  }
  parentPort.postMessage({ publicOrigin: customer.publicOrigin, outbox: customer.outbox });
  const lost = await Promise.race([stopped, ...(customer.whenLost ? [customer.whenLost] : [])]);
  if (lost instanceof CustomerOperatingRefused) throw lost;
} catch (error) {
  if (error instanceof CustomerOperatingRefused) parentPort.postMessage({ problem: error.message });
  throw error;
} finally {
  try { await customer?.close(); } finally { db?.close(); }
  parentPort.close();
}
