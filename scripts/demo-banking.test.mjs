import assert from 'node:assert/strict';
import test from 'node:test';
import { demoBankingReading } from './demo-banking.mjs';
import { generateDemoScenario } from './demo-scenario.mjs';

const scenario = generateDemoScenario({ seed: 'banking-demo-proof', cutoff: '2026-11-21T12:00:00.000Z', release: 'a'.repeat(40) });
test('the first demo bank observation has two funded accounts and a varied complete month of cash activity', () => {
  const reading = demoBankingReading(scenario, scenario.manifest.cutoff);
  assert.deepEqual(reading, demoBankingReading(scenario, scenario.manifest.cutoff));
  assert.equal(reading.snapshot.accounts.length, 2);
  assert.ok(reading.snapshot.accounts.every(account => account.availableMinor > 0 && account.currentMinor >= account.availableMinor));
  assert.ok(reading.snapshot.transactions.length > 50);
  assert.deepEqual(new Set(reading.snapshot.transactions.map(row => row.status)), new Set(['sent', 'pending', 'failed', 'reversed']));
  assert.ok(reading.snapshot.transactions.some(row => row.counterparty.startsWith('Stripe')));
  assert.ok(reading.snapshot.transactions.some(row => row.counterparty.startsWith('Mediavine')));
  assert.ok(reading.snapshot.transactions.some(row => row.kind === 'debitCardCredit'));
  const transfers = reading.snapshot.transactions.filter(row => row.kind === 'internalTransfer');
  assert.equal(transfers.reduce((sum, row) => sum + row.amountMinor, 0), 0);
  assert.ok(reading.snapshot.transactions.every(row => Date.parse(row.createdAt) >= Date.parse(reading.snapshot.windowStart)
    && Date.parse(row.createdAt) <= Date.parse(reading.at)));
});
test('hourly continuation settles the same authorization without changing the available cash twice', () => {
  const first = demoBankingReading(scenario, scenario.manifest.cutoff);
  const later = demoBankingReading(scenario, '2026-11-21T19:00:00.000Z');
  const pending = first.snapshot.transactions.find(row => row.status === 'pending');
  assert.ok(pending);
  assert.equal(later.snapshot.transactions.find(row => row.id === pending.id).status, 'sent');
  const account = first.snapshot.accounts.find(row => row.id === pending.accountId);
  const after = later.snapshot.accounts.find(row => row.id === pending.accountId);
  assert.equal(after.currentMinor - account.currentMinor, pending.amountMinor);
  assert.equal(after.availableMinor, account.availableMinor);
  assert.throws(() => demoBankingReading(scenario, '2026-11-20T00:00:00Z'));
});
