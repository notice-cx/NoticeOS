import { render, screen } from './render';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import type { BankingPayload, MercurySnapshot } from '@noticeos/contract/banking';
import { Banking } from '../src/routes/financials/Banking';

const snapshot: MercurySnapshot = { currency: 'USD', windowStart: '2026-10-01T12:00:00Z', windowEnd: '2026-11-05T12:00:00Z',
  accounts: [{ id: '10000000-0000-4000-8000-000000000001', name: 'Operating', kind: 'checking', status: 'active', currentMinor: 10001, availableMinor: 8029 },
    { id: '10000000-0000-4000-8000-000000000002', name: 'Closed', kind: 'checking', status: 'archived', currentMinor: 90000, availableMinor: 90000 }],
  transactions: [{ id: '10000000-0000-4000-8000-000000000010', accountId: '10000000-0000-4000-8000-000000000001', amountMinor: -1029,
    counterparty: 'Example vendor', kind: 'internalTransfer', status: 'pending', createdAt: '2026-11-04T12:00:00Z', postedAt: null }] };
function show(data: BankingPayload) { render(<MemoryRouter><Banking data={data} /></MemoryRouter>); }
it('shows cents, observation age and pending activity, with archived accounts excluded from available cash', () => {
  show({ state: 'recorded', observedAt: '2026-11-05T12:00:00Z', snapshot });
  expect(screen.getAllByText('$80.29')).toHaveLength(2);
  expect(screen.getByText('Last collected', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('pending')).toBeInTheDocument();
  expect(screen.getByText('Internal transfer')).toBeInTheDocument();
  expect(screen.getByText('-$10.29')).toBeInTheDocument();
});
it.each(['awaiting', 'unavailable', 'not-connected'] as const)('shows %s without inventing a cash zero', state => {
  show({ state, observedAt: null, snapshot: null });
  expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Manage connection' })).toHaveAttribute('href', '/integrations');
  if (state !== 'not-connected') expect(screen.getByRole('status')).toHaveAttribute('data-status-for', 'integration:mercury');
});
