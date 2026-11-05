import { Link } from 'react-router-dom';
import { BANK_ACTIVITY_DISPLAY_LIMIT, MERCURY_WINDOW_DAYS, type BankingPayload } from '@noticeos/contract/banking';
import { SectionLabel } from '@/components/surface/SectionLabel';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatMoney, formatTimestamp } from '@/lib/format';

const amount = (minor: number) => formatMoney(minor / 100, 'USD', { cents: true });

export function Banking({ data }: { data: BankingPayload }) {
  const snapshot = data.snapshot;
  const active = snapshot?.accounts.filter(account => account.status === 'active') ?? [];
  const available = active.reduce((sum, account) => sum + BigInt(account.availableMinor), 0n);
  const safe = available >= -BigInt(Number.MAX_SAFE_INTEGER) && available <= BigInt(Number.MAX_SAFE_INTEGER);
  return (
    <section aria-label="Mercury banking" className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4" data-banking>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel title="Mercury · Deposit accounts" />
        <Link to="/integrations" className="text-sm underline underline-offset-4">Manage connection</Link>
      </div>
      {data.state === 'not-connected' ? <p className="text-sm text-muted-foreground">Connect Mercury to view bank balances and activity.</p>
        : data.state === 'unavailable' ? <p role="status" className="text-sm text-muted-foreground">Bank data could not be read.</p>
          : !snapshot ? <p role="status" className="text-sm text-muted-foreground">Waiting for the first bank collection.</p>
            : <>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <p className="text-2xl font-semibold tabular-nums">{active.length > 0 && safe ? amount(Number(available)) : 'Unavailable'}</p>
                <p className="text-sm text-muted-foreground">Available in active deposit accounts</p>
              </div>
              <p className="text-xs text-muted-foreground">Last collected {data.observedAt ? <time dateTime={data.observedAt}>{formatTimestamp(data.observedAt)}</time> : 'time unavailable'}. Balances are the latest collected values for every accounting period.</p>
              {snapshot.accounts.length === 0 ? <p className="text-sm text-muted-foreground">No deposit accounts returned.</p> : (
                <Table stacked>
                  <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Current</TableHead><TableHead className="text-right">Available</TableHead></TableRow></TableHeader>
                  <TableBody>{snapshot.accounts.map(account => <TableRow key={account.id}>
                    <TableCell label="Account" className="break-words">{account.name}</TableCell><TableCell label="Status" className="capitalize">{account.status}</TableCell>
                    <TableCell label="Current" className="text-right tabular-nums">{amount(account.currentMinor)}</TableCell>
                    <TableCell label="Available" className="text-right tabular-nums">{amount(account.availableMinor)}</TableCell>
                  </TableRow>)}</TableBody>
                </Table>
              )}
              <details>
                <summary className="cursor-pointer text-sm font-medium">Recent bank activity</summary>
                <p className="my-2 text-xs text-muted-foreground">Up to {BANK_ACTIVITY_DISPLAY_LIMIT} transactions created in the last {MERCURY_WINDOW_DAYS} days. Treasury and credit accounts are excluded.</p>
                {snapshot.transactions.length === 0 ? <p className="text-sm text-muted-foreground">No bank activity returned for this window.</p> : <Table stacked>
                  <TableHeader><TableRow><TableHead>Created</TableHead><TableHead>Counterparty</TableHead><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                  <TableBody>{snapshot.transactions.map(transaction => <TableRow key={transaction.id}>
                    <TableCell label="Created"><time dateTime={transaction.createdAt}>{formatTimestamp(transaction.createdAt)}</time></TableCell>
                    <TableCell label="Counterparty" className="break-words">{transaction.counterparty || 'No counterparty'}{transaction.kind === 'internalTransfer' ? <span className="block text-xs text-muted-foreground">Internal transfer</span> : null}</TableCell>
                    <TableCell label="Account" className="break-words">{snapshot.accounts.find(account => account.id === transaction.accountId)?.name ?? 'Unknown account'}</TableCell>
                    <TableCell label="Status" className="capitalize">{transaction.status === 'sent' && transaction.postedAt !== null ? 'Posted' : transaction.status}</TableCell>
                    <TableCell label="Amount" className="text-right tabular-nums">{amount(transaction.amountMinor)}</TableCell>
                  </TableRow>)}</TableBody>
                </Table>}
              </details>
              <p className="text-xs text-muted-foreground">Bank activity is shown separately from revenue and costs. Payouts and transfers do not add to earned revenue.</p>
            </>}
    </section>
  );
}
