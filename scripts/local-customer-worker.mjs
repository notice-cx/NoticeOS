import { parentPort, workerData } from 'node:worker_threads';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { openDevelopmentStart } from './start-development.mjs';

let db, customer;
const stopped = new Promise(resolve => parentPort.once('message', resolve));
try {
  db = openDevelopmentStart(workerData.plan, { profile: 'hosted' });
  customer = await startLocalCustomer(workerData.plan, db, { ntasksOrigin: workerData.ntasksOrigin,
    startSchedules: startLocalCustomerSchedules });
  parentPort.postMessage({ publicOrigin: customer.publicOrigin, outbox: customer.outbox });
  await stopped;
} finally {
  try { await customer?.close(); } finally { db?.close(); }
  parentPort.close();
}
