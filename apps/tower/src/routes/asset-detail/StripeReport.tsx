import { useId } from 'react';
import { minorToMajorUnits } from '@noticeos/contract/money';
import type { StripeSubscriptionReport } from '@noticeos/contract/stripe-report';
import type { DailyRevenueHistory } from '@shared/daily-revenue';
import { StatTile } from '@/components/viz/StatTile';
import { BarStrip } from '@/components/viz/BarStrip';
import { formatInt, formatMoney, formatTimestamp } from '@/lib/format';

export function StripeReport({ report, history, days, nowMs }: {
  report: StripeSubscriptionReport | null | undefined;
  history?: DailyRevenueHistory;
  days: number;
  nowMs: number;
}) {
  const id = useId();
  const sources = history?.bySource?.filter((source) => source.provider === 'stripe') ?? [];
  if (!report && sources.length === 0) return null;
  const latest = report?.latest;
  const growth = report?.comparisons.find((comparison) => comparison.days === days)?.growth;
  const stale = latest ? nowMs - Date.parse(latest.observedAt) > 36 * 3_600_000 : false;
  const money = (value: number) => formatMoney(minorToMajorUnits(value, latest!.currency), latest!.currency, { cents: true });
  return <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3" data-stripe-report="">
    <h2 id={id} className="text-sm font-medium">Stripe</h2>
    {latest ? <>
      <p className="m-0 text-xs text-muted-foreground">
        Subscriptions observed {formatTimestamp(latest.observedAt)}{stale ? ' · overdue' : ''}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Monthly recurring revenue" value={latest.mrrMinor} format={money} role="money" absent="Pricing not measured"
          history={<BarStrip data={report!.history.slice(-days).map((row) => ({ t: row.observedAt.slice(0, 10), v: row.mrrMinor }))} tone="text-financial-revenue" format={money} ariaLabel="Monthly recurring revenue history" className="h-12" />} />
        <StatTile label="Paid-plan customers" value={latest.paidCustomers} format={formatInt} absent="Pricing not measured" />
        <StatTile label="Trials" value={latest.trials} format={formatInt} />
        <StatTile label="Past-due subscriptions" value={latest.pastDue} format={formatInt} role={latest.pastDue > 0 ? 'warning' : 'context'} />
      </div>
      {latest.unmeasuredSubscriptions > 0 ? <p className="m-0 text-sm text-muted-foreground">
        {formatInt(latest.unmeasuredSubscriptions)} subscriptions have unsupported pricing. MRR and customer growth are unavailable.
      </p> : null}
      <p className="m-0 text-xs text-muted-foreground">
        Active and past-due fixed monthly or annual plans; trials excluded. {formatInt(latest.canceling)} scheduled to cancel.
      </p>
      {growth ? <>
        <p className="m-0 text-xs text-muted-foreground">Subscription comparison · {formatTimestamp(growth.from)} to {formatTimestamp(growth.to)}</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="MRR change" value={growth.netMrrMinor} format={money} role="money" />
          <StatTile label="Customers added" value={growth.newCustomers} format={formatInt} />
          <StatTile label="Customers lost" value={growth.lostCustomers} format={formatInt} />
          <StatTile label="Opening customer churn" value={growth.customerChurnPercent} format={(value) => `${value.toFixed(1)}%`} absent="No opening customers" />
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          MRR: {money(growth.newMrrMinor)} added · {money(growth.expansionMinor)} expansion · {money(growth.contractionMinor)} contraction · {money(growth.lostMrrMinor)} lost.
        </p>
      </> : <p className="m-0 text-sm text-muted-foreground">Growth needs comparable reports {days} days apart.</p>}
    </> : <p className="m-0 text-sm text-muted-foreground">No subscription report yet.</p>}
    {sources.map((source) => {
      const rows = source.days.filter((day) => day.date >= history!.from && day.date <= history!.to);
      const measured = rows.filter((day) => day.sales !== undefined);
      const total = (field: 'salesMinor' | 'refundsMinor' | 'feesMinor' | 'payments' | 'refunds') => measured.reduce((sum, day) => sum + day.sales![field], 0);
      const cashMoney = (value: number) => formatMoney(minorToMajorUnits(value, source.currency), source.currency, { cents: true });
      return <div key={`${source.source}/${source.currency}`} className="flex flex-col gap-3">
        <p className="m-0 text-xs text-muted-foreground">Cash receipts · {history!.from} to {history!.to} · {measured.length} of {days} days with a breakdown</p>
        {measured.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatTile label="Gross sales" value={total('salesMinor')} format={cashMoney} role="money" />
          <StatTile label="Refunds, net of reversals" value={total('refundsMinor')} format={cashMoney} />
          <StatTile label="Payment fees" value={total('feesMinor')} format={cashMoney} />
          <StatTile label="Net receipts" value={measured.reduce((sum, day) => sum + day.amountMinor, 0)} format={cashMoney} role="money" />
          <StatTile label="Payments" value={total('payments')} format={formatInt} context={`${formatInt(total('refunds'))} refund transactions`} />
        </div> : <p className="m-0 text-sm text-muted-foreground">No sales breakdown in this period.</p>}
        <p className="m-0 text-xs text-muted-foreground">Gross sales − refunds − payment fees = net receipts. Payouts, disputes and separate account fees are excluded.</p>
      </div>;
    })}
  </section>;
}
